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
  intersectDepartmentFilter,
  landingPathFor,
  reportScopeFor,
} from "./roleAccess";
import { usesEcNoLogin } from "./defaultLoginCredentials";

/**
 * Every capability that changes data or starts a workflow. The COO must have NONE of them —
 * listing them here (rather than spot-checking a few) is what makes the read-only promise
 * auditable: a new mutating flag added to `CapabilityMap` fails this test until it is listed
 * here and confirmed false for the COO.
 */
const MUTATING_CAPABILITIES = [
  "selectTeam",
  "editTimesheet",
  "approveTimesheets",
  "manageSupervisors",
  "manageMasterData",
  "manageEmployees",
  "uploadEmployees",
  "transferEmployees",
  "allocateHours",
  "assignRoles",
  "manageJobOrderMaster",
  "manageJobOrderProgress",
  "manageAttendanceHours",
] as const;

test("requested role capability matrix is enforced", () => {
  assert.deepEqual(
    ["EMPLOYEE", "SUPERVISOR", "HOD", "PM", "ADMIN"].map((role) => [role, capabilitiesFor(role)]),
    [
      ["EMPLOYEE", { selectTeam:false, editTimesheet:false, viewSummary:true, approveTimesheets:false, manageSupervisors:false, manageMasterData:false, manageEmployees:false, uploadEmployees:false, transferEmployees:false, allocateHours:true, assignRoles:false, viewDepartmentSummary:false, manageJobOrderMaster:false, manageJobOrderProgress:false, manageAttendanceHours:false, viewEmployees:false, viewPortfolioDashboard:false }],
      ["SUPERVISOR", { selectTeam:true, editTimesheet:true, viewSummary:true, approveTimesheets:false, manageSupervisors:false, manageMasterData:false, manageEmployees:false, uploadEmployees:false, transferEmployees:false, allocateHours:true, assignRoles:false, viewDepartmentSummary:false, manageJobOrderMaster:false, manageJobOrderProgress:false, manageAttendanceHours:false, viewEmployees:false, viewPortfolioDashboard:false }],
      ["HOD", { selectTeam:false, editTimesheet:false, viewSummary:true, approveTimesheets:true, manageSupervisors:false, manageMasterData:false, manageEmployees:true, uploadEmployees:false, transferEmployees:false, allocateHours:true, assignRoles:false, viewDepartmentSummary:true, manageJobOrderMaster:false, manageJobOrderProgress:true, manageAttendanceHours:false, viewEmployees:true, viewPortfolioDashboard:true }],
      ["PM", { selectTeam:false, editTimesheet:false, viewSummary:true, approveTimesheets:true, manageSupervisors:false, manageMasterData:false, manageEmployees:true, uploadEmployees:false, transferEmployees:true, allocateHours:true, assignRoles:false, viewDepartmentSummary:false, manageJobOrderMaster:true, manageJobOrderProgress:true, manageAttendanceHours:false, viewEmployees:true, viewPortfolioDashboard:true }],
      ["ADMIN", { selectTeam:true, editTimesheet:true, viewSummary:true, approveTimesheets:true, manageSupervisors:true, manageMasterData:true, manageEmployees:true, uploadEmployees:true, transferEmployees:true, allocateHours:true, assignRoles:true, viewDepartmentSummary:true, manageJobOrderMaster:true, manageJobOrderProgress:true, manageAttendanceHours:true, viewEmployees:true, viewPortfolioDashboard:true }],
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

/**
 * The COO is the audited role from the portfolio plan: an organisation-wide READ-ONLY
 * oversight login that lands on the operations dashboard. Every mutating capability must be
 * false — a single stray `true` would let the dashboard become an approvals screen.
 */
test("the COO is a read-only organisation-wide role that lands on the portfolio", () => {
  const coo = capabilitiesFor("COO");
  assert.equal(coo.viewPortfolioDashboard, true, "the COO's whole reason for existing");
  assert.equal(coo.viewSummary, true);
  for (const capability of MUTATING_CAPABILITIES) {
    assert.equal(coo[capability], false, `COO must not be able to ${capability}`);
  }
  assert.equal(coo.viewEmployees, false, "COO reads the dashboard, not the employee register");
  assert.equal(landingPathFor("COO"), "/portfolio");
  // Organisation-wide read: never narrowed to a single Department (compare every other role,
  // which DO narrow when a Department is present).
  assert.equal(departmentScope("COO", 4), undefined);
  assert.equal(departmentScope("COO", null), undefined);
});

test("the portfolio dashboard capability belongs to the oversight roles only", () => {
  // Organisation-wide readers AND the Department-scoped heads may OPEN the dashboard. For the
  // heads the capability is only the DOOR: the SCOPE they then read is their own Department,
  // applied server-side (`reportScopeFor`) — asserting the capability alone would miss that.
  for (const role of ["PM", "ADMIN", "COO", "HOD", "DEPT_HEAD"]) {
    assert.equal(capabilitiesFor(role).viewPortfolioDashboard, true, `${role} sees the portfolio`);
  }
  for (const role of ["EMPLOYEE", "SUPERVISOR", "HR", "FINANCE"]) {
    assert.equal(capabilitiesFor(role).viewPortfolioDashboard, false, `${role} must not see the portfolio`);
  }
});

/* ------------------------------------------------------------------ *
 * The report SCOPE helper — the pure decision the loader applies
 * ------------------------------------------------------------------ */

test("reportScopeFor: the organisation roles read everything, the heads read their one Department", () => {
  for (const role of ["PM", "ADMIN", "COO"]) {
    assert.deepEqual(reportScopeFor(role, 4), { kind: "ORGANISATION" }, `${role} is organisation-wide`);
    assert.deepEqual(reportScopeFor(role, null), { kind: "ORGANISATION" }, `${role} needs no Department`);
  }
  // HOD (both shapes) and DEPT_HEAD: the Department is the scope, the Section is irrelevant.
  assert.deepEqual(reportScopeFor("HOD", 4), { kind: "DEPARTMENT", departmentId: 4 });
  assert.deepEqual(reportScopeFor("DEPT_HEAD", 4), { kind: "DEPARTMENT", departmentId: 4 });
});

test("reportScopeFor fails closed: a head with NO Department reads NOTHING, never the portfolio", () => {
  // The leak this guards: Prisma treats an EMPTY `where` object as EVERY row, so a missing
  // Department must resolve to an explicit zero-row scope, never to "no filter".
  assert.deepEqual(reportScopeFor("HOD", null), { kind: "NONE" }, "unmapped HOD -> nothing");
  assert.deepEqual(reportScopeFor("DEPT_HEAD", null), { kind: "NONE" }, "unmapped Dept Head -> nothing");
});

test("reportScopeFor: a non-account role is NONE, the second lock behind the router gate", () => {
  // SUPERVISOR/EMPLOYEE/HR/FINANCE are refused at the reports router; if a caller somehow reached
  // the loader directly they must read nothing rather than the whole organisation.
  for (const role of ["SUPERVISOR", "EMPLOYEE", "HR", "FINANCE", "UNKNOWN"]) {
    assert.deepEqual(reportScopeFor(role, 4), { kind: "NONE" }, `${role} must read nothing`);
  }
});

test("intersectDepartmentFilter INTERSECTS the request with the actor's scope, never trusts it", () => {
  const org = reportScopeFor("PM", 4);
  const dept4 = reportScopeFor("HOD", 4);
  const none = reportScopeFor("HOD", null);

  // ORGANISATION: the request flows through unchanged (the actor's scope imposes no narrowing).
  assert.deepEqual(intersectDepartmentFilter(org, [9]), [9], "organisation + single request -> that request passes straight through");
  assert.equal(intersectDepartmentFilter(org, null), null, "organisation + no request -> no filter at all");

  // DEPARTMENT: the HOD asking for ANOTHER department gets an EMPTY intersection -> zero rows.
  assert.deepEqual(
    intersectDepartmentFilter(dept4, [9]),
    [],
    "HOD(4) asking for 9 must intersect to the empty set, NOT be trusted with 9"
  );
  // Asking for his own Department narrows to exactly his Department.
  assert.deepEqual(intersectDepartmentFilter(dept4, [4]), [4]);
  // Asking for his own AND another keeps only his own.
  assert.deepEqual(intersectDepartmentFilter(dept4, [4, 9]), [4], "the foreign id is dropped, never added");
  // No request at all -> his whole Department (NOT null, which would mean 'everything').
  assert.deepEqual(intersectDepartmentFilter(dept4, null), [4], "no request means his Department, never the organisation");

  // NONE: always the empty set, whatever was asked for.
  assert.deepEqual(intersectDepartmentFilter(none, [4]), []);
  assert.deepEqual(intersectDepartmentFilter(none, null), []);
});

/**
 * THE account-lockout test. `usesEcNoLogin` decides whether a linked Employee makes an account
 * sign in by EC No. A COO has no linked Employee, but if COO were ever added to that list the
 * login route would take the ecNo branch only and an e-mail sign-in would 401 despite the account
 * existing — the exact way a new role has silently locked itself out before.
 */
test("the COO signs in by e-mail, never by EC No", () => {
  assert.equal(usesEcNoLogin("COO", 5), false);
  assert.equal(usesEcNoLogin("COO", null), false);
});
