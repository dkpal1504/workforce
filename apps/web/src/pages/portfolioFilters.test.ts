import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_ACTIVITY_DAYS,
  decodeFilters,
  defaultFilters,
  downloadsQuery,
  encodeFilters,
  parseIdList,
  portfolioQuery,
  type PortfolioFilterState,
} from "./portfolioFilters";

/**
 * WHY THESE TESTS EXIST: the dashboard screen, the reports screen and both downloads must
 * carry the IDENTICAL query string. The whole point of `portfolioFilters.ts` is that the
 * fetch and the download links go through ONE encoder, so a screen can never show one
 * scope while the file on disk carries another. These tests pin:
 *   1. the round trip is lossless;
 *   2. a default filter set produces a CLEAN url (shareable links);
 *   3. junk is dropped the way the API drops it (never thrown, never a silent narrow-to-nothing);
 *   4. the download query string EQUALS the JSON query string for the same state.
 */

function withFilters(overrides: Partial<PortfolioFilterState>): PortfolioFilterState {
  return { ...defaultFilters(), ...overrides };
}

test("a default filter set encodes to a CLEAN url", () => {
  // The shareable-link requirement: nothing set means nothing in the URL.
  assert.equal(encodeFilters(defaultFilters()), "");
  assert.equal(portfolioQuery(defaultFilters()), "");
  assert.equal(downloadsQuery(defaultFilters()), "");
});

test("the round trip is lossless for a fully-populated filter set", () => {
  const filters = withFilters({
    projectIds: [1, 2, 7],
    wbsIds: [10, 11],
    departmentIds: [3],
    sectionIds: [21, 22, 23],
    status: "active",
    budget: "with",
    bands: ["RED", "AMBER"],
    asOf: "2026-09-30",
    activityDays: 14,
  });
  assert.deepEqual(decodeFilters(encodeFilters(filters)), filters);
});

test("the round trip is lossless for every scalar choice", () => {
  for (const status of ["active", "inactive", "all"] as const) {
    for (const budget of ["all", "with", "without"] as const) {
      const filters = withFilters({ status, budget });
      assert.deepEqual(decodeFilters(encodeFilters(filters)), filters, `${status}/${budget}`);
    }
  }
});

test("defaults are omitted from the url, one field at a time", () => {
  assert.equal(encodeFilters(withFilters({ status: "all" })), "");
  assert.equal(encodeFilters(withFilters({ budget: "all" })), "");
  assert.equal(encodeFilters(withFilters({ activityDays: DEFAULT_ACTIVITY_DAYS })), "");
  assert.equal(encodeFilters(withFilters({ projectIds: [] })), "");
  // Only the non-default field appears.
  assert.equal(encodeFilters(withFilters({ status: "inactive" })), "status=inactive");
  assert.equal(encodeFilters(withFilters({ budget: "without" })), "budget=without");
  assert.equal(encodeFilters(withFilters({ activityDays: 30 })), "activityDays=30");
  assert.equal(encodeFilters(withFilters({ projectIds: [4, 2] })), "projectIds=2%2C4");
});

test("a non-default field encodes to the wire token the API expects", () => {
  assert.equal(encodeFilters(withFilters({ bands: ["RED", "AMBER"] })), "band=RED%2CAMBER");
  assert.equal(encodeFilters(withFilters({ asOf: "2026-01-05" })), "asOf=2026-01-05");
});

test("junk in an id list is dropped the same way the API drops it", () => {
  // "2,3,x" keeps [2,3] — one bad cell in a hand-edited URL must not blank the report.
  assert.deepEqual(parseIdList("2,3,x"), [2, 3]);
  // 0, negatives and decimals are junk, not filters.
  assert.deepEqual(parseIdList("0,-1,4.5,9"), [9]);
  // Duplicates collapse and the list is ascending, so a re-ordered selection is stable.
  assert.deepEqual(parseIdList("3,1,3,2"), [1, 2, 3]);
  // A junk-ONLY list collapses to empty, which means "no filter" (NOT match-nothing).
  assert.deepEqual(parseIdList("x,y,z"), []);
  assert.deepEqual(parseIdList(""), []);
  assert.deepEqual(parseIdList(null), []);
});

test("decode drops junk exactly as the API does and never throws", () => {
  const decoded = decodeFilters("?projectIds=2,3,x&wbsIds=nope&status=purple&band=RED,PURPLE&asOf=2026-02-30&activityDays=9999");
  // Ids: junk tokens dropped.
  assert.deepEqual(decoded.projectIds, [2, 3]);
  // A junk-only id list is "no filter", not "match nothing".
  assert.deepEqual(decoded.wbsIds, []);
  // An unknown enum falls back to the default (the encoder omits it again).
  assert.equal(decoded.status, "all");
  // A known band is kept, an unknown one is dropped (never a silent widen-by-error).
  assert.deepEqual(decoded.bands, ["RED"]);
  // 2026-02-30 matches the regex but is not a real day -> treated as unset.
  assert.equal(decoded.asOf, "");
  // Out of the 1..365 range -> the default.
  assert.equal(decoded.activityDays, DEFAULT_ACTIVITY_DAYS);
  // And the decoded junk re-encodes to a clean url (nothing set survived).
  assert.equal(encodeFilters(decoded), "projectIds=2%2C3&band=RED");
});

test("a band list survives the round trip in the order asked for", () => {
  const filters = withFilters({ bands: ["AMBER", "RED"] });
  assert.equal(encodeFilters(filters), "band=AMBER%2CRED");
  assert.deepEqual(decodeFilters(encodeFilters(filters)).bands, ["AMBER", "RED"]);
});

test("an unset as-of date and a clean activity window round-trip as the defaults", () => {
  const filters = withFilters({ asOf: "", activityDays: DEFAULT_ACTIVITY_DAYS });
  assert.equal(encodeFilters(filters), "");
  const decoded = decodeFilters("?asOf=not-a-date&activityDays=0");
  assert.equal(decoded.asOf, "");
  assert.equal(decoded.activityDays, DEFAULT_ACTIVITY_DAYS);
});

test("a hand-edited url with extra keys re-encodes to a clean url for the decoded state", () => {
  // `decode -> encode` is a normaliser: junk keys and junk values fall away, and the
  // result is a stable string that round-trips again unchanged.
  const decoded = decodeFilters("?projectIds=5&status=active&junk=1&band=&asOf=2026-13-01");
  const once = encodeFilters(decoded);
  assert.equal(once, "projectIds=5&status=active");
  assert.equal(encodeFilters(decodeFilters(once)), once);
});

test("the download query string EQUALS the JSON query string for the same filter state", () => {
  // This is the contract the task exists to protect: the two call sites cannot drift,
  // because they are the same function.
  const states: PortfolioFilterState[] = [
    defaultFilters(),
    withFilters({ status: "active", budget: "with" }),
    withFilters({ projectIds: [3, 1], sectionIds: [9], bands: ["RED", "GREEN"], asOf: "2026-09-30", activityDays: 21 }),
  ];
  for (const state of states) {
    assert.equal(downloadsQuery(state), portfolioQuery(state));
    // A .xlsx and a .pdf link built on it differ only by the path prefix.
    assert.equal(`/api/reports/portfolio.xlsx${downloadsQuery(state)}`, `/api/reports/portfolio.xlsx${portfolioQuery(state)}`);
    assert.equal(`/api/reports/portfolio.pdf${downloadsQuery(state)}`, `/api/reports/portfolio.pdf${portfolioQuery(state)}`);
    assert.equal(`/api/reports/portfolio${portfolioQuery(state)}`, `/api/reports/portfolio${downloadsQuery(state)}`);
  }
});

test("the JSON query string is exactly what a raw URLSearchParams of the same state would carry", () => {
  // Guards against an encoder that adds a key the API does not know, or drops one it does.
  const state = withFilters({
    projectIds: [2, 4],
    wbsIds: [8],
    departmentIds: [1],
    sectionIds: [5, 6],
    status: "inactive",
    budget: "without",
    bands: ["NOT_MEASURABLE"],
    asOf: "2026-03-01",
    activityDays: 90,
  });
  const expected = new URLSearchParams({
    projectIds: "2,4",
    wbsIds: "8",
    departmentIds: "1",
    sectionIds: "5,6",
    status: "inactive",
    budget: "without",
    band: "NOT_MEASURABLE",
    asOf: "2026-03-01",
    activityDays: "90",
  }).toString();
  assert.equal(portfolioQuery(state), `?${expected}`);
  assert.deepEqual(decodeFilters(portfolioQuery(state)), state);
});
