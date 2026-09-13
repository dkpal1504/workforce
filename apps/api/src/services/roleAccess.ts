export type CapabilityMap = {
  selectTeam: boolean;
  editTimesheet: boolean;
  viewSummary: boolean;
  approveTimesheets: boolean;
  manageSupervisors: boolean;
  manageMasterData: boolean;
  manageEmployees: boolean;
  uploadEmployees: boolean;
  allocateHours: boolean;
};

export function capabilitiesFor(role: string): CapabilityMap {
  const admin = role === "ADMIN";
  return {
    selectTeam: admin || role === "SUPERVISOR",
    editTimesheet: admin || role === "SUPERVISOR",
    viewSummary: ["EMPLOYEE", "SUPERVISOR", "HOD", "PM", "HR", "FINANCE", "ADMIN"].includes(role),
    approveTimesheets: ["HOD", "PM", "ADMIN"].includes(role),
    manageSupervisors: admin || role === "HR",
    manageMasterData: admin,
    manageEmployees: ["HOD", "PM", "ADMIN", "HR"].includes(role),
    uploadEmployees: admin || role === "HR",
    allocateHours: ["EMPLOYEE", "SUPERVISOR", "HOD", "PM", "HR", "ADMIN"].includes(role),
  };
}

export function landingPathFor(role: string): string {
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
  return ["EMPLOYEE", "SUPERVISOR", "HOD"].includes(role) ? (departmentId ?? -1) : undefined;
}

export const SUMMARY_VISIBLE_STATUSES = ["HOD_APPROVED", "PM_APPROVED", "REJECTED", "FINAL_REJECTED", "PLANNING_RETURNED"] as const;
