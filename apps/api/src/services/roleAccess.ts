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
   * The organisation-wide operations dashboard (portfolio burn, attention ranking, exports).
   *
   * Deliberately a capability of its own rather than a widening of `viewSummary`: the dashboard
   * crosses every Department, so it must never be reachable by a Department-scoped reader. It is
   * granted to PM, ADMIN and the COO — the three roles that are already organisation-wide.
   */
  viewPortfolioDashboard: boolean;
};

export function capabilitiesFor(role: string): CapabilityMap {
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
    allocateHours: ["EMPLOYEE", "SUPERVISOR", "HOD", "DEPT_HEAD", "PM", "HR", "ADMIN"].includes(role),
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
    // The portfolio dashboard crosses every Department, so it is limited to the roles that are
    // already organisation-wide: PM, ADMIN and the COO. It is NOT derived from `viewSummary`,
    // which many Department-scoped roles hold — widening that would hand a Section HOD the whole
    // portfolio. The COO is a read-only role, so this is the ONLY capability it holds beyond
    // `viewSummary`.
    viewPortfolioDashboard: admin || role === "PM" || role === "COO",
  };
}

export function landingPathFor(role: string): string {
  // The COO's whole job is the operations dashboard, so that is where the role lands. This must
  // be checked before the `/summary` default below, or a COO would never see its own screen.
  if (role === "COO") return "/portfolio";
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
