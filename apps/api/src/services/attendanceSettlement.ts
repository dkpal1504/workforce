import {
  classFor,
  type AttendanceClass,
  type AttendanceDayFact,
  type DayType,
  type RegisterStatus,
} from "./attendanceRegister";

/**
 * Turning one settled range of register facts into rows to store.
 *
 * This is deliberately PURE: it takes what the register said, what the Employee master knows, and any
 * human override, and returns exactly the rows that should exist. No database, no dates read from the
 * clock — so a settlement can be tested against the production shapes that caused the bugs (a single
 * flagged row, a mixed-status man-day, an unregistered id) without a database or a live view.
 *
 * Idempotency is a property of the OUTPUT: the same input produces byte-identical rows, and every row has
 * a stable key (`registerId` + `workDate` for a man-day, `workDate` for the calendar). The writer upserts on
 * those keys, so re-settling a week that has not changed writes nothing new.
 */

export type CalendarSource = "REGISTER" | "OVERRIDE" | "DECLARED";

/** One `attendance_day` row, keyed by (registerId, workDate). */
export type SettlementDayWrite = {
  registerId: string;
  /** NULL when the register id has no Employee row — recorded as an anomaly, never invented. */
  employeeId: number | null;
  workDate: string;
  dayType: DayType;
  attendanceClass: AttendanceClass;
  status: string;
  acceptedHours: number;
  acceptedOtHours: number;
  registerRows: number;
  statusVariants: number;
};

/** One `work_calendar_date` row, keyed by workDate. */
export type SettlementCalendarWrite = {
  workDate: string;
  dayType: DayType;
  source: CalendarSource;
  employeeRows: number;
  presentRows: number;
  absentRows: number;
  weeklyOffRows: number;
  holidayFlagRows: number;
  holidayStatusRows: number;
};

export type SettlementAnomalies = {
  /** Register ids with no Employee row. Named, never silently dropped. */
  unmatchedRegisterIds: string[];
  /** Dates inside the range that the register never answered for. A report must say UNKNOWN for these. */
  missingDates: string[];
  /** Man-days whose rows disagreed about the status. */
  mixedStatusManDays: number;
  /** Statuses that contradict the date's type (P/WO on a working day, an HL status on a non-holiday). */
  statusDayTypeConflicts: number;
  /** Marked present with zero accepted hours: a regularization nobody has done, or a feed gap. */
  presentWithZeroHours: number;
};

export type SettlementPlan = {
  days: SettlementDayWrite[];
  calendar: SettlementCalendarWrite[];
  anomalies: SettlementAnomalies;
};

type DateAccumulator = {
  rows: number;
  present: number;
  absent: number;
  weeklyOff: number;
  holidayFlag: number;
  holidayStatus: number;
};

/** Was the man recorded as having been at work, whatever the day type says? */
function isPresentStatus(status: RegisterStatus): boolean {
  return status === "P" || status === "P/WO" || status === "P/HL";
}

function isHolidayStatus(status: RegisterStatus): boolean {
  return status === "P/HL" || status === "A/HL";
}

export function planSettlement(input: {
  /** Register facts for the range, AFTER the date types are known (see `dateTypesFrom`). */
  facts: readonly AttendanceDayFact[];
  /** The resolved type for every date the register answered for, overrides already applied. */
  dateTypes: ReadonlyMap<string, DayType>;
  /** Employee master, keyed by ec number (which is the register's IDNo for associates). */
  employeeIdByRegisterId: ReadonlyMap<string, number>;
  /** Dates a human has ruled on. Their type wins over the register's, and the row says so. */
  overrides?: ReadonlyMap<string, DayType>;
}): SettlementPlan {
  const { facts, dateTypes, employeeIdByRegisterId } = input;
  const overrides = input.overrides ?? new Map<string, DayType>();

  const days: SettlementDayWrite[] = [];
  const byDate = new Map<string, DateAccumulator>();
  const unmatched = new Set<string>();
  let mixedStatusManDays = 0;
  let statusDayTypeConflicts = 0;
  let presentWithZeroHours = 0;

  for (const fact of facts) {
    // A date type must exist for every date the register answered for; falling back to the fact's own
    // (row-level) type is the old bug in disguise, so it is only a last resort for a fixture.
    const dayType = dateTypes.get(fact.workDate) ?? fact.dayType;
    const attendanceClass = classFor(dayType, fact.status);
    const employeeId = employeeIdByRegisterId.get(fact.idNo) ?? null;

    if (employeeId === null) unmatched.add(fact.idNo);
    if ((fact.statusVariants ?? 1) > 1) mixedStatusManDays += 1;
    if (fact.status === "P/WO" && dayType === "WORKING") statusDayTypeConflicts += 1;
    if (isHolidayStatus(fact.status) && dayType !== "HOLIDAY") statusDayTypeConflicts += 1;
    if (isPresentStatus(fact.status) && Number(fact.acceptedManHours ?? 0) <= 0 && Number(fact.acceptedOt ?? 0) <= 0) {
      presentWithZeroHours += 1;
    }

    days.push({
      registerId: fact.idNo,
      employeeId,
      workDate: fact.workDate,
      dayType,
      attendanceClass,
      status: fact.status,
      acceptedHours: Number(fact.acceptedManHours ?? 0),
      acceptedOtHours: Number(fact.acceptedOt ?? 0),
      registerRows: Number(fact.records ?? 1) || 1,
      statusVariants: Number(fact.statusVariants ?? 1) || 1,
    });

    const acc =
      byDate.get(fact.workDate) ??
      { rows: 0, present: 0, absent: 0, weeklyOff: 0, holidayFlag: 0, holidayStatus: 0 };
    acc.rows += 1;
    if (isPresentStatus(fact.status)) acc.present += 1;
    if (fact.status === "A" || fact.status === "A/HL") acc.absent += 1;
    if (fact.isWeeklyOff) acc.weeklyOff += 1;
    if (fact.isHoliday) acc.holidayFlag += 1;
    if (isHolidayStatus(fact.status)) acc.holidayStatus += 1;
    byDate.set(fact.workDate, acc);
  }

  const calendar: SettlementCalendarWrite[] = [];
  for (const [workDate, acc] of byDate) {
    const dayType = dateTypes.get(workDate);
    if (!dayType) continue; // the register answered for rows we could not date: nothing to assert.
    calendar.push({
      workDate,
      dayType,
      source: overrides.has(workDate) ? "OVERRIDE" : "REGISTER",
      employeeRows: acc.rows,
      presentRows: acc.present,
      absentRows: acc.absent,
      weeklyOffRows: acc.weeklyOff,
      holidayFlagRows: acc.holidayFlag,
      holidayStatusRows: acc.holidayStatus,
    });
  }

  // A date the register never answered for is a hole, not a working day with zero attendance.
  const missingDates = [...dateTypes.keys()].filter((workDate) => !byDate.has(workDate));

  // Deterministic order: the writer's upserts and any later content hash depend on it.
  days.sort((left, right) =>
    left.workDate === right.workDate
      ? left.registerId.localeCompare(right.registerId)
      : left.workDate.localeCompare(right.workDate)
  );
  calendar.sort((left, right) => left.workDate.localeCompare(right.workDate));

  return {
    days,
    calendar,
    anomalies: {
      unmatchedRegisterIds: [...unmatched].sort(),
      missingDates: missingDates.sort(),
      mixedStatusManDays,
      statusDayTypeConflicts,
      presentWithZeroHours,
    },
  };
}
