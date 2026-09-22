import crypto from "crypto";
import bcrypt from "bcryptjs";

/**
 * FIRST-LOGIN PASSWORD FOR NEWLY REGISTERED CONTRACT ACCOUNTS
 *
 * Most contract workers and supervisors have **no e-mail address**, so the
 * e-mailed one-time credential cannot reach them. Instead of e-mailing a secret
 * nobody can read, a deployment can configure ONE shared first password here:
 *
 *   BOOTSTRAP_PASSWORD=password@SDHI        # in .env / .env.production
 *
 * Every account created by a registration path (Employee Registration, Supervisor
 * Registration, HOD registration/promotion, admin user creation, reactivation and
 * the LabourWorks sync) then starts with that password, and **must change it at the
 * first login**: the API blocks every endpoint except the change-password
 * lifecycle until the person has set a password of their own
 * (`middleware/auth.ts`, `PASSWORD_CHANGE_REQUIRED`).
 *
 * It is deliberately CONFIGURATION, not a literal in the source:
 *  - a hardcoded shared password ships inside the image and in git history, which
 *    is how a published secret leaks; the value now lives in the environment only;
 *  - `apps/api/scripts/check-no-dev-bootstrap-password.mjs` still fails the
 *    production build if a literal password is ever assigned in this file again;
 *  - leaving the variable UNSET is the safe default: new accounts get a random,
 *    e-mailed one-time credential instead (`CREDENTIAL_DELIVERY_*`).
 *
 * Operational notes:
 *  - It is a shared secret. Rotate it by changing the value (existing accounts keep
 *    their own password; only accounts provisioned afterwards get the new one).
 *  - Contract workers log in with their EC number, not an e-mail address
 *    (`usesEcNoLogin`).
 *  - When it is in force no credential e-mail is sent for those accounts: the
 *    queue marks the row as cancelled with a clear reason instead of mailing a
 *    password that is already known to the deployment.
 */

/** The configured shared first password, or null when the deployment does not use one. */
export function bootstrapPassword(): string | null {
  const value = (process.env.BOOTSTRAP_PASSWORD ?? "").trim();
  return value === "" ? null : value;
}

/** True while a shared first password is configured for newly provisioned accounts. */
export function usesBootstrapPassword(): boolean {
  return bootstrapPassword() !== null;
}

/**
 * Refuse an unusable shared password at boot. A one- or two-character secret handed
 * to every new account is worse than no shared password at all, and an empty value
 * must mean "not configured" (fall back to the random credential), never "everyone
 * gets an empty password".
 */
export function assertBootstrapPasswordUsable(): void {
  const value = bootstrapPassword();
  if (value === null) return;
  if (value.length < 8) {
    throw new Error(
      "BOOTSTRAP_PASSWORD must be at least 8 characters, or unset to use the random, e-mailed one-time credential."
    );
  }
}

/** Logged once at boot so a deployment can never use a shared password silently. */
export function bootstrapPasswordNotice(): string | null {
  if (!usesBootstrapPassword()) return null;
  return (
    "BOOTSTRAP_PASSWORD is set: newly registered contract accounts start with the shared " +
    "first password and MUST change it at their first login. No credential e-mail is sent to them. " +
    "Unset BOOTSTRAP_PASSWORD to hand out random, e-mailed credentials instead."
  );
}

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

/** The credential state a newly provisioned account starts in. */
export type InitialCredential = { passwordHash: string; mustChangePassword: boolean };

/**
 * Credentials for a newly provisioned account.
 *
 * With BOOTSTRAP_PASSWORD configured: that shared password, and the account must
 * change it at the first login. Without it: a random password that nobody knows
 * until the queued credential is delivered, also with a forced change.
 */
export async function initialCredentialState(): Promise<InitialCredential> {
  const shared = bootstrapPassword();
  if (shared === null) {
    return { passwordHash: await hashDefaultWorkforcePassword(), mustChangePassword: true };
  }
  assertBootstrapPasswordUsable();
  return { passwordHash: await bcrypt.hash(shared, 10), mustChangePassword: true };
}

export function usesEcNoLogin(role: string, employeeId: number | null | undefined): boolean {
  return employeeId != null && ["EMPLOYEE", "SUPERVISOR", "HOD", "DEPT_HEAD", "PM"].includes(role);
}
