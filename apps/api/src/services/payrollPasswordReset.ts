/**
 * Pure rules for the Admin/HR payroll-employee password reset.
 *
 * Kept out of the router so the two decisions that are easy to get wrong can be tested
 * without a database:
 *  - which account roles a reset may target, and
 *  - which identifier a person actually signs in with, so the screen never names an
 *    identifier that cannot log in (an ecNo-login role shows the EC No; an administrative
 *    role shows its e-mail).
 */

/** Roles that sign in with their EC No once a payroll Employee is linked (usesEcNoLogin). */
export const EC_NO_LOGIN_ROLES = ["EMPLOYEE", "SUPERVISOR", "HOD", "DEPT_HEAD", "PM"] as const;

/**
 * A reset targets a person's own payroll login. SUPERVISOR is included because a
 * Supervisor IS a payroll Employee; everything above it (HOD / DEPT_HEAD / PM / HR /
 * FINANCE / ADMIN) has its own lever — Role Assignment re-provisions those accounts.
 */
export function payrollPasswordResettable(role: string): boolean {
  return role === "EMPLOYEE" || role === "SUPERVISOR";
}

/** The identifier to show for `role`, given the linked employee's ecNo and login e-mail. */
export function loginIdentifierFor(role: string, ecNo: string | null | undefined, email: string | null | undefined): string {
  return (EC_NO_LOGIN_ROLES as readonly string[]).includes(role) ? String(ecNo ?? "") : String(email ?? "");
}

/** The label a reset confirmation shows for a role, e.g. "Employee (EC No login)". */
export function resetTargetLabel(role: string): string {
  if (role === "SUPERVISOR") return "Supervisor";
  if (role === "EMPLOYEE") return "Employee";
  return role;
}
