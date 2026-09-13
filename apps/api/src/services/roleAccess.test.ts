import test from "node:test";
import assert from "node:assert/strict";
import { capabilitiesFor, canCreatePayrollEmployee, departmentScope, effectiveOrganisation, hodScopeMatches, landingPathFor } from "./roleAccess";

test("requested role capability matrix is enforced", () => {
  assert.deepEqual(
    ["EMPLOYEE", "SUPERVISOR", "HOD", "PM", "ADMIN"].map((role) => [role, capabilitiesFor(role)]),
    [
      ["EMPLOYEE", { selectTeam:false, editTimesheet:false, viewSummary:true, approveTimesheets:false, manageSupervisors:false, manageMasterData:false, manageEmployees:false, uploadEmployees:false, transferEmployees:false, allocateHours:true }],
      ["SUPERVISOR", { selectTeam:true, editTimesheet:true, viewSummary:true, approveTimesheets:false, manageSupervisors:false, manageMasterData:false, manageEmployees:false, uploadEmployees:false, transferEmployees:false, allocateHours:true }],
      ["HOD", { selectTeam:false, editTimesheet:false, viewSummary:true, approveTimesheets:true, manageSupervisors:false, manageMasterData:false, manageEmployees:true, uploadEmployees:false, transferEmployees:false, allocateHours:true }],
      ["PM", { selectTeam:false, editTimesheet:false, viewSummary:true, approveTimesheets:true, manageSupervisors:false, manageMasterData:false, manageEmployees:true, uploadEmployees:false, transferEmployees:true, allocateHours:true }],
      ["ADMIN", { selectTeam:true, editTimesheet:true, viewSummary:true, approveTimesheets:true, manageSupervisors:true, manageMasterData:true, manageEmployees:true, uploadEmployees:true, transferEmployees:true, allocateHours:true }],
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

test("HOD scope requires both matching Department and Section", () => {
  assert.equal(hodScopeMatches(2, 8, 2, 8), true);
  assert.equal(hodScopeMatches(2, 8, 2, 9), false);
  assert.equal(hodScopeMatches(2, 8, 3, 8), false);
  assert.equal(hodScopeMatches(2, null, 2, 8), false);
});

test("manual organisation mapping wins over the LabourWorks source", () => {
  assert.deepEqual(effectiveOrganisation(1, 10, null), { departmentId: 1, sectionId: 10, overridden: false });
  assert.deepEqual(effectiveOrganisation(1, 10, { departmentId: 2, sectionId: 20 }), { departmentId: 2, sectionId: 20, overridden: true });
  assert.equal(capabilitiesFor("PM").transferEmployees, true);
  assert.equal(capabilitiesFor("HOD").transferEmployees, false);
});
