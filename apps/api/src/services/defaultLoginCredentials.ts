import crypto from "crypto";
import bcrypt from "bcryptjs";

/**
 * Give a newly queued account an unknown random password until its one-time
 * credential is delivered. This prevents pending accounts from sharing a
 * usable, published bootstrap password.
 */
export async function hashDefaultWorkforcePassword(rounds = 10): Promise<string> {
  return bcrypt.hash(crypto.randomBytes(32).toString("base64url"), rounds);
}

export const defaultWorkforceCredentialState = {
  mustChangePassword: true,
  passwordExpiresAt: null,
  credentialProvisionedAt: null,
  credentialSentAt: null,
} as const;

export function usesEcNoLogin(role: string, employeeId: number | null | undefined): boolean {
  return employeeId != null && (role === "EMPLOYEE" || role === "SUPERVISOR");
}
