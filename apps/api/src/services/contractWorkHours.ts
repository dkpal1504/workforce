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
export type JobOrderRef = {
  /** Job Order number as the PM team writes it (repeats across Projects, unique per Project).
   *  Optional because a caller that only wants hours need not select it. */
  code?: string;
  /** `Job_Description` from the CSV. */
  name?: string;
  project: { colorKey: string; name?: string | null };
} | null;

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

/* --------------------------------------------------------------------------------------------- *
 *  Per-SLOT bookings, for the screens that must show WHICH Job Order sits in each shift slot.
 *
 *  The approval queues used to expose only the per-project totals, so the HOD approved a day
 *  without ever seeing the four slots that made it up — the supervisor could see them on the
 *  timesheet and the approver could not. This is the same arithmetic as above (slot = 2h,
 *  legacy hour slot = 1h, OT from `otHours`, Project from the frozen snapshot) applied one row
 *  at a time instead of folded into columns, so the two screens cannot disagree.
 * --------------------------------------------------------------------------------------------- */

/** The four shift slots in the order the timesheet grid prints them. */
export const SHIFT_SLOT_ORDER = ["am1", "am2", "pm1", "pm2"] as const;

export type SlotBooking = {
  /** `am1`|`am2`|`pm1`|`pm2`, or null for a legacy hourly row. */
  shiftSlot: string | null;
  /** Legacy hourly row only (0 = 08:00). */
  hourSlot: number | null;
  isOt: boolean;
  hours: number;
  /** Project colour token, upper-cased, or null when the row carries no project. */
  projectKey: string | null;
  projectName: string | null;
  jobOrderId: number | null;
  /** Job Order number, or the legacy WBS code when the row predates Job Orders. */
  jobOrderCode: string | null;
  /** Job Order description, or the WBS name — what the tooltip says after the number. */
  jobOrderName: string | null;
  status: string;
};

/**
 * One booking per row, ordered am1 → am2 → pm1 → pm2, then legacy hourly rows, then OT.
 * A slot booked twice (two supervisors on the same clock hours) yields two rows on purpose:
 * hiding the second would make the conflict flag unexplainable.
 */
export function slotsFromEntries(entries: readonly BookingEntryLike[]): SlotBooking[] {
  const ordered: { order: number; booking: SlotBooking }[] = [];
  for (const e of entries) {
    if (e.projectWbsId == null && e.jobOrderId == null) continue;
    const isOt = e.otHours != null;
    const shiftIndex = e.shiftSlot == null ? -1 : (SHIFT_SLOT_ORDER as readonly string[]).indexOf(e.shiftSlot);
    // OT is never a shift slot: it prints after the four of them.
    const order = isOt ? 100 : shiftIndex >= 0 ? shiftIndex : 50 + (e.hourSlot ?? 0);
    const colorKey = e.project?.colorKey ?? e.jobOrder?.project.colorKey ?? null;
    ordered.push({
      order,
      booking: {
        shiftSlot: e.shiftSlot,
        hourSlot: e.hourSlot,
        isOt,
        hours: isOt ? e.otHours ?? 0 : e.shiftSlot != null ? 2 : e.hourSlot != null ? 1 : 0,
        projectKey: colorKey == null ? null : String(colorKey).toUpperCase(),
        projectName: e.project?.name ?? e.jobOrder?.project.name ?? null,
        jobOrderId: e.jobOrderId,
        jobOrderCode: e.jobOrder?.code ?? e.projectWbs?.wbsCode ?? null,
        jobOrderName: e.jobOrder?.name ?? e.projectWbs?.name ?? null,
        status: e.status,
      },
    });
  }
  return ordered.sort((a, b) => a.order - b.order).map((row) => row.booking);
}
