import crypto from "crypto";
import bcrypt from "bcryptjs";
import { prisma } from "../db";
import { DEV_BOOTSTRAP_PASSWORD, usesDevBootstrapPassword, usesEcNoLogin } from "./defaultLoginCredentials";
import { createSmtpTransport, safeSmtpError, smtpConfigured } from "./smtp";

export type CredentialDeliveryResult = {
  processed: number;
  sent: number;
  failed: number;
  pending: number;
  disabled: boolean;
};

function temporaryPassword(): string {
  // 144 random bits. base64url avoids whitespace and mail-client punctuation issues.
  return crypto.randomBytes(18).toString("base64url");
}

/**
 * Deliver queued one-time supervisor credentials. The queue contains no password.
 * A fresh password is generated and hashed for every attempt, and is disclosed only
 * to the configured SMTP transport. Missing SMTP configuration leaves work pending.
 */
export async function processCredentialDeliveries(): Promise<CredentialDeliveryResult> {
  const result: CredentialDeliveryResult = { processed: 0, sent: 0, failed: 0, pending: 0, disabled: false };
  if (!smtpConfigured()) {
    result.disabled = true;
    result.pending = await prisma.credentialDelivery.count({ where: { status: "PENDING" } });
    return result;
  }

  const transporter = createSmtpTransport();
  const batchSize = Math.max(1, Math.min(100, Number(process.env.CREDENTIAL_DELIVERY_BATCH_SIZE || 20)));
  const expiryHours = Math.max(1, Number(process.env.TEMP_PASSWORD_EXPIRY_HOURS || 24));
  const staleBefore = new Date(Date.now() - 15 * 60 * 1000);
  await prisma.credentialDelivery.updateMany({
    where: { status: "PROCESSING", updatedAt: { lt: staleBefore } },
    data: { status: "PENDING", lastError: "Recovered stale processing claim." },
  });
  const deliveries = await prisma.credentialDelivery.findMany({
    where: { status: "PENDING" },
    include: { user: { include: { employee: { select: { ecNo: true, active: true } } } } },
    orderBy: { createdAt: "asc" },
    take: batchSize,
  });

  for (const delivery of deliveries) {
    const claimed = await prisma.credentialDelivery.updateMany({
      where: { id: delivery.id, status: "PENDING" },
      data: { status: "PROCESSING", attempts: { increment: 1 }, lastError: null },
    });
    if (!claimed.count) continue;
    result.processed += 1;

    const currentUser = await prisma.user.findUnique({
      where: { id: delivery.userId }, include: { employee: { select: { active: true } } },
    });
    if (!currentUser?.active || (currentUser.employeeId != null && !currentUser.employee?.active)) {
      await prisma.credentialDelivery.update({
        where: { id: delivery.id },
        data: { status: "CANCELLED", lastError: "User or linked Employee is inactive." },
      });
      continue;
    }

    // While the dev bootstrap password is in force, a queued one-time credential
    // would immediately overwrite the password the operator deliberately
    // provisioned (and that an unauthenticated caller can poll for). Fail closed:
    // mark the row FAILED with no attempt, and leave the password alone.
    if (usesDevBootstrapPassword() && !currentUser.credentialSentAt) {
      await prisma.credentialDelivery.update({
        where: { id: delivery.id },
        data: {
          status: "FAILED",
          lastError: "Dev bootstrap password is enabled; a one-time credential would overwrite it.",
        },
      });
      continue;
    }

    const ecNoAccount = usesEcNoLogin(currentUser.role, currentUser.employeeId);
    // While the dev bootstrap password is in force the queue must disclose THAT
    // password. Generating a fresh random one here would mail a secret nobody can
    // read and silently lock the account out of the shared dev credential.
    const devBootstrap = usesDevBootstrapPassword();
    const deliveredPassword = devBootstrap ? String(DEV_BOOTSTRAP_PASSWORD) : temporaryPassword();
    try {
      const now = new Date();
      const expiresAt = new Date(now.getTime() + expiryHours * 60 * 60 * 1000);
      const credentialData = {
        passwordHash: await bcrypt.hash(deliveredPassword, 10),
        mustChangePassword: !devBootstrap,
        passwordExpiresAt: devBootstrap ? null : expiresAt,
        credentialProvisionedAt: now,
        tokenVersion: { increment: 1 },
      };
      const activated = await prisma.user.updateMany({
        where: { id: delivery.userId, active: true },
        data: credentialData,
      });
      if (!activated.count) {
        await prisma.credentialDelivery.update({ where: { id: delivery.id }, data: { status: "CANCELLED", lastError: "User became inactive before delivery." } });
        continue;
      }

      await transporter.sendMail({
        from: process.env.SMTP_FROM!.trim(),
        to: delivery.recipient,
        subject: `Workforce ${devBootstrap ? "account credentials" : "supervisor temporary credential"} (${delivery.purpose})`,
        text: ecNoAccount
          ? [
              "A Workforce login has been provisioned.",
              `Name: ${delivery.user.name}`,
              `Login EC No: ${delivery.user.employee?.ecNo ?? "Not linked"}`,
              `Password: ${deliveredPassword}`,
              ...(devBootstrap ? [] : [`Expires: ${expiresAt.toISOString()}`, "The user must change this password at first login."]),
            ].join("\n")
          : [
              "A Workforce administrative credential has been provisioned.",
              `Name: ${delivery.user.name}`,
              `Login email: ${delivery.user.email}`,
              `Password: ${deliveredPassword}`,
              ...(devBootstrap ? [] : [`Expires: ${expiresAt.toISOString()}`, "The user must change this password at first login."]),
            ].join("\n"),
      });

      const markedSent = await prisma.$transaction(async (tx) => {
        const marked = await tx.credentialDelivery.updateMany({
          where: { id: delivery.id, status: "PROCESSING" },
          data: { status: "SENT", sentAt: new Date(), lastError: null },
        });
        if (marked.count) await tx.user.update({ where: { id: delivery.userId }, data: { credentialSentAt: new Date() } });
        return marked.count > 0;
      });
      if (markedSent) result.sent += 1;
    } catch (error) {
      await prisma.credentialDelivery.updateMany({
        where: { id: delivery.id, status: "PROCESSING" },
        data: { status: "PENDING", lastError: safeSmtpError(error) },
      });
      result.failed += 1;
    }
  }

  result.pending = await prisma.credentialDelivery.count({ where: { status: "PENDING" } });
  return result;
}
