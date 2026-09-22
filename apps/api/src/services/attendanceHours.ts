import fs from "node:fs/promises";
import sql from "mssql";
import { prisma } from "../db";
import { parseCsv } from "./csvParser";

/**
 * Clocked attendance hours (in/out) from LabourWorks.
 *
 * A supervisor books shift slots; LabourWorks knows how long the worker actually
 * clocked in and out. The Admin needs both side by side to validate contract
 * attendance, so a submitted timesheet day keeps the clocked figure in
 * `timesheet_days.in_out_hours`.
 *
 * Contract:
 *   - `in_out_hours` is NULL on every submit (see POST /timesheet/submit). Nothing a
 *     supervisor does writes it.
 *   - It is filled only by POST /api/attendance-hours/refresh (Admin) or by the
 *     09:00 / 21:00 `ATTENDANCE_HOURS_CRON` job, both of which read LabourWorks.
 *   - The join key is the employee ecNo, which the source view calls `IDNo`.
 *   - Nothing else in the app reads the column, so a missing or stale value can
 *     never change booked hours, approvals or reports.
 *
 * The source is configuration, not code, because the view belongs to the IT team:
 * ATTENDANCE_DB_VIEW / _ID_COLUMN / _HOURS_COLUMN / _DATE_COLUMN name it, and
 * ATTENDANCE_DB_QUERY can replace the generated SQL with the exact query the DBA
 * signs off (it must bind @workDate).
 */

/** Which day statuses a refresh may touch. A DRAFT sheet is still being written. */
const NON_DRAFT_STATUSES = ["SUBMITTED", "SUP_APPROVED", "HOD_APPROVED", "PM_APPROVED", "REJECTED", "FINAL_REJECTED", "PLANNING_RETURNED"];

export type AttendanceSourceConfig = {
  /** `schema.view`, e.g. `dbo.Report_Attendance_Intermediate`. */
  view: string;
  idColumn: string;
  hoursColumn: string;
  dateColumn: string;
  /** Full SQL replacing the generated SELECT. Must bind `@workDate`. */
  queryOverride: string | null;
  /** Connection identity (never the password) so the Admin screen can show it. */
  server: string;
  port: number;
  database: string;
  user: string;
  /** Dev/test only: read the clocked hours from a local file instead of SQL Server. */
  fixturePath: string | null;
};

function envValue(name: string): string {
  return (process.env[name] ?? "").trim();
}

/**
 * The fixture seam is for offline development and tests on a box that cannot reach
 * the yard network. It is refused in production, so a stray env var cannot fake
 * attendance data in a live deployment.
 */
export function attendanceFixturePath(): string | null {
  const path = envValue("ATTENDANCE_HOURS_FIXTURE");
  if (!path) return null;
  if (String(process.env.NODE_ENV || "").toLowerCase() === "production") {
    throw new Error("ATTENDANCE_HOURS_FIXTURE is not allowed when NODE_ENV=production.");
  }
  return path;
}

export function attendanceSourceConfig(): AttendanceSourceConfig {
  return {
    view: envValue("ATTENDANCE_DB_VIEW") || "dbo.Report_Attendance_Intermediate",
    idColumn: envValue("ATTENDANCE_DB_ID_COLUMN") || "IDNo",
    hoursColumn: envValue("ATTENDANCE_DB_HOURS_COLUMN") || "ManHours",
    dateColumn: envValue("ATTENDANCE_DB_DATE_COLUMN") || "Date",
    queryOverride: envValue("ATTENDANCE_DB_QUERY") || null,
    server: envValue("BADGEVIEW_DB_HOST"),
    port: Number(envValue("BADGEVIEW_DB_PORT") || 1433),
    database: envValue("ATTENDANCE_DB_NAME") || envValue("BADGEVIEW_DB_NAME") || "LabourWorks",
    user: envValue("ATTENDANCE_DB_USER") || envValue("BADGEVIEW_DB_USER"),
    fixturePath: attendanceFixturePath(),
  };
}

/** One `(employee, date) -> clocked hours` reading from the source. */
export type ClockedHoursReading = {
  /** Source identifier, exactly as the view returned it (`IDNo`). */
  idNo: string;
  /**
   * Total clocked hours for that employee on that date.
   *
   * The view can hold MORE THAN ONE record per worker per date - a split day, or a
   * night shift whose checkout lands the next morning (observed 2026-09-21: BAPL0158
   * 09:03-12:18 = 3.15h and 18:04-08:59 = 14.55h). The day's figure is therefore the
   * SUM of its records, which is also why a "clocked hours" value above 8 is normal
   * and must not be truncated.
   */
  manHours: number | null;
  /** How many source records were summed. 2+ is reported so an odd total is explicable. */
  records: number;
};

/** `dbo.Report_Attendance_Intermediate` -> `[dbo].[Report_Attendance_Intermediate]`. */
function quoteIdentifier(value: string, label: string): string {
  const trimmed = value.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
    throw new Error(`${label} must be a plain identifier, got "${value}".`);
  }
  return `[${trimmed}]`;
}

function quoteView(view: string): string {
  const parts = view.trim().split(".");
  if (parts.length > 2 || !parts.every((part) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(part))) {
    throw new Error(`ATTENDANCE_DB_VIEW must be "view" or "schema.view", got "${view}".`);
  }
  return parts.map((part) => `[${part}]`).join(".");
}

/**
 * The SQL that is sent for one work date.
 *
 * `CAST(... AS date)` on both sides keeps the predicate correct whether the source
 * column is a `date`, a `datetime` or a string, which matters because the view is
 * owned by another team and can change its type.
 */
export function attendanceSql(config: AttendanceSourceConfig): string {
  if (config.queryOverride) return config.queryOverride;
  const view = quoteView(config.view);
  const id = quoteIdentifier(config.idColumn, "ATTENDANCE_DB_ID_COLUMN");
  const hours = quoteIdentifier(config.hoursColumn, "ATTENDANCE_DB_HOURS_COLUMN");
  const date = quoteIdentifier(config.dateColumn, "ATTENDANCE_DB_DATE_COLUMN");
  return `SELECT ${id} AS IdNo, ${hours} AS ManHours FROM ${view} WHERE CAST(${date} AS date) = CAST(@workDate AS date)`;
}

/** `8.58` / `"8.58"` / `" 8,58 "` -> 8.58; anything unparseable -> null. */
export function parseManHours(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = String(value).trim().replace(",", ".");
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Rows from the source view into `ClockHoursReading`s, keyed by the EC number in the
 * exact form the timesheet uses (trimmed, whitespace collapsed). Duplicate rows for
 * one id keep the FIRST non-null reading, so an accidental second row cannot flip a
 * day between values on every run.
 */
export function readingsByEcNo(rows: { IdNo?: unknown; ManHours?: unknown }[]): Map<string, ClockedHoursReading> {
  const map = new Map<string, ClockedHoursReading>();
  for (const row of rows) {
    const idNo = String(row.IdNo ?? "").trim().replace(/\s+/g, " ");
    if (!idNo) continue;
    const key = idNo.toUpperCase();
    const manHours = parseManHours(row.ManHours);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, { idNo, manHours, records: 1 });
      continue;
    }
    // A second record for the same employee-day ADDS to the day's hours.
    map.set(key, {
      idNo: existing.idNo,
      manHours: manHours == null ? existing.manHours : (existing.manHours ?? 0) + manHours,
      records: existing.records + 1,
    });
  }
  return map;
}

/** Clocked hours for ONE work date. `key` is the upper-cased EC number. */
export type ClockedHoursForDate = Map<string, ClockedHoursReading>;

async function fetchFromSqlServer(date: string, config: AttendanceSourceConfig): Promise<ClockedHoursForDate> {
  if (!config.server || !config.user) {
    throw new Error("BADGEVIEW_DB_HOST and BADGEVIEW_DB_USER (or ATTENDANCE_DB_USER) must be set to read clocked hours.");
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
    const request = pool.request();
    request.input("workDate", sql.VarChar(10), date);
    const response = await request.query(attendanceSql(config));
    return readingsByEcNo((response.recordset as { IdNo?: unknown; ManHours?: unknown }[]) || []);
  } finally {
    await pool.close();
  }
}

/**
 * Fixture format (`ATTENDANCE_HOURS_FIXTURE`), either:
 *   - JSON: `{ "2026-09-21": { "FRNEGJ018": 8.58 } }`, or
 *   - CSV:  `date,IDNo,ManHours` with a header row.
 * Both mirror what the SQL query returns, so an offline run exercises the same code.
 */
export function parseClockedHoursFixture(text: string, date: string): ClockedHoursForDate {
  const trimmed = text.trim();
  if (!trimmed) return new Map();
  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed) as Record<string, Record<string, unknown>>;
    const forDate = parsed[date] ?? {};
    return readingsByEcNo(Object.entries(forDate).map(([IdNo, ManHours]) => ({ IdNo, ManHours })));
  }
  const table = parseCsv(trimmed);
  if (!table.length) return new Map();
  const header = table[0].map((cell) => cell.trim().toLowerCase());
  const dateIndex = header.findIndex((cell) => cell === "date" || cell === "workdate" || cell === "work_date");
  const idIndex = header.findIndex((cell) => cell === "idno" || cell === "id_no" || cell === "ecno" || cell === "idcardno");
  const hoursIndex = header.findIndex((cell) => cell === "manhours" || cell === "man_hours");
  if (idIndex < 0 || hoursIndex < 0) {
    throw new Error("ATTENDANCE_HOURS_FIXTURE CSV needs columns: date, IDNo, ManHours.");
  }
  const rows = table
    .slice(1)
    .filter((row) => (dateIndex < 0 ? true : (row[dateIndex] ?? "").trim() === date))
    .map((row) => ({ IdNo: row[idIndex], ManHours: row[hoursIndex] }));
  return readingsByEcNo(rows);
}

/**
 * Turn a driver error into something the Admin can act on.
 *
 * The source view belongs to another team, so the two failures that will actually
 * happen are "the login may not read the view" and "a configured column name is
 * wrong". Both stay verbatim at the front of the message (that is the evidence), with
 * the fix appended.
 */
export function explainSourceError(error: unknown, config: AttendanceSourceConfig): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/permission was denied|error_number"?\s*:?\s*229|The SELECT permission/i.test(message)) {
    return `${message} — the login "${config.user || "(unset)"}" needs SELECT on ${config.view}. Ask IT to grant it, or point ATTENDANCE_DB_USER / ATTENDANCE_DB_PASSWORD at a login that has it.`;
  }
  if (/invalid column name/i.test(message)) {
    return `${message} — check ATTENDANCE_DB_DATE_COLUMN ("${config.dateColumn}"), ATTENDANCE_DB_ID_COLUMN ("${config.idColumn}") and ATTENDANCE_DB_HOURS_COLUMN ("${config.hoursColumn}") against the view, or set ATTENDANCE_DB_QUERY to the exact query the DBA supplies.`;
  }
  return message;
}

/** Clocked hours for one work date, from the fixture when one is configured. */
export async function fetchClockedHoursForDate(date: string): Promise<ClockedHoursForDate> {
  const config = attendanceSourceConfig();
  if (config.fixturePath) {
    const text = await fs.readFile(config.fixturePath, "utf8");
    return parseClockedHoursFixture(text, date);
  }
  try {
    return await fetchFromSqlServer(date, config);
  } catch (error) {
    throw new Error(explainSourceError(error, config));
  }
}

/** One submitted sheet (employee-day) a refresh may stamp with the clocked hours. */
export type SheetForRefresh = {
  dayId: number;
  employeeId: number;
  employeeName: string;
  /** Employee code from the timesheet: the same value the source view calls `IDNo`. */
  ecNo: string;
  workDate: string;
  status: string;
  /** Hours this sheet booked (shift slot = 2h, legacy hour slot = 1h, plus OT). */
  bookedHours: number;
  previousInOutHours: number | null;
  /** null | LABOURWORKS | MANUAL. A MANUAL value is an Admin decision: never overwritten. */
  previousSource: string | null;
  previousAttempts: number;
};

export type PlannedSheet = SheetForRefresh & {
  clockedHours: number | null;
  /** `clockedHours - bookedHours`; null when the source has nothing for the day. */
  difference: number | null;
  /** Source records summed into `clockedHours`; 0 when the source had none. */
  sourceRecords: number;
  /** Calendar days between the work date and the run, for the pending list. */
  ageDays: number;
  outcome: "matched" | "not-in-source" | "no-hours-in-source" | "manual";
  /** True when this run would (or did) write the figure. */
  wouldChange: boolean;
  /** Why a difference was NOT written: a manual value, or the overwrite policy. */
  blockedReason: "manual" | "policy" | null;
  /** Still nothing usable after this run: absent, no hours, or a clocked 0. */
  pending: boolean;
};

/**
 * How a difference between the stored figure and the source is settled.
 *
 *  - `any`     the source is the truth: a later correction wins, up or down. This is
 *              the default, and it is what makes a regularized 0.00 become 8.00.
 *  - `improve` only fill a gap (NULL / 0) or raise a figure; never lower a non-zero
 *              value without a human decision.
 *
 * Absence from the source is NEVER a write in either mode: an empty answer must not
 * wipe a figure an earlier run fetched.
 */
export type OverwritePolicy = "any" | "improve";

/** Whether this reading should be written, and why not when it should not be. */
export function decideWrite(
  row: Pick<PlannedSheet, "outcome" | "clockedHours" | "previousInOutHours" | "previousSource">,
  policy: OverwritePolicy
): { write: boolean; reason: "manual" | "policy" | null } {
  if (row.outcome !== "matched" || row.clockedHours == null) return { write: false, reason: null };
  if (row.previousSource === "MANUAL") return { write: false, reason: "manual" };
  if (row.clockedHours === row.previousInOutHours) return { write: false, reason: null };
  if (
    policy === "improve" &&
    row.previousInOutHours != null &&
    row.previousInOutHours !== 0 &&
    row.clockedHours < row.previousInOutHours
  ) {
    return { write: false, reason: "policy" };
  }
  return { write: true, reason: null };
}

/** Calendar days from an ISO work date to the run date (>= 0). */
function ageInDays(workDate: string, today: string): number {
  const from = new Date(`${workDate}T00:00:00.000Z`).getTime();
  const to = new Date(`${today}T00:00:00.000Z`).getTime();
  return Math.max(0, Math.round((to - from) / 86400000));
}

/**
 * Match the sheets to the clocked readings.
 *
 * Pure on purpose: every rule the Admin relies on ("this is what will change",
 * "this is still pending", "this employee has no attendance row") is decided here and
 * unit-tested without a database or a SQL Server.
 *
 * A sheet whose employee is absent from the source is left UNTOUCHED, not cleared: an
 * absent row means "the view has nothing to say", which must not wipe a value an
 * earlier run already fetched. Such a sheet stays PENDING, which is the signal that
 * regularization is still outstanding.
 */
export function planInOutHoursUpdate(
  sheets: SheetForRefresh[],
  clockedByDate: Map<string, ClockedHoursForDate>,
  options: { overwritePolicy?: OverwritePolicy; today?: string } = {}
): PlannedSheet[] {
  const policy = options.overwritePolicy ?? "any";
  const today = options.today ?? new Date().toISOString().slice(0, 10);

  return sheets.map((sheet) => {
    const base = { ...sheet, ageDays: ageInDays(sheet.workDate, today) };

    // An Admin's manual figure is not re-derived: the source is still reported so the
    // screen can show a disagreement, but nothing is written over the decision.
    if (sheet.previousSource === "MANUAL") {
      const reading = clockedByDate.get(sheet.workDate)?.get(sheet.ecNo.trim().toUpperCase());
      const clocked = reading?.manHours ?? null;
      const rounded = clocked == null ? null : Math.round((clocked - sheet.bookedHours) * 100) / 100;
      return {
        ...base,
        clockedHours: clocked,
        difference: rounded === 0 ? 0 : rounded,
        sourceRecords: reading?.records ?? 0,
        outcome: "manual" as const,
        wouldChange: false,
        blockedReason: "manual" as const,
        pending: false,
      };
    }

    const reading = clockedByDate.get(sheet.workDate)?.get(sheet.ecNo.trim().toUpperCase());
    if (!reading) {
      return {
        ...base,
        clockedHours: null,
        difference: null,
        sourceRecords: 0,
        outcome: "not-in-source" as const,
        wouldChange: false,
        blockedReason: null,
        pending: true,
      };
    }
    if (reading.manHours == null) {
      return {
        ...base,
        clockedHours: null,
        difference: null,
        sourceRecords: reading.records,
        outcome: "no-hours-in-source" as const,
        wouldChange: false,
        blockedReason: null,
        pending: true,
      };
    }
    // Round to 2dp, and normalise -0 to 0 so the UI never prints "-0".
    const rounded = Math.round((reading.manHours - sheet.bookedHours) * 100) / 100;
    const row: PlannedSheet = {
      ...base,
      clockedHours: reading.manHours,
      difference: rounded === 0 ? 0 : rounded,
      sourceRecords: reading.records,
      outcome: "matched" as const,
      wouldChange: false,
      blockedReason: null,
      pending: false,
    };
    const decision = decideWrite(row, policy);
    return {
      ...row,
      wouldChange: decision.write,
      blockedReason: decision.reason,
      // A source figure of 0 is still outstanding regularization, not a result.
      pending: reading.manHours === 0,
    };
  });
}

/** Hours a sheet booked: shift slot = 2h, legacy hour slot = 1h, plus its OT hours. */
export function bookedHoursForEntries(
  entries: { hourSlot: number | null; shiftSlot: string | null; otHours: number | null }[]
): number {
  const hourSlots = new Set<number>();
  const shiftSlots = new Set<string>();
  let overtime = 0;
  for (const entry of entries) {
    if (entry.hourSlot != null) hourSlots.add(entry.hourSlot);
    if (entry.shiftSlot != null) shiftSlots.add(entry.shiftSlot);
    if (entry.otHours != null) overtime += entry.otHours;
  }
  return hourSlots.size + shiftSlots.size * 2 + overtime;
}

export type RefreshOptions = {
  /** Inclusive ISO work date, `YYYY-MM-DD`. */
  dateFrom: string;
  /** Inclusive ISO work date, `YYYY-MM-DD`. */
  dateTo: string;
  /** Also stamp sheets that are still DRAFT (default false: a draft is being written). */
  includeDraft?: boolean;
  /** Report what would change without writing anything. */
  dryRun?: boolean;
  /** Only look at sheets that still have nothing usable (the sweep). */
  onlyPending?: boolean;
  /** Write any difference (`any`, default) or only fill a gap / raise a figure. */
  overwritePolicy?: OverwritePolicy;
  /** Days older than this are out of scope, so a closed period stops moving. */
  maxAgeDays?: number;
  /** Deliberately re-check days older than the cut-off. */
  ignoreAgeCutoff?: boolean;
  /** Test seam: replace the LabourWorks read. */
  fetchForDate?: (date: string) => Promise<ClockedHoursForDate>;
};

export type RefreshResult = {
  dateFrom: string;
  dateTo: string;
  dryRun: boolean;
  includeDraft: boolean;
  onlyPending: boolean;
  overwritePolicy: OverwritePolicy;
  maxAgeDays: number;
  /** Sheets considered (every in-scope, non-draft sheet, one per supervisor-day). */
  sheets: number;
  matched: number;
  unmatched: number;
  updated: number;
  unchanged: number;
  /** In-scope sheets this run writes nothing for: absent, no hours, or a clocked 0. */
  pending: number;
  /** Differences deliberately not written, with the reason. */
  skipped: { manual: number; policy: number };
  /** Source reads performed (one per date that had an in-scope sheet). */
  datesFetched: number;
  /** Per-date source failures. The other dates still run. */
  errors: { date: string; message: string }[];
  rows: PlannedSheet[];
};

/** Every ISO date from `dateFrom` to `dateTo`, inclusive. */
export function dateRange(dateFrom: string, dateTo: string, maxDays = 400): string[] {
  const start = new Date(`${dateFrom}T00:00:00.000Z`);
  const end = new Date(`${dateTo}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw new Error("dateFrom and dateTo must be ISO dates (YYYY-MM-DD).");
  if (start > end) throw new Error("dateFrom must not be after dateTo.");
  const days: string[] = [];
  for (let day = start; day <= end && days.length < maxDays; day = new Date(day.getTime() + 86400000)) {
    days.push(day.toISOString().slice(0, 10));
  }
  if (dayAfter(days[days.length - 1]) <= `${dateTo}T00:00:00.000Z`) {
    throw new Error(`The range is longer than ${maxDays} days; narrow it and run again.`);
  }
  return days;
}

function dayAfter(iso: string): string {
  return new Date(new Date(`${iso}T00:00:00.000Z`).getTime() + 86400000).toISOString();
}

/** The configured policy knobs, in one place for the route, the jobs and the tests. */
export function attendancePolicy() {
  const overwriteRaw = envValue("ATTENDANCE_HOURS_OVERWRITE").toLowerCase();
  const maxAge = Number(envValue("ATTENDANCE_HOURS_MAX_AGE_DAYS") || 45);
  return {
    overwrite: (overwriteRaw === "improve" ? "improve" : "any") as OverwritePolicy,
    maxAgeDays: Number.isFinite(maxAge) && maxAge > 0 ? Math.min(Math.floor(maxAge), 400) : 45,
  };
}

function cutoffIso(maxAgeDays: number, today: string): string {
  return new Date(new Date(`${today}T00:00:00.000Z`).getTime() - maxAgeDays * 86400000).toISOString().slice(0, 10);
}

/**
 * Read LabourWorks for the dates that have in-scope sheets and stamp
 * `timesheet_days.in_out_hours` on the matching ones.
 *
 * Idempotent: a second run with the same source data writes nothing, so the 09:00 and
 * 21:00 job, the weekly sweep and the Admin button can run back to back.
 *
 * BACKFILL MODEL (regularization can take days):
 *  - A stored figure is never final. Every run RE-READS its whole window, including
 *    days that already have a value, so a 0.00 that becomes 8.00 three days later is
 *    corrected on the next run. Do not "optimise" this into "only fetch days that are
 *    still empty" - that would freeze the pending days forever.
 *  - Every consulted day records `in_out_checked_at` and bumps `in_out_attempts`, so a
 *    day that is still 0 after N checks is visible as outstanding work.
 *  - `maxAgeDays` closes the period: older days stop being re-checked (an Admin can
 *    override deliberately with `ignoreAgeCutoff`).
 */
export async function refreshInOutHours(options: RefreshOptions): Promise<RefreshResult> {
  const includeDraft = options.includeDraft === true;
  const dryRun = options.dryRun === true;
  const onlyPending = options.onlyPending === true;
  const policyConfig = attendancePolicy();
  const overwritePolicy = options.overwritePolicy ?? policyConfig.overwrite;
  const maxAgeDays = options.maxAgeDays ?? policyConfig.maxAgeDays;
  const today = new Date().toISOString().slice(0, 10);
  const dates = dateRange(options.dateFrom, options.dateTo);
  const fetchForDate = options.fetchForDate ?? fetchClockedHoursForDate;

  const statuses = includeDraft ? [...NON_DRAFT_STATUSES, "DRAFT"] : NON_DRAFT_STATUSES;
  const days = await prisma.timesheetDay.findMany({
    where: {
      status: { in: statuses },
      workDate: {
        // The cut-off keeps a closed period from moving under the finance team's feet;
        // the range itself comes from dateFrom/dateTo.
        gte: new Date(`${options.ignoreAgeCutoff ? dates[0] : cutoffIso(maxAgeDays, today)}T00:00:00.000Z`),
        lte: new Date(`${dates[dates.length - 1]}T23:59:59.999Z`),
      },
      // A manual figure is an Admin decision; a sweep must not even look at it.
      // NOTE: `inOutSource: { not: "MANUAL" }` alone would also drop every row whose
      // source is NULL (SQL three-valued logic), i.e. exactly the never-fetched days
      // this filter exists to find. NULL must therefore be listed explicitly.
      ...(onlyPending
        ? {
            AND: [
              { OR: [{ inOutHours: null }, { inOutHours: 0 }] },
              { OR: [{ inOutSource: null }, { inOutSource: { not: "MANUAL" } }] },
            ],
          }
        : {}),
    },
    include: {
      employee: { select: { id: true, name: true, ecNo: true } },
      entries: { select: { hourSlot: true, shiftSlot: true, otHours: true } },
    },
    orderBy: [{ workDate: "asc" }, { id: "asc" }],
  });

  const sheets: SheetForRefresh[] = days.map((day) => ({
    dayId: day.id,
    employeeId: day.employeeId,
    employeeName: day.employee.name,
    ecNo: day.employee.ecNo,
    workDate: day.workDate.toISOString().slice(0, 10),
    status: day.status,
    bookedHours: bookedHoursForEntries(day.entries),
    previousInOutHours: day.inOutHours,
    previousSource: day.inOutSource,
    previousAttempts: day.inOutAttempts,
  }));

  // Only dates that actually hold an in-scope sheet are read: a 60-day sweep usually
  // touches a handful of dates instead of 60.
  const neededDates = [...new Set(sheets.map((sheet) => sheet.workDate))].sort();
  const clockedByDate = new Map<string, ClockedHoursForDate>();
  const errors: { date: string; message: string }[] = [];
  const checkedDates = new Set<string>();
  for (const date of neededDates) {
    try {
      clockedByDate.set(date, await fetchForDate(date));
      checkedDates.add(date);
    } catch (error) {
      errors.push({ date, message: error instanceof Error ? error.message : String(error) });
    }
  }

  const plan = planInOutHoursUpdate(sheets, clockedByDate, { overwritePolicy, today });
  const consulted = plan.filter((row) => row.outcome !== "manual" && checkedDates.has(row.workDate));
  const toWrite = consulted.filter((row) => row.wouldChange && row.clockedHours != null);
  const consultedUnchanged = consulted.filter((row) => !toWrite.includes(row));
  const now = new Date();

  if (!dryRun) {
    // One UPDATE per distinct clocked figure instead of one per sheet.
    const byValue = new Map<number, number[]>();
    for (const row of toWrite) {
      const bucket = byValue.get(row.clockedHours as number) ?? [];
      bucket.push(row.dayId);
      byValue.set(row.clockedHours as number, bucket);
    }
    for (const [value, dayIds] of byValue) {
      await prisma.timesheetDay.updateMany({
        where: { id: { in: dayIds } },
        data: { inOutHours: value, inOutSource: "LABOURWORKS", inOutCheckedAt: now, inOutAttempts: { increment: 1 } },
      });
    }
    // Days that were consulted but produced no write still record the check, which is
    // what turns "0 since 19 Sep" into visible, countable outstanding work.
    if (consultedUnchanged.length) {
      await prisma.timesheetDay.updateMany({
        where: { id: { in: consultedUnchanged.map((row) => row.dayId) } },
        data: { inOutCheckedAt: now, inOutAttempts: { increment: 1 } },
      });
    }
  }

  return {
    dateFrom: dates[0],
    dateTo: dates[dates.length - 1],
    dryRun,
    includeDraft,
    onlyPending,
    overwritePolicy,
    maxAgeDays,
    sheets: sheets.length,
    matched: plan.filter((row) => row.clockedHours != null).length,
    unmatched: plan.filter((row) => row.outcome === "not-in-source" || row.outcome === "no-hours-in-source").length,
    updated: dryRun ? 0 : toWrite.length,
    unchanged: consulted.filter((row) => row.outcome === "matched" && !row.wouldChange && row.blockedReason == null).length,
    pending: plan.filter((row) => row.pending).length,
    skipped: {
      manual: plan.filter((row) => row.blockedReason === "manual").length,
      policy: plan.filter((row) => row.blockedReason === "policy").length,
    },
    datesFetched: checkedDates.size,
    errors,
    rows: plan,
  };
}

/** One row of the "still pending" report, straight from the database. */
export type PendingInOutRow = {
  dayId: number;
  employeeId: number;
  employeeName: string;
  ecNo: string;
  workDate: string;
  status: string;
  bookedHours: number;
  inOutHours: number | null;
  inOutSource: string | null;
  inOutAttempts: number;
  inOutCheckedAt: string | null;
  ageDays: number;
};

/**
 * Days that still have no usable clocked figure: absent from the source, no ManHours,
 * or a clocked 0. Reads nothing from LabourWorks, so it is cheap enough to call on
 * every screen load - which is the point: this is the daily "chase the yard" list.
 *
 * A MANUAL value is never listed.
 */
export async function readPendingInOutHours(options: { maxAgeDays?: number } = {}): Promise<PendingInOutRow[]> {
  const maxAgeDays = options.maxAgeDays ?? attendancePolicy().maxAgeDays;
  const today = new Date().toISOString().slice(0, 10);
  const days = await prisma.timesheetDay.findMany({
    where: {
      status: { in: NON_DRAFT_STATUSES },
      workDate: { gte: new Date(`${cutoffIso(maxAgeDays, today)}T00:00:00.000Z`) },
      // NULL has to be listed explicitly: `{ not: "MANUAL" }` alone excludes it, and a
      // never-fetched day is the most pending day there is.
      AND: [
        { OR: [{ inOutHours: null }, { inOutHours: 0 }] },
        { OR: [{ inOutSource: null }, { inOutSource: { not: "MANUAL" } }] },
      ],
    },
    include: {
      employee: { select: { id: true, name: true, ecNo: true } },
      entries: { select: { hourSlot: true, shiftSlot: true, otHours: true } },
    },
    orderBy: [{ workDate: "asc" }, { id: "asc" }],
  });

  return days.map((day) => ({
    dayId: day.id,
    employeeId: day.employeeId,
    employeeName: day.employee.name,
    ecNo: day.employee.ecNo,
    workDate: day.workDate.toISOString().slice(0, 10),
    status: day.status,
    bookedHours: bookedHoursForEntries(day.entries),
    inOutHours: day.inOutHours,
    inOutSource: day.inOutSource,
    inOutAttempts: day.inOutAttempts,
    inOutCheckedAt: day.inOutCheckedAt ? day.inOutCheckedAt.toISOString() : null,
    ageDays: ageInDays(day.workDate.toISOString().slice(0, 10), today),
  }));
}

/**
 * The weekly sweep: everything still pending inside the allowed age, oldest first.
 * It re-checks only days with nothing usable, so it is cheap even though its window is
 * the whole regularization horizon.
 */
export async function sweepPendingInOutHours(
  options: { dryRun?: boolean; maxAgeDays?: number; fetchForDate?: (date: string) => Promise<ClockedHoursForDate> } = {}
): Promise<RefreshResult & { pendingBefore: number }> {
  const maxAgeDays = options.maxAgeDays ?? attendancePolicy().maxAgeDays;
  const today = new Date().toISOString().slice(0, 10);
  const pendingBefore = (await readPendingInOutHours({ maxAgeDays })).length;
  const result = await refreshInOutHours({
    dateFrom: cutoffIso(maxAgeDays, today),
    dateTo: today,
    onlyPending: true,
    maxAgeDays,
    dryRun: options.dryRun,
    fetchForDate: options.fetchForDate,
  });
  return { ...result, pendingBefore };
}

/**
 * An Admin sets (or clears) the clocked figure for one day by hand, for a day HR
 * confirms in writing that LabourWorks will never regularize. Flagged MANUAL so no
 * refresh overwrites it, and audited by the route.
 */
export async function setManualInOutHours(dayId: number, hours: number | null): Promise<{ dayId: number; inOutHours: number | null; inOutSource: string | null }> {
  const day = await prisma.timesheetDay.findUnique({ where: { id: dayId }, select: { id: true } });
  if (!day) throw new Error(`Timesheet day #${dayId} does not exist.`);
  if (hours == null) {
    // Clearing hands the day back to the source: the next refresh fills it again.
    const cleared = await prisma.timesheetDay.update({
      where: { id: dayId },
      data: { inOutHours: null, inOutSource: null, inOutCheckedAt: null, inOutAttempts: 0 },
      select: { id: true, inOutHours: true, inOutSource: true },
    });
    return { dayId: cleared.id, inOutHours: cleared.inOutHours, inOutSource: cleared.inOutSource };
  }
  if (!Number.isFinite(hours) || hours < 0 || hours > 24) {
    throw new Error("Clocked hours must be a number between 0 and 24.");
  }
  const updated = await prisma.timesheetDay.update({
    where: { id: dayId },
    data: { inOutHours: Math.round(hours * 100) / 100, inOutSource: "MANUAL" },
    select: { id: true, inOutHours: true, inOutSource: true },
  });
  return { dayId: updated.id, inOutHours: updated.inOutHours, inOutSource: updated.inOutSource };
}

/** The window the daily job refreshes: today and the lookback days before it. */
export function scheduledRefreshWindow(now = new Date()): { dateFrom: string; dateTo: string } {
  const lookback = Number(process.env.ATTENDANCE_HOURS_LOOKBACK_DAYS || 7);
  const days = Number.isFinite(lookback) && lookback >= 0 ? Math.min(Math.floor(lookback), 60) : 7;
  const dateTo = now.toISOString().slice(0, 10);
  const dateFrom = new Date(now.getTime() - days * 86400000).toISOString().slice(0, 10);
  return { dateFrom, dateTo };
}
