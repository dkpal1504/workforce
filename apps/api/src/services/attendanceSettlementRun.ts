import { prisma } from "../db";
import { aggregateRegisterRows, type AttendanceDayFact } from "./attendanceRegister";
import {
  clampRangeToToday,
  fetchRegisterRange,
  registerAggregate,
  todayInAppZone,
  type RegisterFetchResult,
} from "./attendanceRegisterSource";
import { dateTypesFrom } from "./holidayRecon";
import {
  planSettlement,
  type SettlementAnomalies,
  type SettlementPlan,
} from "./attendanceSettlement";
import type { DayType } from "./attendanceRegister";

/**
 * Writing the settled man-days and the calendar.
 *
 * The logic that decides WHAT to write lives in the pure `planSettlement`. This module only does the three
 * things that need a database: read the Employee master, read the human overrides, and upsert — in an
 * order that leaves a visible trail (a run row exists before any day is written, and is closed as OK,
 * PARTIAL or FAILED afterwards).
 *
 * Re-settling is safe by construction: every row is upserted on its natural key (register id + date for a
 * man-day, date for the calendar), the plan's output is deterministic, and a settled_at on an existing row
 * is never rewritten — so repeating last night's window tonight writes the same values and leaves no
 * trace of a second run beyond the run log.
 */

const WRITE_BATCH = 250;
/** Cap on stored unmatched ids: enough to investigate, small enough to keep the JSON column honest. */
const ANOMALY_ID_LIMIT = 200;

export type SettleOptions = {
  from: string;
  to: string;
  /** Plan and report, but write nothing. The way to see a settlement before it exists. */
  dryRun?: boolean;
};

export type SettleResult = {
  from: string;
  to: string;
  requestedTo: string;
  clampedToToday: boolean;
  source: "SQL" | "FIXTURE";
  datedRead: number;
  daysPlanned: number;
  calendarPlanned: number;
  daysWritten: number;
  calendarWritten: number;
  skippedFutureDates: number;
  anomalies: SettlementAnomalies;
  runId: number | null;
  dryRun: boolean;
};

/** Today's settlement window: today and the lookback days before it, clamped never to cross today. */
export function settleWindow(today: string = todayInAppZone(), lookbackDays = 7): { from: string; to: string } {
  const days = Math.max(0, Math.min(90, Math.trunc(lookbackDays)));
  const to = today;
  const fromDate = new Date(`${today}T00:00:00.000Z`);
  fromDate.setUTCDate(fromDate.getUTCDate() - days);
  return { from: fromDate.toISOString().slice(0, 10), to };
}

/** The Employee master, keyed by its ec number, upper-cased and trimmed to match how the register spells ids. */
async function loadEmployeeIds(registerIds: readonly string[]): Promise<Map<string, number>> {
  const byKey = new Map<string, number>();
  if (!registerIds.length) return byKey;
  const rows = await prisma.employee.findMany({
    where: { ecNo: { in: [...registerIds] } },
    select: { id: true, ecNo: true },
  });
  for (const row of rows) byKey.set(row.ecNo.trim().toUpperCase(), row.id);
  // A register id that differs only in case still belongs to the same man; a genuinely absent one does not.
  const missing = registerIds.filter((id) => !byKey.has(id.trim().toUpperCase()));
  if (missing.length) {
    // `mode: "insensitive"` is only valid on equals/contains, not on `in`, so the fallback is an OR of
    // equality tests. It exists because the register and the Employee master are fed by different teams.
    const loose = await prisma.employee.findMany({
      where: { OR: missing.map((id) => ({ ecNo: { equals: id.trim(), mode: "insensitive" as const } })) },
      select: { id: true, ecNo: true },
    });
    for (const row of loose) byKey.set(row.ecNo.trim().toUpperCase(), row.id);
  }
  return byKey;
}

/** Human decisions for the range, as date -> type. PLANT scope only, for now. */
export async function loadOverrides(from: string, to: string): Promise<Map<string, DayType>> {
  const rows = await prisma.calendarException.findMany({
    where: {
      scopeType: "PLANT",
      scopeId: 0,
      workDate: { gte: new Date(`${from}T00:00:00.000Z`), lte: new Date(`${to}T23:59:59.999Z`) },
    },
    select: { workDate: true, dayType: true },
  });
  const byDate = new Map<string, DayType>();
  for (const row of rows) byDate.set(row.workDate.toISOString().slice(0, 10), row.dayType as DayType);
  return byDate;
}

function dayDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

async function writePlan(plan: SettlementPlan, runId: number): Promise<{ daysWritten: number; calendarWritten: number }> {
  let calendarWritten = 0;
  for (const row of plan.calendar) {
    const workDate = dayDate(row.workDate);
    await prisma.workCalendarDate.upsert({
      where: { workDate },
      create: {
        workDate,
        dayType: row.dayType,
        source: row.source,
        employeeRows: row.employeeRows,
        presentRows: row.presentRows,
        absentRows: row.absentRows,
        weeklyOffRows: row.weeklyOffRows,
        holidayFlagRows: row.holidayFlagRows,
        holidayStatusRows: row.holidayStatusRows,
        settledAt: new Date(),
      },
      // settled_at is deliberately NOT refreshed on an existing row: it records when this date was first
      // answered, which is the evidence a reader needs. dayType/source are written again because an
      // override may have appeared or been withdrawn since the last pass.
      update: {
        dayType: row.dayType,
        source: row.source,
        employeeRows: row.employeeRows,
        presentRows: row.presentRows,
        absentRows: row.absentRows,
        weeklyOffRows: row.weeklyOffRows,
        holidayFlagRows: row.holidayFlagRows,
        holidayStatusRows: row.holidayStatusRows,
      },
    });
    calendarWritten += 1;
  }

  let daysWritten = 0;
  for (let index = 0; index < plan.days.length; index += WRITE_BATCH) {
    const batch = plan.days.slice(index, index + WRITE_BATCH);
    await prisma.$transaction(
      batch.map((day) =>
        prisma.attendanceDay.upsert({
          where: { registerId_workDate: { registerId: day.registerId, workDate: dayDate(day.workDate) } },
          create: {
            registerId: day.registerId,
            employeeId: day.employeeId,
            workDate: dayDate(day.workDate),
            dayType: day.dayType,
            attendanceClass: day.attendanceClass,
            status: day.status,
            acceptedHours: day.acceptedHours,
            acceptedOtHours: day.acceptedOtHours,
            registerRows: day.registerRows,
            statusVariants: day.statusVariants,
            runId,
          },
          update: {
            employeeId: day.employeeId,
            dayType: day.dayType,
            attendanceClass: day.attendanceClass,
            status: day.status,
            acceptedHours: day.acceptedHours,
            acceptedOtHours: day.acceptedOtHours,
            registerRows: day.registerRows,
            statusVariants: day.statusVariants,
            runId,
            // settled_at intentionally untouched: it is the first time this man-day was settled.
          },
        })
      )
    );
    daysWritten += batch.length;
  }
  return { daysWritten, calendarWritten };
}

export async function settleAttendance(options: SettleOptions): Promise<SettleResult> {
  const range = clampRangeToToday({ from: options.from, to: options.to });
  if (range.to < range.from) {
    throw new Error(`Settlement range ${options.from}..${options.to} is entirely in the future (today is ${range.to}).`);
  }

  const register: RegisterFetchResult = await fetchRegisterRange({ dateFrom: range.from, dateTo: range.to });
  if (!register.datesRead.length) {
    throw new Error(
      `The attendance register answered for NO date in ${range.from}..${range.to} ` +
        `(${register.errors.length} error(s); first: ${register.errors[0]?.message ?? "none"}). ` +
        "A settlement over no attendance would write fiction, so nothing was written."
    );
  }

  const rawRows = [...register.byDate.values()].flat();
  const facts: AttendanceDayFact[] = aggregateRegisterRows(rawRows, registerAggregate());
  const dateTypes = dateTypesFrom(facts);
  const overrides = await loadOverrides(range.from, range.to);
  for (const [workDate, dayType] of overrides) dateTypes.set(workDate, dayType);

  const employeeIdByRegisterId = await loadEmployeeIds([...new Set(facts.map((fact) => fact.idNo))]);
  const plan = planSettlement({ facts, dateTypes, employeeIdByRegisterId, overrides });

  const base = {
    from: range.from,
    to: range.to,
    requestedTo: range.requestedTo,
    clampedToToday: range.clamped,
    source: register.source,
    datedRead: register.datesRead.length,
    daysPlanned: plan.days.length,
    calendarPlanned: plan.calendar.length,
    skippedFutureDates: register.skippedFutureDates ?? 0,
    anomalies: plan.anomalies,
    dryRun: Boolean(options.dryRun),
  };

  if (options.dryRun) {
    return { ...base, daysWritten: 0, calendarWritten: 0, runId: null };
  }

  const run = await prisma.attendanceSettlementRun.create({
    data: {
      scopeFrom: dayDate(range.from),
      scopeTo: dayDate(range.to),
      status: "RUNNING",
      source: register.source,
    },
  });

  try {
    const { daysWritten, calendarWritten } = await writePlan(plan, run.id);
    const failedDates = plan.anomalies.missingDates.length;
    await prisma.attendanceSettlementRun.update({
      where: { id: run.id },
      data: {
        finishedAt: new Date(),
        status: failedDates > 0 ? "PARTIAL" : "OK",
        datesSettled: plan.calendar.length,
        datesFailed: failedDates,
        rowsWritten: daysWritten,
        anomalies: {
          unmatchedRegisterIds: plan.anomalies.unmatchedRegisterIds.slice(0, ANOMALY_ID_LIMIT),
          unmatchedRegisterIdsTotal: plan.anomalies.unmatchedRegisterIds.length,
          missingDates: plan.anomalies.missingDates.slice(0, ANOMALY_ID_LIMIT),
          missingDatesTotal: plan.anomalies.missingDates.length,
          mixedStatusManDays: plan.anomalies.mixedStatusManDays,
          statusDayTypeConflicts: plan.anomalies.statusDayTypeConflicts,
          presentWithZeroHours: plan.anomalies.presentWithZeroHours,
          skippedFutureDates: base.skippedFutureDates,
        },
      },
    });
    return { ...base, daysWritten, calendarWritten, runId: run.id };
  } catch (error) {
    // The run row is the record that a settlement was attempted and failed. Without it a half-written
    // range would look like a quiet night.
    await prisma.attendanceSettlementRun.update({
      where: { id: run.id },
      data: {
        finishedAt: new Date(),
        status: "FAILED",
        error: error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000),
      },
    });
    throw error;
  }
}

export function formatSettlementSummary(result: SettleResult): string {
  const lines: string[] = [];
  lines.push(result.dryRun ? "ATTENDANCE SETTLEMENT — DRY RUN (nothing written)" : "ATTENDANCE SETTLEMENT");
  lines.push(
    `  range              ${result.from} .. ${result.to}` +
      (result.clampedToToday ? `   (requested to ${result.requestedTo}; clamped to today)` : "")
  );
  lines.push(`  attendance source  ${result.source}   over ${result.datedRead} date(s)`);
  lines.push(`  man-days planned   ${result.daysPlanned}`);
  lines.push(`  calendar dates     ${result.calendarPlanned}`);
  if (result.dryRun) {
    lines.push(`  skipped            nothing was written (dry run)`);
  } else {
    lines.push(`  written            ${result.daysWritten} man-day(s), ${result.calendarWritten} calendar date(s)`);
    lines.push(`  run id             ${result.runId}`);
  }
  if (result.skippedFutureDates) {
    lines.push(`  future dates       ${result.skippedFutureDates} dropped (planning rows, not attendance)`);
  }
  const anomalies = result.anomalies;
  lines.push("");
  lines.push("ANOMALIES RECORDED WITH THE RUN");
  lines.push(`  register id not in Employee master   ${anomalies.unmatchedRegisterIds.length}`);
  lines.push(`  dates the register did not answer    ${anomalies.missingDates.length}`);
  lines.push(`  mixed status on one man-day          ${anomalies.mixedStatusManDays}`);
  lines.push(`  status contradicts the day type      ${anomalies.statusDayTypeConflicts}`);
  lines.push(`  present with 0 accepted hours        ${anomalies.presentWithZeroHours}`);
  return lines.join("\n");
}
