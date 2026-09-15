import nodemailer from "nodemailer";

/** The SMTP transport, shared by the credential queue and the direct registration e-mail. */
export function smtpConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST?.trim() && process.env.SMTP_FROM?.trim());
}

export function createSmtpTransport() {
  const port = Number(process.env.SMTP_PORT || 587);
  const secure = String(process.env.SMTP_SECURE || "false").toLowerCase() === "true";
  const user = process.env.SMTP_USER?.trim();
  const password = process.env.SMTP_PASSWORD;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST!.trim(),
    port,
    secure,
    ...(user && password ? { auth: { user, pass: password } } : {}),
  });
}

/** Limit persisted provider errors and defensively redact URI-style credentials. */
export function safeSmtpError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/([a-z]+:\/\/)[^@\s]+@/gi, "$1[redacted]@").slice(0, 1000);
}
