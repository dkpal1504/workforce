import crypto from "crypto";
import bcrypt from "bcryptjs";
import { prisma } from "../db";
import { createSmtpTransport, safeSmtpError, smtpConfigured } from "./smtp";
import { DEV_BOOTSTRAP_PASSWORD, usesDevBootstrapPassword } from "./defaultLoginCredentials";

/**
 * First-login credential e-mail for a newly registered employee.
 *
 * Recipient: the employee's own address when the row carries one; otherwise the
 * shared credential inbox (CREDENTIAL_DELIVERY_RECIPIENT, default the IT support
 * mailbox). It fires from development and production alike — the API does the
 * sending, so a local dev box with SMTP_* set really does deliver.
 *
 * Secret disclosed:
 *   - dev bootstrap in force -> the shared local password, and the account is left
 *     unchanged (no forced reset), matching every other dev registration;
 *   - otherwise -> a freshly generated one-time password, hashed onto the account,
 *     with mustChangePassword so the delivered secret must be replaced at first login.
 *
 * Never throws: a registration must not fail because mail did. The caller records
 * the outcome and queues a durable delivery row when the message did not go out.
 */

export const DEFAULT_CREDENTIAL_RECIPIENT = "itsupport.shipyard@swan.co.in";

/** Where a credential notice for this employee should go. */
export function credentialRecipientFor(employeeEmail?: string | null): string {
  const own = String(employeeEmail ?? "").trim();
  if (own) return own;
  return process.env.CREDENTIAL_DELIVERY_RECIPIENT?.trim() || DEFAULT_CREDENTIAL_RECIPIENT;
}

/** A one-time secret: 144 random bits, base64url so no mail client mangles it. */
export function temporaryPassword(): string {
  return crypto.randomBytes(18).toString("base64url");
}

export type CredentialMailOutcome = { sent: boolean; recipient: string; reason?: string };

export async function sendInitialCredentialEmail(
  userId: number,
  opts: { employeeEmail?: string | null; ecNo?: string | null; purpose?: string } = {},
): Promise<CredentialMailOutcome> {
  const recipient = credentialRecipientFor(opts.employeeEmail);
  if (!smtpConfigured()) {
    return { sent: false, recipient, reason: "SMTP is not configured." };
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, email: true, active: true },
  });
  if (!user?.active) return { sent: false, recipient, reason: "Account is inactive." };

  const devBootstrap = usesDevBootstrapPassword();
  const expiryHours = Math.max(1, Number(process.env.TEMP_PASSWORD_EXPIRY_HOURS || 24));
  let deliveredPassword: string;
  let expiresAt: Date | null = null;

  try {
    if (devBootstrap) {
      deliveredPassword = String(DEV_BOOTSTRAP_PASSWORD);
    } else {
      deliveredPassword = temporaryPassword();
      const now = new Date();
      expiresAt = new Date(now.getTime() + expiryHours * 60 * 60 * 1000);
      await prisma.user.update({
        where: { id: userId },
        data: {
          passwordHash: await bcrypt.hash(deliveredPassword, 10),
          mustChangePassword: true,
          passwordExpiresAt: expiresAt,
          credentialProvisionedAt: now,
          tokenVersion: { increment: 1 },
        },
      });
    }

    const lines = [
      opts.ecNo ? "A Workforce login has been provisioned." : "A Workforce account has been provisioned.",
      `Name: ${user.name}`,
      opts.ecNo ? `Login EC No: ${opts.ecNo}` : `Login email: ${user.email}`,
      `Password: ${deliveredPassword}`,
      ...(expiresAt ? [`Expires: ${expiresAt.toISOString()}`, "You must change this password at first login."] : []),
    ];
    await createSmtpTransport().sendMail({
      from: process.env.SMTP_FROM!.trim(),
      to: recipient,
      subject: `Workforce account credentials (${opts.purpose ?? "INITIAL"})`,
      text: lines.join("\n"),
    });
    await prisma.user.update({ where: { id: userId }, data: { credentialSentAt: new Date() } });
    return { sent: true, recipient };
  } catch (error) {
    return { sent: false, recipient, reason: safeSmtpError(error) };
  }
}
