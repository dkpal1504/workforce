/**
 * The reconciliation arithmetic: what the reports say TODAY vs what they would say with the register's
 * day types and classes. PURE — no database, no clock.
 *
 * WHY THIS EXISTS BEFORE THE FEATURE: the customer's requirement is to change figures that finance and
 * the COO already read. The safe way to do that is to compute BOTH figures, print the difference with
 * its reason, and get a sign-off — then flip one report at a time. This module is that comparison, and
 * it deliberately shares its arithmetic with the eventual product code (`attendanceRegister` +
 * `holidayHours`), so the numbers shown for approval are the numbers that will ship.
 *
 * THE BEFORE FIGURES REPRODUCE THE SHIPPED RULES, NOT AN IMPROVED VERSION OF THEM:
 *   - coverage: expected employee-days = employees x EVERY calendar date (the defect being fixed),
 *     "filled" = a day with any timesheet sheet at all, whatever its status.
 *   - Not booked: a missing day is any calendar date with no sheet, priced at MAX_DAILY_HOURS.
 *   - hours: the portfolio's booked figure (`hoursOf`).
 * If a "before" number here disagreed with the screen, the whole reconciliation would be worthless, so
 * the tests pin these to the shipped definitions.
 *
 * THE AFTER FIGURES ARE THE PROPOSAL:
 *   - expected days = WORKING dates from the register (a date is non-working if ANY of its rows says so);
 *   - Not booked splits the gap into "present but nobody booked him" (cost), "absent" (no cost),
 *     "off" (no cost) and "not covered by the register" (unknown, disclosed);
 *   - hours split into regular / holiday / unverified by the employee-day's class.
 */

import type { AttendanceClass, AttendanceDayFact, DayType, RegisterStatus } from "./attendanceRegister";
import { round2 } from "./attendanceRegister";
import { splitHoursByClass, type ClassedHoursRow, type HoursSplit } from "./holidayHours";
import { eachDay } from "./notBooked";

/** One person on the roster the reports count. */
export type ReconPerson = {
  employeeId: number;
  ecNo: string;
  name: string;
  department: string;
  section: string;
  category: string;
};

/** One booked timesheet row, enriched with the register's verdict for that employee-day. */
export type ReconBooking = {
  entryId: number;
  employeeId: number;
  ecNo: string;
  employeeName: string;
  workDate: string;
  /** The timesheet row's status (SUBMITTED / PM_APPROVED / …). */
  status: string;
  /** Booked hours, as the portfolio counts them. */
  hours: number;
  jobOrderId: number | null;
  jobOrderCode: string | null;
  projectCode: string | null;
  wbsCode: string | null;
  /** The employee-day's class; null when the register has no row (unsettled / unread). */
  attendanceClass: AttendanceClass | null;
  dayType: DayType | null;
  registerStatus: RegisterStatus | null;
  clockedHours: number | null;
  /** The register's approved overtime for this employee-day (`[AcceptedOT]`); null = no figure. */
  acceptedOt: number | null;
  /** OT the supervisor punched on this row (null when the row is a shift slot, not OT). */
  punchedOt: number | null;
  /**
   * What the CLMS sync last stamped on the employee-day (`timesheet_days.approved_ot_hours`), so the
   * recon can prove the sync kept up with the yard's 2–15 day approval lag. null = never stamped.
   */
  stampedApprovedOt: number | null;
};

/** One row of the per-date table: the evidence behind every day type. */
export type ReconDateRow = {
  workDate: string;
  dayType: DayType;
  isWeeklyOff: boolean;
  employeesWithRow: number;
  present: number;
  absent: number;
  off: number;
  unknown: number;
  /** The register's own status counts, so the table speaks the source's language. */
  statusCounts: Record<string, number>;
  bookedHours: number;
  clockedHours: number;
  /** Men whose accepted hours are 0 although the status says present (regularisation pending). */
  presentZeroHours: number;
  /** Man-days carrying the source's isHoliday flag, so a HOLIDAY verdict is auditable. */
  holidayFlagRows: number;
  /** Man-days carrying an HL status — the decisive holiday signal. */
  holidayStatusRows: number;
  /** Rows that disagree about the day's status, or whose status contradicts the day type. */
  conflicts: number;
};

/** One row of the per-employee-day variance table. */
export type ReconEmployeeDayRow = {
  workDate: string;
  ecNo: string;
  employeeName: string;
  dayType: DayType | null;
  registerStatus: RegisterStatus | null;
  attendanceClass: AttendanceClass | null;
  bookedHours: number;
  clockedHours: number | null;
  /** The register's approved overtime for the employee-day (null = no figure). */
  acceptedOt: number | null;
  /** OT the supervisor punched on this employee-day. */
  punchedOtHours: number;
  /** booked OT vs approved OT; positive = the yard approved more than was booked. */
  otVariance: number;
  /** The figure the sync last stamped on the day (null = never stamped). */
  stampedApprovedOt: number | null;
  /** booked - clocked; null when the register has nothing to compare against. */
  variance: number | null;
  statuses: string;
  jobOrders: string;
};

/** One row of the per-Job-Order split: what moves out of regular manhours, and why. */
export type ReconJobOrderRow = {
  jobOrderId: number | null;
  jobOrderCode: string | null;
  projectCode: string | null;
  wbsCode: string | null;
  bookedHours: number;
  regularHours: number;
  holidayHours: number;
  unverifiedHours: number;
  provisionalHours: number;
  rows: number;
  holidayRows: number;
  unverifiedRows: number;
};

/**
 * The overtime reconciliation: what supervisors booked, what CLMS approved, and where they disagree.
 *
 * THIS IS THE ONE PLACE THE TWO OT FIGURES MEET. Every report shows the approved figure and never the
 * punch; this block is the evidence behind that rule — how many hours were punched, how many the yard
 * approved, which days are still waiting for an approval (CLMS takes 2–15 days), which were approved
 * for a day nobody booked (the "OT not booked" column), and whether the stamped column has kept up.
 *
 * COUNTED PER EMPLOYEE-DAY, NOT PER ROW: a man can appear on two supervisors' sheets for one date, and
 * the approved figure belongs to the man-day. `approvedOnRow` hands it to the ONE row that booked the
 * overtime — the same rule `attributeApprovedOt` applies to reports — so nothing is counted twice.
 */
export type OvertimeSummary = {
  /** Rows that carry an OT booking. */
  otRows: number;
  /** Distinct employee-days with an OT booking. */
  otDays: number;
  /** OT hours the supervisors punched. */
  punchedHours: number;
  /** Approved OT stated by the register for those employee-days (0 when it approved none). */
  approvedHours: number;
  /** `approvedHours - punchedHours`; positive = the yard paid more than was booked. */
  varianceHours: number;
  /** Hours that would be paid for these employee-days: regular slots + APPROVED OT. */
  paidHours: number;
  /** Hours currently booked (regular slots + punched OT). */
  bookedHours: number;
  /** OT punched but not yet approved — the 2–15 day lag, made visible instead of looking like zero. */
  pendingApprovalDays: number;
  pendingApprovalHours: number;
  /** Days where CLMS approved less than was punched. */
  underApprovedDays: number;
  underApprovedHours: number;
  /** Days where CLMS approved more than was punched (a holiday, usually). */
  overApprovedDays: number;
  overApprovedHours: number;
  /** Approved OT on days NOBODY booked: no Job Order to charge it to ("OT not booked"). */
  unbookedDays: number;
  unbookedHours: number;
  /** Employee-days whose stamped `approved_ot_hours` differs from the register's figure. */
  staleStampedDays: number;
  /** Employee-days with a register figure that the sync has never stamped. */
  neverStampedDays: number;
};

const EPSILON = 0.005;

/** The approved figure of one employee-day, from the rows that mention it. */
function overtimeByEmployeeDay(
  bookings: readonly ReconBooking[]
): Map<string, { approved: number | null; hasOtBooking: boolean; punched: number }> {
  const byDay = new Map<string, { approved: number | null; hasOtBooking: boolean; punched: number }>();
  for (const booking of bookings) {
    const key = `${booking.employeeId}|${booking.workDate}`;
    const entry = byDay.get(key) ?? { approved: null, hasOtBooking: false, punched: 0 };
    if (booking.punchedOt != null) {
      entry.hasOtBooking = true;
      entry.punched += booking.punchedOt;
    }
    // Every row of the day carries the same register figure; keep the first non-null.
    if (entry.approved == null && booking.acceptedOt != null) entry.approved = booking.acceptedOt;
    byDay.set(key, entry);
  }
  return byDay;
}

/** Summarise the overtime reconciliation. PURE — no database, no environment. */
export function summariseOvertime(bookings: readonly ReconBooking[]): OvertimeSummary {
  const byDay = overtimeByEmployeeDay(bookings);
  const summary: OvertimeSummary = {
    otRows: 0,
    otDays: 0,
    punchedHours: 0,
    approvedHours: 0,
    varianceHours: 0,
    paidHours: 0,
    bookedHours: 0,
    pendingApprovalDays: 0,
    pendingApprovalHours: 0,
    underApprovedDays: 0,
    underApprovedHours: 0,
    overApprovedDays: 0,
    overApprovedHours: 0,
    unbookedDays: 0,
    unbookedHours: 0,
    staleStampedDays: 0,
    neverStampedDays: 0,
  };

  // Which OT row carries the day's approved figure (lowest entry id, so runs agree).
  const carrierByDay = new Map<string, number>();
  for (const booking of bookings) {
    if (booking.punchedOt == null) continue;
    const key = `${booking.employeeId}|${booking.workDate}`;
    const current = carrierByDay.get(key);
    if (current == null || booking.entryId < current) carrierByDay.set(key, booking.entryId);
  }

  for (const booking of bookings) {
    const key = `${booking.employeeId}|${booking.workDate}`;
    const day = byDay.get(key);
    const isCarrier = carrierByDay.get(key) === booking.entryId;
    const approvedOnRow = day?.approved ?? 0;
    summary.bookedHours += booking.hours;
    // Paid = booked minus the punch plus the approved figure, counted once.
    summary.paidHours +=
      booking.hours - (booking.punchedOt ?? 0) + (isCarrier ? approvedOnRow : 0);
    if (booking.punchedOt != null) summary.otRows += 1;
  }

  for (const [, day] of byDay) {
    const approved = day.approved ?? 0;
    summary.punchedHours += day.punched;
    if (day.hasOtBooking) {
      summary.otDays += 1;
      summary.approvedHours += approved;
      if (approved <= EPSILON && day.punched > EPSILON) {
        summary.pendingApprovalDays += 1;
        summary.pendingApprovalHours += day.punched;
      } else if (approved + EPSILON < day.punched) {
        summary.underApprovedDays += 1;
        summary.underApprovedHours += day.punched - approved;
      } else if (approved > day.punched + EPSILON) {
        summary.overApprovedDays += 1;
        summary.overApprovedHours += approved - day.punched;
      }
    } else if (approved > EPSILON) {
      summary.unbookedDays += 1;
      summary.unbookedHours += approved;
    }
  }

  // Did the sync keep up? A stamped row that disagrees with the register is a refresh that has not run
  // yet; an approved figure with no stamp at all means the day was never reached.
  const stampedByDay = new Map<string, number | null>();
  for (const booking of bookings) {
    const key = `${booking.employeeId}|${booking.workDate}`;
    if (!stampedByDay.has(key)) stampedByDay.set(key, booking.stampedApprovedOt);
  }
  for (const [key, stamped] of stampedByDay) {
    const approved = byDay.get(key)?.approved;
    if (approved == null) continue;
    if (stamped == null) {
      if (approved > EPSILON) summary.neverStampedDays += 1;
      continue;
    }
    if (Math.abs(stamped - approved) > EPSILON) summary.staleStampedDays += 1;
  }

  summary.punchedHours = round2(summary.punchedHours);
  summary.approvedHours = round2(summary.approvedHours);
  summary.varianceHours = round2(summary.approvedHours - summary.punchedHours);
  summary.paidHours = round2(summary.paidHours);
  summary.bookedHours = round2(summary.bookedHours);
  summary.pendingApprovalHours = round2(summary.pendingApprovalHours);
  summary.underApprovedHours = round2(summary.underApprovedHours);
  summary.overApprovedHours = round2(summary.overApprovedHours);
  summary.unbookedHours = round2(summary.unbookedHours);
  return summary;
}

export type ReconSurfaces = {
  range: {
    from: string;
    to: string;
    calendarDays: number;
    workingDays: number;
    weeklyOffDays: number;
    holidayDays: number;
    /** Dates the register did not cover at all — the reason a figure can be provisional. */
    uncoveredDays: number;
  };
  coverage: {
    before: { expectedEmployeeDays: number; filledEmployeeDays: number; notFilledEmployeeDays: number; filledPct: number };
    after: { expectedEmployeeDays: number; filledEmployeeDays: number; notFilledEmployeeDays: number; filledPct: number };
    /** Employee-days removed from the denominator, i.e. the phantom "Not Filled" rows the fix deletes. */
    removedEmployeeDays: number;
  };
  notBooked: {
    before: { notBookedDays: number; idleHours: number; idleCost: number };
    after: {
      expectedWorkingDays: number;
      bookedDays: number;
      presentUnbookedDays: number;
      absentDays: number;
      offDays: number;
      notCoveredDays: number;
      idleHours: number;
      idleCost: number;
    };
  };
  hours: {
    beforeTotalHours: number;
    after: HoursSplit;
    removedFromRegular: number;
  };
};

/** A fraction (0.87 = 87%), never NaN and never a divide-by-zero. */
export function fraction(numerator: number, denominator: number): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 10000) / 10000;
}

/** `"empId|date"` / `"ecNo|date"` — the key every per-employee-day lookup uses. */
export function dayKey(left: number | string, workDate: string): string {
  return `${left}|${workDate}`;
}

/**
 * The DATE-LEVEL day type, resolved once for every consumer.
 *
 * TWO DIFFERENT RULES, because the two signals have different strength:
 *
 *   HOLIDAY — ANY row carrying an `HL` status wins. A skeleton crew present on a declared holiday does not
 *   turn the holiday into a working day; that is the whole reason this feature exists.
 *
 *   WEEKLY_OFF — a MAJORITY of the day's rows must carry the weekly-off flag. The flag is per MAN (rosters
 *   and shift patterns differ), so "any row" would let one man on a Sunday roster declare the whole yard
 *   closed. This was a real defect: the first production run classified all 90 dates as weekly off while
 *   the same rows' classes said WORKED, so coverage denominators collapsed to zero and the report
 *   contradicted itself.
 *
 * A date with no rows at all stays WORKING and is reported as "not covered"; it is never silently assumed
 * closed.
 */
export function dateTypesFrom(facts: readonly AttendanceDayFact[]): Map<string, DayType> {
  const roll = new Map<string, { rows: number; weeklyOffRows: number; holidayFlagRows: number; holidayStatusRows: number }>();
  for (const fact of facts) {
    const entry = roll.get(fact.workDate) ?? { rows: 0, weeklyOffRows: 0, holidayFlagRows: 0, holidayStatusRows: 0 };
    entry.rows += 1;
    if (fact.isWeeklyOff) entry.weeklyOffRows += 1;
    // The two holiday signals are counted SEPARATELY, because they have different strength:
    //   an HL STATUS is the source's own classification of that man's day and is decisive;
    //   the isHoliday FLAG is a row attribute that can appear on a handful of rows of an ordinary day
    //   (26 Aug 2026: 463 present, 58 absent, no HL status, one flagged row → the date was called a
    //   holiday and every hour on it became holiday work).
    if (fact.status === "P/HL" || fact.status === "A/HL") entry.holidayStatusRows += 1;
    if (fact.isHoliday) entry.holidayFlagRows += 1;
    roll.set(fact.workDate, entry);
  }
  const byDate = new Map<string, DayType>();
  for (const [workDate, entry] of roll) {
    if (entry.holidayStatusRows > 0) byDate.set(workDate, "HOLIDAY");
    else if (entry.holidayFlagRows * 2 > entry.rows) byDate.set(workDate, "HOLIDAY");
    else if (entry.weeklyOffRows * 2 > entry.rows) byDate.set(workDate, "WEEKLY_OFF");
    else byDate.set(workDate, "WORKING");
  }
  return byDate;
}

/** The dates in the range that the register says were WORKING days, in order. */
export function workingDatesFrom(facts: readonly AttendanceDayFact[]): string[] {
  return [...dateTypesFrom(facts).entries()]
    .filter(([, dayType]) => dayType === "WORKING")
    .map(([workDate]) => workDate)
    .sort();
}

/** The dates in the range that the register says were NOT working days, with their type. */
export function nonWorkingDatesFrom(facts: readonly AttendanceDayFact[]): Array<{ workDate: string; dayType: DayType }> {
  return [...dateTypesFrom(facts).entries()]
    .filter(([, dayType]) => dayType !== "WORKING")
    .map(([workDate, dayType]) => ({ workDate, dayType }))
    .sort((a, b) => (a.workDate < b.workDate ? -1 : 1));
}

/* --------------------------------------------------------------------------- *
 * The tables
 * ------------------------------------------------------------------------- */

/** Per-date table: day type, the status counts behind it, and the hours on each side. */
export function summariseDates(
  facts: readonly AttendanceDayFact[],
  bookedHoursByDate: ReadonlyMap<string, number>
): ReconDateRow[] {
  const dateTypes = dateTypesFrom(facts);
  type Acc = ReconDateRow;
  const byDate = new Map<string, Acc>();
  for (const fact of facts) {
    let acc = byDate.get(fact.workDate);
    if (!acc) {
      acc = {
        workDate: fact.workDate,
        dayType: dateTypes.get(fact.workDate) ?? "WORKING",
        isWeeklyOff: false,
        employeesWithRow: 0,
        present: 0,
        absent: 0,
        off: 0,
        unknown: 0,
        statusCounts: {},
        bookedHours: 0,
        clockedHours: 0,
        presentZeroHours: 0,
        holidayFlagRows: 0,
        holidayStatusRows: 0,
        conflicts: 0,
      };
      byDate.set(fact.workDate, acc);
    }
    acc.isWeeklyOff = acc.isWeeklyOff || fact.isWeeklyOff;
    if (fact.isHoliday) acc.holidayFlagRows += 1;
    if (fact.status === "P/HL" || fact.status === "A/HL") acc.holidayStatusRows += 1;
    acc.employeesWithRow += 1;
    acc.statusCounts[fact.status] = (acc.statusCounts[fact.status] ?? 0) + 1;
    if (fact.attendanceClass === "OFF") acc.off += 1;
    else if (fact.attendanceClass === "ABSENT") acc.absent += 1;
    else if (fact.status === "UNKNOWN") acc.unknown += 1;
    else acc.present += 1;
    acc.clockedHours += fact.acceptedManHours ?? 0;
    if (
      fact.status === "P" ||
      fact.status === "P/WO" ||
      fact.status === "P/HL"
    ) {
      if ((fact.acceptedManHours ?? 0) === 0) acc.presentZeroHours += 1;
    }
    if (fact.mixedStatus || fact.statusDayTypeConflict) acc.conflicts += 1;
  }
  return [...byDate.values()]
    .map((acc) => ({
      ...acc,
      bookedHours: round2(bookedHoursByDate.get(acc.workDate) ?? 0),
      clockedHours: round2(acc.clockedHours),
    }))
    .sort((a, b) => (a.workDate < b.workDate ? -1 : 1));
}

/** Per-employee-day variance: booked vs clocked, with the class and the reason. */
export function summariseEmployeeDays(bookings: readonly ReconBooking[]): ReconEmployeeDayRow[] {
  type Acc = {
    workDate: string;
    employeeId: number;
    ecNo: string;
    employeeName: string;
    dayType: DayType | null;
    registerStatus: RegisterStatus | null;
    attendanceClass: AttendanceClass | null;
    booked: number;
    clocked: number | null;
    acceptedOt: number | null;
    punchedOt: number;
    stampedApprovedOt: number | null;
    statuses: Set<string>;
    jobOrders: Set<string>;
  };
  const byKey = new Map<string, Acc>();
  for (const booking of bookings) {
    const key = dayKey(booking.employeeId, booking.workDate);
    let acc = byKey.get(key);
    if (!acc) {
      acc = {
        workDate: booking.workDate,
        employeeId: booking.employeeId,
        ecNo: booking.ecNo,
        employeeName: booking.employeeName,
        dayType: booking.dayType,
        registerStatus: booking.registerStatus,
        attendanceClass: booking.attendanceClass,
        booked: 0,
        clocked: booking.clockedHours,
        acceptedOt: booking.acceptedOt,
        punchedOt: 0,
        stampedApprovedOt: booking.stampedApprovedOt,
        statuses: new Set(),
        jobOrders: new Set(),
      };
      byKey.set(key, acc);
    }
    acc.booked += booking.hours;
    acc.statuses.add(booking.status);
    if (booking.jobOrderCode) acc.jobOrders.add(booking.jobOrderCode);
    // Keep a known clocked figure even if a later row for the same day carries none.
    if (acc.clocked == null) acc.clocked = booking.clockedHours;
    if (acc.acceptedOt == null) acc.acceptedOt = booking.acceptedOt;
    if (acc.stampedApprovedOt == null) acc.stampedApprovedOt = booking.stampedApprovedOt;
    if (booking.punchedOt != null) acc.punchedOt += booking.punchedOt;
  }
  return [...byKey.values()]
    .map((acc) => ({
      workDate: acc.workDate,
      ecNo: acc.ecNo,
      employeeName: acc.employeeName,
      dayType: acc.dayType,
      registerStatus: acc.registerStatus,
      attendanceClass: acc.attendanceClass,
      bookedHours: round2(acc.booked),
      clockedHours: acc.clocked == null ? null : round2(acc.clocked),
      acceptedOt: acc.acceptedOt,
      punchedOtHours: round2(acc.punchedOt),
      otVariance: round2((acc.acceptedOt ?? 0) - acc.punchedOt),
      stampedApprovedOt: acc.stampedApprovedOt,
      variance: acc.clocked == null ? null : round2(acc.booked - acc.clocked),
      statuses: [...acc.statuses].sort().join(" + "),
      jobOrders: [...acc.jobOrders].sort().join(" + "),
    }))
    .sort((a, b) => (a.workDate === b.workDate ? a.ecNo.localeCompare(b.ecNo) : a.workDate < b.workDate ? -1 : 1));
}

/** Per-Job-Order split: exactly `splitHoursByClass`, grouped. Holiday hours largest first. */
export function summariseJobOrders(bookings: readonly ReconBooking[]): ReconJobOrderRow[] {
  const groups = new Map<string, { rows: ReconBooking[]; identity: Omit<ReconJobOrderRow, "bookedHours" | "regularHours" | "holidayHours" | "unverifiedHours" | "provisionalHours" | "rows" | "holidayRows" | "unverifiedRows"> }>();
  for (const booking of bookings) {
    const key = booking.jobOrderId == null ? `none|${booking.projectCode ?? ""}` : String(booking.jobOrderId);
    let group = groups.get(key);
    if (!group) {
      group = {
        rows: [],
        identity: {
          jobOrderId: booking.jobOrderId,
          jobOrderCode: booking.jobOrderCode,
          projectCode: booking.projectCode,
          wbsCode: booking.wbsCode,
        },
      };
      groups.set(key, group);
    }
    group.rows.push(booking);
  }
  return [...groups.values()]
    .map(({ rows, identity }) => {
      const split = splitHoursByClass(
        rows.map<ClassedHoursRow>((row) => ({ attendanceClass: row.attendanceClass, hours: row.hours }))
      );
      return {
        ...identity,
        bookedHours: split.totalHours,
        regularHours: split.regularHours,
        holidayHours: split.holidayHours,
        unverifiedHours: split.unverifiedHours,
        provisionalHours: split.provisionalHours,
        rows: split.rowCount,
        holidayRows: split.holidayRowCount,
        unverifiedRows: split.unverifiedRowCount,
      };
    })
    .sort((a, b) => b.holidayHours - a.holidayHours || b.bookedHours - a.bookedHours);
}

/* --------------------------------------------------------------------------- *
 * The three surfaces being changed
 * ------------------------------------------------------------------------- */

export type SurfaceInput = {
  from: string;
  to: string;
  facts: readonly AttendanceDayFact[];
  bookings: readonly ReconBooking[];
  people: readonly ReconPerson[];
  /** `"empId|date"` for every employee-day that has a sheet in ANY status (the shipped "booked" rule). */
  sheetDays: ReadonlySet<string>;
  maxDailyHours: number;
  rateFor: (category: string) => number;
};

/**
 * The before/after for coverage, Not booked and the hours figures.
 *
 * Both sides use the SAME people and the SAME `sheetDays`, so a difference can only come from the day
 * types and the classes — which is exactly what is being proposed.
 */
export function summariseSurfaces(input: SurfaceInput): ReconSurfaces {
  const calendarDays = eachDay(input.from, input.to);
  const dateTypes = dateTypesFrom(input.facts);
  const workingDates = [...dateTypes.entries()].filter(([, type]) => type === "WORKING").map(([date]) => date);
  const nonWorking = [...dateTypes.entries()].filter(([, type]) => type !== "WORKING");
  const workingSet = new Set(workingDates);
  const coveredDates = new Set(input.facts.map((fact) => fact.workDate));
  const uncoveredDays = calendarDays.filter((date) => !coveredDates.has(date)).length;

  // Per employee-day verdict, keyed by the EC number (the register's own identifier).
  const factByEcDay = new Map<string, AttendanceDayFact>();
  for (const fact of input.facts) factByEcDay.set(dayKey(fact.idNo, fact.workDate), fact);

  // ── Coverage (the shipped rule: a day with ANY sheet counts as filled) ──────
  let filledBefore = 0;
  let filledAfter = 0;
  for (const day of input.sheetDays) {
    const date = day.slice(day.indexOf("|") + 1);
    if (!calendarDays.includes(date)) continue;
    filledBefore += 1;
    if (workingSet.has(date)) filledAfter += 1;
  }
  const expectedBefore = input.people.length * calendarDays.length;
  const expectedAfter = input.people.length * workingDates.length;

  // ── Not booked ─────────────────────────────────────────────────────────────
  let notBookedDaysBefore = 0;
  let idleCostBefore = 0;
  let presentUnbookedDays = 0;
  let absentDays = 0;
  let offDays = 0;
  let notCoveredDays = 0;
  let idleCostAfter = 0;
  let bookedWorkingDays = 0;

  for (const person of input.people) {
    const rate = input.rateFor(person.category);
    for (const date of calendarDays) {
      if (!input.sheetDays.has(dayKey(person.employeeId, date))) {
        notBookedDaysBefore += 1;
        idleCostBefore += input.maxDailyHours * rate;
      }
    }
    for (const date of workingDates) {
      if (input.sheetDays.has(dayKey(person.employeeId, date))) {
        bookedWorkingDays += 1;
        continue;
      }
      const fact = factByEcDay.get(dayKey(person.ecNo.toUpperCase(), date));
      if (!fact || fact.status === "UNKNOWN") {
        notCoveredDays += 1;
      } else if (fact.attendanceClass === "ABSENT") {
        absentDays += 1;
      } else if (fact.attendanceClass === "OFF") {
        offDays += 1;
      } else {
        // Present in the plant, nobody booked him: the cost leak this report exists to name.
        presentUnbookedDays += 1;
        idleCostAfter += input.maxDailyHours * rate;
      }
    }
  }

  // ── Hours ──────────────────────────────────────────────────────────────────
  const beforeTotalHours = round2(input.bookings.reduce((acc, row) => acc + row.hours, 0));
  const split = splitHoursByClass(
    input.bookings.map<ClassedHoursRow>((row) => ({ attendanceClass: row.attendanceClass, hours: row.hours }))
  );

  return {
    range: {
      from: input.from,
      to: input.to,
      calendarDays: calendarDays.length,
      workingDays: workingDates.length,
      weeklyOffDays: nonWorking.filter(([, type]) => type === "WEEKLY_OFF").length,
      holidayDays: nonWorking.filter(([, type]) => type === "HOLIDAY").length,
      uncoveredDays,
    },
    coverage: {
      before: {
        expectedEmployeeDays: expectedBefore,
        filledEmployeeDays: filledBefore,
        notFilledEmployeeDays: Math.max(0, expectedBefore - filledBefore),
        filledPct: fraction(filledBefore, expectedBefore),
      },
      after: {
        expectedEmployeeDays: expectedAfter,
        filledEmployeeDays: filledAfter,
        notFilledEmployeeDays: Math.max(0, expectedAfter - filledAfter),
        filledPct: fraction(filledAfter, expectedAfter),
      },
      removedEmployeeDays: Math.max(0, expectedBefore - expectedAfter),
    },
    notBooked: {
      before: {
        notBookedDays: notBookedDaysBefore,
        idleHours: round2(notBookedDaysBefore * input.maxDailyHours),
        idleCost: round2(idleCostBefore),
      },
      after: {
        expectedWorkingDays: input.people.length * workingDates.length,
        bookedDays: bookedWorkingDays,
        presentUnbookedDays,
        absentDays,
        offDays,
        notCoveredDays,
        idleHours: round2(presentUnbookedDays * input.maxDailyHours),
        idleCost: round2(idleCostAfter),
      },
    },
    hours: {
      beforeTotalHours,
      after: split,
      removedFromRegular: round2(split.holidayHours + split.unverifiedHours),
    },
  };
}

/** CSV rows for the surface summary, so the approval pack is one file per question. */
export function surfaceCsvRows(surfaces: ReconSurfaces): string[][] {
  const { coverage, notBooked, hours, range } = surfaces;
  const afterUnbookedDays =
    notBooked.after.presentUnbookedDays + notBooked.after.absentDays + notBooked.after.offDays + notBooked.after.notCoveredDays;
  return [
    ["section", "measure", "before", "after", "delta"],
    ["range", "calendar days", String(range.calendarDays), String(range.workingDays), String(range.workingDays - range.calendarDays)],
    ["range", "non-working days", "0", String(range.weeklyOffDays + range.holidayDays), `+${range.weeklyOffDays + range.holidayDays}`],
    ["range", "weekly off days", "0", String(range.weeklyOffDays), ""],
    ["range", "holiday days", "0", String(range.holidayDays), ""],
    ["range", "dates not covered by the register", "", String(range.uncoveredDays), ""],
    ["coverage", "expected employee-days", String(coverage.before.expectedEmployeeDays), String(coverage.after.expectedEmployeeDays), String(coverage.after.expectedEmployeeDays - coverage.before.expectedEmployeeDays)],
    ["coverage", "filled employee-days", String(coverage.before.filledEmployeeDays), String(coverage.after.filledEmployeeDays), String(coverage.after.filledEmployeeDays - coverage.before.filledEmployeeDays)],
    ["coverage", "not-filled employee-days", String(coverage.before.notFilledEmployeeDays), String(coverage.after.notFilledEmployeeDays), String(coverage.after.notFilledEmployeeDays - coverage.before.notFilledEmployeeDays)],
    ["coverage", "filled %", (coverage.before.filledPct * 100).toFixed(2), (coverage.after.filledPct * 100).toFixed(2), ((coverage.after.filledPct - coverage.before.filledPct) * 100).toFixed(2)],
    ["not booked", "unbooked employee-days (all reasons)", String(notBooked.before.notBookedDays), String(afterUnbookedDays), String(afterUnbookedDays - notBooked.before.notBookedDays)],
    ["not booked", "idle hours", String(notBooked.before.idleHours), String(notBooked.after.idleHours), String(notBooked.after.idleHours - notBooked.before.idleHours)],
    ["not booked", "idle cost", String(notBooked.before.idleCost), String(notBooked.after.idleCost), String(notBooked.after.idleCost - notBooked.before.idleCost)],
    ["not booked", "present but unbooked (days)", "", String(notBooked.after.presentUnbookedDays), ""],
    ["not booked", "absent (days, no cost)", "", String(notBooked.after.absentDays), ""],
    ["not booked", "off (days, no cost)", "", String(notBooked.after.offDays), ""],
    ["not booked", "not covered by register (days)", "", String(notBooked.after.notCoveredDays), ""],
    ["hours", "booked hours", String(hours.beforeTotalHours), String(hours.beforeTotalHours), "0"],
    ["hours", "regular hours", String(hours.beforeTotalHours), String(hours.after.regularHours), String(round2(hours.after.regularHours - hours.beforeTotalHours))],
    ["hours", "holiday hours", "0", String(hours.after.holidayHours), String(hours.after.holidayHours)],
    ["hours", "unverified hours", "0", String(hours.after.unverifiedHours), String(hours.after.unverifiedHours)],
    ["hours", "provisional hours (subset of regular)", "", String(hours.after.provisionalHours), ""],
  ];
}
