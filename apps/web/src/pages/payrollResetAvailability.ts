/**
 * Pure rule for what the Employees (Payroll) tab may say about one row's password.
 *
 * Lives here (not in SupervisorsPage.tsx) because the same wording leaked into two
 * different conditions and produced a wrong diagnosis of a live production database:
 * the action cell rendered the fall-through of a ROLE check as "Login disabled" for an
 * account that was active, and a PM/ADMIN row therefore read
 *   "Signs in with EC No"  <->  "Login disabled"
 * at the same time. The rule is: an account state and a role state are different things
 * and must produce different words.
 */
export type ResetAvailability = "RESETTABLE" | "RESETTABLE_SUPERVISOR" | "ROLE_OWNED" | "INACTIVE" | "NOT_OWNED";

/**
 * Why this row cannot be reset from the payroll tab.
 *
 * Precedence is deliberate: an INACTIVE account is reported as inactive even when its
 * role is also above Employee/Supervisor, because "reactivate it first" is the action the
 * operator needs, whereas "manage from Role Assignment" would send them to a screen that
 * refuses the work outright (planRoleChange answers ACCOUNT_INACTIVE).
 */
export function resetAvailability(accountActive: boolean, role: string): ResetAvailability {
  if (!accountActive) return "INACTIVE";
  if (role === "EMPLOYEE") return "RESETTABLE";
  if (role === "SUPERVISOR") return "RESETTABLE_SUPERVISOR";
  return "ROLE_OWNED";
}

/**
 * Roles whose credential the payroll tab owns are Employee and Supervisor only; this
 * mirrors `payrollPasswordResettable` in the API, which is the enforcement point.
 */
export function availabilityNeedsServerCheck(availability: ResetAvailability): boolean {
  return availability === "RESETTABLE" || availability === "RESETTABLE_SUPERVISOR";
}

/** The sentence an operator reads in the row. Never says "disabled" for an active account. */
export function resetActionLabel(availability: ResetAvailability, role: string): string {
  switch (availability) {
    case "RESETTABLE":
    case "RESETTABLE_SUPERVISOR":
      return "Reset password";
    case "ROLE_OWNED":
      // Named explicitly, because these are the accounts that actually get lost: a payroll
      // Employee promoted to PM/ADMIN can no longer be reset here and Role Assignment does
      // not touch passwords, so the operator must know which screen owns the credential.
      return `Role ${role} — change it on Role Assignment`;
    case "INACTIVE":
      return "Account inactive — reactivate it first";
    default:
      return "Not a payroll login";
  }
}

/** The sub-line under the Sign-in column. Distinct from the action label on purpose. */
export function signInNote(accountActive: boolean, role: string, usesEcNoLogin: boolean): string {
  if (!accountActive) return "Login disabled";
  return usesEcNoLogin ? "Signs in with EC No" : "Signs in with e-mail";
}
