import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_RANGE_DAYS,
  NOT_FILLED,
  buildCoverage,
  combineCoverageStatuses,
  coverageRange,
  coverageStatusFor,
  filterCoverageRows,
  parseCoverageStatuses,
  parseIsoDay,
  type CoverageCountRow,
} from "./timesheetCoverage";

/**
 * WHY THESE TESTS EXIST: the report's whole value is the sentence "these employees were not covered",
 * and every way of getting that wrong still produces a plausible-looking table. The rules pinned
 * here are the ones that would silently overstate coverage:
 *   1. a REJECTED / returned sheet is Draft, NOT Approved — and an UNRECOGNISED status is Draft too;
 *   2. an employee on two sheets for one day takes the LEAST advanced of them;
 *   3. an employee with no sheet is "Not Filled", which is not a stage of the chain;
 *   4. every date in the range is listed, including the ones nobody filled in;
 *   5. the coverage figures count ROSTER and EXPOSURE separately, and never divide by zero.
 */

test("the status vocabulary maps the eight database states onto the operator's four", () => {
  assert.equal(coverageStatusFor("DRAFT"), "Draft");
  assert.equal(coverageStatusFor("SUBMITTED"), "Submitted");
  assert.equal(coverageStatusFor("HOD_APPROVED"), "HOD Approved");
  assert.equal(coverageStatusFor("PM_APPROVED"), "Approved");
  // Every returned/rejected state is back with the supervisor: Draft, by instruction.
  for (const returned of ["REJECTED", "PLANNING_RETURNED", "FINAL_REJECTED"]) {
    assert.equal(coverageStatusFor(returned), "Draft", `${returned} must count as Draft`);
  }
});

test("an unrecognised or entry-level status is Draft, never Approved", () => {
  // SUP_APPROVED is an ENTRY state and must not read as a day approval; an empty string is the
  // absence of a status, not the end of the approval chain.
  for (const unknown of ["SUP_APPROVED", "", "  ", "APPROVED", "HODAPPROVED", "nonsense"]) {
    assert.equal(coverageStatusFor(unknown), "Draft", `${JSON.stringify(unknown)} must not read as advanced`);
  }
});

test("an employee on two sheets for one date takes the LEAST advanced status", () => {
  // A day is not approved until every sheet covering it is.
  assert.equal(combineCoverageStatuses(["PM_APPROVED", "DRAFT"]), "Draft");
  assert.equal(combineCoverageStatuses(["PM_APPROVED", "SUBMITTED"]), "Submitted");
  assert.equal(combineCoverageStatuses(["HOD_APPROVED", "SUBMITTED"]), "Submitted");
  assert.equal(combineCoverageStatuses(["PM_APPROVED", "HOD_APPROVED"]), "HOD Approved");
  assert.equal(combineCoverageStatuses(["PM_APPROVED", "PM_APPROVED"]), "Approved");
  // A rejection beside an approval is still a day the supervisor must redo.
  assert.equal(combineCoverageStatuses(["PM_APPROVED", "REJECTED"]), "Draft");
  // And with no sheet at all, it is "Not Filled" — not Draft.
  assert.equal(combineCoverageStatuses([]), NOT_FILLED);
});

test("a real YYYY-MM-DD is accepted and an impossible day is refused", () => {
  assert.equal(parseIsoDay("2026-10-13"), "2026-10-13");
  assert.equal(parseIsoDay(" 2026-10-13 "), "2026-10-13");
  assert.equal(parseIsoDay("2026-02-30"), null, "the regex matches it but JS would roll it forward");
  assert.equal(parseIsoDay("13-10-2026"), null);
  assert.equal(parseIsoDay(""), null);
  assert.equal(parseIsoDay(null), null);
});

test("every date in the range is listed, not just the ones with data", () => {
  const range = coverageRange("2026-10-01", "2026-10-05");
  assert.ok(range.ok);
  assert.deepEqual(range.days, ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05"]);
  assert.equal(range.from, "2026-10-01");
  assert.equal(range.to, "2026-10-05");
  // The count of days is inclusive at both ends.
  assert.equal(range.days.length, 5);
});

test("a reversed, malformed or over-long range is refused with a reason", () => {
  const reversed = coverageRange("2026-10-05", "2026-10-01");
  assert.equal(reversed.ok, false);
  assert.equal(reversed.ok === false && reversed.code, "INVALID_RANGE");
  const malformed = coverageRange("2026-10-05", "yesterday");
  assert.equal(malformed.ok === false && malformed.code, "INVALID_RANGE");
  const tooLong = coverageRange("2026-01-01", "2026-12-31");
  assert.equal(tooLong.ok === false && tooLong.code, "RANGE_TOO_LONG");
  // Exactly the cap is allowed; one day more is not.
  const atCap = coverageRange("2026-01-01", "2026-04-02");
  assert.equal(atCap.ok && atCap.days.length, MAX_RANGE_DAYS);
  const overCap = coverageRange("2026-01-01", "2026-04-03");
  assert.equal(overCap.ok, false);
});

/** Rows for one employee, one department/section, across days. */
function row(date: string, employeeId: number, status: CoverageCountRow["status"], sectionId = 1): CoverageCountRow {
  return {
    date,
    employeeId,
    departmentId: 7,
    departmentName: "Production - EOU",
    sectionId,
    sectionName: sectionId === 1 ? "Hull" : "Steel",
    status,
  };
}

test("coverage counts the roster AND the exposure, per Department/Section", () => {
  const rows: CoverageCountRow[] = [
    // Two employees in Hull on a two-day range: one filled both days, one filled nothing.
    row("2026-10-01", 101, "Approved"),
    row("2026-10-02", 101, "Submitted"),
    row("2026-10-01", 102, NOT_FILLED),
    row("2026-10-02", 102, NOT_FILLED),
    // And one employee in Steel with a single filled day.
    row("2026-10-01", 103, "Draft", 2),
    row("2026-10-02", 103, NOT_FILLED, 2),
  ];
  const buckets = buildCoverage(rows);
  assert.equal(buckets.length, 2);

  const hull = buckets.find((b) => b.section?.name === "Hull");
  assert.ok(hull);
  assert.equal(hull.employees, 2, "the roster is two people");
  assert.equal(hull.employeeDays, 4, "two people x two days");
  assert.equal(hull.filledDays, 2);
  assert.equal(hull.notFilledDays, 2);
  // The distinction that matters: ONE person filled nothing at all, while the other filled both
  // days. A summary reporting only employee-days would hide the person who never appears.
  assert.equal(hull.employeesWithFilledDay, 1);
  assert.equal(hull.employeesWithNoFilledDay, 1);
  assert.equal(hull.filledPct, 0.5);

  const steel = buckets.find((b) => b.section?.name === "Steel");
  assert.ok(steel);
  assert.equal(steel.employees, 1);
  assert.equal(steel.employeeDays, 2);
  assert.equal(steel.filledDays, 1);
  assert.equal(steel.employeesWithFilledDay, 1, "a single filled day out of two still counts as touched");
  assert.equal(steel.filledPct, 0.5);
});

test("the Approval Status filter parses labels, tolerates junk, and never matches nothing by typo", () => {
  assert.deepEqual(parseCoverageStatuses("Not Filled"), ["Not Filled"]);
  // The underscore / lower-case form an operator might type normalises onto the label.
  assert.deepEqual(parseCoverageStatuses("hod_approved"), ["HOD Approved"]);
  assert.deepEqual(parseCoverageStatuses("NOT_FILLED"), ["Not Filled"]);
  // Duplicates collapse, and the result is in the report's own vocabulary order (the four stages,
  // then the gap) — NOT the order they were listed in.
  assert.deepEqual(parseCoverageStatuses("Draft,Not Filled,Draft"), ["Draft", "Not Filled"]);
  assert.deepEqual(parseCoverageStatuses("Not Filled,Draft"), ["Draft", "Not Filled"]);
  // An empty or entirely unknown list means NO FILTER — never a zero-row report.
  for (const junk of [null, undefined, "", "   ", "nonsense", "page", "nonsense,junk"]) {
    assert.deepEqual(parseCoverageStatuses(junk), [], `${JSON.stringify(junk)} must mean "no filter"`);
  }
  // A partially valid list keeps the valid words.
  assert.deepEqual(parseCoverageStatuses("Draft,nonsense"), ["Draft"]);
});

test("the filter narrows the DETAIL rows only, and an empty filter keeps every row", () => {
  const rows = [
    row("2026-09-27", 101, "Approved"),
    row("2026-09-27", 102, NOT_FILLED),
    row("2026-09-27", 103, "Not Filled" as never),
  ];
  // No filter: every row, and a COPY (the caller must not be handed its own array to mutate).
  const all = filterCoverageRows(rows, []);
  assert.equal(all.length, 3);
  assert.notEqual(all, rows);
  // Selecting the gap is the operator's use case.
  const gap = filterCoverageRows(rows, ["Not Filled"]);
  assert.equal(gap.length, 2);
  assert.ok(gap.every((r) => r.status === NOT_FILLED));
  // Two statuses OR together.
  assert.equal(filterCoverageRows(rows, ["Approved", "Not Filled"]).length, 3);
  // A status nobody has yields zero rows — the honest answer for a REAL filter, unlike a typo.
  assert.equal(filterCoverageRows(rows, ["Submitted"]).length, 0);
});

test("an employee with no Section is its own bucket, never dropped", () => {
  const rows: CoverageCountRow[] = [row("2026-10-01", 201, NOT_FILLED, 0)];
  rows[0].sectionId = null;
  rows[0].sectionName = null;
  const buckets = buildCoverage(rows);
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].section, null);
  assert.equal(buckets[0].employees, 1);
  assert.equal(buckets[0].employeesWithNoFilledDay, 1);
});

test("an empty report divides by zero nowhere", () => {
  assert.deepEqual(buildCoverage([]), []);
  // A bucket whose every row is unfilled still reports a finite percentage.
  const buckets = buildCoverage([row("2026-10-01", 301, NOT_FILLED)]);
  assert.equal(buckets[0].filledPct, 0);
  assert.equal(buckets[0].filledDays, 0);
  assert.ok(Number.isFinite(buckets[0].filledPct));
});
