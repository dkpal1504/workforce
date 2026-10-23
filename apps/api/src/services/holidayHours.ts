/**
 * The ONE definition of "which bucket do these booked hours belong to".
 *
 * WHY IT EXISTS: the customer's problem — holiday manhours inflating project hours — can be "solved" in
 * five places in five slightly different ways (dashboard, Summary, coverage, Not booked, exports), and
 * two definitions of hours that drift is the worst failure this codebase knows. So the arithmetic lives
 * here once, and every report and both exports consume it.
 *
 * THE CONTRACT IS EXHAUSTIVE: `regular + holiday + unverified === total`, always. Hours are never
 * deleted — only reclassified and disclosed. That is what lets the app remove holiday manhours from
 * project figures without rewriting an approved timesheet or breaking a finance reconciliation.
 *
 * WHAT GOES WHERE
 *
 *   WORKED                                -> regular     (a normal working day)
 *   WORKED_WEEKLY_OFF / WORKED_HOLIDAY    -> holiday     (worked a non-working day; OT by definition)
 *   OFF                                   -> holiday     (hours booked on a day nobody was expected)
 *   ABSENT                                -> unverified  (he was not in the plant; the booking has no
 *                                                         attendance evidence behind it)
 *   UNVERIFIED  (no register row / unknown)
 *   null        (not settled yet)         -> regular     AND counted in `provisionalHours`, which is a
 *                                                         disclosure subset, not a fourth bucket.
 *
 * The last rule is deliberate: an unsettled or unread date must not silently REMOVE hours from a report.
 * Counting them as regular and printing how many are provisional keeps the figure stable and honest,
 * and the moment the register catches up they move to their real bucket.
 */

import type { AttendanceClass } from "./attendanceRegister";
import { round2 } from "./attendanceRegister";

/** One booked row, already reduced to what this module needs. */
export type ClassedHoursRow = {
  /** The stamped class of the employee-day; null means "not settled yet". */
  attendanceClass: AttendanceClass | null;
  hours: number;
};

export type HoursSplit = {
  /** Hours a report shows as project work (includes provisional — see the header). */
  regularHours: number;
  /** Hours booked on a non-working day. Shown BESIDE the regular figure, never inside it. */
  holidayHours: number;
  /** Hours booked for a man with no attendance evidence on a working day. */
  unverifiedHours: number;
  /** Subset of `regularHours` whose day is not settled/unread. Disclosure only. */
  provisionalHours: number;
  /** `regularHours + holidayHours + unverifiedHours` — the invariant, asserted in tests. */
  totalHours: number;
  /** Row counts, so a note can say "on 14 days" rather than only printing hours. */
  rowCount: number;
  holidayRowCount: number;
  unverifiedRowCount: number;
  provisionalRowCount: number;
};

/** A finite, non-negative figure or 0 — a corrupt `NaN` must never poison a sum. */
function safeHours(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return value;
}

/**
 * Classify every row and sum the buckets.
 *
 * Unknown class values (a stale row, a hand-edited database, a future class) fall to provisional: they
 * are counted and disclosed, never dropped and never asserted to be regular work.
 */
export function splitHoursByClass(rows: readonly ClassedHoursRow[]): HoursSplit {
  let regularHours = 0;
  let holidayHours = 0;
  let unverifiedHours = 0;
  let provisionalHours = 0;
  let rowCount = 0;
  let holidayRowCount = 0;
  let unverifiedRowCount = 0;
  let provisionalRowCount = 0;

  for (const row of rows) {
    const hours = safeHours(row.hours);
    rowCount += 1;
    switch (row.attendanceClass) {
      case "WORKED":
        regularHours += hours;
        break;
      case "WORKED_WEEKLY_OFF":
      case "WORKED_HOLIDAY":
      case "OFF":
        holidayHours += hours;
        holidayRowCount += 1;
        break;
      case "ABSENT":
        unverifiedHours += hours;
        unverifiedRowCount += 1;
        break;
      case "UNVERIFIED":
      case null:
      case undefined:
      default:
        regularHours += hours;
        provisionalHours += hours;
        provisionalRowCount += 1;
        break;
    }
  }

  return {
    regularHours: round2(regularHours),
    holidayHours: round2(holidayHours),
    unverifiedHours: round2(unverifiedHours),
    provisionalHours: round2(provisionalHours),
    totalHours: round2(regularHours + holidayHours + unverifiedHours),
    rowCount,
    holidayRowCount,
    unverifiedRowCount,
    provisionalRowCount,
  };
}

/** True when the split accounts for every hour it was given. Pinned by a test on every surface. */
export function isExhaustive(split: HoursSplit): boolean {
  return Math.abs(split.regularHours + split.holidayHours + split.unverifiedHours - split.totalHours) < 0.005;
}

/**
 * The sentences a report prints under its hours figure.
 *
 * Empty when there is nothing to disclose — a clean period should not carry a paragraph of zeroes. Every
 * sentence carries the number behind it, so a reader can trace it to the bucket it came from.
 */
export function holidayHoursNote(split: HoursSplit, options: { maxDailyHours?: number } = {}): string[] {
  const notes: string[] = [];
  if (split.holidayHours > 0) {
    notes.push(
      `${split.holidayHours.toFixed(2)} h are booked on non-working days (weekly off / holiday) across ` +
        `${split.holidayRowCount} day${split.holidayRowCount === 1 ? "" : "s"} — excluded from regular manhours ` +
        `and shown separately. That work is overtime by definition.`
    );
  }
  if (split.unverifiedHours > 0) {
    notes.push(
      `${split.unverifiedHours.toFixed(2)} h have no attendance evidence (the man was recorded absent that day) ` +
        `across ${split.unverifiedRowCount} day${split.unverifiedRowCount === 1 ? "" : "s"} — excluded from regular ` +
        `manhours until confirmed.`
    );
  }
  if (split.provisionalHours > 0) {
    notes.push(
      `${split.provisionalHours.toFixed(2)} h are still PROVISIONAL: their day has not been settled against ` +
        `LabourWorks attendance yet (${split.provisionalRowCount} day${split.provisionalRowCount === 1 ? "" : "s"}). ` +
        `They are counted as regular work and will move buckets once the attendance is in.`
    );
  }
  if (options.maxDailyHours != null && split.totalHours > 0) {
    // A sanity statement, not a rule: it tells the reader the figure is hours, not man-days.
    notes.push(`Total booked hours in this scope: ${split.totalHours.toFixed(2)} h.`);
  }
  return notes;
}

/**
 * The hours a single row is worth, from a timesheet entry.
 *
 * Mirrors `hoursOf` in `portfolioReport.ts` — the operations figure, NOT the Summary's approved-only
 * figure: `(otHours ?? 0) + shiftSlot·2 + hourSlot·1`. Two definitions of "booked hours" already ship
 * on purpose (see the repo skill); this must not become a third.
 */
export function bookedHoursFromEntry(entry: {
  otHours: number | null;
  shiftSlot: string | null;
  hourSlot: number | null;
}): number {
  // Identical to `hoursOf` in portfolioReport.ts, per row: the OT hours (0 when absent) PLUS the slot
  // hours. Written the same way on purpose, so a future edit to one shows up in a diff of the other.
  return safeHours(entry.otHours ?? 0) + (entry.shiftSlot != null ? 2 : entry.hourSlot != null ? 1 : 0);
}
