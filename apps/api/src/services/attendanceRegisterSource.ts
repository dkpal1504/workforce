/**
 * Reading the attendance REGISTER from LabourWorks — one query per date, whole plant.
 *
 * WHAT CHANGED FROM `attendanceHours.ts`: that module answers "how long did THIS submitted sheet's man
 * clock?" and therefore reads only the dates its sheets mention. This one reads the date itself and gets
 * every worker the register holds for it — which is the only way to learn that a date was a weekly off or
 * a holiday (nobody was in the plant) and to see a man who was ABSENT rather than merely unbooked.
 *
 * READ-ONLY. `readOnlyIntent: true`, SELECT only, and the reconciliation script that uses it writes
 * nothing to the application database.
 *
 * THE COLUMN NAMES ARE CONFIGURATION, like the existing reader's: the view belongs to the IT team, and a
 * rename must be a config change rather than a deploy. The defaults are the names confirmed on
 * 2026-10-23: `isWeeklyOff`, `OriginalStatus`, `AcceptedManHrs`, `AcceptedOT`.
 *
 * AGGREGATION HAPPENS IN SQL (`GROUP BY IDNo`), deliberately: the register can hold more than one row per
 * man per date (a split day; a night shift whose checkout lands next morning), and the application should
 * store exactly one fact per employee-day. `ATTENDANCE_HOURS_AGGREGATE` chooses SUM (default, matching the
 * shipped reader) or MAX (if the source repeats the day total on each punch row) — the reconciliation
 * prints both, so the source's real shape decides.
 */

import fs from "node:fs/promises";
import sql from "mssql";
import { attendanceSourceConfig, explainSourceError, parseManHours, quoteIdentifier, quoteView } from "./attendanceHours";
import { parseCsv } from "./csvParser";
import type { HoursAggregate, RawRegisterRow } from "./attendanceRegister";

function envValue(name: string): string {
  return (process.env[name] ?? "").trim();
}

/**
 * The view this reader uses.
 *
 * SEPARATE from `ATTENDANCE_DB_VIEW` on purpose: that variable belongs to the Clocked Hours screen, which
 * reads `Report_Attendance_Intermediate` — an attendance LOG holding one row per punch (`ManHours`). The
 * register needs `Report_Attendance_View`, the object that also carries the day type and the accepted
 * figures. Pointing both at one variable would silently swap the object under the existing screen the next
 * time either side changes its view. Confirmed by the customer on 2026-10-23.
 */
export function registerViewName(): string {
  return envValue("ATTENDANCE_REGISTER_DB_VIEW") || "dbo.Report_Attendance_View";
}

/** The register's columns, resolved from configuration with the confirmed defaults. */
export function registerColumns() {
  return {
    date: envValue("ATTENDANCE_DB_DATE_COLUMN") || "Date",
    id: envValue("ATTENDANCE_DB_ID_COLUMN") || "IDNo",
    weeklyOff: envValue("ATTENDANCE_DB_WEEKLY_OFF_COLUMN") || "isWeeklyOff",
    status: envValue("ATTENDANCE_DB_STATUS_COLUMN") || "OriginalStatus",
    acceptedHours: envValue("ATTENDANCE_DB_ACCEPTED_HOURS_COLUMN") || "AcceptedManHrs",
    acceptedOt: envValue("ATTENDANCE_DB_ACCEPTED_OT_COLUMN") || "AcceptedOT",
    rawHours: envValue("ATTENDANCE_DB_HOURS_COLUMN") || "ManHours",
    cardType: envValue("ATTENDANCE_REGISTER_CARD_TYPE_COLUMN") || "CardType",
    isHoliday: envValue("ATTENDANCE_DB_HOLIDAY_COLUMN") || "isHoliday",
    isLeave: envValue("ATTENDANCE_DB_LEAVE_COLUMN") || "isLeave",
    isTerminated: envValue("ATTENDANCE_REGISTER_TERMINATED_COLUMN") || "IsTerminated",
  };
}

/** The aggregation policy, from `ATTENDANCE_HOURS_AGGREGATE` (SUM default, MAX on request). */
export function registerAggregate(): HoursAggregate {
  return envValue("ATTENDANCE_HOURS_AGGREGATE").toUpperCase() === "MAX" ? "MAX" : "SUM";
}

/**
 * Which card types belong to this application's population.
 *
 * THE REGISTER IS BIGGER THAN THIS APP. It also carries EOU contractors and other card types, which is why
 * the first production run reported 4,620 identifiers with no `Employee` row. The people this app reports
 * on are the associates, confirmed by the customer on 2026-10-23: `Associates` and `ASSOCIATE SEZ`.
 *
 * `ATTENDANCE_REGISTER_CARD_TYPES` overrides the list (comma-separated); the single value `ALL` disables the
 * filter. An empty list never silently means "everything" — it means the filter is off only when asked.
 */
export function registerCardTypes(): string[] {
  const raw = envValue("ATTENDANCE_REGISTER_CARD_TYPES");
  const list = (raw === "" ? "Associates,ASSOCIATE SEZ" : raw)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (list.length === 1 && list[0].toUpperCase() === "ALL") return [];
  for (const value of list) {
    // The value is interpolated into SQL, so it may only contain characters a card type can hold.
    if (!/^[A-Za-z0-9 .&_-]+$/.test(value)) {
      throw new Error(
        `ATTENDANCE_REGISTER_CARD_TYPES contains an unsupported value ${JSON.stringify(value)} — letters, ` +
          "digits, spaces, dot, ampersand, underscore and hyphen only."
      );
    }
  }
  return list;
}

/**
 * Today, in the application's timezone (`APP_TIMEZONE`, default `Asia/Kolkata`).
 *
 * `new Date().toISOString().slice(0,10)` is the UTC date, which is YESTERDAY for every run between 00:00
 * and 05:30 IST — and a job at 02:10 would settle or clamp the wrong day. This is the single conversion.
 */
export function todayInAppZone(now: Date = new Date()): string {
  const timeZone = process.env.APP_TIMEZONE || "Asia/Kolkata";
  try {
    // en-CA renders ISO-like YYYY-MM-DD, which is why it is used rather than a hand-built string.
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/**
 * Drop the future from a date range.
 *
 * THE REGISTER HOLDS PLANNING ROWS: LabourWorks pre-generates an absence row per worker for dates that
 * have not happened (observed: everyone absent on 2026-12-31, max date weeks ahead). Counting those would
 * invent absences, so a future date is never read. Confirmed as a rule by the customer, 2026-10-23.
 */
export function clampRangeToToday(
  range: { from: string; to: string },
  today: string = todayInAppZone()
): { from: string; to: string; requestedTo: string; clamped: boolean } {
  const to = range.to > today ? today : range.to;
  return { from: range.from, to, requestedTo: range.to, clamped: to !== range.to };
}

/**
 * The population filter: card type = associates, and the worker is not terminated.
 *
 * Customer's rule (2026-10-23): `[CardType]` must be `Associates` or `ASSOCIATE SEZ`, and `[IsTerminated]`
 * must be 0. A terminated worker has no attendance rows, so leaving his rows in would put a man on the
 * roster who can never be present — which reads in the reports as a permanent absence.
 *
 * NULL IS TREATED AS NOT TERMINATED (`ISNULL(col,0) = 0`). `IsTerminated` is a nullable bit, and `= 0`
 * alone would silently drop every row whose flag is unset — the same three-valued-logic trap this codebase
 * already documents for `inOutSource != 'MANUAL'`. If the business wants unset treated as terminated, that
 * is one word here; the census prints the distribution so the choice is visible, not assumed.
 */
export function registerPopulationFilter(): string {
  const cardTypes = registerCardTypes();
  const terminatedColumn = quoteIdentifier(registerColumns().isTerminated, "ATTENDANCE_REGISTER_TERMINATED_COLUMN");
  const cardClause = cardTypes.length
    ? ` AND UPPER(LTRIM(RTRIM(${quoteIdentifier(registerColumns().cardType, "ATTENDANCE_REGISTER_CARD_TYPE_COLUMN")}))) IN (${cardTypes
        .map((value) => `'${value.toUpperCase()}'`)
        .join(", ")})`
    : "";
  return `${cardClause} AND ISNULL(${terminatedColumn}, 0) = 0`;
}

/**
 * The SQL for one work date.
 *
 * `MAX(...)` on the day-level attributes (weekly off, status) and `SUM(...)` on the figures, grouped by
 * the employee id: one row per employee-day regardless of how many punches the source held.
 * `COUNT(DISTINCT OriginalStatus)` is carried so a contradicting day is FLAGGED rather than averaged away.
 *
 * `ATTENDANCE_REGISTER_QUERY` replaces the whole statement (it must bind `@workDate`), for the case where
 * the DBA supplies an exact query or the view needs its own date filter.
 */
export function registerSql(): string {
  const override = envValue("ATTENDANCE_REGISTER_QUERY");
  if (override) return override;
  const view = quoteView(registerViewName());
  const columns = registerColumns();
  const id = quoteIdentifier(columns.id, "ATTENDANCE_DB_ID_COLUMN");
  const date = quoteIdentifier(columns.date, "ATTENDANCE_DB_DATE_COLUMN");
  const weeklyOff = quoteIdentifier(columns.weeklyOff, "ATTENDANCE_DB_WEEKLY_OFF_COLUMN");
  const status = quoteIdentifier(columns.status, "ATTENDANCE_DB_STATUS_COLUMN");
  const acceptedHours = quoteIdentifier(columns.acceptedHours, "ATTENDANCE_DB_ACCEPTED_HOURS_COLUMN");
  const acceptedOt = quoteIdentifier(columns.acceptedOt, "ATTENDANCE_DB_ACCEPTED_OT_COLUMN");
  const rawHours = quoteIdentifier(columns.rawHours, "ATTENDANCE_DB_HOURS_COLUMN");
  return (
    `SELECT ${id} AS IdNo, ` +
    `MAX(${weeklyOff}) AS IsWeeklyOff, ` +
    `MAX(${status}) AS OriginalStatus, ` +
    `MAX(${quoteIdentifier(columns.isHoliday, "ATTENDANCE_DB_HOLIDAY_COLUMN")}) AS IsHoliday, ` +
    `COUNT(DISTINCT ${status}) AS StatusVariants, ` +
    `SUM(${acceptedHours}) AS AcceptedManHrs, ` +
    `SUM(${acceptedOt}) AS AcceptedOT, ` +
    `SUM(${rawHours}) AS RawManHours, ` +
    `COUNT(*) AS Records ` +
    `FROM ${view} WHERE CAST(${date} AS date) = CAST(@workDate AS date)` +
    registerPopulationFilter() +
    ` GROUP BY ${id}`
  );
}

/** Case-insensitive field read: `IdNo` / `IDNo` / `idno` are the same column to the source's owner. */
function pick(record: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    if (record[name] !== undefined) return record[name];
  }
  const lowered = new Map<string, unknown>();
  for (const [key, value] of Object.entries(record)) lowered.set(key.toLowerCase(), value);
  for (const name of names) {
    const value = lowered.get(name.toLowerCase());
    if (value !== undefined) return value;
  }
  return undefined;
}

/** One recordset row -> the shape `aggregateRegisterRows` takes. */
export function rowFromRecordset(record: Record<string, unknown>, workDate: string): RawRegisterRow | null {
  const idNo = String(pick(record, "IdNo", "IDNo", "idno") ?? "").trim();
  if (!idNo) return null;
  return {
    workDate,
    idNo,
    isWeeklyOff: pick(record, "IsWeeklyOff", "isWeeklyOff", "isweeklyoff"),
    originalStatus: pick(record, "OriginalStatus", "originalStatus", "originalstatus"),
    acceptedManHours: pick(record, "AcceptedManHrs", "AcceptedManHours", "acceptedManHrs"),
    acceptedOt: pick(record, "AcceptedOT", "AcceptedOt", "acceptedOt", "AcceptedOTHours"),
    rawManHours: pick(record, "RawManHours", "ManHours", "manHours"),
    records: Number(pick(record, "Records", "records") ?? 1) || 1,
    statusVariants: Number(pick(record, "StatusVariants", "statusVariants") ?? 1) || 1,
    isHoliday: pick(record, "IsHoliday", "isHoliday", "isholiday"),
  };
}

/** Is a local fixture configured? Refused in production, like the existing reader's seam. */
export function registerFixturePath(): string | null {
  const path = envValue("ATTENDANCE_REGISTER_FIXTURE");
  if (!path) return null;
  if (String(process.env.NODE_ENV || "").toLowerCase() === "production") {
    throw new Error("ATTENDANCE_REGISTER_FIXTURE is not allowed when NODE_ENV=production.");
  }
  return path;
}

/**
 * Fixture formats, both mirroring the SQL's own aliases:
 *   JSON: `{ "2026-10-01": [ { "IDNo": "BAPL0123", "isWeeklyOff": 0, "OriginalStatus": "P", ... } ] }`
 *   CSV:  `date,IDNo,isWeeklyOff,OriginalStatus,AcceptedManHrs,AcceptedOT,ManHours`
 * The CSV tolerates a missing `isWeeklyOff`/status column (they become false/UNKNOWN) so an older
 * fixture still exercises the reader instead of failing on a column that did not exist before.
 */
export function parseRegisterFixture(text: string): Map<string, RawRegisterRow[]> {
  const byDate = new Map<string, RawRegisterRow[]>();
  const push = (row: RawRegisterRow) => {
    const list = byDate.get(row.workDate) ?? [];
    list.push(row);
    byDate.set(row.workDate, list);
  };
  const trimmed = text.trim();
  if (!trimmed) return byDate;

  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed) as Record<string, Array<Record<string, unknown>>>;
    for (const [workDate, rows] of Object.entries(parsed)) {
      for (const record of rows ?? []) {
        const row = rowFromRecordset(record, workDate);
        if (row) push(row);
      }
    }
    // FAIL LOUDLY. A fixture whose column names do not match produces an empty map that looks exactly
    // like "the yard had no attendance that month" — and a reconciliation built on that is worse than no
    // reconciliation. (This actually happened: the fixture used the view's `IDNo`, the mapper read the
    // SQL alias `IdNo`, and 56,318 rows silently became zero.)
    if (byDate.size === 0 && Object.keys(parsed).length > 0) {
      throw new Error(
        "The attendance fixture was read but produced NO rows. Check its column names — it needs at least " +
          "IDNo, OriginalStatus and AcceptedManHrs (isWeeklyOff / AcceptedOT / ManHours are read when present)."
      );
    }
    return byDate;
  }

  const table = parseCsv(trimmed);
  if (!table.length) return byDate;
  const header = table[0].map((cell) => cell.trim().toLowerCase());
  const index = (...names: string[]) => header.findIndex((cell) => names.includes(cell));
  const dateIdx = index("date", "workdate", "work_date");
  const idIdx = index("idno", "id_no", "ecno", "idcardno");
  const offIdx = index("isweeklyoff", "is_weekly_off", "weeklyoff");
  const statusIdx = index("originalstatus", "original_status", "status");
  const hoursIdx = index("acceptedmanhrs", "accepted_man_hrs", "acceptedmanhours");
  const otIdx = index("acceptedot", "accepted_ot");
  const rawIdx = index("manhours", "man_hours");
  if (dateIdx < 0 || idIdx < 0 || hoursIdx < 0) {
    throw new Error("ATTENDANCE_REGISTER_FIXTURE CSV needs columns: date, IDNo, AcceptedManHrs (isWeeklyOff / OriginalStatus / AcceptedOT / ManHours optional).");
  }
  for (const cells of table.slice(1)) {
    const workDate = (cells[dateIdx] ?? "").trim().slice(0, 10);
    const idNo = (cells[idIdx] ?? "").trim();
    if (!workDate || !idNo) continue;
    push({
      workDate,
      idNo,
      isWeeklyOff: offIdx < 0 ? 0 : cells[offIdx],
      originalStatus: statusIdx < 0 ? "P" : cells[statusIdx],
      acceptedManHours: cells[hoursIdx],
      acceptedOt: otIdx < 0 ? null : cells[otIdx],
      rawManHours: rawIdx < 0 ? parseManHours(cells[hoursIdx]) : cells[rawIdx],
      records: 1,
      statusVariants: 1,
    });
  }
  return byDate;
}

export type RegisterFetchResult = {
  byDate: Map<string, RawRegisterRow[]>;
  /**
   * Columns the view actually has, when every read failed on an unknown column. Populated only on that
   * failure so the caller can print the real names instead of "check your column mapping".
   */
  availableColumns?: string[];
  /** Dates dropped because they are in the future (planning rows, never attendance). */
  skippedFutureDates?: number;
  /** Dates the source answered for; a date MISSING here was never read (not "empty"). */
  datesRead: string[];
  errors: Array<{ date: string; message: string }>;
  /** `SQL` or `FIXTURE` — printed in every report, so nobody mistakes synthetic data for real. */
  source: "SQL" | "FIXTURE";
};

/**
 * Read the register for a date range.
 *
 * ONE connection for the whole range (not one per date): a 90-day reconciliation would otherwise pay 90
 * connection handshakes against the yard's SQL Server. Per-date failures are collected, never fatal — an
 * unreadable date must be visible as "not covered", not silently treated as a holiday.
 */
export async function fetchRegisterRange(options: {
  dateFrom: string;
  dateTo: string;
  dates?: string[];
}): Promise<RegisterFetchResult> {
  const requestedDates = options.dates ?? expandDates(options.dateFrom, options.dateTo);
  // Defence in depth: even if a caller asks for the future, the read stops at today.
  const today = todayInAppZone();
  const dates = requestedDates.filter((date) => date <= today);
  const skippedFutureDates = requestedDates.length - dates.length;
  const errors: Array<{ date: string; message: string }> = [];
  const byDate = new Map<string, RawRegisterRow[]>();
  let availableColumns: string[] | undefined;

  const fixture = registerFixturePath();
  if (fixture) {
    const parsed = parseRegisterFixture(await fs.readFile(fixture, "utf8"));
    for (const date of dates) {
      const rows = parsed.get(date);
      if (rows) byDate.set(date, rows);
    }
    return { byDate, datesRead: [...byDate.keys()].sort(), errors, source: "FIXTURE", skippedFutureDates };
  }

  const config = attendanceSourceConfig();
  if (!config.server || !config.user) {
    throw new Error(
      "BADGEVIEW_DB_HOST and BADGEVIEW_DB_USER (or ATTENDANCE_DB_USER) must be set to read the attendance register."
    );
  }
  let pool: sql.ConnectionPool | null = null;
  try {
    pool = await new sql.ConnectionPool({
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
    const statement = registerSql();
    for (const date of dates) {
      try {
        const request = pool.request();
        request.input("workDate", sql.VarChar(10), date);
        const response = await request.query(statement);
        const rows = ((response.recordset as Record<string, unknown>[]) || [])
          .map((record) => rowFromRecordset(record, date))
          .filter((row): row is RawRegisterRow => row != null);
        byDate.set(date, rows);
      } catch (error) {
        const message = explainSourceError(error, config);
        errors.push({ date, message });
        // DIAGNOSE, DON'T GUESS: the first unknown-column failure is answered by reading the view's own
        // column list once, on the same pool. "Invalid column name 'AcceptedOT'" then arrives with the
        // real names beside it, and nobody has to run SQL by hand from a Windows prompt.
        if (!availableColumns && /invalid column name/i.test(message)) {
          try {
            const described = await describeColumnsOnPool(pool);
            availableColumns = described.map((column) => column.name);
          } catch {
            // A failed diagnosis must not mask the original read error.
          }
        }
      }
    }
  } finally {
    if (pool) await pool.close();
  }

  return { byDate, datesRead: [...byDate.keys()].sort(), errors, source: "SQL", availableColumns, skippedFutureDates };
}

/** Every ISO date from `dateFrom` to `dateTo`, inclusive. Refuses a backwards or absurd range. */
export function expandDates(dateFrom: string, dateTo: string, maxDays = 400): string[] {
  const start = Date.parse(`${dateFrom}T00:00:00Z`);
  const end = Date.parse(`${dateTo}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error("from/to must be ISO dates (YYYY-MM-DD).");
  if (end < start) throw new Error("from must be on or before to.");
  const dates: string[] = [];
  for (let at = start; at <= end; at += 86_400_000) {
    if (dates.length >= maxDays) throw new Error(`The range is longer than ${maxDays} days; narrow it.`);
    dates.push(new Date(at).toISOString().slice(0, 10));
  }
  return dates;
}

/* --------------------------------------------------------------------------- *
 * Source description — what the view ACTUALLY contains
 * ------------------------------------------------------------------------- */

export type SourceColumn = { name: string; type: string; nullable: string };

/**
 * The columns the register reader REQUIRES. If the configured view lacks any of them, the view is not the
 * attendance register we were told about — and the useful answer is not "check your mapping" but "here is
 * the object in this database that does have these columns".
 */
export const REGISTER_REQUIRED_COLUMNS = [
  "isWeeklyOff",
  "isHoliday",
  "OriginalStatus",
  "AcceptedManHrs",
  "AcceptedOT",
  "IsTerminated",
] as const;

/** Which of the required columns the given column list does NOT have (case-insensitive). PURE. */
export function missingRequiredColumns(columns: readonly string[]): string[] {
  const lowered = new Set(columns.map((column) => column.toLowerCase()));
  return REGISTER_REQUIRED_COLUMNS.filter((required) => !lowered.has(required.toLowerCase()));
}

/** Another object in the source SERVER that carries the columns we need. */
export type SourceCandidate = {
  /** The database it lives in — the register may not be in the configured one at all. */
  database: string;
  schema: string;
  table: string;
  /** VIEW | TABLE | … */
  objectType: string;
  /** Which of the searched columns it has. */
  matched: string[];
};

/** `dbo.Report_Attendance_Intermediate` -> `{ schema: "dbo", table: "Report_Attendance_Intermediate" }`. */
export function splitViewName(view: string): { schema: string; table: string } {
  const parts = view.replace(/[\[\]]/g, "").trim().split(".").filter(Boolean);
  if (parts.length === 0) return { schema: "dbo", table: view };
  if (parts.length === 1) return { schema: "dbo", table: parts[0] };
  return { schema: parts[parts.length - 2], table: parts[parts.length - 1] };
}

/** The columns of the configured view, read from the same database the reader uses. */
async function describeColumnsOnPool(pool: sql.ConnectionPool): Promise<SourceColumn[]> {
  const { schema, table } = splitViewName(registerViewName());
  const request = pool.request();
  request.input("schema", sql.VarChar(128), schema);
  request.input("table", sql.VarChar(128), table);
  const response = await request.query(
    "SELECT COLUMN_NAME AS name, DATA_TYPE AS type, IS_NULLABLE AS nullable " +
      "FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @schema AND TABLE_NAME = @table " +
      "ORDER BY ORDINAL_POSITION"
  );
  return ((response.recordset as SourceColumn[]) || []).map((row) => ({ ...row }));
}

/**
 * What the source holds, plus a best-guess mapping to the five columns this reader needs.
 *
 * The guesses are suggestions printed for a human to confirm, never applied silently: a wrong guess about
 * the overtime column would put real money in the wrong bucket.
 */
export async function describeRegisterSource(): Promise<{
  view: string;
  columns: SourceColumn[];
  sample: Array<Record<string, unknown>>;
  mapping: Record<string, string | null>;
  /** Non-empty only when the configured view lacks a required column: where those columns DO live. */
  missingColumns: string[];
  candidates: SourceCandidate[];
  /**
   * What the key columns actually CONTAIN over the last 30 days of the view, not what we assume.
   * `isWeeklyOff` is the one that can silently invert the whole report (a per-man roster flag read as
   * "the yard was closed" collapsed every date to weekly off on the first production run).
   */
  census: {
    windowFrom: string | null;
    windowTo: string | null;
    weeklyOffValues: Array<{ value: string; rows: number }>;
    statusValues: Array<{ value: string; rows: number }>;
    /** The population filter in the data's own spelling, so a mismatch is visible rather than silent. */
    cardTypeValues: Array<{ value: string; rows: number }>;
    holidayValues: Array<{ value: string; rows: number }>;
    /** 0 / 1 / NULL for the termination flag, so "NULL means not terminated" is a visible decision. */
    terminatedValues: Array<{ value: string; rows: number }>;
    /** Rows dated AFTER today. LabourWorks pre-generates an absence row per worker for future dates. */
    futureRows: number;
    maxDateAny: string | null;
    idPatterns: { alphanumeric: number; numericOnly: number; other: number };
  };
  sql: string;
}> {
  const config = attendanceSourceConfig();
  if (!config.server || !config.user) {
    throw new Error(
      "BADGEVIEW_DB_HOST and BADGEVIEW_DB_USER (or ATTENDANCE_DB_USER) must be set to describe the source."
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
    const columns = await describeColumnsOnPool(pool);
    const { schema, table } = splitViewName(registerViewName());
    let sample: Array<Record<string, unknown>> = [];
    try {
      const response = await pool.request().query(
        `SELECT TOP 5 * FROM [${schema}].[${table}] WHERE 1=1${registerPopulationFilter()} ` +
          `ORDER BY [${registerColumns().date}] DESC`
      );
      sample = ((response.recordset as Record<string, unknown>[]) || []).map((row) => ({ ...row }));
    } catch {
      // The configured date column may itself be wrong; a sample without ORDER BY is still useful.
      const response = await pool.request().query(
        `SELECT TOP 5 * FROM [${schema}].[${table}] WHERE 1=1${registerPopulationFilter()}`
      );
      sample = ((response.recordset as Record<string, unknown>[]) || []).map((row) => ({ ...row }));
    }
    const missingColumns = missingRequiredColumns(columns.map((column) => column.name));
    const candidates = missingColumns.length ? await findColumnsAcrossDatabases(pool, missingColumns) : [];
    const census = await valueCensusOnPool(pool, missingColumns.length > 0);
    return {
      view: registerViewName(),
      columns,
      sample,
      mapping: suggestColumnNames(columns.map((column) => column.name)),
      missingColumns,
      candidates,
      census,
      sql: registerSql(),
    };
  } finally {
    await pool.close();
  }
}

/**
 * Best-guess mapping from the view's real columns to the ones this reader needs.
 *
 * PURE, and deliberately conservative: each candidate list is ordered from most to least specific, so the
 * printed suggestion is a starting point for a human, not an authority. `null` means "nothing plausible —
 * you must name it".
 */
export function suggestColumnNames(columns: readonly string[]): Record<string, string | null> {
  const pickFirst = (patterns: RegExp[]): string | null => {
    for (const pattern of patterns) {
      const hit = columns.find((column) => pattern.test(column));
      if (hit) return hit;
    }
    return null;
  };
  return {
    id: pickFirst([/^id_?no$/i, /^idcardno$/i, /^ec_?no$/i, /id/i]),
    date: pickFirst([/^date$/i, /^att_?date$/i, /^attendance_?date$/i, /^work_?date$/i, /date/i]),
    weeklyOff: pickFirst([/^isweeklyoff$/i, /weekly_?off/i, /^is_?wo$/i]),
    status: pickFirst([/^originalstatus$/i, /original_?status/i, /^status$/i, /status/i]),
    isHoliday: pickFirst([/^isholiday$/i, /is_?holiday/i, /holiday/i]),
    acceptedHours: pickFirst([/^acceptedmanhrs$/i, /accepted_?man_?h/i, /accepted_?hours/i, /accepted/i]),
    acceptedOt: pickFirst([/^acceptedot$/i, /accepted_?ot/i, /accepted_?othrs/i, /acceptedothours/i, /ot_?hours/i, /overtime/i, /^ot$/i]),
    rawHours: pickFirst([/^manhours$/i, /man_?hours/i, /^hours$/i]),
  };
}

/**
 * Find the objects in the source SERVER that hold the given columns.
 *
 * THIS IS THE ANSWER TO "the view you named does not have AcceptedOT". The view belongs to another team, its
 * name changes, and the columns may live in a different database entirely — so rather than asking a human to
 * hunt through SSMS, the reader asks the server. Read-only: INFORMATION_SCHEMA only, and a database the login
 * cannot open is skipped rather than failing the whole search.
 *
 * The configured database is searched first; only if it has nothing do the other ONLINE user databases get a
 * pass, so the common case costs one query.
 */
async function findColumnsAcrossDatabases(
  pool: sql.ConnectionPool,
  columnNames: readonly string[]
): Promise<SourceCandidate[]> {
  if (!columnNames.length) return [];

  const searchOne = async (database: string | null): Promise<SourceCandidate[]> => {
    if (database != null && !/^[A-Za-z0-9_]+$/.test(database)) return [];
    const request = pool.request();
    // Compare in ONE case on both sides: the parameter carries the lower-cased name, the column is lowered
    // in SQL. Without that the search silently finds nothing — the same class of bug as the alias mismatch.
    const placeholders = columnNames.map((_, index) => `@c${index}`).join(", ");
    columnNames.forEach((name, index) => request.input(`c${index}`, sql.VarChar(128), name.toLowerCase()));
    // A database name can only be interpolated, never parameterised; it is therefore validated against a
    // strict identifier pattern before it gets near the SQL.
    const prefix = database == null ? "" : `[${database}].`;
    const response = await request.query(
      "SELECT c.TABLE_SCHEMA AS schemaName, c.TABLE_NAME AS tableName, o.type_desc AS objectType, c.COLUMN_NAME AS columnName " +
        `FROM ${prefix}INFORMATION_SCHEMA.COLUMNS c ` +
        `LEFT JOIN ${prefix}sys.objects o ON o.object_id = OBJECT_ID(QUOTENAME(c.TABLE_SCHEMA) + '.' + QUOTENAME(c.TABLE_NAME)) ` +
        `WHERE LOWER(c.COLUMN_NAME) IN (${placeholders}) ` +
        "ORDER BY c.TABLE_NAME, c.COLUMN_NAME"
    );
    const grouped = new Map<string, SourceCandidate>();
    for (const row of (response.recordset as Array<Record<string, unknown>>) || []) {
      const schema = String(row.schemaName ?? "");
      const table = String(row.tableName ?? "");
      if (!schema || !table) continue;
      const key = `${schema}.${table}`;
      const existing = grouped.get(key);
      const columnName = String(row.columnName ?? "");
      if (existing) existing.matched.push(columnName);
      else grouped.set(key, { database: database ?? "", schema, table, objectType: String(row.objectType ?? ""), matched: [columnName] });
    }
    return [...grouped.values()];
  };

  const currentDbRows = ((await pool.request().query("SELECT DB_NAME() AS name")).recordset as Array<{ name?: unknown }>) || [];
  const currentDb = String(currentDbRows[0]?.name ?? "");
  const local = (await searchOne(null)).map((candidate) => ({ ...candidate, database: currentDb }));
  if (local.length) return local.sort((a, b) => b.matched.length - a.matched.length || a.table.localeCompare(b.table));

  const otherRows = ((await pool.request().query(
    "SELECT name FROM sys.databases WHERE state_desc = 'ONLINE' AND database_id > 4"
  )).recordset as Array<{ name?: unknown }>) || [];
  const names = otherRows
    .map((row) => String(row.name ?? ""))
    .filter((name) => name && name !== currentDb && /^[A-Za-z0-9_]+$/.test(name));

  const found: SourceCandidate[] = [];
  for (const name of names) {
    try {
      found.push(...(await searchOne(name)));
    } catch {
      // No permission on that database, or it went offline mid-run: keep looking.
    }
  }
  return found.sort((a, b) => b.matched.length - a.matched.length || a.table.localeCompare(b.table));
}

/**
 * The distribution of the values we make decisions on, over the view's last 30 days.
 *
 * WHY: "every date came out as a weekly off" is not answerable from a sample row — it is a question about
 * how many rows carry 1 versus 0. This prints exactly that, plus the shape of the identifiers (numeric
 * badge ids vs letter-prefixed ecNos), which is the other thing that silently breaks the join to
 * `employees`.
 */
async function valueCensusOnPool(
  pool: sql.ConnectionPool,
  skip: boolean
): Promise<{
  windowFrom: string | null;
  windowTo: string | null;
  weeklyOffValues: Array<{ value: string; rows: number }>;
  statusValues: Array<{ value: string; rows: number }>;
  cardTypeValues: Array<{ value: string; rows: number }>;
  holidayValues: Array<{ value: string; rows: number }>;
  terminatedValues: Array<{ value: string; rows: number }>;
  futureRows: number;
  maxDateAny: string | null;
  idPatterns: { alphanumeric: number; numericOnly: number; other: number };
}> {
  const empty = {
    windowFrom: null,
    windowTo: null,
    weeklyOffValues: [],
    statusValues: [],
    cardTypeValues: [],
    holidayValues: [],
    terminatedValues: [],
    futureRows: 0,
    maxDateAny: null,
    idPatterns: { alphanumeric: 0, numericOnly: 0, other: 0 },
  };
  if (skip) return empty; // the view lacks the columns; a census of them would fail too.

  const { schema, table } = splitViewName(registerViewName());
  const columns = registerColumns();
  const qualified = `[${schema}].[${table}]`;
  const dateColumn = `[${columns.date}]`;
  // The census describes THIS APP'S population, so the same card-type filter applies. Without it the
  // weekly-off majority would be computed over the whole yard (contractors included) — the very mistake
  // that made every date look closed.
  const filter = registerPopulationFilter();
  // THE WINDOW IS ANCHORED ON TODAY, not on MAX(Date). LabourWorks pre-generates a row per worker for
  // FUTURE dates (observed: every worker absent on 2026-12-31), so MAX(Date) sits weeks ahead and a
  // "last 30 days" window built from it describes the future — which is exactly how the first census
  // came to report nothing but `A`.
  const window = await pool.request().query(
    `SELECT CONVERT(varchar(10), MIN(${dateColumn}), 23) AS windowFrom, ` +
      `CONVERT(varchar(10), MAX(CASE WHEN CAST(${dateColumn} AS date) <= CAST(GETDATE() AS date) THEN ${dateColumn} END), 23) AS windowTo, ` +
      `CONVERT(varchar(10), DATEADD(day, -30, CAST(GETDATE() AS date)), 23) AS since, ` +
      `CONVERT(varchar(10), MAX(${dateColumn}), 23) AS maxDateAny, ` +
      `SUM(CASE WHEN CAST(${dateColumn} AS date) > CAST(GETDATE() AS date) THEN 1 ELSE 0 END) AS futureRows ` +
      `FROM ${qualified} WHERE 1=1${filter}`
  );
  const row = (window.recordset as Array<Record<string, unknown>>)?.[0] ?? {};
  const windowFrom = row.windowFrom == null ? null : String(row.windowFrom);
  const windowTo = row.windowTo == null ? null : String(row.windowTo);
  const since = row.since == null ? null : String(row.since);
  const maxDateAny = row.maxDateAny == null ? null : String(row.maxDateAny);
  const futureRows = Number(row.futureRows ?? 0);
  if (!since) return { ...empty, windowFrom, windowTo, maxDateAny, futureRows };

  const distribution = async (column: string): Promise<Array<{ value: string; rows: number }>> => {
    const request = pool.request();
    request.input("since", sql.VarChar(10), since);
    const response = await request.query(
      `SELECT CONVERT(varchar(40), ${column}) AS value, COUNT(*) AS rows FROM ${qualified} ` +
        `WHERE CAST(${dateColumn} AS date) >= @since AND CAST(${dateColumn} AS date) <= CAST(GETDATE() AS date)${filter} ` +
        `GROUP BY CONVERT(varchar(40), ${column}) ORDER BY COUNT(*) DESC`
    );
    return (((response.recordset as Array<Record<string, unknown>>) || []).map((entry) => ({
      value: String(entry.value ?? "(null)"),
      rows: Number(entry.rows ?? 0),
    })));
  };

  const idRequest = pool.request();
  idRequest.input("since", sql.VarChar(10), since);
  const ids = await idRequest.query(
    `SELECT ` +
      `SUM(CASE WHEN [${columns.id}] LIKE '%[^0-9]%' THEN 1 ELSE 0 END) AS alphanumeric, ` +
      `SUM(CASE WHEN [${columns.id}] NOT LIKE '%[^0-9]%' THEN 1 ELSE 0 END) AS numericOnly, ` +
      `SUM(CASE WHEN [${columns.id}] IS NULL OR LTRIM(RTRIM([${columns.id}])) = '' THEN 1 ELSE 0 END) AS other ` +
      `FROM ${qualified} WHERE CAST(${dateColumn} AS date) >= @since ` +
        `AND CAST(${dateColumn} AS date) <= CAST(GETDATE() AS date)${filter}`
  );
  const idRow = (ids.recordset as Array<Record<string, unknown>>)?.[0] ?? {};

  return {
    windowFrom,
    windowTo,
    weeklyOffValues: await distribution(`[${columns.weeklyOff}]`),
    statusValues: await distribution(`[${columns.status}]`),
    cardTypeValues: await distribution(`[${columns.cardType}]`),
    holidayValues: await distribution(`[${columns.isHoliday}]`),
    terminatedValues: await distribution(`[${columns.isTerminated}]`),
    futureRows,
    maxDateAny,
    idPatterns: {
      alphanumeric: Number(idRow.alphanumeric ?? 0),
      numericOnly: Number(idRow.numericOnly ?? 0),
      other: Number(idRow.other ?? 0),
    },
  };
}
