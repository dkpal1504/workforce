import test from "node:test";
import assert from "node:assert/strict";
import {
  ASSIGNABLE_ROLES,
  creatableRolesFor,
  planRoleChange,
  refusalForRoleCreation,
  roleTargetForNewAccount,
  type OpenWorkload,
  type RoleSourceEmployee,
  type RoleTarget,
} from "./roleAssignment";

const NO_WORK: OpenWorkload = { returnedTimesheetDays: 0, pendingApprovals: 0 };

/** An active payroll Employee with a Section — the ordinary case. */
function payrollEmployee(overrides: Partial<RoleSourceEmployee> = {}): RoleSourceEmployee {
  return { id: 900, ecNo: "40031988", name: "Payroll Person", active: true, employmentType: "PAYROLL", departmentId: 81, ...overrides };
}

/** An active contract (blue-collar) Employee — the population Role Assignment used to hide. */
function contractEmployee(overrides: Partial<RoleSourceEmployee> = {}): RoleSourceEmployee {
  return { id: 501, ecNo: "FRNEGJ115", name: "Contract Worker", active: true, employmentType: "CLMS", departmentId: 77, ...overrides };
}

/**
 * A RoleTarget. The current scope is DERIVED from `currentSectionId` unless a test states the
 * set explicitly: an account stored as department-wide (`currentSectionId: null`) heads NO
 * section, and a fixture carrying both `null` and `[103]` would be asserting two contradictory
 * things about the same account.
 */
function target(overrides: Partial<RoleTarget> = {}): RoleTarget {
  const merged: RoleTarget = {
    id: 50,
    name: "Test Person",
    role: "EMPLOYEE",
    active: true,
    currentSectionId: null,
    currentSectionIds: [],
    employeeId: 900,
    employee: { id: 900, active: true, employmentType: "PAYROLL", departmentId: 81 },
    sectionAssignment: { sectionId: 103, sectionActive: true, sectionDepartmentId: 81 },
    ...overrides,
  };
  if (overrides.currentSectionIds === undefined) {
    merged.currentSectionIds = merged.currentSectionId == null ? [] : [merged.currentSectionId];
  }
  return merged;
}

/**
 * The candidate Sections a route loads for Department 81: the two an Admin would tick, plus a
 * Section of ANOTHER Department and an inactive one, so the refusals have something to catch.
 */
const HOD_DEPT_SECTIONS = [
  { id: 103, departmentId: 81, active: true },
  { id: 210, departmentId: 81, active: true },
  { id: 999, departmentId: 77, active: true },
  { id: 511, departmentId: 81, active: false },
];

test("an admin can give a payroll employee the supervisor role, scoped to the employee department", () => {
  const plan = planRoleChange(1, target(), "SUPERVISOR", NO_WORK);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.ok && plan.update, { role: "SUPERVISOR", departmentId: 81, sectionIds: [], sectionId: null });
});

test("a contract (CLMS) linked employee is equally assignable", () => {
  const plan = planRoleChange(1, target({ employee: { id: 900, active: true, employmentType: "CLMS", departmentId: 77 } }), "SUPERVISOR", NO_WORK);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.ok && plan.update, { role: "SUPERVISOR", departmentId: 77, sectionIds: [], sectionId: null });
});

test("HOD takes Department and Section from the employee mapping, never from the request", () => {
  const plan = planRoleChange(1, target(), "HOD", NO_WORK);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.ok && plan.update, { role: "HOD", departmentId: 81, sectionIds: [103], sectionId: 103 });
});

test("HOD is allowed with no section assignment, as a department-wide approver", () => {
  const plan = planRoleChange(1, target({ sectionAssignment: null }), "HOD", NO_WORK);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.ok && plan.update, { role: "HOD", departmentId: 81, sectionIds: [], sectionId: null });
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
  assert.deepEqual(plan.ok && plan.update, { role: "HOD", departmentId: 81, sectionIds: [], sectionId: null });

  const section = planRoleChange(1, target(), "HOD", NO_WORK, { hodScope: "SECTION" });
  assert.equal(section.ok, true);
  assert.deepEqual(section.ok && section.update, { role: "HOD", departmentId: 81, sectionIds: [103], sectionId: 103 });

  // Omitted -> the existing behaviour: inherit the Section when there is one.
  const inferred = planRoleChange(1, target(), "HOD", NO_WORK);
  assert.equal(inferred.ok, true);
  assert.deepEqual(inferred.ok && inferred.update, { role: "HOD", departmentId: 81, sectionIds: [103], sectionId: 103 });
});

test("an unknown HOD scope is refused rather than guessed", () => {
  const plan = planRoleChange(1, target(), "HOD", NO_WORK, { hodScope: "DIVISION" });
  assert.equal(plan.ok, false);
  assert.equal(!plan.ok && plan.code, "INVALID_HOD_SCOPE");
});

/**
 * The reported bug: Role Assignment listed only the 36 people who already had a login, so a
 * blue-collar (contract) Employee could not be picked at all. These tests pin the two rules
 * that let a contract worker become a Supervisor WITHOUT opening the approver roles to them.
 */
test("a contract worker with no account can be created as a Supervisor or an Employee", () => {
  const worker = contractEmployee();
  assert.deepEqual(creatableRolesFor(worker), ["EMPLOYEE", "SUPERVISOR"]);
  assert.equal(refusalForRoleCreation(worker, "SUPERVISOR"), null);
  assert.equal(refusalForRoleCreation(worker, "EMPLOYEE"), null);
});

test("supervisor scope for a contract worker comes from the Employee record, not the request", () => {
  const plan = planRoleChange(1, roleTargetForNewAccount(contractEmployee(), { sectionId: 210, sectionActive: true, sectionDepartmentId: 77 }), "SUPERVISOR", NO_WORK);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.ok && plan.update, { role: "SUPERVISOR", departmentId: 77, sectionIds: [], sectionId: null });
});

test("a contract worker is refused the approver roles with the reason, not silently dropped", () => {
  const worker = contractEmployee();
  for (const role of ["HOD", "DEPT_HEAD"]) {
    const refusal = refusalForRoleCreation(worker, role);
    assert.equal(refusal?.code, "ROLE_REQUIRES_PAYROLL_EMPLOYEE", `${role} must be payroll-only`);
    assert.match(refusal!.error, /contract labour/i);
  }
});

test("organisation-wide roles are never created from an Employee record", () => {
  for (const role of ["PM", "HR", "FINANCE", "ADMIN"]) {
    for (const employee of [payrollEmployee(), contractEmployee()]) {
      const refusal = refusalForRoleCreation(employee, role);
      assert.equal(refusal?.code, "ROLE_NOT_CREATABLE_FOR_EMPLOYEE", `${role} is not an Employee role`);
      assert.match(refusal!.error, /Create the account first/);
    }
  }
});

test("a payroll Employee can be created as HOD / Department Head, still using the shared scope rules", () => {
  const employee = payrollEmployee();
  assert.equal(refusalForRoleCreation(employee, "HOD"), null);
  assert.equal(refusalForRoleCreation(employee, "DEPT_HEAD"), null);

  const asHod = planRoleChange(1, roleTargetForNewAccount(employee, { sectionId: 103, sectionActive: true, sectionDepartmentId: 81 }), "HOD", NO_WORK);
  assert.equal(asHod.ok, true);
  assert.deepEqual(asHod.ok && asHod.update, { role: "HOD", departmentId: 81, sectionIds: [103], sectionId: 103 });

  const asDepartmentHod = planRoleChange(1, roleTargetForNewAccount(employee, null), "HOD", NO_WORK);
  assert.equal(asDepartmentHod.ok, true);
  assert.deepEqual(asDepartmentHod.ok && asDepartmentHod.update, { role: "HOD", departmentId: 81, sectionIds: [], sectionId: null });

  const asHead = planRoleChange(1, roleTargetForNewAccount(employee, null), "DEPT_HEAD", NO_WORK);
  assert.equal(asHead.ok, true);
  assert.deepEqual(asHead.ok && asHead.update, { role: "DEPT_HEAD", departmentId: 81, sectionIds: [], sectionId: null });
});

test("a newly created account is never the Admin's own account, whatever the Employee id", () => {
  // The synthetic target id is negative so it cannot collide with a real User id: the Admin
  // must never hit the SELF_ROLE_CHANGE guard by picking Employee #1.
  const actorId = 1;
  const plan = planRoleChange(actorId, roleTargetForNewAccount(contractEmployee({ id: 1 }), null), "SUPERVISOR", NO_WORK);
  assert.equal(plan.ok, true);
  assert.notEqual(roleTargetForNewAccount(contractEmployee({ id: 1 }), null).id, actorId);
});

test("the first assignment onto an Employee record has no current role, so nothing reads as a no-op", () => {
  const created = roleTargetForNewAccount(contractEmployee(), null);
  assert.equal(created.role, "NONE");
  assert.equal(created.employeeId, 501);
  assert.equal(created.employee?.employmentType, "CLMS");
});

test("an inactive or EC-No-less Employee cannot have a login created", () => {
  assert.equal(refusalForRoleCreation(contractEmployee({ active: false }), "SUPERVISOR")?.code, "EMPLOYEE_INACTIVE");
  assert.equal(refusalForRoleCreation(contractEmployee({ ecNo: null }), "SUPERVISOR")?.code, "EMPLOYEE_ECNO_REQUIRED");
  assert.deepEqual(creatableRolesFor(contractEmployee({ active: false })), []);
  assert.deepEqual(creatableRolesFor(payrollEmployee({ ecNo: "" })), []);
});

test("an unknown role is refused before any Employee rule is applied", () => {
  const refusal = refusalForRoleCreation(contractEmployee(), "SUPERVIZOR");
  assert.equal(refusal?.code, "INVALID_ROLE");
});

test("a Department Head is department-wide with no Section scope", () => {
  const plan = planRoleChange(1, target(), "DEPT_HEAD", NO_WORK);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.ok && plan.update, { role: "DEPT_HEAD", departmentId: 81, sectionIds: [], sectionId: null });
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

/**
 * The COO is an organisation-wide login exactly like ADMIN/HR/FINANCE: it reports on the whole
 * portfolio rather than acting for one person, so it must NOT be in EMPLOYEE_LINKED_ROLES and
 * must need no Employee record. Moving an account TO and FROM COO must both plan cleanly.
 */
test("the COO is assignable without an Employee, from and to", () => {
  const unlinked = target({ employeeId: null, employee: null, role: "PM" });
  const toCoo = planRoleChange(1, unlinked, "COO", NO_WORK);
  assert.equal(toCoo.ok, true, "an account with no Employee can become the COO");
  assert.deepEqual(toCoo.ok && toCoo.update, { role: "COO", departmentId: null, sectionIds: [], sectionId: null });

  // A linked Employee moving OFF a payroll role onto COO keeps its Department as a display
  // fact but takes NO Section scope (a COO is organisation-wide, never narrowed).
  const linked = target({ role: "HOD", employeeId: 900 });
  const fromLinked = planRoleChange(1, linked, "COO", NO_WORK);
  assert.equal(fromLinked.ok, true, "an HOD can be re-roled to COO");
  assert.deepEqual(fromLinked.ok && fromLinked.update, { role: "COO", departmentId: 81, sectionIds: [], sectionId: null });

  // FROM COO: the move back out plans from the COO role itself, not just onto it.
  const asCoo = planRoleChange(1, target({ role: "COO", employeeId: null, employee: null }), "ADMIN", NO_WORK);
  assert.equal(asCoo.ok, true, "a COO can be moved off COO");
  assert.equal(asCoo.ok && asCoo.update.role, "ADMIN");

  assert.equal(ASSIGNABLE_ROLES.includes("COO"), true);
});

test("the COO is never created from an Employee record", () => {
  // Like PM/HR/FINANCE the COO is an organisation-wide account, so it is not one of the roles
  // an Employee can be promoted into from the listing: the account is created first, then
  // re-roled to COO. This keeps the payroll-only approver rules out of reach of the COO.
  for (const employee of [payrollEmployee(), contractEmployee()]) {
    const refusal = refusalForRoleCreation(employee, "COO");
    assert.equal(refusal?.code, "ROLE_NOT_CREATABLE_FOR_EMPLOYEE");
    assert.match(refusal!.error, /Create the account first/);
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
  assert.deepEqual(widen.ok && widen.update, { role: "HOD", departmentId: 81, sectionIds: [], sectionId: null });

  const narrow = planRoleChange(1, target({ role: "HOD", currentSectionId: null }), "HOD", NO_WORK, { hodScope: "SECTION" });
  assert.equal(narrow.ok, true);
  assert.deepEqual(narrow.ok && narrow.update, { role: "HOD", departmentId: 81, sectionIds: [103], sectionId: 103 });

  // Genuinely identical -> still refused.
  const same = planRoleChange(1, target({ role: "HOD", currentSectionId: 103 }), "HOD", NO_WORK, { hodScope: "SECTION" });
  assert.equal(!same.ok && same.code, "NO_CHANGE");
});

// --- the multi-Section Section Head: one payroll employee heading several Sections ---

test("an HOD scope is a SET of sections of the same department", () => {
  const plan = planRoleChange(1, target(), "HOD", NO_WORK, { sections: HOD_DEPT_SECTIONS, sectionIds: [103, 210] });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.ok && plan.update, {
    role: "HOD",
    departmentId: 81,
    sectionIds: [103, 210],
    sectionId: 103, // the legacy mirror is the FIRST section, so an un-converted caller agrees
  });
});

test("an EMPTY section set is department-wide, unchanged from the null scalar", () => {
  const plan = planRoleChange(1, target(), "HOD", NO_WORK, { sections: HOD_DEPT_SECTIONS, sectionIds: [] });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.ok && plan.update, { role: "HOD", departmentId: 81, sectionIds: [], sectionId: null });
});

test("a Section Head may be WIDENED from one section to two, and is not a no-op", () => {
  const hod = target({ role: "HOD", currentSectionId: 103, currentSectionIds: [103] });
  const plan = planRoleChange(1, hod, "HOD", NO_WORK, { sections: HOD_DEPT_SECTIONS, sectionIds: [103, 210] });
  assert.equal(plan.ok, true, "same role, wider SET must go through");
  assert.deepEqual(plan.ok && plan.update, { role: "HOD", departmentId: 81, sectionIds: [103, 210], sectionId: 103 });
});

test("a Section Head may be NARROWED to one of several sections", () => {
  const hod = target({ role: "HOD", currentSectionId: 103, currentSectionIds: [103, 210] });
  const plan = planRoleChange(1, hod, "HOD", NO_WORK, { sections: HOD_DEPT_SECTIONS, sectionIds: [210] });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.ok && plan.update, { role: "HOD", departmentId: 81, sectionIds: [210], sectionId: 210 });
});

test("a department-wide HOD may be narrowed to a set of sections", () => {
  const deptHod = target({ role: "HOD", currentSectionId: null, currentSectionIds: [] });
  const plan = planRoleChange(1, deptHod, "HOD", NO_WORK, { sections: HOD_DEPT_SECTIONS, sectionIds: [103, 210] });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.ok && plan.update, { role: "HOD", departmentId: 81, sectionIds: [103, 210], sectionId: 103 });
});

test("the SAME set is still a no-op, so an unmoved scope is never rewritten", () => {
  const hod = target({ role: "HOD", currentSectionId: 103, currentSectionIds: [103, 210] });
  const plan = planRoleChange(1, hod, "HOD", NO_WORK, { sections: HOD_DEPT_SECTIONS, sectionIds: [103, 210] });
  assert.equal(!plan.ok && plan.code, "NO_CHANGE");
});

test("the order of the requested sections does not change the outcome", () => {
  const plan = planRoleChange(1, target(), "HOD", NO_WORK, { sections: HOD_DEPT_SECTIONS, sectionIds: [210, 103, 210] });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.ok && plan.update, { role: "HOD", departmentId: 81, sectionIds: [103, 210], sectionId: 103 });
});

test("a section outside the Employee department is refused, naming the reason", () => {
  const plan = planRoleChange(1, target(), "HOD", NO_WORK, { sections: HOD_DEPT_SECTIONS, sectionIds: [103, 999] });
  assert.equal(!plan.ok && plan.code, "SECTION_NOT_IN_DEPARTMENT");
  assert.match((!plan.ok && plan.error) || "", /another Department/i);
});

test("a section set with no department to scope it is refused", () => {
  const noDept = target({ employee: { id: 900, active: true, employmentType: "PAYROLL", departmentId: null as unknown as number } });
  const plan = planRoleChange(1, noDept, "HOD", NO_WORK, { sections: HOD_DEPT_SECTIONS, sectionIds: [103] });
  // The refusal names the cause that applies FIRST: the Employee has no Department to scope the
  // set to, which is a mapping to correct, not a missing Section.
  assert.equal(!plan.ok && plan.code, "INVALID_HOD_SCOPE");
});

test("the deprecated hodScope alias still works for one release", () => {
  const dept = planRoleChange(1, target(), "HOD", NO_WORK, { hodScope: "DEPARTMENT" });
  assert.deepEqual(dept.ok && dept.update, { role: "HOD", departmentId: 81, sectionIds: [], sectionId: null });
  const section = planRoleChange(1, target(), "HOD", NO_WORK, { hodScope: "SECTION" });
  assert.deepEqual(section.ok && section.update, { role: "HOD", departmentId: 81, sectionIds: [103], sectionId: 103 });
});

test("a non-HOD role ignores the section set entirely", () => {
  const plan = planRoleChange(1, target(), "SUPERVISOR", NO_WORK, { sections: HOD_DEPT_SECTIONS, sectionIds: [103, 210] });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.ok && plan.update, { role: "SUPERVISOR", departmentId: 81, sectionIds: [], sectionId: null });
});
