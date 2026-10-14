import { Prisma } from "@prisma/client";

/*
 * WHICH SECTION HEAD RECEIVES A SUBMITTED TIMESHEET.
 *
 * ============================= THE RULE =============================
 * A submitted sheet is routed by the SECTION OF THE SUPERVISOR WHO TAGGED IT, not by the Section of
 * the person whose hours are on it. A Supervisor may build his team from ANY Section of his own
 * Department (that is what `GET /teams/pool` offers him), so the sheet he raises for another
 * Section's labour used to land in that other Section's queue and be invisible to the head of the
 * Section the Supervisor himself is tagged to. It now goes to HIS Section Head: a Supervisor in
 * `Steel` with a team drawn from `Hull and Outfitting` submits to the Steel Section Head.
 *
 * The Supervisor's Section is his EMPLOYEE mapping (`EmployeeSectionAssignment`) — the same mapping
 * the app shows him as his own Section and defaults the Select Team filter to. The account-level
 * `User.sectionId` mirror is deliberately NOT consulted: it is not maintained for a SUPERVISOR
 * account (registrations and the sync both write `departmentId` only), so a value left behind by an
 * earlier role would silently misroute his sheets to a Section he does not belong to.
 *
 * ============================ THE FALLBACK ===========================
 * A sheet can be tagged by an account with NO Section of its own — an Admin editing a sheet (Admin
 * holds `editTimesheet`), or a login whose Employee carries no Section assignment. Such a sheet must
 * NOT fall out of every queue, because then nobody could ever approve it. It keeps the previous
 * behaviour exactly: the EMPLOYEE's Section decides. The two branches are mutually exclusive by
 * construction (one requires the tagger's Section to exist, the other requires it to be absent), so
 * a sheet is never routed by both.
 *
 * ======================= ONE DEFINITION, FIVE READERS =================
 * This fragment is the ONLY implementation of the rule. It is consumed by the HOD approval queue (the
 * received list and the Planning-returned list), the history listing, the decision paths
 * (approve / reject / send-back / batch), the Job Order consumption lens, and the `pendingApprovals`
 * blocker that guards a role change in the Admin panel. A queue and its guard drifting apart is the
 * failure this module exists to prevent — never recompute this filter by hand in a route.
 *
 * WHY A PRISMA FRAGMENT RATHER THAN A PREDICATE OVER LOADED ROWS: these readers narrow in SQL today,
 * and several of them page in SQL (`take: 200` on the history listing). Moving the rule into JS would
 * silently change what a page means — the newest 200 rows of the DEPARTMENT, filtered afterwards,
 * instead of the newest 200 rows that belong to this approver.
 *
 * NOTE ON THE DEPARTMENT: a Section belongs to exactly one Department and an HOD's Section scope is
 * validated to be its own Department's (`validateScopeSections`), so matching on Section ids carries
 * the Department with it. The Department only has to be stated for the DEPARTMENT-WIDE scope, where
 * there is no Section to compare.
 */

/**
 * Days whose ROUTING Section is one of `sectionIds` (see the module doc for what "routing Section"
 * means).
 *
 * An EMPTY set is NOT "every Section": Prisma reads an empty `where` as every row, which is the
 * opposite of the intent, so an empty set matches nothing and the caller states the department-wide
 * case explicitly (`hodRoutingScope`). Returning a match-nothing fragment rather than widening keeps
 * a wrong call from leaking the whole organisation.
 */
export function routingSectionScope(sectionIds: readonly number[]): Prisma.TimesheetDayWhereInput {
  const sections = [...sectionIds];
  if (sections.length === 0) return { id: -1 };
  return {
    OR: [
      // 1. THE RULE: the Section of the Supervisor who tagged the sheet.
      { taggedBy: { employee: { sectionAssignment: { sectionId: { in: sections } } } } },
      // 2. THE FALLBACK: the tagger has no Section of his own, so the EMPLOYEE's Section decides —
      //    unchanged from before this rule. A tagger either has a Section assignment or does not, so
      //    branches 1 and 2 can never both fire for one sheet.
      {
        employee: { sectionAssignment: { sectionId: { in: sections } } },
        taggedBy: { OR: [{ employee: null }, { employee: { sectionAssignment: null } }] },
      },
    ],
  };
}

/**
 * The whole routing scope of an approver: the days whose Section Head is this account.
 *
 *   departmentId set, sections EMPTY      -> every sheet routed to this Department (no Section to
 *                                            compare, so the tagger's OR the employee's Department)
 *   departmentId set, sections non-empty  -> exactly those routing Sections
 *   departmentId null                     -> nothing (fail closed; an unmapped head routes no work)
 */
export function hodRoutingScope(
  departmentId: number | null,
  actorSectionIds: readonly number[]
): Prisma.TimesheetDayWhereInput {
  if (departmentId == null) return { id: -1 };
  if (actorSectionIds.length === 0) {
    return {
      OR: [
        { employee: { departmentId } },
        { taggedBy: { departmentId } },
        { taggedBy: { employee: { departmentId } } },
      ],
    };
  }
  return routingSectionScope(actorSectionIds);
}
