/** Edit rules after HOD / Project Head approval. */

export const APPROVED_STATUSES = ["HOD_APPROVED", "PM_APPROVED"] as const;
export type ApprovedStatus = (typeof APPROVED_STATUSES)[number];

/**
 * Statuses that are hard-locked: once a supervisor submits, or HOD/PM approve,
 * the day can no longer be edited (unless rejected/returned, which unlocks it).
 * SUBMITTED is the supervisor's submit cutoff — the user requirement is that
 * assign/unassign is allowed only UNTIL submission.
 */
export const LOCKED_STATUSES = ["SUBMITTED", "HOD_APPROVED", "PM_APPROVED", "FINAL_REJECTED"] as const;
export type LockedStatus = (typeof LOCKED_STATUSES)[number];

export type EditMode = "full" | "addOnly" | "locked";

export type EditLockInfo = {
  editMode: EditMode;
  approvedAt: string | null;
  lockExpiresAt: string | null;
};

export function isApprovedStatus(status: string): status is ApprovedStatus {
  return (APPROVED_STATUSES as readonly string[]).includes(status);
}

export function isProtectedEntryStatus(status: string): boolean {
  return isApprovedStatus(status);
}

/**
 * Submission is the edit cutoff. SUBMITTED and approved days are read-only in
 * every supervisor view until HOD/Project Head rejects or returns them.
 * REJECTED amendments keep previously approved slots protected while allowing
 * the rejected/new slots to be corrected and resubmitted.
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

  if ((LOCKED_STATUSES as readonly string[]).includes(status)) {
    return {
      editMode: "locked",
      approvedAt: isApprovedStatus(status) ? (latestApproveAt ?? now).toISOString() : null,
      lockExpiresAt: null,
    };
  }

  return { editMode: "full", approvedAt: null, lockExpiresAt: null };
}
