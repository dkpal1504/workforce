/**
 * Shared CSV reading for the master-data upload endpoints.
 *
 * Extracted from the Employee CSV uploader so the Job Order import reads a file
 * exactly the same way: RFC-ish quoting (embedded commas, doubled quotes and
 * newlines inside quotes), the same 2MB ceiling, and formula-injection rejection
 * (a cell starting with = + - @ is a spreadsheet formula risk, not data).
 *
 * Nothing here touches the database: the routes own their own lookups, so every
 * helper below is unit-testable on plain strings.
 */

/** Upload ceiling shared by every CSV endpoint (matches the JSON body limit in index.ts). */
export const CSV_MAX_BYTES = 2 * 1024 * 1024;

/** A plain decimal number, optionally signed, optionally in exponent form. */
const NUMERIC_CELL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** Neutralize CSV injection: a cell starting with =,+,-,@ is a formula-injection risk. */
export function isCsvInjection(value: string): boolean {
  const first = value.trim().charAt(0);
  return first === "=" || first === "+" || first === "-" || first === "@";
}

/** True when the cell is a plain number, so `-5` is data rather than a formula. */
export function isPlainNumber(value: string): boolean {
  const text = value.trim();
  return NUMERIC_CELL.test(text) && Number.isFinite(Number(text));
}

/**
 * Index of the first formula-injection cell, or -1.
 *
 * A numeric cell is exempt because a signed number legitimately starts with `-`
 * or `+`: the Job Order import must report `-5` as a negative quantity, not as an
 * injection attempt. The Employee uploader has no numeric column, so it keeps the
 * strict `isCsvInjection` check and stays byte-for-byte compatible.
 */
export function findCsvInjectionIndex(cells: string[]): number {
  return cells.findIndex((cell) => isCsvInjection(cell) && !isPlainNumber(cell));
}

/** Parse a CSV string (handles quoted fields and embedded commas). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      if (cell !== "" || row.length > 0) row.push(cell);
      if (row.length > 0 || cell !== "") rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

export type CsvFileResult =
  | { ok: true; rows: string[][] }
  | { ok: false; status: number; code: string; error: string };

/**
 * Validate and parse the raw CSV text carried by a request body.
 *
 * The three failure codes below are the contract the Employee uploader already
 * returns to its page, so both endpoints fail identically:
 *   EMPTY_CSV, FILE_TOO_LARGE, INVALID_CSV.
 */
export function readCsvFile(text: unknown): CsvFileResult {
  const raw = typeof text === "string" ? text : null;
  if (!raw?.trim()) {
    return { ok: false, status: 400, code: "EMPTY_CSV", error: "csv data is required (send raw CSV text)." };
  }
  if (raw.length > CSV_MAX_BYTES) {
    return { ok: false, status: 400, code: "FILE_TOO_LARGE", error: "CSV file exceeds 2MB limit." };
  }
  const rows = parseCsv(raw);
  if (rows.length < 2) {
    return { ok: false, status: 400, code: "INVALID_CSV", error: "CSV must have a header row + at least one data row." };
  }
  return { ok: true, rows };
}

/**
 * Column name -> index for a header row. Names are trimmed and lower-cased, so
 * callers ignore case. The FIRST occurrence wins, matching `indexOf` on the header
 * as the Employee uploader read it before this helper existed.
 */
export function columnIndexByName(header: string[]): Map<string, number> {
  const columns = new Map<string, number>();
  header.forEach((name, index) => {
    const key = name.trim().toLowerCase();
    if (!columns.has(key)) columns.set(key, index);
  });
  return columns;
}

/** Reader for one data row: values are trimmed and a missing column reads as "". */
export function rowReader(row: string[], columns: Map<string, number>): (name: string) => string {
  return (name: string) => {
    const index = columns.get(name.trim().toLowerCase());
    return index === undefined ? "" : (row[index] ?? "").trim();
  };
}

/**
 * Render rows as CSV text (used by the template downloads). A cell is quoted only
 * when it needs to be, and an inner quote is doubled, so the download round-trips
 * through `parseCsv`.
 */
export function buildCsvText(rows: string[][]): string {
  const cell = (value: string) =>
    /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  return `${rows.map((row) => row.map(cell).join(",")).join("\n")}\n`;
}
