/**
 * Contract-work hours arithmetic — the ONE definition of "how many hours is this booking?", shared
 * by the approval queues, the Summary and the timesheet-coverage report.
 *
 * WHY IT LIVES HERE RATHER THAN IN A ROUTE: it used to be a private helper inside
 * `routes/approvals.ts`, which meant the approval screens owned the only working copy of the rule
 * and a second report could only copy it — and two definitions of "hours" that drift is the worst
 * failure a reporting feature has, because both numbers look plausible and neither is obviously
 * wrong. It is pure (no database, no environment) so it can be tested directly.
 */

/**
 * Contract-workmen overhead is unused regular-shift capacity. On a holiday, an OT-only booking
 * represents the entire attendance and must not create an artificial regular-shift overhead
 * balance.
 */
export function contractOverheadHours(
  maxDailyHours: number,
  regularHours: number,
  overtimeHours: number
): number {
  if (regularHours === 0 && overtimeHours > 0) return 0;
  return Math.max(0, maxDailyHours - regularHours);
}

/** Legacy WBS link on a booking row. The WBS carries no colour of its own. */
export type ProjectWbsRef = { wbsCode: string; name: string | null } | null;
/** Frozen project snapshot captured when the hours were booked. */
export type ProjectRef = { colorKey: string; name?: string | null } | null;
export type JobOrderRef = { project: { colorKey: string; name?: string | null } } | null;

/** The shape of a booking row this arithmetic needs — a subset of a TimesheetEntry with its joins. */
export type BookingEntryLike = {
  projectWbsId: number | null;
  jobOrderId: number | null;
  status: string;
  shiftSlot: string | null;
  hourSlot: number | null;
  otHours: number | null;
  /** Snapshot first: a later master-data change must not move booked hours. */
  project: ProjectRef;
  projectWbs: ProjectWbsRef;
  jobOrder: JobOrderRef;
};

export type ProjectHours = {
  /** Regular hours per Project colour key. */
  projectHours: Record<string, number>;
  /** Overtime hours per Project colour key. */
  projectOtHours: Record<string, number>;
  /** Unused regular capacity for the day (see `contractOverheadHours`). */
  overhead: number;
  /** Regular + overtime. OVERHEADS ARE NOT INCLUDED — they are capacity, not booked work. */
  totalAlloc: number;
  regularTotalAlloc: number;
  totalOtHours: number;
};

/**
 * Per-project regular and overtime hours for one employee-day, plus that day's overhead.
 *
 * THE THREE RULES, each of which was a real defect when written the other way:
 *   1. A row tagged to NEITHER a WBS nor a Job Order is not billable work — it is skipped, or the
 *      "hours" would appear in no project column while still inflating the day's total.
 *   2. The row's Project is the FROZEN SNAPSHOT (`entry.project`); the Job Order path is only the
 *      fallback for rows booked before the snapshot existed. Reading the live Job Order first would
 *      let a later master-data remap move approved history.
 *   3. A shift slot is 2h, a legacy hour slot is 1h — the same conversion the timesheet grid, the
 *      daily-max gate and the OT-excess rule use. A third interpretation here would make one screen
 *      disagree with the two that gate the data.
 */
export function projectHoursFromEntries(entries: readonly BookingEntryLike[], maxDailyHours: number): ProjectHours {
  // Keep regular and overtime hours under the project they are charged to.
  const projectHours: Record<string, number> = {};
  const projectOtHours: Record<string, number> = {};
  for (const e of entries) {
    if (e.projectWbsId == null && e.jobOrderId == null) continue;
    // The Project of a booking row is the frozen attribution snapshot; the Job
    // Order path is only the fallback for rows booked before the snapshot existed.
    const colorKey = e.project?.colorKey ?? e.jobOrder?.project.colorKey ?? null;
    if (!colorKey) continue;
    const key = String(colorKey).toUpperCase();
    if (e.otHours != null) {
      projectOtHours[key] = (projectOtHours[key] || 0) + e.otHours;
      continue;
    }
    // A shift slot is 2h; a legacy hour slot is 1h.
    const hours = e.shiftSlot != null ? 2 : e.hourSlot != null ? 1 : 0;
    projectHours[key] = (projectHours[key] || 0) + hours;
  }
  const regularTotalAlloc = Object.values(projectHours).reduce((a, b) => a + b, 0);
  const totalOtHours = Object.values(projectOtHours).reduce((a, b) => a + b, 0);
  // OT is normally additive. For an OT-only holiday booking, it represents
  // the whole attendance and must not create artificial regular overhead.
  const overhead = contractOverheadHours(maxDailyHours, regularTotalAlloc, totalOtHours);
  const totalAlloc = regularTotalAlloc + totalOtHours;
  return { projectHours, projectOtHours, overhead, totalAlloc, regularTotalAlloc, totalOtHours };
}
