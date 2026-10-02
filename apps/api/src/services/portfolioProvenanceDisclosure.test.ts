import test from "node:test";
import assert from "node:assert/strict";
import { assemblePortfolioReport } from "./portfolioReport";
import type { PortfolioFilters } from "./portfolioFilters";

/**
 * THE DISCLOSURE DEFECT, pinned at the pure assembly layer with no database.
 *
 * WHY THIS FILE EXISTS SEPARATELY
 *   The provenance block is built from the EFFECTIVE (already-intersected) Department set, not from
 *   the raw request. Getting that backwards produces a report that returns the RIGHT rows while
 *   CLAIMING a scope the actor never had: an HOD of Department 1 who asks for `departmentIds=[1,2]`
 *   reads his own 2 rows, but his export would print "Department: 1, 2" and stamp that into the
 *   filename hash. The rows are contained; the STATEMENT about the boundary is false, which is worse
 *   in a forwarded document than an empty one.
 *
 *   The DB-backed half of this coverage lives in portfolioReport.test.ts (it needs real departments
 *   to intersect). This file is the database-free half, so the property is protected even if the
 *   fixtures change — the two halves fail independently.
 *
 * The EMPTY intersection is the case that matters most: an HOD asking for a Department that is not
 * his must be told "None", never handed back the foreign id he requested.
 */

const NOW = new Date("2026-10-02T00:00:00Z");

function filters(overrides: Partial<PortfolioFilters> = {}): PortfolioFilters {
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
    ...overrides,
  };
}

/** The printed "Department" value from the provenance filter list, or null when absent. */
function departmentLineOf(report: ReturnType<typeof assemblePortfolioReport>): string | null {
  const entry = report.provenance.filters.find((row) => row.label === "Department");
  return entry ? entry.value : null;
}

function assemble(
  requested: PortfolioFilters,
  effectiveDepartmentIds: number[] | null,
  role = "HOD",
  departmentId: number | null = 1
) {
  return assemblePortfolioReport({
    facts: [],
    filters: requested,
    actor: { id: 9, name: "probe", role, departmentId },
    asOf: NOW,
    now: NOW,
    // An ORGANISATION actor never carries a DEPARTMENT scope; a head always does.
    ...(role === "HOD" || role === "DEPT_HEAD"
      ? { scope: { kind: "DEPARTMENT" as const, departmentId: 1 } }
      : {}),
    effectiveDepartmentIds,
  });
}

test("an empty applied department set is stated as None, never the foreign request", () => {
  // The HOD asked for a Department that is not his. The intersect refused it, so the report is empty
  // AND must say so: printing "Department: 2" would tell a reader the report covers Department 2.
  const report = assemble(filters({ departmentIds: [2] }), []);
  const line = departmentLineOf(report);

  assert.equal(line, "None (nothing in the applied scope)");
  assert.ok(!String(line).includes("2"), "the refused foreign department id must not appear");
  assert.ok(
    report.definitions.notes.some((note) => note.startsWith("Requested Department filter")),
    "the request that was narrowed away is still recorded, so nothing is silently dropped"
  );
});

test("an intersected request prints only the APPLIED department", () => {
  const report = assemble(filters({ departmentIds: [1, 2] }), [1]);
  assert.equal(departmentLineOf(report), "1", "only the department actually applied");
});

test("the filters hash follows the EFFECTIVE set, so a narrowed report cannot share a filename", () => {
  const requested = filters({ departmentIds: [1, 2] });
  const narrowed = assemble(requested, [1]);
  const wholeOrganisation = assemble(requested, [1, 2], "PM", null);

  assert.notEqual(
    narrowed.provenance.filtersHash,
    wholeOrganisation.provenance.filtersHash,
    "the same request under a different applied scope must not produce the same report key"
  );
});

test("an ORGANISATION actor's request is passed through unchanged (no regression)", () => {
  const report = assemble(filters({ departmentIds: [9] }), [9], "PM", null);
  assert.equal(departmentLineOf(report), "9", "PM asking for a department still names it");
  assert.ok(
    !report.definitions.notes.some((note) => note.startsWith("Requested Department filter")),
    "nothing was narrowed, so the narrowing note must be absent rather than noise"
  );
});

test("the hash is stable for identical effective sets, whoever asked", () => {
  const requested = filters({ departmentIds: [1] });
  const asHod = assemble(requested, [1], "HOD", 1);
  const asDepartmentHead = assemble(requested, [1], "DEPT_HEAD", 1);

  assert.equal(asHod.provenance.filtersHash, asDepartmentHead.provenance.filtersHash);
  assert.equal(asHod.provenance.filtersHash, assemble(requested, [1], "HOD", 1).provenance.filtersHash);
});
