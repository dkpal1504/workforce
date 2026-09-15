import test from "node:test";
import assert from "node:assert/strict";
import { ASSIGNABLE_ROLES, planRoleChange, type OpenWorkload, type RoleTarget } from "./roleAssignment";

const NO_WORK: OpenWorkload = { returnedTimesheetDays: 0, pendingApprovals: 0 };

function target(overrides: Partial<RoleTarget> = {}): RoleTarget {
  return {
    id: 50,
    name: "Test Person",
    role: "EMPLOYEE",
    active: true,
    currentSectionId: null,
    employeeId: 900,
    employee: { id: 900, active: true, employmentType: "PAYROLL", departmentId: 81 },
    sectionAssignment: { sectionId: 103, sectionActive: true, sectionDepartmentId: 81 },
    ...overrides,
  };
}

test("an admin can give a payroll employee the supervisor role, scoped to the employee department", () => {
  const plan = planRoleChange(1, target(), "SUPERVISOR", NO_WORK);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.ok && plan.update, { role: "SUPERVISOR", departmentId: 81, sectionId: null });
});

test("a contract (CLMS) linked employee is equally assignable", () => {
  const plan = planRoleChange(1, target({ employee: { id: 900, active: true, employmentType: "CLMS", departmentId: 77 } }), "SUPERVISOR", NO_WORK);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.ok && plan.update, { role: "SUPERVISOR", departmentId: 77, sectionId: null });
});

test("HOD takes Department and Section from the employee mapping, never from the request", () => {
  const plan = planRoleChange(1, target(), "HOD", NO_WORK);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.ok && plan.update, { role: "HOD", departmentId: 81, sectionId: 103 });
});

test("HOD is allowed with no section assignment, as a department-wide approver", () => {
  const plan = planRoleChange(1, target({ sectionAssignment: null }), "HOD", NO_WORK);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.ok && plan.update, { role: "HOD", departmentId: 81, sectionId: null });
});

test("HOD refuses a section that is inactive or in another department", () => {
  const inactive = planRoleChange(1, target({ sectionAssignment: { sectionId: 103, sectionActive: false, sectionDepartmentId: 81 } }), "HOD", NO_WORK);
  assert.equal(inactive.ok, false);
  assert.equal(!inactive.ok && inactive.code, "INVALID_HOD_SCOPE");
  const foreign = planRoleChange(1, target({ sectionAssignment: { sectionId: 103, sectionActive: true, sectionDepartmentId: 99 } }), "HOD", NO_WORK);
  assert.equal(!foreign.ok && foreign.code, "INVALID_HOD_SCOPE");
});

test("operational roles need an active linked employee", () => {
  const unlinked = planRoleChange(1, target({ employeeId: null, employee: null }), "SUPERVISOR", NO_WORK);
  assert.equal(!unlinked.ok && unlinked.code, "EMPLOYEE_REQUIRED");
  const inactiveEmployee = planRoleChange(1, target({ role: "SUPERVISOR", employee: { id: 900, active: false, employmentType: "PAYROLL", departmentId: 81 } }), "EMPLOYEE", NO_WORK);
  assert.equal(!inactiveEmployee.ok && inactiveEmployee.code, "EMPLOYEE_INACTIVE");
});

test("an HOD can be scoped to the whole Department explicitly", () => {
  // Employee HAS a Section; the explicit scope must still win (this is how an Admin
  // creates a Department HOD for someone with a Section on their record).
  const plan = planRoleChange(1, target(), "HOD", NO_WORK, { hodScope: "DEPARTMENT" });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.ok && plan.update, { role: "HOD", departmentId: 81, sectionId: null });

  const section = planRoleChange(1, target(), "HOD", NO_WORK, { hodScope: "SECTION" });
  assert.equal(section.ok, true);
  assert.deepEqual(section.ok && section.update, { role: "HOD", departmentId: 81, sectionId: 103 });

  // Omitted -> the existing behaviour: inherit the Section when there is one.
  const inferred = planRoleChange(1, target(), "HOD", NO_WORK);
  assert.equal(inferred.ok, true);
  assert.deepEqual(inferred.ok && inferred.update, { role: "HOD", departmentId: 81, sectionId: 103 });
});

test("an unknown HOD scope is refused rather than guessed", () => {
  const plan = planRoleChange(1, target(), "HOD", NO_WORK, { hodScope: "DIVISION" });
  assert.equal(plan.ok, false);
  assert.equal(!plan.ok && plan.code, "INVALID_HOD_SCOPE");
});

test("a Department Head is department-wide with no Section scope", () => {
  const plan = planRoleChange(1, target(), "DEPT_HEAD", NO_WORK);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.ok && plan.update, { role: "DEPT_HEAD", departmentId: 81, sectionId: null });
});

test("a Department Head still needs an active linked employee", () => {
  const unlinked = planRoleChange(1, target({ employeeId: null, employee: null }), "DEPT_HEAD", NO_WORK);
  assert.equal(!unlinked.ok && unlinked.code, "EMPLOYEE_REQUIRED");
});

test("admin, HR and finance need no employee linkage", () => {
  const unlinked = target({ employeeId: null, employee: null, role: "EMPLOYEE" });
  for (const role of ["ADMIN", "HR", "FINANCE"]) {
    const plan = planRoleChange(1, unlinked, role, NO_WORK);
    assert.equal(plan.ok, true, `${role} should be assignable without an employee`);
    assert.equal(plan.ok && plan.update.role, role);
  }
});

test("an admin cannot change their own role", () => {
  const plan = planRoleChange(7, target({ id: 7, role: "ADMIN", employeeId: null, employee: null }), "SUPERVISOR", NO_WORK);
  assert.equal(plan.ok, false);
  assert.equal(!plan.ok && plan.code, "SELF_ROLE_CHANGE");
});

test("an inactive account or an unknown role is refused", () => {
  assert.equal(!planRoleChange(1, target({ active: false }), "SUPERVISOR", NO_WORK).ok, true);
  const bad = planRoleChange(1, target(), "SUPERVIZOR", NO_WORK);
  assert.equal(!bad.ok && bad.code, "INVALID_ROLE");
  assert.equal(ASSIGNABLE_ROLES.includes("EMPLOYEE"), true);
  assert.equal(ASSIGNABLE_ROLES.includes("DEPT_HEAD"), true);
});

test("work returned for rework, and an untouched approval queue, block a role change", () => {
  const returned = planRoleChange(1, target({ role: "SUPERVISOR" }), "EMPLOYEE", { ...NO_WORK, returnedTimesheetDays: 2 });
  assert.equal(!returned.ok && returned.code, "OPEN_TIMESHEETS");
  const withApprovals = planRoleChange(1, target({ role: "HOD" }), "SUPERVISOR", { ...NO_WORK, pendingApprovals: 3 });
  assert.equal(!withApprovals.ok && withApprovals.code, "OPEN_APPROVALS");
});

test("approved history does not block a move, or nobody with history could be reassigned", () => {
  const plan = planRoleChange(1, target({ role: "SUPERVISOR" }), "HOD", NO_WORK);
  assert.equal(plan.ok, true);
});

test("a no-op change is not written", () => {
  const plan = planRoleChange(1, target({ role: "SUPERVISOR", employeeId: 900 }), "SUPERVISOR", NO_WORK);
  assert.equal(!plan.ok && plan.code, "NO_CHANGE");
});

test("moving an existing HOD from Section to Department is allowed, not a no-op", () => {
  const existingSectionHod = target({ role: "HOD", currentSectionId: 103 });
  const widen = planRoleChange(1, existingSectionHod, "HOD", NO_WORK, { hodScope: "DEPARTMENT" });
  assert.equal(widen.ok, true, "same role, wider scope must go through");
  assert.deepEqual(widen.ok && widen.update, { role: "HOD", departmentId: 81, sectionId: null });

  const narrow = planRoleChange(1, target({ role: "HOD", currentSectionId: null }), "HOD", NO_WORK, { hodScope: "SECTION" });
  assert.equal(narrow.ok, true);
  assert.deepEqual(narrow.ok && narrow.update, { role: "HOD", departmentId: 81, sectionId: 103 });

  // Genuinely identical -> still refused.
  const same = planRoleChange(1, target({ role: "HOD", currentSectionId: 103 }), "HOD", NO_WORK, { hodScope: "SECTION" });
  assert.equal(!same.ok && same.code, "NO_CHANGE");
});
