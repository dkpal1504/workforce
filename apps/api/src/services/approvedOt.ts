/**
 * APPROVED overtime, read from CLMS LabourWorks — one figure per employee-day.
 *
 * WHAT THIS FIXES. The overtime a supervisor punches is what he believes was worked; the
 * overtime CLMS approves is what is paid. `[AcceptedOT]` in
 * `[LabourWorks].[dbo].[Report_Attendance_View]` is that approved figure, and it exists for
 * the same `IDNo` and `Date` the timesheet already carries. This module matches those two
 * and stamps `timesheet_days.approved_ot_hours`, which is the OT figure every screen and
 * report must read. The punch is kept on the entry row as the captured reference, never as
 * the OT number.
 *
 * THE THREE RULES, each a decision rather than an inference:
 *   1. ZERO IS AN ANSWER. A day with no CLMS row, or a row whose `AcceptedOT` is NULL, is
 *      stamped 0 — "CLMS approved no overtime". It never falls back to the supervisor's
 *      punch, because falling back would silently pay unapproved overtime on exactly the
 *      days CLMS has not regularised yet. NULL stays "never fetched", which is a different
 *      fact and must not be printed as 0.
 *   2. A MANUAL VALUE IS AN ADMIN DECISION. Rows whose `approved_ot_source` is MANUAL are
 *      never read, overwritten or even counted as unchanged by any refresh.
 *   3. THE READ IS PER DATE, NOT PER SHEET. One query answers a whole date for the plant,
 *      so a 14-day window costs 14 queries however many sheets were submitted.
 *
 * SEPARATE FROM THE CLOCKED-HOURS READER (`attendanceHours.ts`): that one reads
 * `Report_Attendance_Intermediate` for `ManHours`. This one reads
 * `Report_Attendance_View.AcceptedOT`. Both point at the same server and database, and the
 * view and column names come from the SAME configuration, so a rename is one change.
 *
 * The write path is idempotent: a second run over the same CLMS data writes nothing and only
 * refreshes `approved_ot_checked_at`.
 */

import fs from "node:fs/promises";
import sql from "mssql";
import { prisma } from "../db";
import {
  attendanceSourceConfig,
  explainSourceError,
  NON_DRAFT_STATUSES,
  quoteIdentifier,
  quoteView,
} from "./attendanceHours";
import {
  registerAggregate,
  registerColumns,
  registerViewName,
  todayInAppZone,
} from "./attendanceRegisterSource";
import { parseCsv } from "./csvParser";

function envValue(name: string): string {
  return (process.env[name] ?? "").trim();
}

/**
 * The view and column the approved OT comes from.
 *
 * DELIBERATELY THE SAME SOURCE AS THE ATTENDANCE REGISTER: `Report_Attendance_View` and
 * `[AcceptedOT]`. Pointing this at its own variable would let the register and the approved
 * OT drift onto two different objects after one config change, which is the failure mode
 * this codebase already documents for the clocked-hours view.
 */
export function approvedOtSource() {
  const columns = registerColumns();
  return {
    view: registerViewName(),
    idColumn: columns.id,
    otColumn: columns.acceptedOt,
    dateColumn: columns.date,
    /** SUM (default) or MAX, the same policy the settlement uses for the register. */
    aggregate: registerAggregate(),
  };
}

/**
 * The SQL for one work date.
 *
 * NO POPULATION FILTER, deliberately: the settlement filter drops terminated workers, but
 * a man terminated last week still has sheets from the week before and his approved OT for
 * those days must still be read. The join to `employees` happens in the application against
 * ecNo, so a contractor id simply finds no sheet.
 */
export function approvedOtSql(): string {
  const override = envValue("APPROVED_OT_QUERY");
  if (override) return override;
  const source = approvedOtSource();
  const view = quoteView(source.view);
  const id = quoteIdentifier(source.idColumn, "ATTENDANCE_DB_ID_COLUMN");
  const ot = quoteIdentifier(source.otColumn, "ATTENDANCE_DB_ACCEPTED_OT_COLUMN");
  const date = quoteIdentifier(source.dateColumn, "ATTENDANCE_DB_DATE_COLUMN");
  const figure = source.aggregate === "MAX" ? `MAX(${ot})` : `SUM(${ot})`;
  return (
    `SELECT ${id} AS IdNo, ${figure} AS ApprovedOT, COUNT(*) AS Records ` +
    `FROM ${view} WHERE CAST(${date} AS date) = CAST(@workDate AS date) GROUP BY ${id}`
  );
}

/** One employee-day's approved overtime, as the source states it. */
export type ApprovedOtReading = {
  ecNo: string;
  /** NULL when the source carries no figure for him that day. Callers stamp it as 0. */
  hours: number | null;
  /** Source rows that produced the figure; 2+ means a split day. */
  records: number;
};

export type ApprovedOtForDate = Map<string, ApprovedOtReading>;

/** `8.5` / `"8.5"` / `" 8,5 "` -> 8.5; anything unparseable -> null. */
export function parseApprovedOt(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = String(value).trim().replace(",", ".");
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Rows -> one reading per ecNo, keyed upper-cased and trimmed to match how sheets spell it. */
export function approvedOtByEcNo(rows: { IdNo?: unknown; ApprovedOT?: unknown; Records?: unknown }[]): ApprovedOtForDate {
  const map: ApprovedOtForDate = new Map();
  for (const row of rows) {
    const ecNo = String(row.IdNo ?? "").trim().replace(/\s+/g, " ");
    if (!ecNo) continue;
    const key = ecNo.toUpperCase();
    const hours = parseApprovedOt(row.ApprovedOT);
    const records = Number(row.Records ?? 1) || 1;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, { ecNo, hours, records });
      continue;
    }
    // Two source rows for one id: add the figures, but a null stays null only when BOTH are null.
    map.set(key, {
      ecNo: existing.ecNo,
      hours: hours == null ? existing.hours : (existing.hours ?? 0) + hours,
      records: existing.records + records,
    });
  }
  return map;
}

/** Is a local fixture configured? Refused in production, like the existing reader's seam. */
export function approvedOtFixturePath(): string | null {
  const path = envValue("APPROVED_OT_FIXTURE");
  if (!path) return null;
  if (String(process.env.NODE_ENV || "").toLowerCase() === "production") {
    throw new Error("APPROVED_OT_FIXTURE is not allowed when NODE_ENV=production.");
  }
  return path;
}

/**
 * Fixture formats, mirroring what the SQL returns:
 *   JSON: `{ "2026-11-24": { "BAPL0123": 2, "BAPL0124": 0 } }`
 *   CSV:  `date,IDNo,AcceptedOT` with a header row, one block for many dates.
 */
export function parseApprovedOtFixture(text: string): Map<string, ApprovedOtForDate> {
  const byDate = new Map<string, ApprovedOtForDate>();
  const trimmed = text.trim();
  if (!trimmed) return byDate;

  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed) as Record<string, Record<string, unknown>>;
    for (const [workDate, figures] of Object.entries(parsed)) {
      const readings: ApprovedOtForDate = new Map();
      for (const [ecNo, value] of Object.entries(figures ?? {})) {
        const key = ecNo.trim().toUpperCase();
        if (!key) continue;
        readings.set(key, { ecNo: ecNo.trim(), hours: parseApprovedOt(value), records: 1 });
      }
      byDate.set(workDate, readings);
    }
    return byDate;
  }

  const table = parseCsv(trimmed);
  if (!table.length) return byDate;
  const header = table[0].map((cell) => cell.trim().toLowerCase());
  const dateIdx = header.findIndex((cell) => cell === "date" || cell === "workdate" || cell === "work_date");
  const idIdx = header.findIndex((cell) => cell === "idno" || cell === "id_no" || cell === "ecno");
  const otIdx = header.findIndex((cell) => cell === "acceptedot" || cell === "accepted_ot" || cell === "ot" || cell === "hours");
  if (dateIdx < 0 || idIdx < 0 || otIdx < 0) {
    throw new Error("APPROVED_OT_FIXTURE CSV needs columns: date, IDNo, AcceptedOT.");
  }
  for (const cells of table.slice(1)) {
    const workDate = (cells[dateIdx] ?? "").trim().slice(0, 10);
    const ecNo = (cells[idIdx] ?? "").trim();
    if (!workDate || !ecNo) continue;
    const readings = byDate.get(workDate) ?? new Map<string, ApprovedOtReading>();
    readings.set(ecNo.toUpperCase(), { ecNo, hours: parseApprovedOt(cells[otIdx]), records: 1 });
    byDate.set(workDate, readings);
  }
  return byDate;
}

/**
 * Read one work date's approved OT from LabourWorks.
 *
 * One connection per refresh (the caller keeps it), never one per date: the sync hook and
 * the settlement both cover a week, and a handshake per date would be the slowest thing in
 * the run.
 */
async function withSourcePool<T>(work: (pool: sql.ConnectionPool) => Promise<T>): Promise<T> {
  const config = attendanceSourceConfig();
  if (!config.server || !config.user) {
    throw new Error(
      "BADGEVIEW_DB_HOST and BADGEVIEW_DB_USER (or ATTENDANCE_DB_USER) must be set to read approved overtime."
    );
  }
  const pool = await new sql.ConnectionPool({
    server: config.server,
    port: config.port,
    user: config.user,
    password: envValue("ATTENDANCE_DB_PASSWORD") || envValue("BADGEVIEW_DB_PASSWORD"),
    database: config.database,
    options: {
      encrypt: String(process.env.BADGEVIEW_DB_ENCRYPT || "false").toLowerCase() === "true",
      trustServerCertificate: true,
      readOnlyIntent: true,
    },
    connectionTimeout: 15000,
    requestTimeout: 60000,
  }).connect();
  try {
    return await work(pool);
  } finally {
    await pool.close();
  }
}

async function readDate(pool: sql.ConnectionPool, date: string): Promise<ApprovedOtForDate> {
  const request = pool.request();
  request.input("workDate", sql.VarChar(10), date);
  const response = await request.query(approvedOtSql());
  return approvedOtByEcNo((response.recordset as { IdNo?: unknown; ApprovedOT?: unknown; Records?: unknown }[]) || []);
}

/* --------------------------------------------------------------------------- *
 * Planning — pure, so the write decision is testable without a database
 * --------------------------------------------------------------------------- */

/** The fields of a timesheet day this refresh needs. */
export type SheetForApprovedOt = {
  dayId: number;
  employeeId: number;
  employeeName: string;
  ecNo: string;
  workDate: string;
  status: string;
  /** OT hours the supervisor(s) punched, kept as the captured reference. */
  punchedOtHours: number;
  previousHours: number | null;
  previousSource: string | null;
};

export type ApprovedOtPlanRow = {
  dayId: number;
  employeeId: number;
  employeeName: string;
  ecNo: string;
  workDate: string;
  status: string;
  punchedOtHours: number;
  previousHours: number | null;
  previousSource: string | null;
  /** What CLMS approves for this employee-day; null only when the date could not be read. */
  approvedHours: number | null;
  /**
   * MATCHED       the source answered for this id
   * NONE_APPROVED the source answered for the date but has no row for this id -> 0
   * MANUAL        an Admin value; never touched
   * UNREAD        the date's read failed, so nothing is written
   */
  outcome: "MATCHED" | "NONE_APPROVED" | "MANUAL" | "UNREAD";
  wouldChange: boolean;
};

const round2 = (value: number): number => Math.round(value * 100) / 100;

/**
 * Decide what each sheet's approved OT becomes.
 *
 * `datesRead` is the set of dates the source actually answered: a date missing from it was
 * never read, and its rows are left exactly as they are. Writing 0 for an unread date would
 * turn "CLMS is slow today" into "no overtime approved", which is the one error that costs
 * a man money without anybody noticing.
 */
export function planApprovedOtUpdate(
  sheets: readonly SheetForApprovedOt[],
  approvedByDate: Map<string, ApprovedOtForDate>,
  datesRead: ReadonlySet<string>
): ApprovedOtPlanRow[] {
  return sheets.map((sheet) => {
    const base = {
      dayId: sheet.dayId,
      employeeId: sheet.employeeId,
      employeeName: sheet.employeeName,
      ecNo: sheet.ecNo,
      workDate: sheet.workDate,
      status: sheet.status,
      punchedOtHours: sheet.punchedOtHours,
      previousHours: sheet.previousHours,
      previousSource: sheet.previousSource,
    };
    if (sheet.previousSource === "MANUAL") {
      return { ...base, approvedHours: sheet.previousHours, outcome: "MANUAL", wouldChange: false };
    }
    if (!datesRead.has(sheet.workDate)) {
      return { ...base, approvedHours: sheet.previousHours, outcome: "UNREAD", wouldChange: false };
    }
    const reading = approvedByDate.get(sheet.workDate)?.get(sheet.ecNo.trim().toUpperCase());
    const approvedHours = round2(reading?.hours ?? 0);
    return {
      ...base,
      approvedHours,
      outcome: reading ? "MATCHED" : "NONE_APPROVED",
      wouldChange: sheet.previousHours == null || round2(sheet.previousHours) !== approvedHours,
    };
  });
}

/* --------------------------------------------------------------------------- *
 * Refresh — read CLMS, stamp the sheets
 * --------------------------------------------------------------------------- */

export type ApprovedOtRefreshOptions = {
  /** Inclusive ISO work date, `YYYY-MM-DD`. */
  dateFrom: string;
  /** Inclusive ISO work date, `YYYY-MM-DD`. */
  dateTo: string;
  /** Explicit dates instead of a range (the settlement passes the dates it settled). */
  dates?: string[];
  /** Also stamp sheets that are still DRAFT (default false: a draft is being written). */
  includeDraft?: boolean;
  /** Report what would change without writing anything. */
  dryRun?: boolean;
  /** Test seam: replace the LabourWorks read. */
  fetchForDate?: (date: string) => Promise<ApprovedOtForDate>;
};

export type ApprovedOtRefreshResult = {
  dateFrom: string;
  dateTo: string;
  dryRun: boolean;
  includeDraft: boolean;
  /** SQL or FIXTURE — printed everywhere, so synthetic data is never mistaken for real. */
  source: "SQL" | "FIXTURE";
  /** Non-draft sheets in scope. A day may carry several (one per supervisor). */
  sheets: number;
  /** Sheets whose employee-day CLMS answered for. */
  matched: number;
  /** Sheets with a real CLMS row for this id (the rest are explicit zeros). */
  withApprovedOt: number;
  updated: number;
  unchanged: number;
  manualSkipped: number;
  /** Dates the source answered — a date missing here was never read. */
  datesRead: string[];
  errors: { date: string; message: string }[];
  rows: ApprovedOtPlanRow[];
};

/** Every ISO date from `dateFrom` to `dateTo`, inclusive. Refuses a backwards or absurd range. */
export function approvedOtDateRange(dateFrom: string, dateTo: string, maxDays = 400): string[] {
  const start = new Date(`${dateFrom}T00:00:00.000Z`);
  const end = new Date(`${dateTo}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error("dateFrom and dateTo must be ISO dates (YYYY-MM-DD).");
  }
  if (end < start) throw new Error("dateFrom must not be after dateTo.");
  const dates: string[] = [];
  for (let at = start.getTime(); at <= end.getTime(); at += 86_400_000) {
    if (dates.length >= maxDays) throw new Error(`The range is longer than ${maxDays} days; narrow it.`);
    dates.push(new Date(at).toISOString().slice(0, 10));
  }
  return dates;
}

/**
 * Read CLMS for the dates that hold in-scope sheets and stamp
 * `timesheet_days.approved_ot_hours` on the matching ones.
 *
 * ONE VALUE PER EMPLOYEE-DAY, WRITTEN TO EVERY SHEET OF THAT DAY: `timesheet_days` is keyed
 * by (employee, date, supervisor), so two supervisors who each booked the same man on the
 * same date have two rows. The approved figure belongs to the man-day, not to the sheet, so
 * both show the truth — and the report arithmetic that counts OT takes it once per
 * employee-day (see `approvedOtForDays`), never once per sheet.
 */
export async function refreshApprovedOt(options: ApprovedOtRefreshOptions): Promise<ApprovedOtRefreshResult> {
  const includeDraft = options.includeDraft === true;
  const dryRun = options.dryRun === true;
  const dates = (options.dates ?? approvedOtDateRange(options.dateFrom, options.dateTo))
    .filter(Boolean)
    .sort();
  if (!dates.length) throw new Error("No dates to refresh.");
  const today = todayInAppZone();
  const futureSkipped = dates.filter((date) => date > today);
  const readDates = dates.filter((date) => date <= today);
  if (!readDates.length) {
    return {
      dateFrom: dates[0],
      dateTo: dates[dates.length - 1],
      dryRun,
      includeDraft,
      source: "SQL",
      sheets: 0,
      matched: 0,
      withApprovedOt: 0,
      updated: 0,
      unchanged: 0,
      manualSkipped: 0,
      datesRead: [],
      errors: futureSkipped.map((date) => ({ date, message: "Future date: CLMS carries planning rows, never attendance." })),
      rows: [],
    };
  }

  const statuses = includeDraft ? [...NON_DRAFT_STATUSES, "DRAFT"] : NON_DRAFT_STATUSES;
  const days = await prisma.timesheetDay.findMany({
    where: {
      status: { in: statuses },
      workDate: {
        gte: new Date(`${readDates[0]}T00:00:00.000Z`),
        lte: new Date(`${readDates[readDates.length - 1]}T23:59:59.999Z`),
      },
    },
    include: {
      employee: { select: { id: true, name: true, ecNo: true } },
      entries: { select: { otHours: true } },
    },
    orderBy: [{ workDate: "asc" }, { employeeId: "asc" }, { id: "asc" }],
  });

  const sheets: SheetForApprovedOt[] = days.map((day) => ({
    dayId: day.id,
    employeeId: day.employeeId,
    employeeName: day.employee.name,
    ecNo: day.employee.ecNo,
    workDate: day.workDate.toISOString().slice(0, 10),
    status: day.status,
    punchedOtHours: day.entries.reduce((sum, entry) => sum + (entry.otHours ?? 0), 0),
    previousHours: day.approvedOtHours,
    previousSource: day.approvedOtSource,
  }));

  const neededDates = [...new Set(sheets.map((sheet) => sheet.workDate))].sort();
  const approvedByDate = new Map<string, ApprovedOtForDate>();
  const datesRead = new Set<string>();
  const errors: { date: string; message: string }[] = [];
  let source: "SQL" | "FIXTURE" = "SQL";

  const fixture = approvedOtFixturePath();
  if (fixture) {
    source = "FIXTURE";
    const parsed = parseApprovedOtFixture(await fs.readFile(fixture, "utf8"));
    for (const date of neededDates) {
      const readings = parsed.get(date);
      if (readings) {
        approvedByDate.set(date, readings);
        datesRead.add(date);
      } else {
        approvedByDate.set(date, new Map());
        datesRead.add(date);
      }
    }
  } else if (neededDates.length) {
    const fetchForDate = options.fetchForDate;
    if (fetchForDate) {
      for (const date of neededDates) {
        try {
          approvedByDate.set(date, await fetchForDate(date));
          datesRead.add(date);
        } catch (error) {
          errors.push({ date, message: error instanceof Error ? error.message : String(error) });
        }
      }
    } else {
      const config = attendanceSourceConfig();
      try {
        await withSourcePool(async (pool) => {
          for (const date of neededDates) {
            try {
              approvedByDate.set(date, await readDate(pool, date));
              datesRead.add(date);
            } catch (error) {
              errors.push({ date, message: explainSourceError(error, config) });
            }
          }
        });
      } catch (error) {
        // The connection itself failed: every date is unread, and nothing may be written.
        const message = explainSourceError(error, config);
        for (const date of neededDates) errors.push({ date, message });
      }
    }
  }

  const plan = planApprovedOtUpdate(sheets, approvedByDate, datesRead);
  const toWrite = plan.filter((row) => row.outcome !== "MANUAL" && row.outcome !== "UNREAD" && row.wouldChange);
  const consultedUnchanged = plan.filter(
    (row) => row.outcome !== "MANUAL" && row.outcome !== "UNREAD" && !row.wouldChange
  );
  const now = new Date();

  if (!dryRun) {
    // One UPDATE per distinct figure instead of one per sheet.
    const byValue = new Map<number, number[]>();
    for (const row of toWrite) {
      if (row.approvedHours == null) continue;
      const bucket = byValue.get(row.approvedHours) ?? [];
      bucket.push(row.dayId);
      byValue.set(row.approvedHours, bucket);
    }
    for (const [value, dayIds] of byValue) {
      await prisma.timesheetDay.updateMany({
        where: { id: { in: dayIds } },
        data: { approvedOtHours: value, approvedOtSource: "LABOURWORKS", approvedOtCheckedAt: now },
      });
    }
    // Days consulted and already correct still record that CLMS was asked, so "when was
    // this figure last confirmed" is answerable from the row itself.
    if (consultedUnchanged.length) {
      await prisma.timesheetDay.updateMany({
        where: { id: { in: consultedUnchanged.map((row) => row.dayId) } },
        data: { approvedOtCheckedAt: now },
      });
    }
  }

  return {
    dateFrom: dates[0],
    dateTo: dates[dates.length - 1],
    dryRun,
    includeDraft,
    source,
    sheets: sheets.length,
    matched: plan.filter((row) => row.outcome === "MATCHED" || row.outcome === "NONE_APPROVED").length,
    withApprovedOt: plan.filter((row) => row.outcome === "MATCHED").length,
    updated: dryRun ? 0 : toWrite.length,
    unchanged: consultedUnchanged.length,
    manualSkipped: plan.filter((row) => row.outcome === "MANUAL").length,
    datesRead: [...datesRead].sort(),
    errors,
    rows: plan,
  };
}

/* --------------------------------------------------------------------------- *
 * Report-side helpers — one approved OT fact per employee-day
 * --------------------------------------------------------------------------- */

export type ApprovedOtFact = {
  /** Approved hours for the employee-day; 0 when CLMS approved none. */
  hours: number;
  /** LABOURWORKS | MANUAL | null (never fetched). */
  source: string | null;
  /** False when the day has never been read from CLMS — the UI must say "not fetched". */
  fetched: boolean;
};

/** `employeeId|YYYY-MM-DD` — the key every report uses to count a day's OT once. */
export function employeeDayKey(employeeId: number, workDate: Date | string): string {
  const iso = typeof workDate === "string" ? workDate.slice(0, 10) : workDate.toISOString().slice(0, 10);
  return `${employeeId}|${iso}`;
}

/**
 * The overtime a REPORT prints, in whole hours.
 *
 * WHY THIS EXISTS: CLMS states `AcceptedOT` with a fractional part on a few man-days (7.58, 14.3,
 * 23.53 …), and every report multiplied that fraction outward — the Summary page printed five
 * decimals once a period's approvals were summed. Overtime is reported to people in whole hours, so
 * the figure crosses ONE boundary here and every screen, list and export gets an integer from the
 * same rule. It is applied on READ, not on write: `timesheet_days.approved_ot_hours` keeps exactly
 * what CLMS approved, so the reconciliation report can still show the yard's precise number and a
 * later CLMS correction is still visible.
 *
 * Rounding is half-up (`Math.round`) and never negative — the same `Math.max(0, …)` floor the
 * project arithmetic applies. Rounding per employee-day (rather than per report total) is deliberate:
 * a man-day is the unit CLMS approves and the unit an approver judges, so a list of days always adds
 * up to the same total the report prints.
 */
export function reportedOtHours(hours: number | null | undefined): number {
  if (hours == null || !Number.isFinite(hours)) return 0;
  return Math.max(0, Math.round(hours));
}

/**
 * Collapse the approved OT of a day's sheets to ONE fact per employee-day.
 *
 * Several supervisors may hold a sheet for the same man on the same date; the approved
 * figure is the same on all of them, and summing the rows would count the man's overtime
 * two or three times. Anything that reports OT must go through this.
 *
 * The value handed out is the REPORTED figure (`reportedOtHours`), which is what a screen should
 * print; the audit comparison inside `refreshApprovedOt` reads the stored column directly and is
 * therefore unaffected.
 */
export function approvedOtForDays(
  days: readonly {
    employeeId: number;
    workDate: Date | string;
    approvedOtHours: number | null;
    approvedOtSource?: string | null;
  }[]
): Map<string, ApprovedOtFact> {
  const byDay = new Map<string, ApprovedOtFact>();
  for (const day of days) {
    const key = employeeDayKey(day.employeeId, day.workDate);
    const existing = byDay.get(key);
    if (existing) {
      // The same employee-day appears more than once only because several supervisors
      // booked it. Prefer a fetched fact over a never-fetched one; the figures agree.
      if (!existing.fetched && day.approvedOtHours != null) {
        byDay.set(key, { hours: reportedOtHours(day.approvedOtHours), source: day.approvedOtSource ?? null, fetched: true });
      }
      continue;
    }
    byDay.set(key, {
      hours: reportedOtHours(day.approvedOtHours),
      source: day.approvedOtSource ?? null,
      fetched: day.approvedOtHours != null,
    });
  }
  return byDay;
}

/** The approved OT for one employee-day, as a report should count it (0 when unfetched). */
export function approvedOtForDay(
  byDay: ReadonlyMap<string, ApprovedOtFact>,
  employeeId: number,
  workDate: Date | string
): number {
  return byDay.get(employeeDayKey(employeeId, workDate))?.hours ?? 0;
}

/**
 * Which sheet of an employee-day CARRIES the overtime, so it is attributed once.
 *
 * The approved OT has no Project or Job Order of its own; it is charged to the Job Order the
 * supervisor booked the OT against that day. That row is the carrier. When CLMS approved OT
 * for a day nobody booked OT on, there is no carrier and the figure belongs in the
 * "OT not booked" bucket rather than being dropped.
 */
export function approvedOtCarrierDayIds(
  days: readonly { id: number; employeeId: number; workDate: Date | string; entries: readonly { otHours: number | null }[] }[]
): Set<number> {
  const best = new Map<string, { id: number; hasOtEntry: boolean }>();
  for (const day of days) {
    const key = employeeDayKey(day.employeeId, day.workDate);
    const hasOtEntry = day.entries.some((entry) => entry.otHours != null);
    const existing = best.get(key);
    if (!existing) {
      best.set(key, { id: day.id, hasOtEntry });
      continue;
    }
    if (!existing.hasOtEntry && hasOtEntry) best.set(key, { id: day.id, hasOtEntry });
  }
  const carriers = new Set<number>();
  for (const entry of best.values()) carriers.add(entry.id);
  return carriers;
}

/**
 * Everything a screen needs to report one day's overtime: the approved figure per
 * employee-day, and WHICH sheet of that day carries it (so it is counted once).
 *
 * ONE database read for the whole screen: the sibling sheets of the same employee-day are
 * not always among the rows being rendered — an HOD approving one supervisor's sheet must
 * still know that another supervisor booked that man's OT, or the approved hours would be
 * dropped from the column totals entirely.
 */
export async function loadApprovedOtContext(
  days: readonly { id: number; employeeId: number; workDate: Date | string }[]
): Promise<{ byDay: Map<string, ApprovedOtFact>; carriers: Set<number> }> {
  if (!days.length) return { byDay: new Map(), carriers: new Set() };
  const employeeIds = [...new Set(days.map((day) => day.employeeId))];
  const dates = [...new Set(days.map((day) => employeeDayKey(day.employeeId, day.workDate).split("|")[1]))].map(
    (iso) => new Date(`${iso}T00:00:00.000Z`)
  );
  const siblings = await prisma.timesheetDay.findMany({
    where: {
      employeeId: { in: employeeIds },
      workDate: { in: dates },
      status: { in: NON_DRAFT_STATUSES },
    },
    select: {
      id: true,
      employeeId: true,
      workDate: true,
      approvedOtHours: true,
      approvedOtSource: true,
      entries: { select: { otHours: true } },
    },
  });
  const byDay = approvedOtForDays(siblings);
  const carriers = approvedOtCarrierDayIds(siblings);
  // A day outside NON_DRAFT_STATUSES (a draft is being written) still renders; it simply
  // carries no approved OT until it is submitted.
  return { byDay, carriers };
}

/** The approved OT of one day row, as the screens report it. */
export function approvedOtOfDay(
  context: { byDay: Map<string, ApprovedOtFact>; carriers: Set<number> },
  day: { id: number; employeeId: number; workDate: Date | string }
): { hours: number; fetched: boolean; carriedHere: boolean } {
  const fact = context.byDay.get(employeeDayKey(day.employeeId, day.workDate));
  return {
    hours: fact?.hours ?? 0,
    fetched: fact?.fetched ?? false,
    carriedHere: context.carriers.has(day.id),
  };
}

/**
 * Attribute each day's approved OT to the ONE booking entry that carries it.
 *
 * Reports aggregate `timesheet_entries` rows, so the approved figures have to be handed out
 * per row: the first OT booking of an employee-day (lowest id, so repeated runs agree) gets
 * the whole day's approved hours, and every other OT row of that day gets 0. A NON-OT row is
 * absent from the map on purpose — its hours are slots, not overtime, and a zero there would
 * be indistinguishable from "this row has no OT".
 */
export function attributeApprovedOt(
  entries: readonly {
    id: number;
    employeeId: number;
    workDate: Date | string;
    otHours: number | null;
  }[],
  byDay: ReadonlyMap<string, ApprovedOtFact>
): Map<number, number> {
  const carrierByDay = new Map<string, number>();
  for (const entry of entries) {
    if (entry.otHours == null) continue;
    const key = employeeDayKey(entry.employeeId, entry.workDate);
    const current = carrierByDay.get(key);
    if (current == null || entry.id < current) carrierByDay.set(key, entry.id);
  }
  const attributed = new Map<number, number>();
  for (const entry of entries) {
    if (entry.otHours == null) continue;
    const key = employeeDayKey(entry.employeeId, entry.workDate);
    const isCarrier = carrierByDay.get(key) === entry.id;
    attributed.set(entry.id, isCarrier ? byDay.get(key)?.hours ?? 0 : 0);
  }
  return attributed;
}

/**
 * Load the approved OT for a set of entries' employee-days, in one query.
 *
 * Used by every report that aggregates entries rather than sheets: the day rows carry the
 * stamped figure, and `attributeApprovedOt` hands it to the row that booked the overtime.
 */
export async function loadApprovedOtForEntries(
  entries: readonly { employeeId: number; workDate: Date | string }[]
): Promise<Map<string, ApprovedOtFact>> {
  if (!entries.length) return new Map();
  const employeeIds = [...new Set(entries.map((entry) => entry.employeeId))];
  const dates = [
    ...new Set(entries.map((entry) => employeeDayKey(entry.employeeId, entry.workDate).split("|")[1])),
  ].map((iso) => new Date(`${iso}T00:00:00.000Z`));
  const days = await prisma.timesheetDay.findMany({
    where: { employeeId: { in: employeeIds }, workDate: { in: dates } },
    select: {
      employeeId: true,
      workDate: true,
      approvedOtHours: true,
      approvedOtSource: true,
    },
  });
  return approvedOtForDays(days);
}

/**
 * Which employee-days have a Job Order booked against their overtime ANYWHERE.
 *
 * The difference between "OT not booked" and "booked against a Project this report does not
 * show" is the difference between a real gap and a filter artefact, so the bucket that carries
 * unbooked overtime asks the database rather than inferring it from a scoped row set.
 */
export async function loadOtBookingDays(
  entries: readonly { employeeId: number; workDate: Date | string }[]
): Promise<Set<string>> {
  if (!entries.length) return new Set();
  const employeeIds = [...new Set(entries.map((entry) => entry.employeeId))];
  const dates = [
    ...new Set(entries.map((entry) => employeeDayKey(entry.employeeId, entry.workDate).split("|")[1])),
  ].map((iso) => new Date(`${iso}T00:00:00.000Z`));
  const rows = await prisma.timesheetEntry.findMany({
    where: { employeeId: { in: employeeIds }, workDate: { in: dates }, otHours: { not: null } },
    select: { employeeId: true, workDate: true },
  });
  return new Set(rows.map((row) => employeeDayKey(row.employeeId, row.workDate)));
}

/**
 * The work dates in a period that hold a non-draft sheet whose approved OT has NEVER been fetched.
 *
 * `approved_ot_hours IS NULL` is the only honest signal for "nobody ever asked CLMS about this
 * day": every refresh stamps an explicit value (0 included), so a NULL that survives a refresh
 * window is a hole, not an approval of nothing. The automatic writers only look BACKWARDS from
 * today (`APPROVED_OT_LOOKBACK_DAYS` on the sync, `APPROVED_OT_BACKFILL_DAYS` on the nightly job),
 * so a month that closed before the feature was switched on is never revisited — exactly the
 * failure this returns: September and most of October stayed NULL while the window kept stamping
 * the last few weeks.
 *
 * One query, one row per DATE (`distinct`), oldest first, capped — a catch-up pass reads those
 * dates and no others, so the cost is proportional to the hole rather than to the horizon.
 */
export async function neverStampedApprovedOtDates(options: {
  dateFrom: string;
  dateTo: string;
  limit?: number;
}): Promise<string[]> {
  const rows = await prisma.timesheetDay.findMany({
    where: {
      approvedOtHours: null,
      status: { in: [...NON_DRAFT_STATUSES] },
      workDate: {
        gte: new Date(`${options.dateFrom}T00:00:00.000Z`),
        lte: new Date(`${options.dateTo}T00:00:00.000Z`),
      },
    },
    select: { workDate: true },
    distinct: ["workDate"],
    orderBy: { workDate: "asc" },
    take: Math.max(1, options.limit ?? 90),
  });
  return rows.map((row) => row.workDate.toISOString().slice(0, 10));
}

/* --------------------------------------------------------------------------- *
 * Trigger helpers — called by the sync and the settlement, never fatal
 * --------------------------------------------------------------------------- */

/**
 * The window a sync-triggered refresh covers.
 *
 * 21 DAYS, NOT 7: CLMS approves overtime 2–15 days after the day worked, so a window sized to the
 * attendance regularization SLA would miss every slow approval. The nightly backfill
 * (`APPROVED_OT_BACKFILL_DAYS`, 30) is the safety net; this window is what makes the twice-daily sync
 * itself cover the whole approval lag.
 */
export function scheduledApprovedOtWindow(now: Date = new Date()): { dateFrom: string; dateTo: string } {
  const lookback = Number(process.env.APPROVED_OT_LOOKBACK_DAYS || 21);
  const days = Number.isFinite(lookback) && lookback >= 0 ? Math.min(Math.floor(lookback), 60) : 21;
  const dateTo = now.toISOString().slice(0, 10);
  const dateFrom = new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
  return { dateFrom, dateTo };
}

function enabled(name: string, defaultValue: boolean): boolean {
  const raw = String(process.env[name] ?? "").trim().toLowerCase();
  if (raw === "") return defaultValue;
  return raw === "true" || raw === "1" || raw === "yes";
}

/**
 * Refresh after a CLMS/BadgeView sync pass, so a sync completion is IMMEDIATELY followed by
 * the approved overtime the yard has regularised.
 *
 * NEVER THROWS: the employee sync is the app's critical path, and a yard SQL Server that is
 * slow for ten seconds must not report the sync as failed. The failure is logged with
 * enough detail to act on, and the next trigger (18:00 sync, 06:00 settlement, Admin button)
 * re-reads the whole window anyway.
 */
export async function refreshApprovedOtAfterSync(): Promise<ApprovedOtRefreshResult | null> {
  if (!enabled("APPROVED_OT_SYNC_ON_COMPLETE", true)) return null;
  const window = scheduledApprovedOtWindow();
  try {
    const result = await refreshApprovedOt(window);
    console.log(
      `[approvedOt] after sync: ${result.updated} sheet(s) stamped, ${result.withApprovedOt} with approved OT, ` +
        `${result.datesRead.length} date(s) read, ${result.errors.length} error(s).`
    );
    return result;
  } catch (error) {
    console.error("[approvedOt] after-sync refresh failed:", error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * Refresh after a settlement run, over exactly the dates it settled. Same non-fatal rule:
 * a stamping failure must not turn a successful settlement into a failed one.
 */
export async function refreshApprovedOtAfterSettlement(dates: readonly string[]): Promise<ApprovedOtRefreshResult | null> {
  if (!enabled("APPROVED_OT_AFTER_SETTLEMENT", true)) return null;
  if (!dates.length) return null;
  try {
    const result = await refreshApprovedOt({
      dateFrom: [...dates].sort()[0],
      dateTo: [...dates].sort().slice(-1)[0],
      dates: [...dates],
    });
    console.log(
      `[approvedOt] after settlement: ${result.updated} sheet(s) stamped over ${dates.length} date(s), ` +
        `${result.errors.length} error(s).`
    );
    return result;
  } catch (error) {
    console.error("[approvedOt] after-settlement refresh failed:", error instanceof Error ? error.message : error);
    return null;
  }
}

/** An Admin sets (or clears) the approved figure for one day by hand; no refresh overwrites it. */
export async function setManualApprovedOt(
  dayId: number,
  hours: number | null
): Promise<{ dayId: number; approvedOtHours: number | null; approvedOtSource: string | null }> {
  const day = await prisma.timesheetDay.findUnique({ where: { id: dayId }, select: { id: true } });
  if (!day) throw new Error(`Timesheet day #${dayId} does not exist.`);
  if (hours == null) {
    const cleared = await prisma.timesheetDay.update({
      where: { id: dayId },
      data: { approvedOtHours: null, approvedOtSource: null, approvedOtCheckedAt: null },
      select: { id: true, approvedOtHours: true, approvedOtSource: true },
    });
    return { dayId: cleared.id, approvedOtHours: cleared.approvedOtHours, approvedOtSource: cleared.approvedOtSource };
  }
  if (!Number.isFinite(hours) || hours < 0 || hours > 24) {
    throw new Error("Approved overtime must be a number between 0 and 24.");
  }
  const updated = await prisma.timesheetDay.update({
    where: { id: dayId },
    data: { approvedOtHours: round2(hours), approvedOtSource: "MANUAL", approvedOtCheckedAt: new Date() },
    select: { id: true, approvedOtHours: true, approvedOtSource: true },
  });
  return { dayId: updated.id, approvedOtHours: updated.approvedOtHours, approvedOtSource: updated.approvedOtSource };
}

/** A readable summary, for the routes and the jobs' logs. */
export function formatApprovedOtSummary(result: ApprovedOtRefreshResult): string {
  const lines: string[] = [];
  lines.push(result.dryRun ? "APPROVED OT REFRESH — DRY RUN (nothing written)" : "APPROVED OT REFRESH");
  lines.push(`  range            ${result.dateFrom} .. ${result.dateTo}`);
  lines.push(`  source           ${result.source}  ${approvedOtSource().view}.${approvedOtSource().otColumn}`);
  lines.push(`  sheets in scope  ${result.sheets}   (drafts ${result.includeDraft ? "included" : "excluded"})`);
  lines.push(`  matched          ${result.matched}   with approved OT ${result.withApprovedOt}`);
  lines.push(`  written          ${result.updated}   unchanged ${result.unchanged}   manual ${result.manualSkipped}`);
  if (result.errors.length) {
    lines.push(`  errors           ${result.errors.length}`);
    for (const error of result.errors.slice(0, 5)) lines.push(`      ${error.date}: ${error.message}`);
  }
  return lines.join("\n");
}
