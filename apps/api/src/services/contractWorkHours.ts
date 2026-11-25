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
  /** APPROVED overtime hours per Project colour key (CLMS `AcceptedOT`). */
  projectOtHours: Record<string, number>;
  /** Unused regular capacity for the day (see `contractOverheadHours`). */
  overhead: number;
  /** Regular + overtime. OVERHEADS ARE NOT INCLUDED — they are capacity, not booked work. */
  totalAlloc: number;
  regularTotalAlloc: number;
  /** Approved overtime counted for the day (the sum of `projectOtHours`). */
  totalOtHours: number;
  /** OT the supervisor punched, kept as the captured reference. NEVER the reported figure. */
  punchedOtHours: number;
  /** True when the day's approved OT has been fetched from CLMS; false = never fetched. */
  otFetched: boolean;
  /** Approved OT that nobody booked a Job Order against (see `OT_NOT_BOOKED_COLOR_KEY`). */
  otNotBookedHours: number;
};

/**
 * The colour key of the bucket that carries approved overtime no supervisor booked.
 *
 * CLMS approves a number per man-day with no Project or Job Order on it. When the day has an
 * OT booking, that booking's Project receives the whole figure (the supervisor's split is
 * attribution, not arithmetic). When the day has none, the hours still have to appear
 * somewhere — dropping them would make a report that disagrees with CLMS — so they land in
 * this bucket, which the screens print as "OT not booked".
 */
export const OT_NOT_BOOKED_COLOR_KEY = "OT_NOT_BOOKED";

/**
 * The approved overtime of one employee-day, as CLMS states it.
 *
 * `hours` is the figure that is reported. `fetched` is false only when the day has never been
 * read from CLMS: the arithmetic still counts 0 (a punch is never a substitute) and the
 * screens say "not fetched yet" instead of implying the yard approved nothing.
 */
export type ApprovedOtAttribution = {
  hours: number;
  fetched: boolean;
};

/**
 * Per-project regular and APPROVED overtime hours for one employee-day, plus that day's overhead.
 *
 * THE FIVE RULES, each of which was a real defect when written the other way:
 *   1. A row tagged to NEITHER a WBS nor a Job Order is not billable work — it is skipped, or the
 *      "hours" would appear in no project column while still inflating the day's total.
 *   2. The row's Project is the FROZEN SNAPSHOT (`entry.project`); the Job Order path is only the
 *      fallback for rows booked before the snapshot existed. Reading the live Job Order first would
 *      let a later master-data remap move approved history.
 *   3. A shift slot is 2h, a legacy hour slot is 1h — the same conversion the timesheet grid, the
 *      daily-max gate and the OT-excess rule use. A third interpretation here would make one screen
 *      disagree with the two that gate the data.
 *   4. OVERTIME IS THE CLMS-APPROVED FIGURE, never the supervisor's punch. The punch only says WHICH
 *      Project the OT is charged to; the hours come from `approvedOt`. A day CLMS approves no OT for
 *      therefore reports zero overtime however many hours were punched — that is the point.
 *   5. APPROVED OT WITH NO BOOKING IS STILL HOURS. When nobody booked OT that day, the figure lands in
 *      `OT_NOT_BOOKED_COLOR_KEY` so a report total always equals what CLMS approved.
 */
export function projectHoursFromEntries(
  entries: readonly BookingEntryLike[],
  maxDailyHours: number,
  approvedOt: ApprovedOtAttribution
): ProjectHours {
  // Keep regular hours under the project they are charged to, and remember which project the
  // day's OT booking points at — that Project receives the whole approved figure.
  const projectHours: Record<string, number> = {};
  const projectOtHours: Record<string, number> = {};
  let punchedOtHours = 0;
  let otCarrierKey: string | null = null;
  for (const e of entries) {
    if (e.projectWbsId == null && e.jobOrderId == null) continue;
    // The Project of a booking row is the frozen attribution snapshot; the Job
    // Order path is only the fallback for rows booked before the snapshot existed.
    const colorKey = e.project?.colorKey ?? e.jobOrder?.project.colorKey ?? null;
    if (!colorKey) continue;
    const key = String(colorKey).toUpperCase();
    if (e.otHours != null) {
      // The punch is a REFERENCE: it names the project the approved OT is charged to and is
      // reported separately, never added to the overtime.
      punchedOtHours += e.otHours;
      if (otCarrierKey == null) otCarrierKey = key;
      continue;
    }
    // A shift slot is 2h; a legacy hour slot is 1h.
    const hours = e.shiftSlot != null ? 2 : e.hourSlot != null ? 1 : 0;
    projectHours[key] = (projectHours[key] || 0) + hours;
  }

  const approvedHours = Number.isFinite(approvedOt.hours) ? Math.max(0, round2(approvedOt.hours)) : 0;
  let otNotBookedHours = 0;
  if (approvedHours > 0) {
    if (otCarrierKey != null) {
      projectOtHours[otCarrierKey] = (projectOtHours[otCarrierKey] || 0) + approvedHours;
    } else {
      projectOtHours[OT_NOT_BOOKED_COLOR_KEY] = approvedHours;
      otNotBookedHours = approvedHours;
    }
  }

  const regularTotalAlloc = Object.values(projectHours).reduce((a, b) => a + b, 0);
  const totalOtHours = Object.values(projectOtHours).reduce((a, b) => a + b, 0);
  // OT is normally additive. For an OT-only holiday booking, it represents
  // the whole attendance and must not create artificial regular overhead.
  const overhead = contractOverheadHours(maxDailyHours, regularTotalAlloc, totalOtHours);
  const totalAlloc = regularTotalAlloc + totalOtHours;
  return {
    projectHours,
    projectOtHours,
    overhead,
    totalAlloc,
    regularTotalAlloc,
    totalOtHours,
    punchedOtHours: round2(punchedOtHours),
    otFetched: approvedOt.fetched,
    otNotBookedHours,
  };
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

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
