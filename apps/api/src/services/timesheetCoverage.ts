/**
 * The timesheet-coverage report's PURE rules: the status vocabulary, the date range, and the
 * section/department coverage arithmetic.
 *
 * WHY SEPARATE FROM THE ASSEMBLY: every rule below is a decision a reader will argue with — which
 * day statuses count as "Approved", what an employee with no sheet is called, whether a person with
 * one filled day out of twenty is "covered" — and a decision buried in a database loop cannot be
 * tested or quoted back to the person who asked. The loader next door only reads rows and hands them
 * here.
 *
 * THE VOCABULARY IS THE OPERATOR'S, NOT THE DATABASE'S. The database carries eight day/entry
 * statuses (DRAFT, SUBMITTED, HOD_APPROVED, PM_APPROVED, REJECTED, PLANNING_RETURNED,
 * FINAL_REJECTED, SUP_APPROVED); the report carries five and the mapping is stated once:
 *
 *   Draft         <- DRAFT and every returned/rejected state (a sheet the supervisor must redo is
 *                    back in the supervisor's hands, which is what "Draft" means to the reader)
 *   Submitted     <- SUBMITTED        (waiting for the HOD)
 *   HOD Approved  <- HOD_APPROVED     (waiting for the PM)
 *   Approved      <- PM_APPROVED      (the end of the chain)
 *   Not Filled    <- there is no sheet for that employee on that date
 *
 * AN UNKNOWN STATUS IS NEVER "Approved". Anything the mapping does not recognise falls to Draft,
 * because the one thing this column must never do is overstate how far a day has got.
 */

export const COVERAGE_STATUS_ORDER = ["Draft", "Submitted", "HOD Approved", "Approved"] as const;
export type CoverageStatus = (typeof COVERAGE_STATUS_ORDER)[number] | "Not Filled";

/** The status for a day with NO sheet at all. */
export const NOT_FILLED: CoverageStatus = "Not Filled";

/** Day statuses that mean "back with the supervisor" — grouped under Draft. */
const RETURNED_OR_REJECTED = ["REJECTED", "PLANNING_RETURNED", "FINAL_REJECTED"] as const;

/** One row's status, from any day or entry status the database can hold. */
export function coverageStatusFor(dayStatus: string): CoverageStatus {
  const status = String(dayStatus ?? "").trim().toUpperCase();
  if (status === "SUBMITTED") return "Submitted";
  if (status === "HOD_APPROVED") return "HOD Approved";
  if (status === "PM_APPROVED") return "Approved";
  if (status === "DRAFT") return "Draft";
  if ((RETURNED_OR_REJECTED as readonly string[]).includes(status)) return "Draft";
  // Including SUP_APPROVED (an ENTRY state, not a day state) and anything unrecognised.
  return "Draft";
}

/**
 * One ROW's status when the employee has more than one sheet for the same date.
 *
 * `TimesheetDay` is unique per (employee, workDate, tagger), so the same person can legitimately be
 * on two supervisors' sheets on one day. The row still reports the LEAST ADVANCED of them: a day is
 * not approved until every sheet covering it is, and taking the most advanced would let a second
 * sheet's Draft disappear behind a first sheet's approval.
 */
export function combineCoverageStatuses(dayStatuses: readonly string[]): CoverageStatus {
  if (!dayStatuses.length) return NOT_FILLED;
  const mapped = dayStatuses.map(coverageStatusFor);
  return mapped.reduce((lowest, current) => (STATUS_RANK[current] < STATUS_RANK[lowest] ? current : lowest));
}

/** How far a status is along the chain. `Not Filled` ranks below everything — it is the absence of
 *  a sheet, not a stage of one. */
const STATUS_RANK: Record<CoverageStatus, number> = {
  "Not Filled": -1,
  Draft: 0,
  Submitted: 1,
  "HOD Approved": 2,
  Approved: 3,
};

/** Every status a filter may name, in display order (the four stages, then the gap). */
export const COVERAGE_STATUS_VALUES: readonly CoverageStatus[] = [...COVERAGE_STATUS_ORDER, NOT_FILLED];

/** Is this one of the five statuses the report can show? */
export function isCoverageStatus(value: unknown): value is CoverageStatus {
  return typeof value === "string" && (COVERAGE_STATUS_VALUES as readonly string[]).includes(value);
}

/**
 * The Approval Status filter, parsed from a query value (`statuses=Not Filled,Draft`).
 *
 * Unknown words are DROPPED rather than refused, and an entirely unknown list becomes EMPTY — which
 * means "no filter", never "match nothing". Narrowing a report to zero rows because of one typo is
 * worse than ignoring the typo, and it is the same rule the portfolio filters follow.
 */
export function parseCoverageStatuses(raw: unknown): CoverageStatus[] {
  if (raw == null || raw === "") return [];
  const text = Array.isArray(raw) ? raw.join(",") : String(raw);
  const picked = new Set<CoverageStatus>();
  for (const token of text.split(",")) {
    const candidate = token.trim();
    // Accept the exact label; also the underscore / lower-case form an operator might type.
    const normalised =
      COVERAGE_STATUS_VALUES.find((status) => status === candidate) ??
      COVERAGE_STATUS_VALUES.find((status) => status.toUpperCase().replace(/\s+/g, "_") === candidate.toUpperCase());
    if (normalised) picked.add(normalised);
  }
  // Returned in the report's OWN vocabulary order, not the order they were typed: the filter then
  // produces the same query string and the same provenance whichever way the operator ticked.
  return COVERAGE_STATUS_VALUES.filter((status) => picked.has(status));
}

/**
 * The DETAIL rows an Approval Status filter keeps. One row per (date x employee), as ever.
 *
 * WHY THIS NARROWS THE DETAIL ONLY: the coverage figures and the headline totals describe the WHOLE
 * roster, and they are the answer to "who is not covered". Recomputing them from the filtered rows
 * would make the filter circular — selecting "Not Filled" would report 0% filled everywhere and hide
 * exactly what the operator is looking for. So the filter is a lens on the evidence, not on the
 * finding, and every surface that prints a count says which of the two it is counting.
 */
export function filterCoverageRows<T extends { status: CoverageStatus }>(
  rows: readonly T[],
  statuses: readonly CoverageStatus[]
): T[] {
  if (!statuses.length) return [...rows];
  return rows.filter((row) => statuses.includes(row.status));
}

/* --------------------------------------------------------------------------- *
 * The date range
 * ------------------------------------------------------------------------- */

/** A range longer than this is refused rather than assembled: 500 employees x 92 days is already
 *  ~46,000 rows, and a typo in a year field should not try to build a decade. */
export const MAX_RANGE_DAYS = 92;

const DAY_MS = 24 * 60 * 60 * 1000;

/** A real `YYYY-MM-DD` calendar day, or null. The round-trip catches "2026-02-30". */
export function parseIsoDay(value: unknown): string | null {
  const text = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) return null;
  return text;
}

export type CoverageRange =
  | { ok: true; from: string; to: string; days: string[] }
  | { ok: false; code: string; error: string };

/**
 * The inclusive list of dates the report covers.
 *
 * ALL dates are listed, not just the ones with data: the whole point of the report is the days
 * nobody filled in, and a weekend absent from the range would read as covered.
 */
export function coverageRange(fromInput: unknown, toInput: unknown): CoverageRange {
  const from = parseIsoDay(fromInput);
  const to = parseIsoDay(toInput);
  if (!from || !to) {
    return { ok: false, code: "INVALID_RANGE", error: "Both dates are required, as YYYY-MM-DD." };
  }
  const start = new Date(`${from}T00:00:00.000Z`).getTime();
  const end = new Date(`${to}T00:00:00.000Z`).getTime();
  if (end < start) {
    return { ok: false, code: "INVALID_RANGE", error: `The end date (${to}) is before the start date (${from}).` };
  }
  const count = Math.round((end - start) / DAY_MS) + 1;
  if (count > MAX_RANGE_DAYS) {
    return {
      ok: false,
      code: "RANGE_TOO_LONG",
      error: `The range is ${count} days; the most this report builds at once is ${MAX_RANGE_DAYS}.`,
    };
  }
  const days: string[] = [];
  for (let offset = 0; offset < count; offset += 1) {
    days.push(new Date(start + offset * DAY_MS).toISOString().slice(0, 10));
  }
  return { ok: true, from, to, days };
}

/* --------------------------------------------------------------------------- *
 * Coverage arithmetic
 * ------------------------------------------------------------------------- */

/** The minimum a row must carry to be counted. */
export type CoverageCountRow = {
  date: string;
  employeeId: number;
  departmentId: number;
  departmentName: string;
  sectionId: number | null;
  sectionName: string | null;
  status: CoverageStatus;
};

export type CoverageBucket = {
  department: { id: number; name: string };
  section: { id: number; name: string } | null;
  /** Distinct employees in this bucket over the whole range. */
  employees: number;
  /** Employees x dates — every one of them is a row of the report. */
  employeeDays: number;
  filledDays: number;
  notFilledDays: number;
  /** Employees with at least one filled day in the range. */
  employeesWithFilledDay: number;
  /** Employees with NO filled day at all — the population the report exists to expose. */
  employeesWithNoFilledDay: number;
  /** `filledDays / employeeDays`, ALWAYS finite (0 when there are no employee-days). */
  filledPct: number;
};

/**
 * The section/department coverage figures.
 *
 * BOTH QUESTIONS ARE ANSWERED, because they are different questions and a report that answers only
 * one of them is ambiguous: "employees" is the roster (how many people are in this Section), while
 * "employee-days" is the exposure (how much of the period is unaccounted for). An employee with one
 * filled day out of twenty counts in `employeesWithFilledDay` AND leaves nineteen unfilled days; a
 * summary that reported only the former would call the Section covered.
 *
 * `filledPct` is a FRACTION (0.87 = 87%), always finite, and is formatted by the caller. Rows are
 * grouped by Department then Section, and a null section is its own bucket ("No section") rather
 * than being dropped — an unassigned employee is exactly the case someone needs to see.
 */
export function buildCoverage(rows: readonly CoverageCountRow[]): CoverageBucket[] {
  type Acc = {
    department: { id: number; name: string };
    section: { id: number; name: string } | null;
    employees: Set<number>;
    employeesWithFilledDay: Set<number>;
    employeeDays: number;
    filledDays: number;
  };
  const buckets = new Map<string, Acc>();

  for (const row of rows) {
    const key = `${row.departmentId}:${row.sectionId ?? "none"}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        department: { id: row.departmentId, name: row.departmentName },
        section:
          row.sectionId == null ? null : { id: row.sectionId, name: row.sectionName ?? `Section ${row.sectionId}` },
        employees: new Set<number>(),
        employeesWithFilledDay: new Set<number>(),
        employeeDays: 0,
        filledDays: 0,
      };
      buckets.set(key, bucket);
    }
    bucket.employees.add(row.employeeId);
    bucket.employeeDays += 1;
    if (row.status !== NOT_FILLED) {
      bucket.filledDays += 1;
      bucket.employeesWithFilledDay.add(row.employeeId);
    }
  }

  return [...buckets.values()]
    .map((bucket) => ({
      department: bucket.department,
      section: bucket.section,
      employees: bucket.employees.size,
      employeeDays: bucket.employeeDays,
      filledDays: bucket.filledDays,
      notFilledDays: bucket.employeeDays - bucket.filledDays,
      employeesWithFilledDay: bucket.employeesWithFilledDay.size,
      employeesWithNoFilledDay: bucket.employees.size - bucket.employeesWithFilledDay.size,
      filledPct: bucket.employeeDays === 0 ? 0 : bucket.filledDays / bucket.employeeDays,
    }))
    .sort(
      (a, b) =>
        a.department.name.localeCompare(b.department.name) ||
        (a.section?.name ?? "").localeCompare(b.section?.name ?? "")
    );
}
