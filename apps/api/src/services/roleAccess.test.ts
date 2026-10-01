import test from "node:test";
import assert from "node:assert/strict";
import {
  capabilitiesFor,
  canCreatePayrollEmployee,
  departmentScope,
  effectiveOrganisation,
  hodEmployeeScopeSet,
  hodScopeMatches,
  hodScopeMatchesSet,
  landingPathFor,
} from "./roleAccess";

test("requested role capability matrix is enforced", () => {
  assert.deepEqual(
    ["EMPLOYEE", "SUPERVISOR", "HOD", "PM", "ADMIN"].map((role) => [role, capabilitiesFor(role)]),
    [
      ["EMPLOYEE", { selectTeam:false, editTimesheet:false, viewSummary:true, approveTimesheets:false, manageSupervisors:false, manageMasterData:false, manageEmployees:false, uploadEmployees:false, transferEmployees:false, allocateHours:true, assignRoles:false, viewDepartmentSummary:false, manageJobOrderMaster:false, manageJobOrderProgress:false, manageAttendanceHours:false, viewEmployees:false }],
      ["SUPERVISOR", { selectTeam:true, editTimesheet:true, viewSummary:true, approveTimesheets:false, manageSupervisors:false, manageMasterData:false, manageEmployees:false, uploadEmployees:false, transferEmployees:false, allocateHours:true, assignRoles:false, viewDepartmentSummary:false, manageJobOrderMaster:false, manageJobOrderProgress:false, manageAttendanceHours:false, viewEmployees:false }],
      ["HOD", { selectTeam:false, editTimesheet:false, viewSummary:true, approveTimesheets:true, manageSupervisors:false, manageMasterData:false, manageEmployees:true, uploadEmployees:false, transferEmployees:false, allocateHours:true, assignRoles:false, viewDepartmentSummary:true, manageJobOrderMaster:false, manageJobOrderProgress:true, manageAttendanceHours:false, viewEmployees:true }],
      ["PM", { selectTeam:false, editTimesheet:false, viewSummary:true, approveTimesheets:true, manageSupervisors:false, manageMasterData:false, manageEmployees:true, uploadEmployees:false, transferEmployees:true, allocateHours:true, assignRoles:false, viewDepartmentSummary:false, manageJobOrderMaster:true, manageJobOrderProgress:true, manageAttendanceHours:false, viewEmployees:true }],
      ["ADMIN", { selectTeam:true, editTimesheet:true, viewSummary:true, approveTimesheets:true, manageSupervisors:true, manageMasterData:true, manageEmployees:true, uploadEmployees:true, transferEmployees:true, allocateHours:true, assignRoles:true, viewDepartmentSummary:true, manageJobOrderMaster:true, manageJobOrderProgress:true, manageAttendanceHours:true, viewEmployees:true }],
    ]
  );
});

test("department and payroll creation scopes fail closed", () => {
  assert.equal(departmentScope("HOD", null), -1);
  assert.equal(departmentScope("HOD", 7), 7);
  assert.equal(departmentScope("PM", 7), undefined);
  assert.equal(canCreatePayrollEmployee("HOD"), true);
  assert.equal(canCreatePayrollEmployee("SUPERVISOR"), false);
});

test("role landing pages match primary work", () => {
  assert.equal(landingPathFor("EMPLOYEE"), "/allocations");
  assert.equal(landingPathFor("SUPERVISOR"), "/select-team");
  assert.equal(landingPathFor("HOD"), "/approvals");
});

test("a Section HOD matches its own Department AND Section", () => {
  assert.equal(hodScopeMatches(2, 8, 2, 8), true);
  assert.equal(hodScopeMatches(2, 8, 2, 9), false, "another Section of the same Department");
  assert.equal(hodScopeMatches(2, 8, 3, 8), false, "another Department");
});

/**
 * The multi-section Section Head: one person, several Sections of ONE Department.
 * These tests are the contract for the whole feature — the read-side rule every screen uses.
 */
test("a multi-section HOD reaches exactly its own Sections, nothing else", () => {
  assert.equal(hodScopeMatchesSet(4, [8, 42], 4, 8), true);
  assert.equal(hodScopeMatchesSet(4, [8, 42], 4, 42), true);
  assert.equal(hodScopeMatchesSet(4, [8, 42], 4, 9), false, "another Section of the same Department is not theirs");
  assert.equal(hodScopeMatchesSet(4, [8, 42], 21, 8), false, "another Department never matches");
  assert.equal(hodScopeMatchesSet(4, [8, 42], 4, null), false, "an unassigned Section is not one of theirs");
});

test("an EMPTY set still means department-wide, exactly like today's null section", () => {
  for (const resourceSection of [8, 42, 999, null] as (number | null)[]) {
    assert.equal(hodScopeMatchesSet(4, [], 4, resourceSection), true, `dept-wide must cover ${resourceSection}`);
  }
  assert.equal(hodScopeMatchesSet(4, [], 21, 8), false, "still cannot leave the Department");
});

test("no Department matches nothing at all, whatever the section set says", () => {
  for (const sections of [[], [8], [8, 42]]) {
    assert.equal(hodScopeMatchesSet(null, sections, 4, 8), false);
  }
});

test("the employee filter narrows by Section, and drops the filter when department-wide", () => {
  assert.deepEqual(hodEmployeeScopeSet(4, [8, 42]), { departmentId: 4, sectionAssignment: { sectionId: { in: [8, 42] } } });
  // EMPTY means the whole Department, so NO section filter is applied — this is the difference
  // between "every Section" and "no Section", and getting it backwards hides or leaks rows.
  assert.deepEqual(hodEmployeeScopeSet(4, []), { departmentId: 4 });
  assert.deepEqual(hodEmployeeScopeSet(null, [8]), { id: -1 }, "no Department matches nothing");
});

test("a Department HOD (no Section) matches every Section of its Department", () => {
  assert.equal(hodScopeMatches(2, null, 2, 8), true);
  assert.equal(hodScopeMatches(2, null, 2, 9), true, "other Sections are in scope");
  assert.equal(hodScopeMatches(2, null, 2, null), true, "unassigned Section still in the Department");
  assert.equal(hodScopeMatches(2, null, 3, 8), false, "never crosses into another Department");
  assert.equal(hodScopeMatches(null, null, 2, 8), false, "an approver with no Department matches nothing");
});

test("the Department Head is oversight-only, and HOD keeps approval rights", () => {
  assert.equal(capabilitiesFor("DEPT_HEAD").viewSummary, true);
  assert.equal(capabilitiesFor("DEPT_HEAD").viewDepartmentSummary, true);
  assert.equal(capabilitiesFor("DEPT_HEAD").approveTimesheets, false);
  assert.equal(capabilitiesFor("DEPT_HEAD").manageEmployees, false);
  assert.equal(capabilitiesFor("HOD").approveTimesheets, true);
  assert.equal(capabilitiesFor("HOD").viewDepartmentSummary, true);
  assert.equal(capabilitiesFor("SUPERVISOR").viewDepartmentSummary, false);
  assert.equal(landingPathFor("DEPT_HEAD"), "/summary");
  assert.equal(landingPathFor("HOD"), "/approvals");
});

test("manual organisation mapping wins over the LabourWorks source", () => {
  assert.deepEqual(effectiveOrganisation(1, 10, null), { departmentId: 1, sectionId: 10, overridden: false });
  assert.deepEqual(effectiveOrganisation(1, 10, { departmentId: 2, sectionId: 20 }), { departmentId: 2, sectionId: 20, overridden: true });
  assert.equal(capabilitiesFor("PM").transferEmployees, true);
  assert.equal(capabilitiesFor("HOD").transferEmployees, false);
  // Only an Admin may assign roles.
  assert.equal(capabilitiesFor("ADMIN").assignRoles, true);
  assert.equal(capabilitiesFor("HR").assignRoles, false);
  assert.equal(capabilitiesFor("SUPERVISOR").assignRoles, false);
});
