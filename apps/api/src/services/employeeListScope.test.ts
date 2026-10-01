import test from "node:test";
import assert from "node:assert/strict";
import { employeeListScopeFor, employeeListWhere, seesWholeDepartment } from "./employeeListScope";

/**
 * The production case this rule was written for:
 *   HOD Bhavesh Sheladiya, department 4 (Production - EOU), scope section 8 (Hull and Outfitting).
 *   He saw 57 employees (his Section); his Department holds 113 across 6 Sections.
 */
const sectionHead = { role: "HOD", departmentId: 4, sectionId: 8 } as const;

test("a Section Head sees the whole Department, not just his Section", () => {
  assert.deepEqual(employeeListScopeFor(sectionHead), { kind: "DEPARTMENT", departmentId: 4 });
  assert.deepEqual(employeeListWhere(employeeListScopeFor(sectionHead)), { departmentId: 4 });
});

test("a HOD with no Section (Department HOD) gets the same department-wide view", () => {
  assert.deepEqual(employeeListScopeFor({ role: "HOD", departmentId: 4, sectionId: null }), { kind: "DEPARTMENT", departmentId: 4 });
});

test("a Department Head gets the department-wide view too", () => {
  assert.equal(seesWholeDepartment("DEPT_HEAD"), true);
  assert.deepEqual(employeeListScopeFor({ role: "DEPT_HEAD", departmentId: 4, sectionId: 8 }), { kind: "DEPARTMENT", departmentId: 4 });
  assert.deepEqual(employeeListScopeFor({ role: "DEPT_HEAD", departmentId: 4, sectionId: null }), { kind: "DEPARTMENT", departmentId: 4 });
});

test("a SUPERVISOR is unchanged: still his Department AND his own Section", () => {
  assert.equal(seesWholeDepartment("SUPERVISOR"), false);
  assert.deepEqual(employeeListScopeFor({ role: "SUPERVISOR", departmentId: 4, sectionId: 8 }), {
    kind: "DEPARTMENT_SECTION", departmentId: 4, sectionId: 8,
  });
  assert.deepEqual(employeeListWhere(employeeListScopeFor({ role: "SUPERVISOR", departmentId: 4, sectionId: 8 })), {
    departmentId: 4, sectionAssignment: { sectionId: 8 },
  });
});

test("unrestricted roles list everything", () => {
  for (const role of ["ADMIN", "HR", "PM", "FINANCE"]) {
    assert.deepEqual(employeeListScopeFor({ role, departmentId: 4, sectionId: 8 }), { kind: "ALL" }, role);
    assert.deepEqual(employeeListScopeFor({ role, departmentId: null, sectionId: null }), { kind: "ALL" }, role);
  }
});

test("a head with no Department mapping FAILS CLOSED rather than widening to every department", () => {
  const noDepartment = employeeListScopeFor({ role: "HOD", departmentId: null, sectionId: 8 });
  assert.equal(noDepartment.kind, "NONE");
  // `{}` in Prisma means EVERY row, so NONE must never produce it — that is the leak this guards.
  const where = employeeListWhere(noDepartment);
  assert.deepEqual(where, { id: -1 });
  assert.notDeepEqual(where, {});
  assert.deepEqual(employeeListWhere(employeeListScopeFor({ role: "DEPT_HEAD", departmentId: null, sectionId: null })), { id: -1 });
});

test("a SUPERVISOR with a missing mapping also fails closed", () => {
  assert.equal(employeeListScopeFor({ role: "SUPERVISOR", departmentId: 4, sectionId: null }).kind, "NONE");
  assert.equal(employeeListScopeFor({ role: "SUPERVISOR", departmentId: null, sectionId: 8 }).kind, "NONE");
  assert.deepEqual(employeeListWhere(employeeListScopeFor({ role: "SUPERVISOR", departmentId: 4, sectionId: null })), { id: -1 });
});

test("an EMPLOYEE gets no listing scope at all (they are not a listing role)", () => {
  // EMPLOYEE is not a listing role: the route gates on viewEmployees, which EMPLOYEE lacks. If it
  // ever reaches here the scope is ALL, so the GATE must stay in place — asserted in roleAccess.
  assert.deepEqual(employeeListScopeFor({ role: "EMPLOYEE", departmentId: 4, sectionId: 8 }), { kind: "ALL" });
});
