import test from "node:test";
import assert from "node:assert/strict";
import {
  parsePortfolioFilters,
  describePortfolioFilters,
  portfolioFiltersHash,
  type PortfolioFilters,
} from "./portfolioFilters";

/**
 * The dashboard screen and BOTH downloads (xlsx, pdf) are fed by the SAME query
 * string, so these tests pin the one place that decides what a filtered report
 * actually asked for. Every expectation here is written against the raw query
 * object Express hands the route (string values, unknown shape).
 */

/** The documented defaults: no filter at all, an all-status/all-budget listing. */
function defaults(): PortfolioFilters {
  return {
    projectIds: null,
    wbsIds: null,
    departmentIds: null,
    sectionIds: null,
    status: "all",
    budget: "all",
    bands: null,
    asOf: null,
    activityDays: 7,
  };
}

function mustParse(query: unknown): PortfolioFilters {
  const result = parsePortfolioFilters(query);
  if (!result.ok) {
    assert.fail(`${result.code}: ${result.error}`);
  }
  return result.filters;
}

function mustFail(query: unknown): { code: string; error: string } {
  const result = parsePortfolioFilters(query);
  assert.equal(result.ok, false, "expected the parse to fail");
  if (result.ok) throw new Error("expected failure");
  return { code: result.code, error: result.error };
}

function valueFor(filters: PortfolioFilters, label: string, labels?: Parameters<typeof describePortfolioFilters>[1]): string {
  const row = describePortfolioFilters(filters, labels).find((entry) => entry.label === label);
  assert.ok(row, `expected a "${label}" provenance row`);
  return row.value;
}

test("no params at all applies the documented defaults", () => {
  assert.deepEqual(mustParse({}), defaults());
  assert.deepEqual(mustParse(undefined), defaults());
  assert.deepEqual(mustParse(null), defaults());
});

test("a comma-separated id list keeps the valid ids and drops the junk", () => {
  assert.deepEqual(mustParse({ projectIds: "2,3,x" }).projectIds, [2, 3]);
  assert.deepEqual(mustParse({ wbsIds: "8,9" }).wbsIds, [8, 9]);
  assert.deepEqual(mustParse({ departmentIds: "4" }).departmentIds, [4]);
  assert.deepEqual(mustParse({ sectionIds: "8,26" }).sectionIds, [8, 26]);
});

test("a list that becomes EMPTY after dropping junk means NO FILTER, not match-nothing", () => {
  // The whole point: [2,3] is a filter, but "x" must NOT become [] (which would be
  // read as "match nothing"). It becomes null, the same as sending nothing.
  assert.equal(mustParse({ projectIds: "x" }).projectIds, null);
  assert.equal(mustParse({ projectIds: "" }).projectIds, null);
  assert.equal(mustParse({ projectIds: ",,," }).projectIds, null);
  assert.equal(mustParse({ projectIds: "0,-3,abc" }).projectIds, null);
});

test("positive-integer lists reject zero/negatives/decimals without failing the request", () => {
  assert.deepEqual(mustParse({ projectIds: "0,4,-2,5.5" }).projectIds, [4]);
});

test("duplicate ids collapse so the export hash stays stable", () => {
  assert.deepEqual(mustParse({ projectIds: "2,2,3" }).projectIds, [2, 3]);
});

test("band accepts a subset of the known bands", () => {
  assert.deepEqual(mustParse({ band: "RED,AMBER" }).bands, ["RED", "AMBER"]);
  assert.deepEqual(mustParse({ band: "NOT_MEASURABLE" }).bands, ["NOT_MEASURABLE"]);
  assert.deepEqual(mustParse({ band: "green,red" }).bands, ["GREEN", "RED"]);
});

test("an unknown band fails with INVALID_BAND naming the allowed values", () => {
  const failure = mustFail({ band: "PURPLE" });
  assert.equal(failure.code, "INVALID_BAND");
  assert.match(failure.error, /RED/);
  assert.match(failure.error, /AMBER/);
  assert.match(failure.error, /GREEN/);
  assert.match(failure.error, /NOT_MEASURABLE/);
  assert.match(failure.error, /PURPLE/);
});

test("a well-formed asOf becomes a Date", () => {
  const filters = mustParse({ asOf: "2026-10-01" });
  assert.ok(filters.asOf instanceof Date);
  assert.equal(filters.asOf.toISOString().slice(0, 10), "2026-10-01");
});

test("a malformed or impossible asOf fails with INVALID_ASOF", () => {
  for (const bad of ["2026-13-45", "01/10/2026", "2026-10-1", "2026-02-30", "not-a-date"]) {
    assert.equal(mustFail({ asOf: bad }).code, "INVALID_ASOF", bad);
  }
  // An empty value is ABSENT, not malformed: it takes the documented null default.
  assert.equal(mustParse({ asOf: "" }).asOf, null);
});

test("activityDays is clamped to 1..365", () => {
  assert.equal(mustParse({ activityDays: "30" }).activityDays, 30);
  assert.equal(mustParse({ activityDays: "1" }).activityDays, 1);
  assert.equal(mustParse({ activityDays: "365" }).activityDays, 365);
  assert.equal(mustFail({ activityDays: "0" }).code, "INVALID_ACTIVITY_DAYS");
  assert.equal(mustFail({ activityDays: "366" }).code, "INVALID_ACTIVITY_DAYS");
  assert.equal(mustFail({ activityDays: "7.5" }).code, "INVALID_ACTIVITY_DAYS");
  assert.equal(mustFail({ activityDays: "soon" }).code, "INVALID_ACTIVITY_DAYS");
});

test("status and budget accept only their documented vocabularies", () => {
  assert.equal(mustParse({ status: "active" }).status, "active");
  assert.equal(mustParse({ status: "inactive" }).status, "inactive");
  assert.equal(mustParse({ status: "all" }).status, "all");
  assert.equal(mustParse({ budget: "with" }).budget, "with");
  assert.equal(mustParse({ budget: "without" }).budget, "without");
  assert.equal(mustParse({ budget: "all" }).budget, "all");

  assert.equal(mustFail({ status: "weird" }).code, "INVALID_STATUS");
  assert.equal(mustFail({ budget: "maybe" }).code, "INVALID_BUDGET");
});

test("the filters hash is deterministic and changes with the resolved filter set", () => {
  const base = mustParse({ projectIds: "2,3", band: "RED" });
  const same = mustParse({ projectIds: "3,2", band: "RED" });
  assert.equal(portfolioFiltersHash(base), portfolioFiltersHash(same));
  assert.match(portfolioFiltersHash(base), /^[0-9a-f]{8}$/);

  const widerWindow = mustParse({ projectIds: "2,3", band: "RED", activityDays: "30" });
  assert.notEqual(portfolioFiltersHash(base), portfolioFiltersHash(widerWindow));

  const noFilter = mustParse({});
  assert.notEqual(portfolioFiltersHash(base), portfolioFiltersHash(noFilter));
});

test("describePortfolioFilters reads 'All' for every unset filter", () => {
  const described = describePortfolioFilters(defaults());
  assert.deepEqual(described, [
    { label: "Project", value: "All" },
    { label: "WBS", value: "All" },
    { label: "Department", value: "All" },
    { label: "Section", value: "All" },
    { label: "Status", value: "All" },
    { label: "Budget", value: "All" },
    { label: "Band", value: "All" },
    { label: "As of", value: "All" },
    { label: "Activity window", value: "7 days" },
  ]);
});

test("describePortfolioFilters names the values that ARE set, using supplied labels", () => {
  const filters = mustParse({
    projectIds: "1,2",
    sectionIds: "8",
    status: "active",
    budget: "with",
    band: "RED,AMBER",
    asOf: "2026-10-01",
    activityDays: "14",
  });
  const labels = {
    projectIds: { 1: "OSV H030", 2: "TUG GMB I" },
    sectionIds: { 8: "Hull and Outfitting" },
  };
  assert.equal(valueFor(filters, "Project", labels), "OSV H030, TUG GMB I");
  assert.equal(valueFor(filters, "Section", labels), "Hull and Outfitting");
  assert.equal(valueFor(filters, "Status"), "Active");
  assert.equal(valueFor(filters, "Budget"), "With budget");
  assert.equal(valueFor(filters, "Band"), "RED, AMBER");
  assert.equal(valueFor(filters, "As of"), "2026-10-01");
  assert.equal(valueFor(filters, "Activity window"), "14 days");
});

test("describePortfolioFilters falls back to the raw id when no label is supplied", () => {
  const filters = mustParse({ projectIds: "1,2" });
  assert.equal(valueFor(filters, "Project"), "1, 2");
});
