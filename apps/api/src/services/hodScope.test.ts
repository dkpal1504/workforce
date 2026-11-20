import test from "node:test";
import assert from "node:assert/strict";

import {
  describeHodScope,
  hodScopeDepartmentIds,
  hodScopeFromLegacy,
  hodScopeFromRows,
  hodScopeNamedSectionIds,
  sameHodScope,
} from "./hodScope";

/*
 * The grant set is what makes one HOD head two plants. These tests pin the two properties that
 * matter: an account with NO rows keeps today's exact scope (so the migration is zero-touch), and a
 * second Department is additive — it can never take authority away from the home Department.
 */

const EOU = 12; // Yardservice - EOU (home)
const SEZ = 11; // Yardservice - SEZ (granted)
const EOU_OPERATION = 17;
const EOU_MAINTENANCE = 19;
const SEZ_OPERATION = 24;

test("an account with no rows keeps the legacy single-Department scope", () => {
  assert.deepEqual(hodScopeFromRows({
    departmentId: EOU, legacySectionId: EOU_MAINTENANCE, departmentGrants: [], sectionRows: [],
  }), { grants: [{ departmentId: EOU, sectionIds: [EOU_MAINTENANCE] }] });

  assert.deepEqual(hodScopeFromRows({
    departmentId: EOU, legacySectionId: null, departmentGrants: [], sectionRows: [],
  }), { grants: [{ departmentId: EOU, sectionIds: [] }] }, "no Department at all still means the whole Department");

  assert.deepEqual(hodScopeFromRows({
    departmentId: null, legacySectionId: null, departmentGrants: [], sectionRows: [],
  }), { grants: [] }, "an unmapped account matches nothing");
});

test("two whole-Department grants are both held, and the legacy mirror is ignored", () => {
  const scope = hodScopeFromRows({
    departmentId: EOU,
    legacySectionId: EOU_MAINTENANCE,
    departmentGrants: [EOU, SEZ],
    sectionRows: [],
  });
  assert.deepEqual(scope, {
    grants: [
      { departmentId: SEZ, sectionIds: [] },
      { departmentId: EOU, sectionIds: [] },
    ],
  });
  assert.deepEqual(hodScopeDepartmentIds(scope), [SEZ, EOU]);
  assert.deepEqual(hodScopeNamedSectionIds(scope), []);
});

test("named Sections are grouped by THEIR OWN Department, not the account's", () => {
  const scope = hodScopeFromRows({
    departmentId: EOU,
    legacySectionId: EOU_OPERATION,
    departmentGrants: [EOU],
    sectionRows: [
      { sectionId: EOU_OPERATION, departmentId: EOU },
      { sectionId: EOU_MAINTENANCE, departmentId: EOU },
      { sectionId: SEZ_OPERATION, departmentId: SEZ },
    ],
  });
  assert.deepEqual(scope, {
    grants: [
      { departmentId: SEZ, sectionIds: [SEZ_OPERATION] },
      { departmentId: EOU, sectionIds: [] },
    ],
  }, "the whole-Department grant wins for EOU; the SEZ Section still carries SEZ with it");
});

test("a named Section under a Department it does not belong to is still reported under ITS Department", () => {
  // Defensive: the write path refuses this, but a stale row must not be able to widen EOU's grant.
  const scope = hodScopeFromRows({
    departmentId: EOU,
    legacySectionId: null,
    departmentGrants: [EOU],
    sectionRows: [{ sectionId: SEZ_OPERATION, departmentId: SEZ }],
  });
  assert.deepEqual(hodScopeDepartmentIds(scope), [SEZ, EOU]);
});

test("sameHodScope compares authority, not order", () => {
  const left = { grants: [{ departmentId: EOU, sectionIds: [19, 17] }, { departmentId: SEZ, sectionIds: [] as number[] }] };
  const right = { grants: [{ departmentId: SEZ, sectionIds: [] as number[] }, { departmentId: EOU, sectionIds: [17, 19] }] };
  assert.equal(sameHodScope(left, right), true);
  assert.equal(sameHodScope(left, { grants: [{ departmentId: EOU, sectionIds: [17] }, { departmentId: SEZ, sectionIds: [] }] }), false);
  assert.equal(sameHodScope({ grants: [] }, { grants: [] }), true);
  assert.equal(sameHodScope({ grants: [] }, left), false);
});

test("describeHodScope names Departments and Sections, never bare ids", () => {
  const departmentName = (id: number) => ({ [EOU]: "Yardservice - EOU", [SEZ]: "Yardservice - SEZ" } as Record<number, string>)[id];
  const sectionName = (id: number) => ({ [SEZ_OPERATION]: "Operation", [EOU_MAINTENANCE]: "Maintenance" } as Record<number, string>)[id];
  assert.equal(
    describeHodScope(
      { grants: [{ departmentId: EOU, sectionIds: [EOU_MAINTENANCE] }, { departmentId: SEZ, sectionIds: [SEZ_OPERATION] }] },
      departmentName,
      sectionName
    ),
    "Yardservice - EOU (Maintenance); Yardservice - SEZ (Operation)"
  );
  assert.equal(
    describeHodScope({ grants: [{ departmentId: EOU, sectionIds: [] }] }, departmentName, sectionName),
    "Yardservice - EOU (all Sections)"
  );
  assert.equal(describeHodScope({ grants: [] }, departmentName, sectionName), "no Department (matches nothing)");
});

test("hodScopeFromLegacy is the compatibility keystone", () => {
  assert.deepEqual(hodScopeFromLegacy(EOU, [19, 17, 19]), { grants: [{ departmentId: EOU, sectionIds: [17, 19] }] });
  assert.deepEqual(hodScopeFromLegacy(EOU, []), { grants: [{ departmentId: EOU, sectionIds: [] }] });
  assert.deepEqual(hodScopeFromLegacy(null, [17]), { grants: [] });
});
