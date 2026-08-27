/** Edit rules after HOD / Project Head approval. */

export const APPROVED_STATUSES = ["HOD_APPROVED", "PM_APPROVED"] as const;
export type ApprovedStatus = (typeof APPROVED_STATUSES)[number];

/**
 * Statuses that are hard-locked: once a supervisor submits, or HOD/PM approve,
 * the day can no longer be edited (unless rejected/returned, which unlocks it).
 * SUBMITTED is the supervisor's submit cutoff — the user requirement is that
 * assign/unassign is allowed only UNTIL submission.
 */
export const LOCKED_STATUSES = ["SUBMITTED", "HOD_APPROVED", "PM_APPROVED"] as const;
export type LockedStatus = (typeof LOCKED_STATUSES)[number];

export type EditMode = "full" | "addOnly" | "locked";

export type EditLockInfo = {
  editMode: EditMode;
  approvedAt: string | null;
  lockExpiresAt: string | null;
};

const MS_24H = 24 * 60 * 60 * 1000;

export function isApprovedStatus(status: string): status is ApprovedStatus {
  return (APPROVED_STATUSES as readonly string[]).includes(status);
}

export function isProtectedEntryStatus(status: string): boolean {
  return isApprovedStatus(status);
}

/**
 * 24h window starts at the latest APPROVE action for this timesheet day
 * (HOD approve for HOD_APPROVED, PM approve for PM_APPROVED).
 *
 * REJECTED days that still have previously approved entry slots stay in
 * addOnly mode so supervisors can fix/resubmit new hours without touching
 * already-approved slots.
 */
export function resolveEditLock(
  status: string,
  latestApproveAt: Date | null,
  opts: { hasProtectedEntries?: boolean } = {},
  now: Date = new Date()
): EditLockInfo {
  if (status === "REJECTED" && opts.hasProtectedEntries) {
    const approvedAt = latestApproveAt ?? now;
    return {
      editMode: "addOnly",
      approvedAt: approvedAt.toISOString(),
      lockExpiresAt: null,
    };
  }

  // Submit is the hard cutoff: once submitted (or HOD/PM approved), the day is
  // locked until it is rejected/returned. SUBMITTED is not an "approved" status
  // but is still hard-locked per the user requirement.
  if ((LOCKED_STATUSES as readonly string[]).includes(status) && !isApprovedStatus(status)) {
    return { editMode: "locked", approvedAt: null, lockExpiresAt: null };
  }

  if (!isApprovedStatus(status)) {
    return { editMode: "full", approvedAt: null, lockExpiresAt: null };
  }

  const approvedAt = latestApproveAt ?? now;
  const lockExpiresAt = new Date(approvedAt.getTime() + MS_24H);
  const withinWindow = now.getTime() < lockExpiresAt.getTime();

  return {
    editMode: withinWindow ? "addOnly" : "locked",
    approvedAt: approvedAt.toISOString(),
    lockExpiresAt: lockExpiresAt.toISOString(),
  };
}
