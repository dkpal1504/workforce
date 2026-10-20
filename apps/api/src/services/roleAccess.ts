/**
 * Roles that see an aggregate view of a whole Department.
 *
 * A **Department HOD** is an HOD with no Section scope: it aggregates the hours the
 * Section HODs have already approved across every Section of its Department. An
 * **Department Head** is the same view without approval rights — used where the
 * Department wants oversight but the Section HODs keep the approval decision.
 *
 * A **Section HOD** is the existing behaviour: Department + Section, approving only
 * its own Section's timesheets.
 */
export const DEPARTMENT_VIEW_ROLES = ["HOD", "DEPT_HEAD"] as const;

export function isDepartmentViewRole(role: string): boolean {
  return (DEPARTMENT_VIEW_ROLES as readonly string[]).includes(role);
}

export type CapabilityMap = {
  selectTeam: boolean;
  editTimesheet: boolean;
  viewSummary: boolean;
  approveTimesheets: boolean;
  manageSupervisors: boolean;
  manageMasterData: boolean;
  manageEmployees: boolean;
  uploadEmployees: boolean;
  transferEmployees: boolean;
  allocateHours: boolean;
  /** Assign roles to accounts (Admin only). */
  assignRoles: boolean;
  /** Department-wide approved-hours oversight (Department HOD / Department Head). */
  viewDepartmentSummary: boolean;
  /** Project / WBS / UoM / Network masters and the Job Order CSV upload (PM + Admin). */
  manageJobOrderMaster: boolean;
  /** Punch quantity progress (HOD, Department Head) and approve it (PM, Admin). */
  manageJobOrderProgress: boolean;
  /** Read/refresh the clocked attendance hours (in/out) from LabourWorks (Admin only). */
  manageAttendanceHours: boolean;
  /**
   * READ-ONLY employee listing for a head who does not register people: the whole Department for
   * HOD (both shapes) and Department Head. See services/employeeListScope.ts for why this exists
   * separately from `manageEmployees`.
   */
  viewEmployees: boolean;
  /**
   * The operations dashboard (portfolio burn, attention ranking, exports).
   *
   * Deliberately a capability of its own rather than a widening of `viewSummary` — but it is
   * NOT a "whole organisation" flag, and calling it that was the bug this change fixes:
   * the capability only decides WHO may reach the dashboard; the SCOPE each role then reads
   * is decided server-side by `reportScopeFor`. PM/ADMIN/COO see the whole portfolio; an HOD
   * (either shape) and a DEPT_HEAD see their ONE Department, never another's. A Department
   * mapping is therefore mandatory for the Department-scoped holders and is enforced fail-closed
   * in the report loader, not here.
   */
  viewPortfolioDashboard: boolean;
  /**
   * Assign accounts to Projects (the Project Managers panel). ADMIN only: an assignment IS a
   * read scope over work, so granting it is an administrative act, not an operational one.
   */
  manageProjectManagers: boolean;
  /**
   * Read the Timesheet coverage report (Reports → "Timesheet coverage").
   *
   * A capability of its own because that report's row set is the EMPLOYEE ROSTER — employees x
   * dates — which a project scope cannot define. A PROJECT_MANAGER therefore holds the portfolio
   * dashboard and NOT this: the Reports tab strip hides the tab, and
   * `routes/reports.ts` gates the two coverage endpoints separately so the wider portfolio gate
   * cannot admit it by accident.
   */
  viewTimesheetCoverage: boolean;
  /**
   * The Job Order conversations screen and the header bell.
   *
   * The door only. WHO each thread shows is decided per request by `conversationScopeFor` — an
   * assigned Project Manager sees its projects, an HOD its department and section set, PM/ADMIN/COO
   * everything — so this flag must never be read as "may read every conversation".
   */
  viewConversations: boolean;
};

export function capabilitiesFor(role: string, employmentType: string | null | undefined): CapabilityMap {
  const admin = role === "ADMIN";
  return {
    selectTeam: admin || role === "SUPERVISOR",
    editTimesheet: admin || role === "SUPERVISOR",
    viewSummary: ["EMPLOYEE", "SUPERVISOR", "HOD", "DEPT_HEAD", "PM", "HR", "FINANCE", "ADMIN", "COO"].includes(role),
    approveTimesheets: ["HOD", "PM", "ADMIN"].includes(role),
  // Department Head: department-wide read-only oversight of approved hours.
    manageSupervisors: admin || role === "HR",
    manageMasterData: admin,
    manageEmployees: ["HOD", "PM", "ADMIN", "HR"].includes(role),
    uploadEmployees: admin || role === "HR",
    transferEmployees: admin || role === "PM",
    // My Hours is a PAYROLL screen; see `canUseMyHours` for why the role alone cannot answer it.
    allocateHours: canUseMyHours(role, employmentType),
    assignRoles: admin,
    viewDepartmentSummary: isDepartmentViewRole(role) || admin,
    // Master data for the Job Order hierarchy is owned by the PM team and Admin.
    manageJobOrderMaster: admin || role === "PM",
    // HODs punch the cumulative quantity progress; PMs approve, reject or send it back.
    manageJobOrderProgress: admin || role === "PM" || role === "HOD" || role === "DEPT_HEAD",
    // The clocked (in/out) figure is an audit over every department's submitted
    // sheets, so only Admin may read it or trigger a refresh.
    manageAttendanceHours: admin,
    // A Department Head has the department-wide READ view but no employee registration, so it
    // needs a listing capability of its own; HOD keeps `manageEmployees` (registration form
    // included) and therefore already satisfies this too.
    viewEmployees: admin || role === "HR" || ["HOD", "PM", "DEPT_HEAD"].includes(role),
    // The portfolio dashboard is read by PM, ADMIN and the COO across the whole organisation,
    // and by HOD (either shape) and DEPT_HEAD narrowed to their OWN Department. It is NOT
    // derived from `viewSummary`, which many Department-scoped roles hold. The capability only
    // admits the role to the router; the Department narrowing is applied server-side by
    // `reportScopeFor` in the report loader, so a Section Head still sees every Section of the
    // Department and nothing outside it.
    // PROJECT_MANAGER is admitted here and NARROWED to its assigned projects by `reportScopeFor`;
    // the flag is only the door (see the `viewPortfolioDashboard` note above).
    viewPortfolioDashboard: admin || role === "PM" || role === "COO" || role === "HOD" || role === "DEPT_HEAD" || role === "PROJECT_MANAGER",
    // Assigning a person to a Project is an administrative act; the panel is Admin-only.
    manageProjectManagers: admin,
    // Every existing reader of the Reports screen keeps the coverage report; a project scope does
    // not (see the CapabilityMap note). This list MUST match the coverage routes' own role list.
    viewTimesheetCoverage: admin || role === "PM" || role === "COO" || role === "HOD" || role === "DEPT_HEAD",
    // Same six roles the conversation router admits, and no others.
    viewConversations: admin || role === "PM" || role === "COO" || role === "HOD" || role === "DEPT_HEAD" || role === "PROJECT_MANAGER",
  };
}

/** The roles whose day can be built from recorded hours at all (My Hours or the Timesheet grid). */
const ALLOCATION_ROLES = ["EMPLOYEE", "SUPERVISOR", "HOD", "DEPT_HEAD", "PM", "PROJECT_MANAGER", "HR", "ADMIN"] as const;

/**
 * May this account keep My Hours (self-service hour booking)?
 *
 * PAYROLL employees only. My Hours records a payroll person's own 2-hour slots; a contract
 * worker's hours are tagged FOR him by his Supervisor on the Timesheet page.
 *
 * THE ROLE IS NOT THE TEST. A payroll employee can hold the SUPERVISOR role, so a SUPERVISOR
 * account may legitimately be payroll (and may already hold My Hours days). The employment type
 * decides; the role does not.
 *
 * AN ACCOUNT WITH NO LINKED RECORD IS REFUSED (fail closed): it has no person to record hours
 * for, and the allocation routes require the link anyway, so admitting it would only offer a
 * door the API closes.
 */
export function canUseMyHours(role: string, employmentType: string | null | undefined): boolean {
  if (!(ALLOCATION_ROLES as readonly string[]).includes(role)) return false;
  return employmentType === "PAYROLL";
}

export function landingPathFor(role: string): string {
  // The COO's whole job is the operations dashboard, so that is where the role lands. This must
  // be checked before the `/summary` default below, or a COO would never see its own screen.
  if (role === "COO") return "/portfolio";
  // A Project Manager's whole job is his own projects, so the portfolio IS his landing page.
  if (role === "PROJECT_MANAGER") return "/portfolio";
  if (role === "DEPT_HEAD") return "/summary";
  if (["HOD", "PM", "ADMIN"].includes(role)) return "/approvals";
  if (role === "SUPERVISOR") return "/select-team";
  if (role === "EMPLOYEE") return "/allocations";
  if (role === "HR") return "/employees";
  return "/summary";
}

export function canCreatePayrollEmployee(role: string): boolean {
  return ["HOD", "PM", "ADMIN", "HR"].includes(role);
}

export function departmentScope(role: string, departmentId: number | null): number | undefined {
  // COO is intentionally absent: it reads the WHOLE organisation, so `undefined` (meaning "apply
  // no Department filter") is the correct answer. Adding it to the list below would silently
  // narrow the portfolio to one Department — the opposite of the role's purpose.
  return ["EMPLOYEE", "SUPERVISOR", "HOD", "DEPT_HEAD"].includes(role) ? (departmentId ?? -1) : undefined;
}

/**
 * The whole-Department (or whole-organisation) scope of the operations/portfolio report.
 *
 * WHY A SEPARATE CONCEPT FROM `departmentScope`: they answer different questions. `departmentScope`
 * returns a single scalar used by routes that key on ONE department, where `-1` is an impossible
 * id that matches nothing. The portfolio report also has to distinguish "the whole organisation"
 * from "this Department" from "nothing", because an HOD must see his WHOLE Department (every
 * Section) while PM/ADMIN/COO see everything and a role with no Department must fail closed to
 * NOTHING — never the whole portfolio. Modelling that as three explicit kinds keeps the fail-closed
 * case from being accidentally represented by `undefined` (which means "no filter" = everything).
 *
 *   ORGANISATION — every Department (PM, ADMIN, COO). Unchanged from today.
 *   DEPARTMENT   — exactly `departmentId`, every Section of it (an HOD of either shape, and
 *                  DEPT_HEAD). A Section Head is deliberately NOT narrowed to his Section here:
 *                  the agreed rule for this report is the whole Department.
 *   PROJECTS     — exactly the projects this account MANAGES (PROJECT_MANAGER). A Project spans
 *                  Departments, so this scope is legitimately CROSS-department: it is the only
 *                  kind that is not expressed as a Department at all. `projectIds` is NEVER empty —
 *                  an account assigned to nothing is NONE, so an empty array can never be read as
 *                  "all projects".
 *   NONE         — matches no row. Reached when an HOD/DEPT_HEAD has NO Department mapping, or a
 *                  PROJECT_MANAGER has no active assignment: a report that silently widened to the
 *                  whole portfolio for an unmapped account would be the exact leak this type exists
 *                  to prevent.
 *
 * A non-account role (SUPERVISOR/EMPLOYEE/unknown) resolves to NONE. Those roles are refused at
 * the router, so this is the second, independent lock: even a caller that reached the loader
 * directly would read nothing rather than the organisation.
 */
export type ReportScope =
  | { kind: "ORGANISATION" }
  | { kind: "DEPARTMENT"; departmentId: number }
  | { kind: "PROJECTS"; projectIds: readonly number[] }
  | { kind: "NONE" };

/**
 * The scope an actor's report is ACTUALLY limited to.
 *
 * `assignedProjectIds` is read from `project_manager_assignments` by the caller and is consulted
 * ONLY for PROJECT_MANAGER. That role-gating is deliberate: an assignment row accidentally attached
 * to another account must be inert, so it can neither narrow nor widen that role's report.
 *
 * FAIL CLOSED, in both directions: a Project Manager with no assignment is NONE (zero rows, with an
 * explicit sentence on screen), never the organisation and never a Department fallback.
 */
export function reportScopeFor(
  role: string,
  departmentId: number | null,
  assignedProjectIds: readonly number[] | null = null
): ReportScope {
  // The organisation-wide readers, exactly the non-Department-scoped holders of
  // `viewPortfolioDashboard`.
  if (role === "PM" || role === "ADMIN" || role === "COO") return { kind: "ORGANISATION" };
  // A Project Manager reads exactly the projects he manages. Deduplicated, positive, sorted, so the
  // provenance line and the filters hash do not change when the same set arrives in another order.
  if (role === "PROJECT_MANAGER") {
    const projectIds = [...new Set(assignedProjectIds ?? [])]
      .filter((id) => Number.isInteger(id) && id > 0)
      .sort((a, b) => a - b);
    return projectIds.length ? { kind: "PROJECTS", projectIds } : { kind: "NONE" };
  }
  // A Department-scoped head: HOD (both shapes) and DEPT_HEAD read their whole Department. The
  // Section is intentionally not consulted — a section-narrowed account and a department-wide
  // account behave identically on this report.
  if (isDepartmentViewRole(role)) {
    // FAIL CLOSED. `departmentId == null` (a head with no mapping) must NOT become ORGANISATION
    // and must NOT become DEPARTMENT-with-some-sentinel — it is NONE, an explicit zero-row scope.
    // See the loader: the impossible `{ id: -1 }` filter (the `hodEmployeeScopeSet` idiom) is what
    // makes this real at the query, because Prisma treats an EMPTY `{}` where as EVERY row.
    return departmentId == null ? { kind: "NONE" } : { kind: "DEPARTMENT", departmentId };
  }
  return { kind: "NONE" };
}

/**
 * The Department filter to apply to the Job Order query, given the actor's own scope and the
 * Department ids the REQUEST asked for.
 *
 * THE CORE RULE — INTERSECT, NEVER TRUST. A request must never widen the actor's scope. An HOD
 * whose own Department is 4, asking for `departmentIds=9`, must receive Department 4 data, not
 * Department 9: the requested ids narrow WITHIN the actor's scope but can never add to it. So the
 * result is the intersection `actor ∩ requested`, and for an ORGANISATION actor the intersection
 * is just the request.
 *
 * WHY THIS RETURNS `number[] | null` RATHER THAN A MERELY-SMALLER-OR-SAME SET:
 *   `null`   — no Department filter at all (an organisation actor with no request, or a request
 *              that selected every Department).
 *   `[]`     — an EMPTY intersection: the request is disjoint from the actor's scope. This is a
 *              real, honest answer meaning "nothing matches", and the loader must translate it
 *              into `{ in: [] }`. It must NOT fall back to the actor's own Department: silently
 *              substituting Department 4 when 9 was asked for produces a report that ignores the
 *              filter it was given, which is worse than an empty one. See the loader comment.
 *   NONE     — the actor has no scope at all; the caller applies `{ id: -1 }` / `{ in: [] }`.
 */
export function intersectDepartmentFilter(
  scope: ReportScope,
  requested: number[] | null
): number[] | null {
  if (scope.kind === "ORGANISATION") return requested;
  if (scope.kind === "NONE") return [];
  // A PROJECTS scope says nothing about Departments: a project spans them, so it must never narrow
  // this dimension. The Project predicate is what bounds that actor (see `intersectProjectFilter`).
  if (scope.kind === "PROJECTS") return requested;
  // DEPARTMENT: keep only the requested ids that ARE the actor's Department. No request -> the
  // actor's Department alone. An empty result is the honest "disjoint" case (an EMPTY array, never
  // a substituted Department).
  if (requested == null) return [scope.departmentId];
  return requested.filter((id) => id === scope.departmentId);
}

/**
 * The Project filter to apply to the Job Order query, given the actor's scope and the project ids
 * the REQUEST asked for.
 *
 * The same contract as `intersectDepartmentFilter`, for the same reason — INTERSECT, NEVER TRUST:
 *
 *   null  — no Project predicate at all (an organisation actor with no request).
 *   []    — an EMPTY intersection: the request is disjoint from the actor's assignment. This is a
 *           real, honest answer meaning "nothing matches", and the loader must turn it into
 *           `{ in: [] }`. It must NOT fall back to the assigned set: a report that silently ignores
 *           the filter it was handed is worse than an empty one, because the reader believes a
 *           filter was applied.
 *   ids   — those projects.
 *
 * A DEPARTMENT scope says nothing about projects (a Department spans projects and a project spans
 * Departments), so the request flows through untouched; the Department predicate is what enforces
 * that actor's bound. A NONE scope always matches nothing.
 */
export function intersectProjectFilter(
  scope: ReportScope,
  requested: number[] | null
): number[] | null {
  if (scope.kind === "NONE") return [];
  if (scope.kind === "PROJECTS") {
    if (requested == null) return [...scope.projectIds];
    return requested.filter((id) => scope.projectIds.includes(id));
  }
  return requested;
}

export const SUMMARY_VISIBLE_STATUSES = ["HOD_APPROVED", "PM_APPROVED", "REJECTED", "FINAL_REJECTED", "PLANNING_RETURNED"] as const;

/**
 * Can this approver act on a resource, given a SET of sections?
 *
 *   departmentId set, sections EMPTY      -> whole Department (unchanged: was `sectionId == null`)
 *   departmentId set, sections non-empty  -> exactly those Sections
 *   departmentId null                     -> nothing
 *
 * The Department gate comes FIRST and is absolute: a Section from another Department can never
 * match, even if a stale row existed. Callers must uphold the same-department rule when WRITING a
 * scope (see `validateScopeSections`); this function is the read-side rule.
 */
export function hodScopeMatchesSet(
  actorDepartmentId: number | null,
  actorSectionIds: readonly number[],
  resourceDepartmentId: number,
  resourceSectionId: number | null
): boolean {
  if (actorDepartmentId == null) return false;
  if (actorDepartmentId !== resourceDepartmentId) return false;
  // An empty set means the WHOLE Department — the single-Department Section Head case.
  if (actorSectionIds.length === 0) return true;
  return resourceSectionId != null && actorSectionIds.includes(resourceSectionId);
}

/**
 * The Prisma `employee` filter for an approver's scope.
 *
 * Replaces the two duplicated `hodEmployeeScope` copies (routes/approvals.ts and
 * routes/employeeAllocation.ts). Note the two shapes are NOT interchangeable:
 *   EMPTY set  -> `{ departmentId }`                     — no Section filter at all (every Section)
 *   NON-empty  -> `{ departmentId, sectionAssignment }`  — narrows to those Sections
 * Swapping them either hides rows or leaks every Section of the Department.
 */
export function hodEmployeeScopeSet(departmentId: number | null, actorSectionIds: readonly number[]) {
  if (departmentId == null) return { id: -1 };
  if (actorSectionIds.length === 0) return { departmentId };
  return { departmentId, sectionAssignment: { sectionId: { in: [...actorSectionIds] } } };
}

/**
 * Can this approver act on a resource in the given Department/Section?
 *
 *   Section HOD (Department + Section)  -> must match BOTH.
 *   Department HOD (Department, no Section) -> matches the whole Department.
 *
 * Legacy single-section form, kept so un-converted callers keep their exact behaviour while the
 * call sites move to `hodScopeMatchesSet`.
 */
export function hodScopeMatches(
  actorDepartmentId: number | null,
  actorSectionId: number | null,
  resourceDepartmentId: number,
  resourceSectionId: number | null
): boolean {
  return hodScopeMatchesSet(
    actorDepartmentId,
    actorSectionId == null ? [] : [actorSectionId],
    resourceDepartmentId,
    resourceSectionId
  );
}

export function effectiveOrganisation(
  sourceDepartmentId: number,
  sourceSectionId: number | null,
  override: { departmentId: number; sectionId: number } | null
) {
  return override
    ? { departmentId: override.departmentId, sectionId: override.sectionId, overridden: true }
    : { departmentId: sourceDepartmentId, sectionId: sourceSectionId, overridden: false };
}
