import { prisma } from "../db";

/**
 * Which (employee, date) pairs a report is allowed to divide by.
 *
 * THE CUSTOMER'S RULE (2026-10-24): every worker can have a different weekly off, so a yard-wide calendar
 * cannot say who was expected to work. LabourWorks already answers it per man: his day is a WORKING day for
 * HIM when `OriginalStatus` is `P`, `P/HL` or `P/WO`. A day he was absent, on his weekly off, or on a
 * holiday is not a day he owed a timesheet — so it must not appear as a day he failed to fill one in.
 *
 * This replaces the plant calendar as the DENOMINATOR (the calendar still exists, and is still the right
 * thing to show a reader as "the yard's day", but it no longer decides who owed what).
 *
 * Two fallbacks, both chosen so a report never looks better than the truth:
 *   - SETTLE_REPORTS off        -> every pair (calendar days), i.e. today's numbers exactly
 *   - an employee with no settled rows in the range -> his calendar days, and he is named
 */

export type SettledCoverageMode = "CALENDAR" | "SETTLED";

export type SettledCoverage = {
  mode: SettledCoverageMode;
  /**
   * `employeeId:date` for every pair the report includes, or NULL in calendar mode (include everything).
   */
  pairs: Set<string> | null;
  /** The dates each employee owes, for callers that work per person (Not booked). NULL in calendar mode. */
  daysByEmployee: Map<number, string[]> | null;
  /** Employees with no settled attendance at all in the range: they keep their calendar days. */
  employeesOnCalendarDays: number[];
  /** How many (employee, date) pairs the report now divides by. */
  pairCount: number;
};

export function settleReportsEnabled(): boolean {
  return String(process.env.SETTLE_REPORTS || "false").toLowerCase() === "true";
}

/** Attendance classes that mean "he was here": the source said P, P/HL or P/WO. */
const WORKED_CLASSES = new Set(["WORKED", "WORKED_WEEKLY_OFF", "WORKED_HOLIDAY"]);

/**
 * The decision, pure, so the states that matter are testable without a database: a man with a different
 * weekly off, a man with no settled data at all, and the flag being off.
 */
export function chooseSettledCoverage(input: {
  mode: SettledCoverageMode;
  employeeIds: readonly number[];
  rangeDays: readonly string[];
  /** Settled rows for the range: one per man-day, with the class the settlement decided. */
  settled: ReadonlyArray<{ employeeId: number; date: string; attendanceClass: string }>;
}): SettledCoverage {
  const { mode, employeeIds, rangeDays, settled } = input;

  if (mode === "CALENDAR" || employeeIds.length === 0 || rangeDays.length === 0) {
    return {
      mode: "CALENDAR",
      pairs: null,
      daysByEmployee: null,
      employeesOnCalendarDays: [],
      pairCount: employeeIds.length * rangeDays.length,
    };
  }

  const byEmployee = new Map<number, string[]>();
  for (const row of settled) {
    if (!WORKED_CLASSES.has(row.attendanceClass)) continue;
    const list = byEmployee.get(row.employeeId);
    if (list) list.push(row.date);
    else byEmployee.set(row.employeeId, [row.date]);
  }
  const settledIds = new Set(settled.map((row) => row.employeeId));

  const pairs = new Set<string>();
  const daysByEmployee = new Map<number, string[]>();
  const employeesOnCalendarDays: number[] = [];

  for (const employeeId of employeeIds) {
    if (!settledIds.has(employeeId)) {
      // No settled attendance for this man in the range: keep his calendar days rather than dropping him
      // out of the report, and name him so the reason is visible.
      employeesOnCalendarDays.push(employeeId);
      for (const day of rangeDays) pairs.add(`${employeeId}:${day}`);
      daysByEmployee.set(employeeId, [...rangeDays]);
      continue;
    }
    const days = byEmployee.get(employeeId) ?? [];
    // An employee whose settled rows say he worked no day at all keeps his calendar days too: a report that
    // silently showed him owing nothing would hide the very gap this report exists to find.
    const effective = days.length ? days : [...rangeDays];
    daysByEmployee.set(employeeId, effective);
    for (const day of effective) pairs.add(`${employeeId}:${day}`);
  }

  // Everyone fell back: say so, and behave exactly like calendar mode so no number is left ambiguous.
  if (employeesOnCalendarDays.length === employeeIds.length) {
    return {
      mode: "CALENDAR",
      pairs: null,
      daysByEmployee: null,
      employeesOnCalendarDays,
      pairCount: employeeIds.length * rangeDays.length,
    };
  }

  return {
    mode: "SETTLED",
    pairs,
    daysByEmployee,
    employeesOnCalendarDays,
    pairCount: pairs.size,
  };
}

/** Read the settled man-days for a range, then decide. */
export async function settledCoverageFor(
  employeeIds: readonly number[],
  rangeDays: readonly string[],
  options: { mode?: SettledCoverageMode } = {}
): Promise<SettledCoverage> {
  const mode: SettledCoverageMode = options.mode ?? (settleReportsEnabled() ? "SETTLED" : "CALENDAR");
  if (mode === "CALENDAR" || !employeeIds.length || !rangeDays.length) {
    return chooseSettledCoverage({ mode: "CALENDAR", employeeIds, rangeDays, settled: [] });
  }

  const rows = await prisma.attendanceDay.findMany({
    where: {
      employeeId: { in: [...employeeIds] },
      workDate: {
        gte: new Date(`${rangeDays[0]}T00:00:00.000Z`),
        lte: new Date(`${rangeDays[rangeDays.length - 1]}T00:00:00.000Z`),
      },
    },
    select: { employeeId: true, workDate: true, attendanceClass: true },
  });

  return chooseSettledCoverage({
    mode,
    employeeIds,
    rangeDays,
    settled: rows
      .filter((row) => row.employeeId != null)
      .map((row) => ({
        employeeId: row.employeeId as number,
        date: row.workDate.toISOString().slice(0, 10),
        attendanceClass: row.attendanceClass,
      })),
  });
}
