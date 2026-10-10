/**
 * THE TIMESHEET TEAM GUARD, as arithmetic.
 *
 * `PUT /timesheet/day` (and the OT / entry / submit routes) authorise a save by asking
 * "is every employee in this payload still mine for this date?". That question is a
 * comparison of COUNTS, and the route can only run it against a database. Splitting the
 * arithmetic out makes it testable — this function is where the guard's one off-by-design
 * bug lived, and no test could see it while it sat inside a route.
 *
 * Two authorisation paths:
 *
 *  - THE SELF PATH. A supervisor's OWN Employee row is authorised without any team row.
 *    Team membership cannot describe it: his own record carries no `daily_team_selection`
 *    entry (he is not on his own team), and the CLMS requirement does not apply to him.
 *    It is instead checked directly: his row must be in this Department and ACTIVE.
 *
 *  - THE TEAM PATH. Everybody else must have a live team row for this exact date, and be
 *    CLMS in this Department.
 *
 * THE BUG THIS SHAPE PREVENTS: the team count must be measured against `teamIds.length`,
 * never against the whole payload. There can never be a team row for the self id, so
 * comparing against the full length made any save that carried the supervisor's own row
 * together with a colleague UNSATISFIABLE — false by construction, refusing the save with
 * "Labour must be assigned to your team from a Section in your Department".
 */
export function teamAccessSatisfied(input: {
  /** The Employee row behind the sheet owner's login; null when the account has none. */
  ownEmployeeId: number | null;
  /** Every employee id in the payload, duplicates and all. */
  employeeIds: readonly number[];
  /** Did the self path's own check pass? (in this Department and active). Ignored if he is not in the payload. */
  ownMatched: boolean;
  /** How many live team rows matched — measured against the TEAM ids only. */
  teamMatchedCount: number;
}): boolean {
  const ids = [...new Set(input.employeeIds)];
  if (ids.length === 0) return false;

  const { ownEmployeeId } = input;
  const selfIds = ownEmployeeId == null ? [] : ids.filter((id) => id === ownEmployeeId);
  const teamIds = ids.filter((id) => id !== ownEmployeeId);

  // The self row, when present, stands or falls on its own check.
  if (selfIds.length && !input.ownMatched) return false;
  // Nobody but himself: the team count is irrelevant.
  if (!teamIds.length) return true;

  return input.teamMatchedCount === teamIds.length;
}
