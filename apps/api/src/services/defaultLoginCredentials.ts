import crypto from "crypto";
import bcrypt from "bcryptjs";

/**
 * LOCAL DEV BOOTSTRAP PASSWORD — DO NOT SHIP.
 *
 * While the application is still being built and tested on the development box,
 * every account created from the web UI (Employee Registration, Supervisor
 * Registration, HOD registration/promotion, admin user creation and
 * re-activation) is provisioned with this one known password so the account can
 * be logged into immediately, without waiting for a credential e-mail.
 *
 * SET THIS TO null TO REMOVE IT: nothing else needs editing. All call sites route
 * through `initialCredentialState()`, which falls back to a random, undelivered
 * credential (the production behaviour) as soon as this is null.
 * `apps/api/scripts/check-no-dev-bootstrap-password.mjs` fails the production
 * build while a literal password is still assigned here, and
 * `assertDevBootstrapAllowed()` refuses to boot against PostgreSQL, so a
 * forgotten removal breaks the deploy loudly instead of silently shipping a
 * shared password to every new employee.
 */
export const DEV_BOOTSTRAP_PASSWORD: string | null = "password@SDHI";

/** True while the local dev bootstrap password above is in force. */
export function usesDevBootstrapPassword(): boolean {
  return DEV_BOOTSTRAP_PASSWORD !== null;
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

export function isLocalTestDatabase(): boolean {
  return String(process.env.DATABASE_URL || "").startsWith("file:");
}

/**
 * Fail closed: the shared bootstrap password exists only so the dev SQLite box
 * can be used without a credential e-mail. Refuse to hand it out against a
 * PostgreSQL database (i.e. production), whatever NODE_ENV claims. No-op once
 * DEV_BOOTSTRAP_PASSWORD is null.
 */
export function assertDevBootstrapAllowed(): void {
  if (!usesDevBootstrapPassword()) return;
  if (!isLocalTestDatabase()) {
    throw new Error(
      "The local dev bootstrap password is enabled but DATABASE_URL is not a file: SQLite database. " +
        "Set DEV_BOOTSTRAP_PASSWORD to null in services/defaultLoginCredentials.ts before deploying.",
    );
  }
}

/**
 * Credentials for a newly provisioned account. Pre-production this is the fixed
 * bootstrap password, so a freshly registered person can log in straight away and
 * is not forced through a password change; set DEV_BOOTSTRAP_PASSWORD to null and
 * this reverts to the random, e-mail-delivered one-time credential.
 */
export async function initialCredentialState(): Promise<InitialCredential> {
  if (!usesDevBootstrapPassword()) {
    return { passwordHash: await hashDefaultWorkforcePassword(), mustChangePassword: true };
  }
  assertDevBootstrapAllowed();
  return { passwordHash: await bcrypt.hash(DEV_BOOTSTRAP_PASSWORD!, 10), mustChangePassword: false };
}

export function usesEcNoLogin(role: string, employeeId: number | null | undefined): boolean {
  return employeeId != null && ["EMPLOYEE", "SUPERVISOR", "HOD", "DEPT_HEAD", "PM"].includes(role);
}
