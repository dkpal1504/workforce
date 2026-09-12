import crypto from "crypto";
import bcrypt from "bcryptjs";
import nodemailer from "nodemailer";
import { prisma } from "../db";
import { usesEcNoLogin } from "./defaultLoginCredentials";

export type CredentialDeliveryResult = {
  processed: number;
  sent: number;
  failed: number;
  pending: number;
  disabled: boolean;
};

function smtpConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST?.trim() && process.env.SMTP_FROM?.trim());
}

function temporaryPassword(): string {
  // 144 random bits. base64url avoids whitespace and mail-client punctuation issues.
  return crypto.randomBytes(18).toString("base64url");
}

function safeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  // Limit persisted provider errors and defensively redact URI-style credentials.
  return text.replace(/([a-z]+:\/\/)[^@\s]+@/gi, "$1[redacted]@").slice(0, 1000);
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

  const port = Number(process.env.SMTP_PORT || 587);
  const secure = String(process.env.SMTP_SECURE || "false").toLowerCase() === "true";
  const user = process.env.SMTP_USER?.trim();
  const password = process.env.SMTP_PASSWORD;
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST!.trim(),
    port,
    secure,
    ...(user && password ? { auth: { user, pass: password } } : {}),
  });
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

    const ecNoAccount = usesEcNoLogin(currentUser.role, currentUser.employeeId);
    const deliveredPassword = temporaryPassword();
    try {
      const now = new Date();
      const expiresAt = new Date(now.getTime() + expiryHours * 60 * 60 * 1000);
      const credentialData = {
        passwordHash: await bcrypt.hash(deliveredPassword, 10),
        mustChangePassword: true,
        passwordExpiresAt: expiresAt,
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
        subject: `Workforce supervisor temporary credential (${delivery.purpose})`,
        text: ecNoAccount
          ? [
              "A Workforce login has been provisioned.",
              `Name: ${delivery.user.name}`,
              `Login EC No: ${delivery.user.employee?.ecNo ?? "Not linked"}`,
              `Temporary password: ${deliveredPassword}`,
              `Expires: ${expiresAt.toISOString()}`,
              "The user must change this password at first login.",
            ].join("\n")
          : [
              "A Workforce administrative credential has been provisioned.",
              `Name: ${delivery.user.name}`,
              `Login email: ${delivery.user.email}`,
              `Temporary password: ${deliveredPassword}`,
              `Expires: ${expiresAt.toISOString()}`,
              "The user must change this password at first login.",
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
        data: { status: "PENDING", lastError: safeError(error) },
      });
      result.failed += 1;
    }
  }

  result.pending = await prisma.credentialDelivery.count({ where: { status: "PENDING" } });
  return result;
}
