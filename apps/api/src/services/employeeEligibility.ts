type EmployeeLifecycle = {
  active: boolean;
  terminatedAt: Date | null;
};

type DraftLifecycle = {
  status: string;
  createdAt: Date;
};

/** A draft created before termination may be submitted once, but never edited. */
export function canSubmitRetainedDraft(
  employee: EmployeeLifecycle,
  day: DraftLifecycle | null | undefined
): boolean {
  return Boolean(
    !employee.active &&
      employee.terminatedAt &&
      day &&
      day.status === "DRAFT" &&
      day.createdAt.getTime() <= employee.terminatedAt.getTime()
  );
}

export function inactiveEmployeePayload() {
  return {
    error: "Employee is inactive; this record is read-only.",
    code: "EMPLOYEE_INACTIVE",
  };
}

export function rejectionStatusForEmployee(active: boolean, activeStatus = "REJECTED"): string {
  return active ? activeStatus : "FINAL_REJECTED";
}
