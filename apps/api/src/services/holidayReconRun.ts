/**
 * The reconciliation RUNNER — the database reads and the report shape, compiled into `dist` so a thin
 * `scripts/holiday-hours-recon.mjs` can run it inside the production api container.
 *
 * WHY A SERVICE AND NOT THE SCRIPT: the runtime image installs `npm ci --omit=dev`, so `tsx` does not
 * exist there; every operator script in this repo (create-first-admin.mjs, sync-labourworks.mjs) is a
 * thin `.mjs` importing `../dist/services/...`. Putting the logic here also makes the CSV shapes and the
 * printed summary unit-testable, which a top-level script is not.
 *
 * READ-ONLY CONTRACT: SELECT only, both databases. No INSERT/UPDATE, no schema change, no flag flipped.
 * Any future write belongs in the settlement service, not here.
 */

import { getMaxDailyHours } from "../config";
import { prisma } from "../db";
import { aggregateRegisterRows, clockedHoursOf, type AttendanceDayFact } from "./attendanceRegister";
import {
  clampRangeToToday,
  fetchRegisterRange,
  registerAggregate,
  suggestColumnNames,
  todayInAppZone,
  type RegisterFetchResult,
} from "./attendanceRegisterSource";
import { bookedHoursFromEntry } from "./holidayHours";
import {
  dayKey,
  summariseDates,
  summariseEmployeeDays,
  summariseJobOrders,
  summariseSurfaces,
  surfaceCsvRows,
  type ReconBooking,
  type ReconDateRow,
  type ReconEmployeeDayRow,
  type ReconJobOrderRow,
  type ReconPerson,
  type ReconSurfaces,
} from "./holidayRecon";
import { BOOKED_HOURS_STATUSES } from "./portfolioReporting";

/** `to` is clamped to today: the register's future rows are planning rows, never attendance. */
export type ReconOptions = { from: string; to: string };

export type ReconAnomalies = {
  /** Register ids with no `Employee` row: a master-data gap, not an attendance problem. */
  unmatchedIdNos: string[];
  statusContradictsDayType: number;
  mixedStatusRows: number;
  presentZeroHours: number;
  /** Man-days where SUM and MAX disagree — the evidence that settles the aggregation policy. */
  sumMaxDisagreements: number;
  bookedWithoutRegisterRow: number;
};

export type ReconResult = {
  from: string;
  /** The effective end date: never later than today. */
  to: string;
  /** What the caller asked for, so a clamp is visible rather than silent. */
  requestedTo: string;
  clampedToToday: boolean;
  skippedFutureDates: number;
  source: RegisterFetchResult["source"];
  aggregate: ReturnType<typeof registerAggregate>;
  registerRows: number;
  datesRead: number;
  readErrors: Array<{ date: string; message: string }>;
  people: number;
  sheets: number;
  bookings: number;
  maxDailyHours: number;
  dates: ReconDateRow[];
  employeeDays: ReconEmployeeDayRow[];
  jobOrders: ReconJobOrderRow[];
  surfaces: ReconSurfaces;
  anomalies: ReconAnomalies;
};

/**
 * Read both sides and reconcile them. Throws when the register returns nothing at all: a reconciliation
 * over an unread register would present "every day unsettled" as a finding, which is the one outcome the
 * customer must never be shown.
 */
export async function runHolidayRecon(options: ReconOptions): Promise<ReconResult> {
  const maxDailyHours = getMaxDailyHours();
  // A future date can only hold planning rows, so the whole run stops at today (IST — see
  // `todayInAppZone`; the UTC date would be yesterday for a 02:00 job).
  const range = clampRangeToToday({ from: options.from, to: options.to });
  if (range.clamped && range.to < range.from) {
    throw new Error(`--to ${options.to} is in the future and --from ${options.from} is after today (${range.to}).`);
  }
  const fromDate = new Date(`${range.from}T00:00:00.000Z`);
  const toDate = new Date(`${range.to}T23:59:59.999Z`);

  const employees = await prisma.employee.findMany({
    where: { active: true, employmentType: "CLMS" },
    select: {
      id: true,
      ecNo: true,
      name: true,
      category: true,
      department: { select: { name: true } },
      sectionAssignment: { select: { section: { select: { name: true } } } },
    },
    orderBy: { ecNo: "asc" },
  });
  const people: ReconPerson[] = employees.map((employee) => ({
    employeeId: employee.id,
    ecNo: employee.ecNo.trim().toUpperCase(),
    name: employee.name,
    department: employee.department?.name ?? "",
    section: employee.sectionAssignment?.section?.name ?? "",
    category: employee.category,
  }));
  const employeeByEcNo = new Map(people.map((person) => [person.ecNo, person]));

  const register = await fetchRegisterRange({ dateFrom: range.from, dateTo: range.to });
  const rawRows = [...register.byDate.values()].flat();
  if (rawRows.length === 0) {
    const firstError = register.errors[0]?.message ?? "no rows returned and no error reported";
    // When the failure was an unknown column, print the column list the view DOES have plus a suggested
    // mapping. That turns "check your column names" into a copy-paste answer, and every one of these is an
    // ENV override — so fixing it needs no rebuild.
    const columns = register.availableColumns ?? [];
    const hint = columns.length
      ? `\n\nThe view has these columns: ${columns.join(", ")}\n` +
        `Suggested mapping (confirm before using): ${JSON.stringify(suggestColumnNames(columns))}\n` +
        "Set the matching ATTENDANCE_DB_*_COLUMN variable(s) and re-run — no rebuild required."
      : "";
    throw new Error(
      `The attendance register returned NO rows for ${options.from}..${options.to} (source ${register.source}, ` +
        `dates read ${register.datesRead.length}, errors ${register.errors.length}). First error: ${firstError}. ` +
        "A reconciliation over no attendance would be fiction, so nothing was produced." +
        hint
    );
  }
  const facts: AttendanceDayFact[] = aggregateRegisterRows(rawRows, registerAggregate());
  const factByEcDay = new Map(facts.map((fact) => [dayKey(fact.idNo, fact.workDate), fact]));

  const [sheetRows, entryRows, rates] = await Promise.all([
    prisma.timesheetDay.findMany({
      where: { workDate: { gte: fromDate, lte: toDate } },
      select: { employeeId: true, workDate: true },
    }),
    prisma.timesheetEntry.findMany({
      where: { workDate: { gte: fromDate, lte: toDate }, status: { in: [...BOOKED_HOURS_STATUSES] } },
      select: {
        id: true,
        employeeId: true,
        workDate: true,
        status: true,
        otHours: true,
        shiftSlot: true,
        hourSlot: true,
        jobOrderId: true,
        employee: { select: { ecNo: true, name: true } },
        project: { select: { code: true } },
        projectWbs: { select: { wbsCode: true } },
        jobOrder: { select: { code: true } },
      },
    }),
    prisma.costRate.findMany({ orderBy: { effectiveFrom: "desc" } }),
  ]);

  const sheetDays = new Set(sheetRows.map((row) => dayKey(row.employeeId, row.workDate.toISOString().slice(0, 10))));

  const bookings: ReconBooking[] = entryRows.map((entry) => {
    const workDate = entry.workDate.toISOString().slice(0, 10);
    const ecNo = entry.employee.ecNo.trim().toUpperCase();
    const fact = factByEcDay.get(dayKey(ecNo, workDate));
    return {
      entryId: entry.id,
      employeeId: entry.employeeId,
      ecNo,
      employeeName: entry.employee.name,
      workDate,
      status: entry.status,
      hours: bookedHoursFromEntry(entry),
      jobOrderId: entry.jobOrderId,
      jobOrderCode: entry.jobOrder?.code ?? null,
      projectCode: entry.project?.code ?? null,
      wbsCode: entry.projectWbs?.wbsCode ?? null,
      attendanceClass: fact?.attendanceClass ?? null,
      dayType: fact?.dayType ?? null,
      registerStatus: fact?.status ?? null,
      clockedHours: fact ? clockedHoursOf(fact) : null,
      acceptedOt: fact?.acceptedOt ?? null,
    };
  });

  const rateFor = (category: string): number => {
    const row = rates.find((rate) => rate.category === category);
    return row ? Number(row.ratePerHour) : 0;
  };

  const bookedByDate = new Map<string, number>();
  for (const booking of bookings) {
    bookedByDate.set(booking.workDate, (bookedByDate.get(booking.workDate) ?? 0) + booking.hours);
  }

  const unmatchedIdNos = [...new Set(facts.filter((fact) => !employeeByEcNo.has(fact.idNo)).map((fact) => fact.idNo))].sort();

  return {
    from: range.from,
    to: range.to,
    requestedTo: range.requestedTo,
    clampedToToday: range.clamped,
    skippedFutureDates: register.skippedFutureDates ?? 0,
    source: register.source,
    aggregate: registerAggregate(),
    registerRows: rawRows.length,
    datesRead: register.datesRead.length,
    readErrors: register.errors,
    people: people.length,
    sheets: sheetRows.length,
    bookings: bookings.length,
    maxDailyHours,
    dates: summariseDates(facts, bookedByDate),
    employeeDays: summariseEmployeeDays(bookings),
    jobOrders: summariseJobOrders(bookings),
    surfaces: summariseSurfaces({
      from: range.from,
      to: range.to,
      facts,
      bookings,
      people,
      sheetDays,
      maxDailyHours,
      rateFor,
    }),
    anomalies: {
      unmatchedIdNos,
      statusContradictsDayType: facts.filter((fact) => fact.statusDayTypeConflict).length,
      mixedStatusRows: facts.filter((fact) => fact.mixedStatus).length,
      presentZeroHours: facts.filter(
        (fact) =>
          (fact.status === "P" || fact.status === "P/WO" || fact.status === "P/HL") &&
          (fact.acceptedManHours ?? 0) === 0
      ).length,
      sumMaxDisagreements: facts.filter(
        (fact) => fact.distinctHourValues > 1 && fact.acceptedManHoursSum !== fact.acceptedManHoursMax
      ).length,
      bookedWithoutRegisterRow: bookings.filter((booking) => booking.attendanceClass == null).length,
    },
  };
}

/** Close the pool so an operator script exits instead of hanging on an open handle. */
export async function closeReconDb(): Promise<void> {
  await prisma.$disconnect();
}

function fmt(value: number): string {
  return value.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

/** The block a human reads. Every line names the number behind it; nothing is asserted without one. */
export function renderReconSummary(result: ReconResult): string[] {
  const { surfaces, anomalies } = result;
  const lines: string[] = [];
  lines.push("");
  lines.push("HOLIDAY-HOURS RECONCILIATION (read-only — nothing was written to the databases)");
  lines.push(
    `  range              ${result.from} .. ${result.to}` +
      (result.clampedToToday
        ? `   (requested to ${result.requestedTo}; clamped to today — future rows are planning rows, not attendance)`
        : "")
  );
  lines.push(
    `  attendance source  ${result.source}${result.source === "FIXTURE" ? "  (SYNTHETIC — not the yard's data)" : ""}`
  );
  lines.push(`  register rows      ${fmt(result.registerRows)} across ${fmt(result.datesRead)} date(s)`);
  lines.push(
    `  hours aggregate    ${result.aggregate}  (SUM and MAX disagree on ${fmt(anomalies.sumMaxDisagreements)} man-day(s))`
  );
  lines.push(`  roster counted     ${fmt(result.people)} active CLMS employee(s)`);
  lines.push(`  sheets in range    ${fmt(result.sheets)} employee-day(s)`);
  lines.push(`  bookings in range  ${fmt(result.bookings)} row(s), ${fmt(surfaces.hours.beforeTotalHours)} h`);
  if (result.readErrors.length) {
    lines.push(`  READ ERRORS        ${fmt(result.readErrors.length)} date(s): ${result.readErrors[0].message.slice(0, 160)}`);
  }
  lines.push("");
  lines.push("RANGE");
  lines.push(`  calendar days      ${fmt(surfaces.range.calendarDays)}`);
  lines.push(
    `  working days       ${fmt(surfaces.range.workingDays)}   (weekly off ${surfaces.range.weeklyOffDays} + holiday ${surfaces.range.holidayDays})`
  );
  lines.push(`  not covered        ${fmt(surfaces.range.uncoveredDays)} date(s) the register did not answer for`);
  lines.push("");
  lines.push("TIMESHEET COVERAGE");
  lines.push(
    `  expected days      ${fmt(surfaces.coverage.before.expectedEmployeeDays)} -> ${fmt(surfaces.coverage.after.expectedEmployeeDays)}  (removed ${fmt(surfaces.coverage.removedEmployeeDays)})`
  );
  lines.push(
    `  filled days        ${fmt(surfaces.coverage.before.filledEmployeeDays)} -> ${fmt(surfaces.coverage.after.filledEmployeeDays)}`
  );
  lines.push(
    `  not filled         ${fmt(surfaces.coverage.before.notFilledEmployeeDays)} -> ${fmt(surfaces.coverage.after.notFilledEmployeeDays)}`
  );
  lines.push(
    `  filled %           ${(surfaces.coverage.before.filledPct * 100).toFixed(2)}% -> ${(surfaces.coverage.after.filledPct * 100).toFixed(2)}%`
  );
  lines.push("");
  lines.push("NOT BOOKED");
  lines.push(
    `  unbooked days      ${fmt(surfaces.notBooked.before.notBookedDays)} -> ${fmt(surfaces.notBooked.after.presentUnbookedDays)} present-but-unbooked` +
      ` (+ ${fmt(surfaces.notBooked.after.absentDays)} absent, ${fmt(surfaces.notBooked.after.offDays)} off, ` +
      `${fmt(surfaces.notBooked.after.notCoveredDays)} not covered)`
  );
  lines.push(
    `  idle hours         ${fmt(surfaces.notBooked.before.idleHours)} -> ${fmt(surfaces.notBooked.after.idleHours)}`
  );
  lines.push(
    `  idle cost          ${fmt(surfaces.notBooked.before.idleCost)} -> ${fmt(surfaces.notBooked.after.idleCost)}` +
      (surfaces.notBooked.before.idleCost === 0 ? "  (no cost rate configured — set one under Cost rates)" : "")
  );
  lines.push("");
  lines.push("BOOKED HOURS");
  lines.push(`  today              ${fmt(surfaces.hours.beforeTotalHours)} h, all counted as project manhours`);
  lines.push(
    `  proposed           regular ${fmt(surfaces.hours.after.regularHours)} h + holiday ${fmt(surfaces.hours.after.holidayHours)} h ` +
      `+ unverified ${fmt(surfaces.hours.after.unverifiedHours)} h = ${fmt(surfaces.hours.after.totalHours)} h`
  );
  lines.push(`  removed from regular ${fmt(surfaces.hours.removedFromRegular)} h`);
  lines.push(
    `  provisional        ${fmt(surfaces.hours.after.provisionalHours)} h (day not settled against attendance yet)`
  );
  lines.push("");
  lines.push("ANOMALIES TO LOOK AT");
  lines.push(`  register id not in Employee master   ${fmt(anomalies.unmatchedIdNos.length)}`);
  lines.push(`  status contradicts the day type      ${fmt(anomalies.statusContradictsDayType)}`);
  lines.push(`  mixed status on one man-day          ${fmt(anomalies.mixedStatusRows)}`);
  lines.push(`  present with 0 accepted hours        ${fmt(anomalies.presentZeroHours)}`);
  lines.push(`  booked with no register row          ${fmt(anomalies.bookedWithoutRegisterRow)}`);
  lines.push("");
  return lines;
}

/** The CSV files, as `[name, rows]` — the caller writes them. Shapes are pinned by a test. */
export function reconCsvFiles(result: ReconResult): Array<{ name: string; rows: Array<Array<unknown>> }> {
  return [
    {
      name: "01-dates.csv",
      rows: [
        [
          "date",
          "day_type",
          "is_weekly_off",
          "employees_with_row",
          "present",
          "absent",
          "off",
          "unknown",
          "status_P",
          "status_P_WO",
          "status_P_HL",
          "status_A",
          "status_A_HL",
          "present_zero_hours",
          "conflicts",
          "booked_hours_app",
          "clocked_hours_register",
        ],
        ...result.dates.map((row) => [
          row.workDate,
          row.dayType,
          row.isWeeklyOff ? 1 : 0,
          row.employeesWithRow,
          row.present,
          row.absent,
          row.off,
          row.unknown,
          row.statusCounts.P ?? 0,
          row.statusCounts["P/WO"] ?? 0,
          row.statusCounts["P/HL"] ?? 0,
          row.statusCounts.A ?? 0,
          row.statusCounts["A/HL"] ?? 0,
          row.presentZeroHours,
          row.conflicts,
          row.bookedHours,
          row.clockedHours,
        ]),
      ],
    },
    {
      name: "02-employee-days.csv",
      rows: [
        [
          "date",
          "ec_no",
          "employee",
          "day_type",
          "register_status",
          "class",
          "booked_hours",
          "clocked_hours",
          "accepted_ot",
          "variance_booked_minus_clocked",
          "sheet_statuses",
          "job_orders",
        ],
        ...result.employeeDays.map((row) => [
          row.workDate,
          row.ecNo,
          row.employeeName,
          row.dayType ?? "NO_REGISTER",
          row.registerStatus ?? "",
          row.attendanceClass ?? "PROVISIONAL",
          row.bookedHours,
          row.clockedHours ?? "",
          row.acceptedOt ?? "",
          row.variance ?? "",
          row.statuses,
          row.jobOrders,
        ]),
      ],
    },
    {
      name: "03-job-orders.csv",
      rows: [
        [
          "job_order_id",
          "job_order",
          "project",
          "wbs",
          "booked_hours",
          "regular_hours_after",
          "holiday_hours_removed",
          "unverified_hours_removed",
          "provisional_hours",
          "rows",
          "holiday_rows",
          "unverified_rows",
        ],
        ...result.jobOrders.map((row) => [
          row.jobOrderId ?? "",
          row.jobOrderCode ?? "",
          row.projectCode ?? "",
          row.wbsCode ?? "",
          row.bookedHours,
          row.regularHours,
          row.holidayHours,
          row.unverifiedHours,
          row.provisionalHours,
          row.rows,
          row.holidayRows,
          row.unverifiedRows,
        ]),
      ],
    },
    { name: "04-surfaces.csv", rows: surfaceCsvRows(result.surfaces) },
    {
      name: "05-anomalies.csv",
      rows: [
        ["kind", "date", "ec_no", "detail"],
        ...result.anomalies.unmatchedIdNos.map((idNo) => [
          "NOT_IN_EMPLOYEE_MASTER",
          "",
          idNo,
          "attendance register row has no matching Employee.ecNo",
        ]),
        ["STATUS_CONTRADICTS_DAY_TYPE", "", "", `${result.anomalies.statusContradictsDayType} man-day(s) — see the day-type screen`],
        ["MIXED_STATUS_ROWS", "", "", `${result.anomalies.mixedStatusRows} man-day(s) with more than one OriginalStatus`],
        ["PRESENT_ZERO_HOURS", "", "", `${result.anomalies.presentZeroHours} man-day(s) present with AcceptedManHrs 0/NULL (regularisation pending)`],
        ["SUM_AND_MAX_DISAGREE", "", "", `${result.anomalies.sumMaxDisagreements} man-day(s) — the evidence for ATTENDANCE_HOURS_AGGREGATE`],
        ["BOOKED_WITHOUT_REGISTER_ROW", "", "", `${result.anomalies.bookedWithoutRegisterRow} booking row(s) with no attendance row (provisional)`],
      ],
    },
  ];
}
