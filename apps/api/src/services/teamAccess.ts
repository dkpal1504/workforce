/**
 * THE TIMESHEET TEAM GUARD, as arithmetic.
 *
 * `PUT /timesheet/day` (and the OT / entry / submit routes) authorise a save by asking
 * "may this supervisor act on every employee in this payload?". The route can only answer
 * that against a database, so the arithmetic lives here where it can be tested — the guard's
 * earlier count-based form shipped a bug that no test could reach while it sat in a route.
 *
 * Two authorisation paths:
 *
 *  - THE SELF PATH. A supervisor's OWN Employee row is authorised without any team row.
 *    Team membership cannot describe it: his own record carries no `daily_team_selection`
 *    entry (he is not on his own team) and the CLMS requirement does not apply to him.
 *    It is checked directly instead: his row must be in this Department and ACTIVE.
 *
 *  - THE TEAM PATH. Everybody else must be authorised by ONE of two records:
 *
 *      1. a LIVE team row for this exact date — he picked this person for this day; or
 *      2. an EXISTING TimesheetDay on this very sheet — (employeeId, workDate, taggedById).
 *
 *    The second is THE SHEET'S OWN RECORD OF PREVIOUS AUTHORISATION. A row can only be
 *    there because the guard admitted it when the sheet was first saved, so re-deriving
 *    permission from today's team list lets any later change to the org data strand a day
 *    that a Section HOD has already sent back for correction: the correction could never be
 *    saved again, and the supervisor would be told his labour "must be assigned to your team"
 *    about an employee visibly sitting on his own sheet. Reading the sheet back widens
 *    nothing — an employee who is neither on this sheet nor in today's team is still refused.
 *
 * WHY SET MEMBERSHIP, NOT A COUNT: the previous form compared the number of matching team
 * rows against the number of ids. Counts cannot say WHICH employee matched, so one employee
 * holding both a team row and a day row could satisfy the count for a colleague holding
 * neither. Membership cannot be fooled that way, and it is the only form that can express
 * two independent sources of authorisation.
 */
export function teamAccessSatisfied(input: {
  /** The Employee row behind the sheet owner's login; null when the account has none. */
  ownEmployeeId: number | null;
  /** Every employee id in the payload, duplicates and all. */
  employeeIds: readonly number[];
  /** Did the self path's own check pass (in this Department and active)? Ignored when he is not in the payload. */
  ownMatched: boolean;
  /**
   * The ids the TEAM path authorises: live team rows for this date, UNIONED with the employees
   * already recorded on this sheet for this date. Only the non-self ids are looked for here.
   */
  authorisedTeamIds: readonly number[];
}): boolean {
  const ids = [...new Set(input.employeeIds)];
  if (ids.length === 0) return false;

  const { ownEmployeeId } = input;
  const selfIds = ownEmployeeId == null ? [] : ids.filter((id) => id === ownEmployeeId);
  const teamIds = ids.filter((id) => id !== ownEmployeeId);

  // The self row, when present, stands or falls on its own check.
  if (selfIds.length && !input.ownMatched) return false;
  // Nobody but himself: the team path is not consulted.
  if (!teamIds.length) return true;

  const authorised = new Set(input.authorisedTeamIds);
  return teamIds.every((id) => authorised.has(id));
}

/**
 * WHO MAY BE PUT ON A SUPERVISOR'S DAY ROSTER — the one rule, in one place.
 *
 * It is deliberately the same set the team path above accepts for a team row: ACTIVE
 * contract labour (CLMS) in the supervisor's OWN Department. A Section mapping is NOT
 * part of it. A Section is how the sheet is later ROUTED to an HOD; it is not what makes
 * a man bookable, and the guard never looked at it.
 *
 * The roster/pool queries used to add `sectionAssignment: { section: { departmentId,
 * active: true } }` on top, which made the roster STRICTER than the guard. The failure mode
 * was invisible: a man whose Section was missing, foreign or switched off never appeared in
 * Select Team and was silently dropped by "Select from Previous Day" (a bare `continue` in
 * the copy loop), while the Daily Timesheet's own picker kept offering him — so a supervisor
 * could fill a whole sheet from the picker and only discover the disagreement when the save
 * was refused with a message about Sections.
 *
 * Callers must use this fragment (or `rosterRefusal` for reporting) rather than hand-writing
 * the condition, so the roster, the pool, the carry-over and the guard cannot drift apart
 * again.
 */
export function rosterEmployeeWhere(departmentId: number): import("@prisma/client").Prisma.EmployeeWhereInput {
  return { active: true, departmentId, employmentType: "CLMS" };
}

/** Why a person cannot be put on this supervisor's roster. Null = he can. */
export type RosterRefusal = "INACTIVE" | "OTHER_DEPARTMENT" | "NOT_CLMS";

export function rosterRefusal(
  employee: { active: boolean; departmentId: number | null; employmentType: string },
  departmentId: number
): RosterRefusal | null {
  if (!employee.active) return "INACTIVE";
  if (employee.departmentId !== departmentId) return "OTHER_DEPARTMENT";
  if (employee.employmentType !== "CLMS") return "NOT_CLMS";
  return null;
}

/** Operator-facing wording. Says what to DO, not what the rule is called. */
export const ROSTER_REFUSAL_TEXT: Record<RosterRefusal, string> = {
  INACTIVE: "no longer active",
  OTHER_DEPARTMENT: "in another Department",
  NOT_CLMS: "not contract labour (CLMS)",
};
