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
};

export function capabilitiesFor(role: string): CapabilityMap {
  const admin = role === "ADMIN";
  return {
    selectTeam: admin || role === "SUPERVISOR",
    editTimesheet: admin || role === "SUPERVISOR",
    viewSummary: ["EMPLOYEE", "SUPERVISOR", "HOD", "DEPT_HEAD", "PM", "HR", "FINANCE", "ADMIN"].includes(role),
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
  };
}

export function landingPathFor(role: string): string {
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
  return ["EMPLOYEE", "SUPERVISOR", "HOD", "DEPT_HEAD"].includes(role) ? (departmentId ?? -1) : undefined;
}

export const SUMMARY_VISIBLE_STATUSES = ["HOD_APPROVED", "PM_APPROVED", "REJECTED", "FINAL_REJECTED", "PLANNING_RETURNED"] as const;

/**
 * Can this approver act on a resource in the given Department/Section?
 *
 *   Section HOD (Department + Section)  -> must match BOTH.
 *   Department HOD (Department, no Section) -> matches the whole Department.
 *
 * The Department-wide branch is what lets a Department HOD see and (where the role
 * allows) action every Section under its Department. A Department HOD still cannot
 * reach another Department, and an approver with no Department at all matches nothing.
 */
export function hodScopeMatches(
  actorDepartmentId: number | null,
  actorSectionId: number | null,
  resourceDepartmentId: number,
  resourceSectionId: number | null
): boolean {
  if (actorDepartmentId == null) return false;
  if (actorDepartmentId !== resourceDepartmentId) return false;
  if (actorSectionId == null) return true; // Department-level approver
  return actorSectionId === resourceSectionId;
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
