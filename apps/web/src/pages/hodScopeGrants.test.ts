import test from "node:test";
import assert from "node:assert/strict";
import {
  grantsDiffer,
  grantsFromAccount,
  grantsProblem,
  grantsSummary,
  groupDepartmentsByFunction,
  normaliseGrants,
  roleScopePayload,
  scopeEndpointPayload,
  setGrantWhole,
  toggleDepartment,
  toggleGrantSection,
} from "./hodScopeGrants";

/**
 * WHY THESE TESTS EXIST: this module decides what the two write endpoints are told. A payload that
 * silently drops the second plant is exactly the bug the screen exists to fix, and it would look like a
 * saved screen with the old scope still in place.
 */

const SECTIONS = [
  { id: 501, code: "YSE-01", name: "Jetty A", departmentId: 12 },
  { id: 502, code: "YSE-02", name: "Wharf", departmentId: 12 },
  { id: 511, code: "YSS-01", name: "Jetty B", departmentId: 11 },
];

test("an account holding two whole Departments reopens as two whole grants", () => {
  const grants = grantsFromAccount({ homeDepartmentId: 12, scopeDepartmentIds: [11, 12], scopeSectionIds: [], sections: SECTIONS });
  assert.deepEqual(grants, [
    { departmentId: 11, sectionIds: [] },
    { departmentId: 12, sectionIds: [] },
  ]);
});

test("named Sections fold into their own Department's grant; a home Department with no grants is whole", () => {
  const named = grantsFromAccount({ homeDepartmentId: 12, scopeDepartmentIds: [], scopeSectionIds: [502, 511], sections: SECTIONS });
  assert.deepEqual(named, [
    { departmentId: 11, sectionIds: [511] },
    { departmentId: 12, sectionIds: [502] },
  ]);
  const inherited = grantsFromAccount({ homeDepartmentId: 12, scopeDepartmentIds: [], scopeSectionIds: [], sections: SECTIONS });
  assert.deepEqual(inherited, [{ departmentId: 12, sectionIds: [] }]);
});

test("ticking a second plant adds it, and unticking removes it", () => {
  let grants = [{ departmentId: 12, sectionIds: [] }] as { departmentId: number; sectionIds: number[] }[];
  grants = toggleDepartment(grants, 11);
  assert.deepEqual(grants.map((g) => g.departmentId), [11, 12]);
  grants = toggleDepartment(grants, 12);
  assert.deepEqual(grants, [{ departmentId: 11, sectionIds: [] }]);
});

test("whole beats named, and a Section only ever lands on its own Department", () => {
  const started = toggleDepartment([], 12);
  const named = toggleGrantSection(started, 12, 501);
  assert.deepEqual(named, [{ departmentId: 12, sectionIds: [501] }]);
  // Switching back to whole drops the named list: the two must never be mixed for one Department.
  assert.deepEqual(setGrantWhole(named, 12, true), [{ departmentId: 12, sectionIds: [] }]);
  // Duplicates and unknown Departments cannot leak into a payload.
  assert.deepEqual(normaliseGrants([{ departmentId: 12, sectionIds: [501] }, { departmentId: 12, sectionIds: [501, 502] }]), [
    { departmentId: 12, sectionIds: [501, 502] },
  ]);
});

test("the role payload names whole Departments and the named Sections separately", () => {
  const grants = [
    { departmentId: 12, sectionIds: [] },
    { departmentId: 11, sectionIds: [511] },
  ];
  assert.deepEqual(roleScopePayload(grants), { departmentIds: [11, 12], sectionIds: [511] });
  // The payload is normalised (sorted, deduped) so two equal scopes always produce identical bytes.
  assert.deepEqual(scopeEndpointPayload(grants), {
    grants: [
      { departmentId: 11, sectionIds: [511] },
      { departmentId: 12, sectionIds: [] },
    ],
  });
  // The two-plant case the whole feature exists for: both whole, no sections named.
  assert.deepEqual(roleScopePayload([{ departmentId: 12, sectionIds: [] }, { departmentId: 11, sectionIds: [] }]), {
    departmentIds: [11, 12],
    sectionIds: [],
  });
});

test("a scope change is detected, an identical scope is not", () => {
  assert.equal(grantsDiffer([{ departmentId: 12, sectionIds: [] }], [{ departmentId: 12, sectionIds: [] }]), false);
  assert.equal(grantsDiffer([{ departmentId: 12, sectionIds: [] }], [{ departmentId: 12, sectionIds: [501] }]), true);
  assert.equal(grantsDiffer([{ departmentId: 12, sectionIds: [] }], [{ departmentId: 12, sectionIds: [] }, { departmentId: 11, sectionIds: [] }]), true);
});

test("an empty scope is refused before the request, and the summary names what was chosen", () => {
  assert.match(grantsProblem([]) ?? "", /at least one Department/i);
  assert.equal(grantsProblem([{ departmentId: 12, sectionIds: [] }]), null);
  const summary = grantsSummary(
    [{ departmentId: 12, sectionIds: [] }, { departmentId: 11, sectionIds: [511] }],
    (id) => (id === 12 ? "Yardservice - EOU" : "Yardservice - SEZ"),
    () => "Jetty B"
  );
  assert.equal(summary, "Yardservice - SEZ (Jetty B) · Yardservice - EOU (whole Department)");
});

test("departments group by function with EOU before SEZ, so the two plants sit together", () => {
  const groups = groupDepartmentsByFunction([
    { id: 11, name: "Yardservice - SEZ", businessUnit: "SEZ", functionGroup: "Yardservice" },
    { id: 12, name: "Yardservice - EOU", businessUnit: "EOU", functionGroup: "Yardservice" },
    { id: 13, name: "Safety - EOU", businessUnit: "EOU", functionGroup: "Safety" },
    // No functionGroup yet (a deployment that has not run the backfill) falls back to the name.
    { id: 14, name: "Fabrication Shop", businessUnit: null, functionGroup: null },
  ]);
  assert.deepEqual(groups.map((g) => g.functionGroup), ["Fabrication Shop", "Safety", "Yardservice"]);
  assert.deepEqual(groups[2].departments.map((d) => d.id), [12, 11]);
});
