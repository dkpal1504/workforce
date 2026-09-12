import bcrypt from "bcryptjs";

/**
 * Temporary shared bootstrap credential requested for the current rollout.
 * Replace this policy with one-time credential delivery before production.
 */
export const DEFAULT_WORKFORCE_PASSWORD = "password@SDHI";

export async function hashDefaultWorkforcePassword(rounds = 10): Promise<string> {
  return bcrypt.hash(DEFAULT_WORKFORCE_PASSWORD, rounds);
}

export const defaultWorkforceCredentialState = {
  mustChangePassword: false,
  passwordExpiresAt: null,
  credentialProvisionedAt: null,
  credentialSentAt: null,
} as const;

export function usesEcNoLogin(role: string, employeeId: number | null | undefined): boolean {
  return employeeId != null && (role === "EMPLOYEE" || role === "SUPERVISOR");
}
