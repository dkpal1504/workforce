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
  };
}

/** The aggregation policy, from `ATTENDANCE_HOURS_AGGREGATE` (SUM default, MAX on request). */
export function registerAggregate(): HoursAggregate {
  return envValue("ATTENDANCE_HOURS_AGGREGATE").toUpperCase() === "MAX" ? "MAX" : "SUM";
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
  const config = attendanceSourceConfig();
  const view = quoteView(config.view);
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
    `COUNT(DISTINCT ${status}) AS StatusVariants, ` +
    `SUM(${acceptedHours}) AS AcceptedManHrs, ` +
    `SUM(${acceptedOt}) AS AcceptedOT, ` +
    `SUM(${rawHours}) AS RawManHours, ` +
    `COUNT(*) AS Records ` +
    `FROM ${view} WHERE CAST(${date} AS date) = CAST(@workDate AS date) ` +
    `GROUP BY ${id}`
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
  const dates = options.dates ?? expandDates(options.dateFrom, options.dateTo);
  const errors: Array<{ date: string; message: string }> = [];
  const byDate = new Map<string, RawRegisterRow[]>();

  const fixture = registerFixturePath();
  if (fixture) {
    const parsed = parseRegisterFixture(await fs.readFile(fixture, "utf8"));
    for (const date of dates) {
      const rows = parsed.get(date);
      if (rows) byDate.set(date, rows);
    }
    return { byDate, datesRead: [...byDate.keys()].sort(), errors, source: "FIXTURE" };
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
        errors.push({ date, message: explainSourceError(error, config) });
      }
    }
  } finally {
    if (pool) await pool.close();
  }

  return { byDate, datesRead: [...byDate.keys()].sort(), errors, source: "SQL" };
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
