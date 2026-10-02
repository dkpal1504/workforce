/**
 * Portfolio filter parsing — the one place a query string is turned into a report scope.
 *
 * The dashboard screen and BOTH downloads (portfolio.xlsx, portfolio.pdf) are driven by
 * the SAME query parameters. If each route parsed them its own way, a screen could show
 * one thing and the export the next — the worst kind of reporting bug, because both
 * look plausible. So this module is pure, has no database or I/O, and both the JSON
 * route and the export routes go through `parsePortfolioFilters`.
 *
 * The shape of the result is deliberately explicit:
 *   - every list is `number[] | null`. `null` means "no filter", which is NOT the same
 *     as an empty array; an empty array would read as "match nothing" downstream. This
 *     distinction is the whole reason a junk-only list collapses to null (see below).
 *   - scalar enums fall back to a documented default, and any other value is REFUSED
 *     with a code — a typo in `status` must never silently degrade to "all".
 *   - `asOf: null` means "resolve the as-of date from the data", never "today": the
 *     reporting layer decides, because only it knows the latest booking date.
 */

import { createHash } from "node:crypto";

/** The hours-burn bands a report may be narrowed to. Defined locally so this module
 *  does not depend on portfolioReporting.ts, which is owned by another change. */
export const BANDS = ["RED", "AMBER", "GREEN", "NOT_MEASURABLE"] as const;
export type Band = (typeof BANDS)[number];

export const STATUSES = ["active", "inactive", "all"] as const;
export type PortfolioStatus = (typeof STATUSES)[number];

export const BUDGETS = ["all", "with", "without"] as const;
export type PortfolioBudget = (typeof BUDGETS)[number];

/** Defaults, named once so the docstring, the parser and the tests cannot drift. */
export const DEFAULT_ACTIVITY_DAYS = 7;
export const DEFAULT_STATUS: PortfolioStatus = "all";
export const DEFAULT_BUDGET: PortfolioBudget = "all";

export type PortfolioFilters = {
  /** null = no filter (not an empty array). */
  projectIds: number[] | null;
  wbsIds: number[] | null;
  departmentIds: number[] | null;
  sectionIds: number[] | null;
  status: PortfolioStatus;
  budget: PortfolioBudget;
  bands: Band[] | null;
  /** null = resolve from the data, i.e. the latest booking date the query layer finds. */
  asOf: Date | null;
  activityDays: number;
};

/**
 * The failure branch carries a CODE and a human sentence — the house error shape from
 * jobOrderProgress.ts, minus the HTTP status (the route owns that, not this parser).
 */
export type ParseError = { ok: false; code: string; error: string };
export type ParseResult =
  | { ok: true; filters: PortfolioFilters }
  | ParseError;

function fail(code: string, error: string): ParseError {
  return { ok: false, code, error };
}

/**
 * Read one query key off whatever Express handed us. `req.query` is `unknown` here on
 * purpose: a repeated key (?projectIds=1&projectIds=2) arrives as an array, and a
 * crafted `?x[a]=b` arrives as an object. Only strings, numbers and string arrays are
 * meaningful; anything else is treated as absent rather than stringified into junk.
 */
function rawValue(query: unknown, key: string): unknown {
  if (typeof query !== "object" || query === null) return undefined;
  return (query as Record<string, unknown>)[key];
}

/** Present = a non-empty trimmed string. Used to tell "not sent" from "sent empty". */
function asText(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => asText(entry))
      .filter((entry): entry is string => entry !== null);
    return parts.length ? parts.join(",") : null;
  }
  return null;
}

/**
 * Parse a comma-separated positive-integer list.
 *
 * JUNK IS DROPPED, NOT FATAL: "2,3,x" keeps [2,3] so one bad cell in a hand-edited
 * URL does not blank the report. The important half of that decision is what happens
 * when EVERY value is junk: the list becomes EMPTY, and an empty list is returned as
 * NULL. Null means "no filter" (show everything); an empty array would mean "match
 * nothing" (show nothing). Silently flipping a filtered view to an empty report is far
 * worse than ignoring a typo, so empty collapses to null. Ids are de-duplicated and
 * kept in ascending order so the export hash does not change when the user reorders
 * the same selection.
 */
function parseIdList(value: unknown): number[] | null {
  const text = asText(value);
  if (text === null) return null;
  const ids = new Set<number>();
  for (const token of text.split(",")) {
    const trimmed = token.trim();
    // Positive integers only: 0, negatives and decimals are junk, not filters.
    if (!/^\d+$/.test(trimmed)) continue;
    const id = Number(trimmed);
    if (Number.isSafeInteger(id) && id > 0) ids.add(id);
  }
  if (ids.size === 0) return null; // junk-only -> no filter, NOT match-nothing
  return [...ids].sort((a, b) => a - b);
}

/**
 * Parse the band list. Every value must be a known band — unlike the id lists, an
 * unknown band is REFUSED, because silently dropping "PURPLE" would quietly widen the
 * report and nobody would notice. Input order is preserved (the screen shows the bands
 * in the order asked for); canonical ordering is applied only when hashing.
 */
function parseBands(value: unknown): ParseError | Band[] | null {
  const text = asText(value);
  if (text === null) return null;
  const bands: Band[] = [];
  for (const token of text.split(",")) {
    const trimmed = token.trim();
    if (trimmed === "") continue;
    const upper = trimmed.toUpperCase();
    if (!(BANDS as readonly string[]).includes(upper)) {
      return fail(
        "INVALID_BAND",
        `Unknown band "${trimmed}". Allowed values are ${BANDS.join(", ")}.`
      );
    }
    const band = upper as Band;
    if (!bands.includes(band)) bands.push(band);
  }
  return bands.length ? bands : null;
}

/** An enum off its documented vocabulary is an error, never a silent fallback. */
function parseStatus(value: unknown): ParseError | PortfolioStatus {
  const text = asText(value);
  if (text === null) return DEFAULT_STATUS;
  const lower = text.toLowerCase();
  if (!(STATUSES as readonly string[]).includes(lower)) {
    return fail(
      "INVALID_STATUS",
      `Unknown status "${text}". Allowed values are ${STATUSES.join(", ")}.`
    );
  }
  return lower as PortfolioStatus;
}

function parseBudget(value: unknown): ParseError | PortfolioBudget {
  const text = asText(value);
  if (text === null) return DEFAULT_BUDGET;
  const lower = text.toLowerCase();
  if (!(BUDGETS as readonly string[]).includes(lower)) {
    return fail(
      "INVALID_BUDGET",
      `Unknown budget "${text}". Allowed values are ${BUDGETS.join(", ")}.`
    );
  }
  return lower as PortfolioBudget;
}

/**
 * Parse a YYYY-MM-DD date. The regex alone is not enough: "2026-02-30" matches it but
 * is not a real day, and JS would roll it forward to March. So the parsed date is
 * round-tripped back to a string and must equal the input — that is what catches an
 * impossible calendar day instead of quietly reporting the wrong period.
 */
function parseAsOf(value: unknown): ParseError | Date | null {
  const text = asText(value);
  if (text === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return fail("INVALID_ASOF", `Invalid asOf "${text}". Use the format YYYY-MM-DD.`);
  }
  const date = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
    return fail("INVALID_ASOF", `Invalid asOf "${text}". That is not a real calendar date.`);
  }
  return date;
}

/** An integer 1..365. A missing value keeps the default; anything else is refused. */
function parseActivityDays(value: unknown): ParseError | number {
  const text = asText(value);
  if (text === null) return DEFAULT_ACTIVITY_DAYS;
  if (!/^\d+$/.test(text)) {
    return fail(
      "INVALID_ACTIVITY_DAYS",
      `Invalid activityDays "${text}". Provide a whole number of days between 1 and 365.`
    );
  }
  const days = Number(text);
  if (!Number.isSafeInteger(days) || days < 1 || days > 365) {
    return fail(
      "INVALID_ACTIVITY_DAYS",
      `Invalid activityDays "${text}". Provide a whole number of days between 1 and 365.`
    );
  }
  return days;
}

function isFailure(value: unknown): value is ParseError {
  return typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === false;
}

/**
 * Parse and validate the whole filter set.
 *
 * Any failure short-circuits: the caller gets a code it can map to a 400 and a sentence
 * it can show, and no half-parsed filter set ever reaches a query.
 */
export function parsePortfolioFilters(query: unknown): ParseResult {
  const status = parseStatus(rawValue(query, "status"));
  if (isFailure(status)) return status;

  const budget = parseBudget(rawValue(query, "budget"));
  if (isFailure(budget)) return budget;

  const bands = parseBands(rawValue(query, "band"));
  if (isFailure(bands)) return bands;

  const asOf = parseAsOf(rawValue(query, "asOf"));
  if (isFailure(asOf)) return asOf;

  const activityDays = parseActivityDays(rawValue(query, "activityDays"));
  if (isFailure(activityDays)) return activityDays;

  return {
    ok: true,
    filters: {
      projectIds: parseIdList(rawValue(query, "projectIds")),
      wbsIds: parseIdList(rawValue(query, "wbsIds")),
      departmentIds: parseIdList(rawValue(query, "departmentIds")),
      sectionIds: parseIdList(rawValue(query, "sectionIds")),
      status,
      budget,
      bands,
      asOf,
      activityDays,
    },
  };
}

/* ---------------------------------------------------------------------------
 * Provenance — the readable filter list and the filename hash
 * ------------------------------------------------------------------------- */

/** Optional id -> name maps, so the provenance block names projects and sections
 *  the way the screen does instead of dumping raw ids. */
export type FilterLabels = {
  projectIds?: Record<number, string> | null;
  wbsIds?: Record<number, string> | null;
  departmentIds?: Record<number, string> | null;
  sectionIds?: Record<number, string> | null;
};

function describeIds(ids: number[] | null, labels: Record<number, string> | null | undefined): string {
  if (!ids) return "All";
  return ids.map((id) => labels?.[id] ?? String(id)).join(", ");
}

const STATUS_LABELS: Record<PortfolioStatus, string> = {
  active: "Active",
  inactive: "Inactive",
  all: "All",
};

const BUDGET_LABELS: Record<PortfolioBudget, string> = {
  all: "All",
  with: "With budget",
  without: "Without budget",
};

/**
 * The human-readable filter list used in the export provenance block and the screen's
 * "filters applied" line. Every unset filter reads "All" so the block is a complete
 * statement of scope, not a list of only what happened to be set — an absent line is
 * what lets a reader assume a filter was not there.
 */
export function describePortfolioFilters(
  filters: PortfolioFilters,
  labels?: FilterLabels
): Array<{ label: string; value: string }> {
  return [
    { label: "Project", value: describeIds(filters.projectIds, labels?.projectIds) },
    { label: "WBS", value: describeIds(filters.wbsIds, labels?.wbsIds) },
    { label: "Department", value: describeIds(filters.departmentIds, labels?.departmentIds) },
    { label: "Section", value: describeIds(filters.sectionIds, labels?.sectionIds) },
    { label: "Status", value: STATUS_LABELS[filters.status] },
    { label: "Budget", value: BUDGET_LABELS[filters.budget] },
    { label: "Band", value: filters.bands ? filters.bands.join(", ") : "All" },
    { label: "As of", value: filters.asOf ? filters.asOf.toISOString().slice(0, 10) : "All" },
    { label: "Activity window", value: `${filters.activityDays} days` },
  ];
}

/**
 * A canonical string for hashing: lists sorted, so the same SELECTION always produces
 * the same key whatever order the ids were clicked in. `asOf` is reduced to its date
 * (the Date is always UTC midnight) so two equal filters are byte-identical.
 */
function canonicalFilters(filters: PortfolioFilters): string {
  const sorted = (ids: number[] | null): number[] | null =>
    ids ? [...ids].sort((a, b) => a - b) : null;
  return JSON.stringify({
    projectIds: sorted(filters.projectIds),
    wbsIds: sorted(filters.wbsIds),
    departmentIds: sorted(filters.departmentIds),
    sectionIds: sorted(filters.sectionIds),
    status: filters.status,
    budget: filters.budget,
    bands: filters.bands ? [...filters.bands].sort() : null,
    asOf: filters.asOf ? filters.asOf.toISOString().slice(0, 10) : null,
    activityDays: filters.activityDays,
  });
}

/**
 * A short, stable hash of the RESOLVED filter set, stamped into the export filename so
 * two differently-filtered reports never share a name (and a downloaded file can be
 * traced back to what it asked for). Deterministic: same filters -> same hash.
 */
export function portfolioFiltersHash(filters: PortfolioFilters): string {
  return createHash("sha1").update(canonicalFilters(filters)).digest("hex").slice(0, 8);
}
