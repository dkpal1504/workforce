import { prisma } from "../db";

/**
 * Which dates a report may divide by.
 *
 * Every report in this application was built over CALENDAR days. That is right for a factory that works
 * every day and wrong for this yard, which works six days a week and closes for festivals: a Sunday was
 * counted as 599 unfilled employee-days, and a holiday's hours were counted as project manhours.
 *
 * The settled calendar (`work_calendar_date`, written by the nightly settlement) answers the question
 * properly. This module decides — in one place, once — which dates a report uses, and it FAILS SAFE:
 *
 *   SETTLE_REPORTS=false            -> calendar days (today's behaviour, byte for byte)
 *   SETTLE_REPORTS=true, calendar   -> the settled working days for the whole range
 *   SETTLE_REPORTS=true, PARTIAL    -> calendar days, and the response says which dates are unsettled
 *
 * The fallback is deliberately the LARGER denominator. Settling three days of a thirty-day range would
 * otherwise shrink the denominator and make coverage look better than it is — the one direction a report
 * must never fail in.
 */

export type ReportCalendarMode = "CALENDAR" | "SETTLED";

export type ReportCalendar = {
  mode: ReportCalendarMode;
  /** ISO dates the report divides by, in ascending order. */
  days: string[];
  /** Dates in the range the settled calendar has no verdict for. Non-empty only on a fallback. */
  unsettledDates: string[];
  /** True when the mode asked for SETTLED but the calendar could not answer for the whole range. */
  fellBack: boolean;
};

/** Is the settled calendar switched on for reports? Off unless an operator says otherwise. */
export function settleReportsEnabled(): boolean {
  return String(process.env.SETTLE_REPORTS || "false").toLowerCase() === "true";
}

/**
 * The decision, kept pure so it can be tested against the exact states that matter: no calendar at all,
 * a partial calendar, a whole calendar, and a holiday falling on a Sunday.
 */
export function chooseReportDays(input: {
  rangeDays: readonly string[];
  mode: ReportCalendarMode;
  /** date -> day type, for whatever the calendar actually knows. */
  calendar: ReadonlyMap<string, string>;
}): ReportCalendar {
  const { rangeDays, mode, calendar } = input;

  if (mode === "CALENDAR") {
    return { mode: "CALENDAR", days: [...rangeDays], unsettledDates: [], fellBack: false };
  }

  const unsettledDates = rangeDays.filter((day) => !calendar.has(day));
  const workingDays = rangeDays.filter((day) => calendar.get(day) === "WORKING");

  if (unsettledDates.length > 0) {
    return { mode: "CALENDAR", days: [...rangeDays], unsettledDates, fellBack: true };
  }
  if (workingDays.length === 0) {
    // A range with no working day at all (a plant shutdown): an empty report is honest, but dividing by
    // zero is not, so the caller still gets the calendar days and the reason.
    return { mode: "SETTLED", days: [], unsettledDates: [], fellBack: false };
  }
  return { mode: "SETTLED", days: workingDays, unsettledDates: [], fellBack: false };
}

/** Read the settled calendar for a range, then decide. */
export async function reportCalendarFor(
  rangeDays: readonly string[],
  options: { mode?: ReportCalendarMode } = {}
): Promise<ReportCalendar> {
  const mode: ReportCalendarMode = options.mode ?? (settleReportsEnabled() ? "SETTLED" : "CALENDAR");
  if (mode === "CALENDAR" || rangeDays.length === 0) {
    return chooseReportDays({ rangeDays, mode: "CALENDAR", calendar: new Map() });
  }

  const rows = await prisma.workCalendarDate.findMany({
    where: {
      workDate: {
        gte: new Date(`${rangeDays[0]}T00:00:00.000Z`),
        lte: new Date(`${rangeDays[rangeDays.length - 1]}T00:00:00.000Z`),
      },
    },
    select: { workDate: true, dayType: true },
  });
  const calendar = new Map<string, string>();
  for (const row of rows) calendar.set(row.workDate.toISOString().slice(0, 10), row.dayType);
  return chooseReportDays({ rangeDays, mode, calendar });
}
