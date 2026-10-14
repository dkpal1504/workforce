import assert from "node:assert/strict";
import test from "node:test";

import { hodRoutingScope, routingSectionScope } from "./approvalRouting";

/*
 * The routing rule is a Prisma `where` fragment, so these tests run it rather than only reading it:
 * a deliberately small evaluator applies the fragment to in-memory fixtures. It THROWS on a fragment
 * shape it does not know, so a future branch cannot be added to the rule and silently pass here.
 *
 * The fixtures are the reported case and its neighbours: a `Steel` Supervisor (Section 8) with a team
 * drawn from `Hull and Outfitting` (Section 41), both in Department 4.
 */

const DEPARTMENT = 4;
const OTHER_DEPARTMENT = 3;
const STEEL = 8;
const HULL = 41;

type EmployeeFixture = { departmentId: number; sectionId: number | null };
type TaggerFixture = {
  departmentId: number | null;
  /** `null` = the account is not linked to an Employee at all (an Admin editing a sheet). */
  employee: EmployeeFixture | null;
};
type DayFixture = {
  id: number;
  employee: EmployeeFixture;
  taggedBy: TaggerFixture;
};

function matchesEmployee(fragment: Record<string, any>, employee: EmployeeFixture): boolean {
  for (const [key, value] of Object.entries(fragment)) {
    if (key === "departmentId") {
      if (value !== employee.departmentId) return false;
      continue;
    }
    if (key === "sectionAssignment") {
      if (value === null) {
        if (employee.sectionId !== null) return false;
        continue;
      }
      const ids = value.sectionId?.in as number[] | undefined;
      if (!ids || employee.sectionId === null || !ids.includes(employee.sectionId)) return false;
      continue;
    }
    throw new Error(`unhandled employee filter key: ${key}`);
  }
  return true;
}

function matchesTagger(fragment: Record<string, any>, tagger: TaggerFixture): boolean {
  for (const [key, value] of Object.entries(fragment)) {
    if (key === "OR") {
      if (!(value as Record<string, any>[]).some((branch) => matchesTagger(branch, tagger))) return false;
      continue;
    }
    if (key === "departmentId") {
      if (value !== tagger.departmentId) return false;
      continue;
    }
    if (key === "employee") {
      if (value === null) {
        if (tagger.employee !== null) return false;
        continue;
      }
      // A nested filter on a relation that is absent can never match.
      if (tagger.employee === null) return false;
      if (!matchesEmployee(value, tagger.employee)) return false;
      continue;
    }
    throw new Error(`unhandled tagger filter key: ${key}`);
  }
  return true;
}

function matches(fragment: Record<string, any>, day: DayFixture): boolean {
  for (const [key, value] of Object.entries(fragment)) {
    if (key === "id") {
      if (value !== day.id) return false;
      continue;
    }
    if (key === "OR") {
      if (!(value as Record<string, any>[]).some((branch) => matches(branch, day))) return false;
      continue;
    }
    if (key === "employee") {
      if (!matchesEmployee(value, day.employee)) return false;
      continue;
    }
    if (key === "taggedBy") {
      if (!matchesTagger(value, day.taggedBy)) return false;
      continue;
    }
    throw new Error(`unhandled timesheet-day filter key: ${key}`);
  }
  return true;
}

function routedTo(day: DayFixture, departmentId: number | null, sections: number[]): boolean {
  return matches(hodRoutingScope(departmentId, sections) as Record<string, any>, day);
}

/** A Steel Supervisor tagging a Hull and Outfitting employee: the case that changed. */
const steelSupervisorSheet: DayFixture = {
  id: 101,
  employee: { departmentId: DEPARTMENT, sectionId: HULL },
  taggedBy: { departmentId: DEPARTMENT, employee: { departmentId: DEPARTMENT, sectionId: STEEL } },
};

/** Same Section as his team — unchanged behaviour, kept so the rule cannot regress it. */
const sameSectionSheet: DayFixture = {
  id: 102,
  employee: { departmentId: DEPARTMENT, sectionId: STEEL },
  taggedBy: { departmentId: DEPARTMENT, employee: { departmentId: DEPARTMENT, sectionId: STEEL } },
};

/** An Admin editing a sheet: the tagger has no Employee at all. */
const adminTaggedSheet: DayFixture = {
  id: 103,
  employee: { departmentId: DEPARTMENT, sectionId: HULL },
  taggedBy: { departmentId: null, employee: null },
};

/** A supervisor account whose Employee carries no Section assignment (no mapping to route by). */
const unmappedTaggerSheet: DayFixture = {
  id: 104,
  employee: { departmentId: DEPARTMENT, sectionId: STEEL },
  taggedBy: { departmentId: DEPARTMENT, employee: { departmentId: DEPARTMENT, sectionId: null } },
};

test("a Steel Supervisor's Hull-and-Outfitting labour goes to the STEEL Section Head, not Hull's", () => {
  assert.equal(routedTo(steelSupervisorSheet, DEPARTMENT, [STEEL]), true);
  assert.equal(routedTo(steelSupervisorSheet, DEPARTMENT, [HULL]), false, "the Section of the labour no longer decides");
});

test("the Supervisor's own Section still routes to itself", () => {
  assert.equal(routedTo(sameSectionSheet, DEPARTMENT, [STEEL]), true);
  assert.equal(routedTo(sameSectionSheet, DEPARTMENT, [HULL]), false);
});

test("a Head covering several Sections receives the sheets of every Supervisor inside them", () => {
  assert.equal(routedTo(steelSupervisorSheet, DEPARTMENT, [STEEL, HULL]), true);
  assert.equal(routedTo(sameSectionSheet, DEPARTMENT, [STEEL, HULL]), true);
  assert.equal(routedTo(steelSupervisorSheet, DEPARTMENT, [18, 26]), false);
});

test("a Department-wide Head receives every Section of his Department — the tagger's OR the employee's", () => {
  assert.equal(routedTo(steelSupervisorSheet, DEPARTMENT, []), true);
  assert.equal(routedTo(adminTaggedSheet, DEPARTMENT, []), true);
  assert.equal(routedTo(steelSupervisorSheet, OTHER_DEPARTMENT, []), false, "another Department's head sees nothing");
});

test("an unmapped Head routes nothing (fail closed)", () => {
  assert.equal(routedTo(steelSupervisorSheet, null, []), false);
  assert.equal(routedTo(steelSupervisorSheet, null, [STEEL]), false);
});

test("a tagger with NO Section of his own leaves the EMPLOYEE's Section deciding (unchanged)", () => {
  assert.equal(routedTo(adminTaggedSheet, DEPARTMENT, [HULL]), true);
  assert.equal(routedTo(adminTaggedSheet, DEPARTMENT, [STEEL]), false);
  assert.equal(routedTo(unmappedTaggerSheet, DEPARTMENT, [STEEL]), true);
  assert.equal(routedTo(unmappedTaggerSheet, DEPARTMENT, [HULL]), false);
});

test("the rule keys on the Supervisor's Section and carries its Department with it", () => {
  // A Section belongs to exactly one Department and a Head's scope is validated to be its own
  // Department's, so a Section match is already a Department match. A cross-Department team cannot be
  // built in the first place (`hasTeamAccess` and the team pool both require the same Department),
  // but if one existed the Supervisor's own Section would decide — which is the rule as stated.
  const foreignSupervisorSheet: DayFixture = {
    id: 105,
    employee: { departmentId: DEPARTMENT, sectionId: HULL },
    taggedBy: { departmentId: OTHER_DEPARTMENT, employee: { departmentId: OTHER_DEPARTMENT, sectionId: 60 } },
  };
  assert.equal(routedTo(foreignSupervisorSheet, OTHER_DEPARTMENT, [60]), true);
  assert.equal(routedTo(foreignSupervisorSheet, DEPARTMENT, [HULL]), false);
});

test("an EMPTY Section set is match-nothing, never every Section", () => {
  assert.equal(matches(routingSectionScope([]) as Record<string, any>, steelSupervisorSheet), false);
});
