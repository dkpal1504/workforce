/**
 * Portfolio filter URL round-trip — the ONE place the /portfolio and /reports query
 * strings are built and parsed.
 *
 * WHY THIS MODULE EXISTS: the dashboard screen, the reports screen and BOTH downloads
 * (portfolio.xlsx, portfolio.pdf) must carry the IDENTICAL query string. If each screen
 * built its own `URLSearchParams`, a screen could show one thing and the file another —
 * the worst kind of reporting bug, because both look plausible. So the JSON fetch and
 * every download link go through `portfolioQuery()` on the same filter state, and the
 * tests assert the two cannot drift.
 *
 * DEFAULTS ARE OMITTED: a clean filter set (all "All", the 7-day window, no as-of date)
 * encodes to the EMPTY string, so a clean screen has a clean, shareable URL. Only a
 * filter the operator actually set appears in the URL.
 *
 * JUNK IS DROPPED THE SAME WAY THE API DROPS IT (services/portfolioFilters.ts on the API):
 *   - every id list keeps only positive integers, de-duplicated and ascending;
 *   - a list that is ENTIRELY junk collapses to EMPTY, which means "no filter" — NOT
 *     "match nothing". Silently narrowing a view to an empty report on one bad cell is
 *     worse than ignoring the typo, so empty is the honest result;
 *   - `band` keeps only known bands; unknown bands are dropped;
 *   - an out-of-range or non-numeric `activityDays` falls back to the default;
 *   - `asOf` is kept only when it is a real `YYYY-MM-DD` calendar day (a round-trip
 *     check catches "2026-02-30", which the API also refuses).
 *
 * This module is PURE — no React, no `api()` — so it can be unit-tested under node:test
 * without a DOM, exactly like the other `*.test.ts` helpers in this folder.
 */

/** The four hours-burn bands, in the canonical order the report uses. */
export const BANDS = ["RED", "AMBER", "GREEN", "NOT_MEASURABLE"] as const;
export type Band = (typeof BANDS)[number];

export const STATUSES = ["active", "inactive", "all"] as const;
export type PortfolioStatus = (typeof STATUSES)[number];

export const BUDGETS = ["all", "with", "without"] as const;
export type PortfolioBudget = (typeof BUDGETS)[number];

/** Defaults, named once so the docstring, the encoder and the tests cannot drift. */
export const DEFAULT_ACTIVITY_DAYS = 7;
export const MIN_ACTIVITY_DAYS = 1;
export const MAX_ACTIVITY_DAYS = 365;
export const DEFAULT_STATUS: PortfolioStatus = "all";
export const DEFAULT_BUDGET: PortfolioBudget = "all";

/**
 * The filter state the screens hold and the URL carries.
 *
 * Empty arrays mean "no filter" for that dimension (the API's `null`); they are NOT
 * "match nothing". `asOf: ""` means "resolve the as-of date from the data", which is the
 * API's `null`.
 */
export type PortfolioFilterState = {
  projectIds: number[];
  wbsIds: number[];
  departmentIds: number[];
  sectionIds: number[];
  status: PortfolioStatus;
  budget: PortfolioBudget;
  bands: Band[];
  /** `YYYY-MM-DD`, or "" to let the report resolve it from the latest booking. */
  asOf: string;
  activityDays: number;
};

/** A fresh default filter set. A function (not a shared constant) so the arrays are never shared. */
export function defaultFilters(): PortfolioFilterState {
  return {
    projectIds: [],
    wbsIds: [],
    departmentIds: [],
    sectionIds: [],
    status: DEFAULT_STATUS,
    budget: DEFAULT_BUDGET,
    bands: [],
    asOf: "",
    activityDays: DEFAULT_ACTIVITY_DAYS,
  };
}

/* --------------------------------------------------------------------------- *
 * Parsing primitives (mirroring the API's parser)
 * ------------------------------------------------------------------------- */

/** Ascending, de-duplicated positive integers; junk tokens are dropped. */
export function parseIdList(text: string | null): number[] {
  if (text === null) return [];
  const ids = new Set<number>();
  for (const token of text.split(",")) {
    const trimmed = token.trim();
    // Positive integers only: 0, negatives and decimals are junk, not filters.
    if (!/^\d+$/.test(trimmed)) continue;
    const id = Number(trimmed);
    if (Number.isSafeInteger(id) && id > 0) ids.add(id);
  }
  return [...ids].sort((a, b) => a - b);
}

function readStatus(value: string | null, fallback: PortfolioStatus): PortfolioStatus {
  if (value === null) return fallback;
  const lower = value.trim().toLowerCase();
  return (STATUSES as readonly string[]).includes(lower) ? (lower as PortfolioStatus) : fallback;
}

function readBudget(value: string | null, fallback: PortfolioBudget): PortfolioBudget {
  if (value === null) return fallback;
  const lower = value.trim().toLowerCase();
  return (BUDGETS as readonly string[]).includes(lower) ? (lower as PortfolioBudget) : fallback;
}

/** Keep known bands only, upper-cased and de-duplicated, in the order they were asked for. */
function readBands(value: string | null): Band[] {
  if (value === null) return [];
  const bands: Band[] = [];
  for (const token of value.split(",")) {
    const upper = token.trim().toUpperCase();
    if (!(BANDS as readonly string[]).includes(upper)) continue;
    const band = upper as Band;
    if (!bands.includes(band)) bands.push(band);
  }
  return bands;
}

/**
 * A real `YYYY-MM-DD` day, or "" (the API's null). The regex alone is not enough —
 * "2026-02-30" matches it but is not a real day, and JS would roll it forward — so the
 * parsed date is round-tripped back and must equal the input.
 */
function readAsOf(value: string | null): string {
  if (value === null) return "";
  const text = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return "";
  const date = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) return "";
  return text;
}

function readActivityDays(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const text = value.trim();
  if (!/^\d+$/.test(text)) return fallback;
  const days = Number(text);
  if (!Number.isSafeInteger(days) || days < MIN_ACTIVITY_DAYS || days > MAX_ACTIVITY_DAYS) return fallback;
  return days;
}

/* --------------------------------------------------------------------------- *
 * Encode / decode
 * --------------------------------------------------------------------------- */

function sameIds(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort((x, y) => x - y);
  const right = [...b].sort((x, y) => x - y);
  return left.every((value, index) => value === right[index]);
}

function sameBands(a: readonly Band[], b: readonly Band[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, index) => value === right[index]);
}

/**
 * Turn a filter state into a query string WITHOUT the leading "?".
 *
 * Every field equal to its default is OMITTED, so `encodeFilters(defaultFilters())` is
 * the empty string. Values are appended in a fixed order so the same state always
 * produces the same string (a stable, shareable URL).
 */
export function encodeFilters(
  filters: PortfolioFilterState,
  defaults: PortfolioFilterState = defaultFilters()
): string {
  const params = new URLSearchParams();

  const addIds = (key: string, value: readonly number[], fallback: readonly number[]) => {
    if (value.length === 0) return; // empty = no filter, so nothing to write
    if (sameIds(value, fallback)) return; // equal to the default -> omitted
    params.set(key, [...value].sort((a, b) => a - b).join(","));
  };

  addIds("projectIds", filters.projectIds, defaults.projectIds);
  addIds("wbsIds", filters.wbsIds, defaults.wbsIds);
  addIds("departmentIds", filters.departmentIds, defaults.departmentIds);
  addIds("sectionIds", filters.sectionIds, defaults.sectionIds);

  if (filters.status !== defaults.status) params.set("status", filters.status);
  if (filters.budget !== defaults.budget) params.set("budget", filters.budget);
  if (filters.bands.length > 0 && !sameBands(filters.bands, defaults.bands)) {
    params.set("band", filters.bands.join(","));
  }
  if (filters.asOf !== defaults.asOf && filters.asOf !== "") params.set("asOf", filters.asOf);
  if (filters.activityDays !== defaults.activityDays) {
    params.set("activityDays", String(filters.activityDays));
  }

  return params.toString();
}

/**
 * Parse a query string (with or without a leading "?") back into a filter state.
 * Lossless against `encodeFilters`, and tolerant of a hand-edited URL: junk is dropped
 * the same way the API drops it, never thrown.
 */
export function decodeFilters(
  searchString: string,
  defaults: PortfolioFilterState = defaultFilters()
): PortfolioFilterState {
  const params = new URLSearchParams(
    searchString.startsWith("?") ? searchString.slice(1) : searchString
  );
  return {
    projectIds: parseIdList(params.get("projectIds")),
    wbsIds: parseIdList(params.get("wbsIds")),
    departmentIds: parseIdList(params.get("departmentIds")),
    sectionIds: parseIdList(params.get("sectionIds")),
    status: readStatus(params.get("status"), defaults.status),
    budget: readBudget(params.get("budget"), defaults.budget),
    bands: readBands(params.get("band")),
    asOf: readAsOf(params.get("asOf")),
    activityDays: readActivityDays(params.get("activityDays"), defaults.activityDays),
  };
}

/**
 * The exact query string (WITH the leading "?", or "" when clean) that BOTH the JSON
 * fetch and every download link use. Built from the same encoder, so the screen and the
 * file provably ask for the same data — a screen can never show one scope while a
 * download carries another.
 */
export function portfolioQuery(
  filters: PortfolioFilterState,
  defaults: PortfolioFilterState = defaultFilters()
): string {
  const query = encodeFilters(filters, defaults);
  return query ? `?${query}` : "";
}

/**
 * Alias used by the download buttons. It is deliberately the SAME function object as
 * `portfolioQuery`, not a second implementation, so the two call sites cannot diverge.
 */
export const downloadsQuery = portfolioQuery;
