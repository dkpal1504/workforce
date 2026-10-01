/**
 * Who owns a Supervisor account's `active` flag, and what that means for the LabourWorks sync.
 *
 * WHY THIS MODULE EXISTS
 *   A supervisor login is created by one of three paths, and until now the LabourWorks sync
 *   treated only the first as its own:
 *     - the sync itself creates the account (`User.source = SYNC`);
 *     - an Admin grants the SUPERVISOR role from Role Assignment to an Employee that has no
 *       account yet (`User.source = MANUAL`, `createAccountForEmployee` in routes/admin.ts);
 *     - a payroll Employee is registered in this app and later promoted (`MANUAL` / `PAYROLL`).
 *
 *   The sync's supervisor lifecycle was gated on the SOURCE'S JOB TITLE:
 *       effectiveSupervisor = NatureOfWork === "Supervisor" || a live SupervisorOverride
 *   A blue-collar worker's NatureOfWork is their TRADE. So for anyone this app promoted, it
 *   reads "Office Assistant" / "Technician" / "Welder" and the predicate is false on EVERY run.
 *   The re-enable branch (badgeViewSync.ts, `else if (effectiveSupervisor)`) therefore never
 *   ran, while the withdrawal branch needed only `role === "SUPERVISOR"` and ran on every tick.
 *
 *   Net effect, and the reported bug: Role Assignment could create a supervisor login that the
 *   sync was GUARANTEED to disable and could NEVER bring back. The account went Disabled within
 *   one tick of being created and stayed there while the person remained active in LabourWorks
 *   with a team whose timesheets they must file. No sync run, override or repair changed the
 *   outcome, because the source's job title is the sole authority and it does not say Supervisor.
 *
 *   The rule is now about OWNERSHIP, not job titles: `User.source` says who provisioned the
 *   account. A `SYNC` account belongs to LabourWorks and is still mirrored exactly as before —
 *   including the "supervisor eligibility removed" withdrawal. An account THIS APP created
 *   belongs to this app: the sync still mirrors the EMPLOYEE (identity, organisation, and
 *   active/terminated) but never withdraws the app's own role grant, and it re-opens the login
 *   when it finds one closed for a person LabourWorks still lists as active.
 *
 *   TERMINATION IS NOT WEAKENED. `employee.active = false` (the source says IsTerminated) and
 *   the absence sweep both still disable an account regardless of its source; those are checked
 *   before this module is consulted. What is refused is only the reverse inference — "LabourWorks
 *   does not call this person a Supervisor" is not evidence that they are not one here.
 *
 * Pure on purpose: no database, no environment, so the decision that caused the bug is
 * unit-tested directly instead of being inferred from a whole sync run.
 */

export const SUPERVISOR_ROLE = "SUPERVISOR";

/** The stored source of a User/Employee row, normalised for comparison. */
export function accountSourceOf(source: string | null | undefined): string {
  return String(source ?? "").trim().toUpperCase();
}

/**
 * True when the account was provisioned by this application (Role Assignment, payroll
 * registration, supervisor registration, CSV import), so the app owns its `active` flag.
 *
 * `SYNC` is the only source LabourWorks owns. Anything else — including a null or an
 * unexpected value — counts as app-owned, because the alternative (treating an unknown
 * source as sync-owned) is exactly what disables an account nobody can re-enable.
 */
export function isAppOwnedAccount(source: string | null | undefined): boolean {
  return accountSourceOf(source) !== "SYNC";
}

/** Does the sync get to change this account's `active` flag for supervisor-roster reasons? */
export function syncOwnsSupervisorRoster(source: string | null | undefined): boolean {
  return !isAppOwnedAccount(source);
}

export type SupervisorLifecycleContext = {
  /** `User.source` — who provisioned the account. */
  accountSource: string | null | undefined;
  /** `Employee.active` as the sync just wrote it (`true` = on the rolls in LabourWorks). */
  employeeActive: boolean;
  /** `User.active` as currently stored. */
  accountActive: boolean;
  /** `User.role`. */
  role: string;
};

/**
 * Should the sync CLOSE this login purely because the source row does not describe the person
 * as a supervisor?
 *
 * Only for a LabourWorks-owned (`SYNC`) account. For an account this app created, the role
 * grant is the app's decision and re-deciding it from `NatureOfWork` on every tick is the bug.
 */
export function shouldWithdrawSupervisorRole(context: SupervisorLifecycleContext): boolean {
  if (!context.employeeActive) return false;
  if (!syncOwnsSupervisorRoster(context.accountSource)) return false;
  return context.role === SUPERVISOR_ROLE && context.accountActive;
}

/**
 * Should the sync RE-OPEN this login?
 *
 * `employeeActive` means LabourWorks still has them on the rolls (they are in the validated
 * snapshot and not terminated). An app-owned supervisor login that is closed while the person
 * is active is the stuck state this module exists to prevent, and the sync is the only thing
 * that runs on a schedule — so it converges the flag instead of leaving the account to a
 * manual click, and it heals accounts already stuck from before this fix.
 */
export function shouldReopenSupervisorAccount(context: SupervisorLifecycleContext): boolean {
  if (!context.employeeActive) return false;
  if (!isAppOwnedAccount(context.accountSource)) return false;
  return context.role === SUPERVISOR_ROLE && !context.accountActive;
}

/**
 * The single decision the sync consults, so the route layer and the sync cannot disagree about
 * who owns an account. Returns whether `active` must change, to what, and the reason to record.
 */
export function supervisorAccountTransition(
  context: SupervisorLifecycleContext
): { change: false } | { change: true; active: boolean; reason: string } {
  if (shouldWithdrawSupervisorRole(context)) {
    return { change: true, active: false, reason: "Supervisor eligibility removed." };
  }
  if (shouldReopenSupervisorAccount(context)) {
    return { change: true, active: true, reason: "Account re-opened: employee is active in the source." };
  }
  return { change: false };
}
