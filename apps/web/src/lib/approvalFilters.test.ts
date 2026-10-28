import assert from "node:assert/strict";
import test from "node:test";
import {
  anyFilterActive,
  filteredCount,
  matchesFilters,
  NO_FILTERS,
  optionLists,
  projectIdsFromKeys,
  type FilterSubject,
} from "./approvalFilters";

const subject = (over: Partial<FilterSubject> = {}): FilterSubject => ({
  department: "Production - EOU",
  supervisorIds: [4],
  projectIds: [3, 11],
  ...over,
});

test("no filter means everything, and says so", () => {
  assert.equal(anyFilterActive(NO_FILTERS), false);
  assert.equal(matchesFilters(NO_FILTERS, subject()), true);
  assert.equal(anyFilterActive({ department: "Production - EOU", supervisor: "", project: "" }), true);
});

test("the department matches by its label, exactly", () => {
  assert.equal(matchesFilters({ ...NO_FILTERS, department: "Production - EOU" }, subject()), true);
  // "Production" is NOT "Production - EOU": different label, different chain of approval.
  assert.equal(matchesFilters({ ...NO_FILTERS, department: "Production" }, subject()), false);
  assert.equal(matchesFilters({ ...NO_FILTERS, department: "Production - EOU" }, subject({ department: null })), false);
});

test("the supervisor filter matches the ids a row carries, as a set", () => {
  assert.equal(matchesFilters({ ...NO_FILTERS, supervisor: "4" }, subject()), true);
  assert.equal(matchesFilters({ ...NO_FILTERS, supervisor: "9" }, subject()), false);
  // A payroll day filled by two accounts answers to either.
  assert.equal(matchesFilters({ ...NO_FILTERS, supervisor: "9" }, subject({ supervisorIds: [4, 9] })), true);
});

test("the project filter matches a real project id, from any lens", () => {
  assert.equal(matchesFilters({ ...NO_FILTERS, project: "11" }, subject()), true);
  // The same dropdown value serves the payroll and job-order lenses, which carry ids directly.
  assert.equal(matchesFilters({ ...NO_FILTERS, project: "7" }, subject({ projectIds: [7] })), true);
  assert.equal(matchesFilters({ ...NO_FILTERS, project: "7" }, subject()), false);
});

test("a zero or non-numeric selection does not hide the whole queue", () => {
  // "" means "no filter"; "0" is not an id. Neither may zero the screen, because an empty list reads as
  // a queue with nothing in it rather than as a broken filter.
  assert.equal(matchesFilters({ ...NO_FILTERS, supervisor: "0" }, subject()), true);
  assert.equal(matchesFilters({ ...NO_FILTERS, project: "0" }, subject()), true);
  assert.equal(matchesFilters({ ...NO_FILTERS, project: "" }, subject()), true);
});

test("the three filters combine: each one narrows the last", () => {
  const filters = { department: "Production - EOU", supervisor: "4", project: "3" };
  assert.equal(matchesFilters(filters, subject()), true);
  assert.equal(matchesFilters(filters, subject({ department: "QA/QC - EOU" })), false);
  assert.equal(matchesFilters(filters, subject({ supervisorIds: [11] })), false);
  assert.equal(matchesFilters(filters, subject({ projectIds: [5] })), false);
});

test("hours keyed by colour key become project ids through the map the report uses", () => {
  const keyToId = new Map([
    ["A", 3],
    ["B", 5],
  ]);
  assert.deepEqual(projectIdsFromKeys({ A: 8, B: 0, C: 2 }, keyToId), [3]);
  assert.deepEqual(projectIdsFromKeys(undefined, keyToId), []);
});

test("the dropdowns offer only what the loaded queue actually contains, and no duplicates", () => {
  const options = optionLists({
    departments: ["Production - EOU", null, "QA/QC - EOU", "Production - EOU", undefined],
    supervisors: [
      { id: 4, name: "Zed" },
      { id: 4, name: "Zed" },
      { id: 2, name: "Amit" },
      null,
    ],
    projects: [
      { id: 5, code: "CSR.014", name: "Ocean Citrine" },
      { id: 3, code: "CSR.008", name: "TUG GMB I" },
    ],
  });
  assert.deepEqual(options.departments, ["Production - EOU", "QA/QC - EOU"]);
  assert.deepEqual(options.supervisors, [
    { id: 2, name: "Amit" },
    { id: 4, name: "Zed" },
  ]);
  assert.deepEqual(
    options.projects.map((project) => project.code),
    ["CSR.008", "CSR.014"]
  );
});

test("the count line says what was hidden, and stays quiet when nothing was", () => {
  assert.equal(filteredCount(40, 40), "40");
  assert.equal(filteredCount(12, 40), "12 of 40");
});
