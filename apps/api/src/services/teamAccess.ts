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
