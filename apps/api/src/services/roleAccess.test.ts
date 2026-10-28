import test from "node:test";
import assert from "node:assert/strict";
import {
  canUseMyHours,
  capabilitiesFor,
  canCreatePayrollEmployee,
  departmentScope,
  effectiveOrganisation,
  hodEmployeeScopeSet,
  hodScopeMatches,
  hodScopeMatchesSet,
  intersectDepartmentFilter,
  intersectProjectFilter,
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
  "manageProjectManagers",
] as const;

test("requested role capability matrix is enforced", () => {
  assert.deepEqual(
    ["EMPLOYEE", "SUPERVISOR", "HOD", "PM", "PROJECT_MANAGER", "ADMIN"].map((role) => [role, capabilitiesFor(role, "PAYROLL")]),
    [
      ["EMPLOYEE", { selectTeam:false, editTimesheet:false, viewSummary:true, approveTimesheets:false, manageSupervisors:false, manageMasterData:false, manageEmployees:false, uploadEmployees:false, transferEmployees:false, allocateHours:true, assignRoles:false, viewDepartmentSummary:false, manageJobOrderMaster:false, manageJobOrderProgress:false, manageAttendanceHours:false, viewEmployees:false, viewPortfolioDashboard:false, manageProjectManagers:false, viewTimesheetCoverage:false, viewConversations:false, viewProjectReview:false, runProjectReview:false }],
      ["SUPERVISOR", { selectTeam:true, editTimesheet:true, viewSummary:true, approveTimesheets:false, manageSupervisors:false, manageMasterData:false, manageEmployees:false, uploadEmployees:false, transferEmployees:false, allocateHours:true, assignRoles:false, viewDepartmentSummary:false, manageJobOrderMaster:false, manageJobOrderProgress:false, manageAttendanceHours:false, viewEmployees:false, viewPortfolioDashboard:false, manageProjectManagers:false, viewTimesheetCoverage:false, viewConversations:false, viewProjectReview:false, runProjectReview:false }],
      ["HOD", { selectTeam:false, editTimesheet:false, viewSummary:true, approveTimesheets:true, manageSupervisors:false, manageMasterData:false, manageEmployees:true, uploadEmployees:false, transferEmployees:false, allocateHours:true, assignRoles:false, viewDepartmentSummary:true, manageJobOrderMaster:false, manageJobOrderProgress:true, manageAttendanceHours:false, viewEmployees:true, viewPortfolioDashboard:true, manageProjectManagers:false, viewTimesheetCoverage:true, viewConversations:true, viewProjectReview:true, runProjectReview:false }],
      ["PM", { selectTeam:false, editTimesheet:false, viewSummary:true, approveTimesheets:true, manageSupervisors:false, manageMasterData:false, manageEmployees:true, uploadEmployees:false, transferEmployees:true, allocateHours:true, assignRoles:false, viewDepartmentSummary:false, manageJobOrderMaster:true, manageJobOrderProgress:true, manageAttendanceHours:false, viewEmployees:true, viewPortfolioDashboard:true, manageProjectManagers:false, viewTimesheetCoverage:true, viewConversations:true, viewProjectReview:true, runProjectReview:true }],
      // The Project Manager: read-only, ONE screen and its reports. Every mutating flag is false,
      // `viewSummary` is false (the Summary router does not admit the role, so a nav link there
      // would be a 403), and the coverage report is out because its row set is an employee roster
      // a project scope cannot define.
      ["PROJECT_MANAGER", { selectTeam:false, editTimesheet:false, viewSummary:false, approveTimesheets:false, manageSupervisors:false, manageMasterData:false, manageEmployees:false, uploadEmployees:false, transferEmployees:false, allocateHours:true, assignRoles:false, viewDepartmentSummary:false, manageJobOrderMaster:false, manageJobOrderProgress:false, manageAttendanceHours:false, viewEmployees:false, viewPortfolioDashboard:true, manageProjectManagers:false, viewTimesheetCoverage:false, viewConversations:true, viewProjectReview:true, runProjectReview:false }],
      ["ADMIN", { selectTeam:true, editTimesheet:true, viewSummary:true, approveTimesheets:true, manageSupervisors:true, manageMasterData:true, manageEmployees:true, uploadEmployees:true, transferEmployees:true, allocateHours:true, assignRoles:true, viewDepartmentSummary:true, manageJobOrderMaster:true, manageJobOrderProgress:true, manageAttendanceHours:true, viewEmployees:true, viewPortfolioDashboard:true, manageProjectManagers:true, viewTimesheetCoverage:true, viewConversations:true, viewProjectReview:true, runProjectReview:true }],
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
  assert.equal(capabilitiesFor("DEPT_HEAD", "PAYROLL").viewSummary, true);
  assert.equal(capabilitiesFor("DEPT_HEAD", "PAYROLL").viewDepartmentSummary, true);
  assert.equal(capabilitiesFor("DEPT_HEAD", "PAYROLL").approveTimesheets, false);
  assert.equal(capabilitiesFor("DEPT_HEAD", "PAYROLL").manageEmployees, false);
  assert.equal(capabilitiesFor("HOD", "PAYROLL").approveTimesheets, true);
  assert.equal(capabilitiesFor("HOD", "PAYROLL").viewDepartmentSummary, true);
  assert.equal(capabilitiesFor("SUPERVISOR", "PAYROLL").viewDepartmentSummary, false);
  assert.equal(landingPathFor("DEPT_HEAD"), "/summary");
  assert.equal(landingPathFor("HOD"), "/approvals");
});

test("manual organisation mapping wins over the LabourWorks source", () => {
  assert.deepEqual(effectiveOrganisation(1, 10, null), { departmentId: 1, sectionId: 10, overridden: false });
  assert.deepEqual(effectiveOrganisation(1, 10, { departmentId: 2, sectionId: 20 }), { departmentId: 2, sectionId: 20, overridden: true });
  assert.equal(capabilitiesFor("PM", "PAYROLL").transferEmployees, true);
  assert.equal(capabilitiesFor("HOD", "PAYROLL").transferEmployees, false);
  // Only an Admin may assign roles.
  assert.equal(capabilitiesFor("ADMIN", "PAYROLL").assignRoles, true);
  assert.equal(capabilitiesFor("HR", "PAYROLL").assignRoles, false);
  assert.equal(capabilitiesFor("SUPERVISOR", "PAYROLL").assignRoles, false);
});

/**
 * The COO is the audited role from the portfolio plan: an organisation-wide READ-ONLY
 * oversight login that lands on the operations dashboard. Every mutating capability must be
 * false — a single stray `true` would let the dashboard become an approvals screen.
 */
test("the COO is a read-only organisation-wide role that lands on the portfolio", () => {
  const coo = capabilitiesFor("COO", "PAYROLL");
  assert.equal(coo.viewPortfolioDashboard, true, "the COO's whole reason for existing");
  assert.equal(coo.viewSummary, true);
  for (const capability of MUTATING_CAPABILITIES) {
    assert.equal(coo[capability], false, `COO must not be able to ${capability}`);
  }
  assert.equal(coo.viewEmployees, false, "COO reads the dashboard, not the employee register");
  // The one write-shaped capability the COO holds, by the owner's instruction: the COO chairs reviews.
  // It writes meeting minutes, never work data, which is why it is not in the mutating list above.
  assert.equal(coo.runProjectReview, true, "the COO chairs the review");
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
    assert.equal(capabilitiesFor(role, "PAYROLL").viewPortfolioDashboard, true, `${role} sees the portfolio`);
  }
  for (const role of ["EMPLOYEE", "SUPERVISOR", "HR", "FINANCE"]) {
    assert.equal(capabilitiesFor(role, "PAYROLL").viewPortfolioDashboard, false, `${role} must not see the portfolio`);
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
 * THE account-lockout test, rewritten because the original premise was wrong.
 *
 * `usesEcNoLogin` decides whether a linked Employee lets an account sign in by EC No. A COO is designed to hold
 * no Employee — but holding one is allowed (a payroll employee promoted to COO keeps his link), and the old
 * rule locked exactly that account out: the EC No was refused because of the role and the e-mail was null
 * because payroll employees have none. Signing in by EC No cannot break the e-mail door either: an EC No never
 * matches the e-mail lookup, so both remain reachable.
 */
test("an organisation-wide role signs in with its EC No when it has one, and by e-mail when it does not", () => {
  // Promoted payroll employee: his EC No is his, whatever role he now holds.
  assert.equal(usesEcNoLogin(5), true);
  // The designed COO: no Employee record at all, so the e-mail is the only door and it stays open.
  assert.equal(usesEcNoLogin(null), false);
});

/**
 * My Hours is a PAYROLL screen, and the ROLE cannot decide it: a payroll employee can hold the
 * SUPERVISOR role, so keying the capability off the role would strand that person's existing days.
 */

test("My Hours is payroll-only, whichever role the account holds", () => {
  assert.equal(canUseMyHours("EMPLOYEE", "PAYROLL"), true);
  assert.equal(canUseMyHours("SUPERVISOR", "PAYROLL"), true, "a payroll employee who supervises keeps My Hours");
  assert.equal(canUseMyHours("HOD", "PAYROLL"), true, "an HOD books his own hours");

  assert.equal(canUseMyHours("SUPERVISOR", "CLMS"), false, "a contract supervisor routes slots and OT via Timesheet");
  assert.equal(canUseMyHours("EMPLOYEE", "CLMS"), false);
  assert.equal(canUseMyHours("HOD", "CLMS"), false);
});

test("an unlinked or unknown account fails closed", () => {
  assert.equal(canUseMyHours("SUPERVISOR", null), false);
  assert.equal(canUseMyHours("SUPERVISOR", undefined), false);
  assert.equal(canUseMyHours("SUPERVISOR", ""), false);
  assert.equal(canUseMyHours("COO", "PAYROLL"), false, "the org-wide reader never recorded hours");
  assert.equal(canUseMyHours("FINANCE", "PAYROLL"), false, "FINANCE never recorded hours");
  assert.equal(canUseMyHours("NONSENSE", "PAYROLL"), false);
});

test("the capability follows the employment type, not the role", () => {
  // The same ROLE, two answers — which is the whole reason the signature changed.
  assert.equal(capabilitiesFor("SUPERVISOR", "PAYROLL").allocateHours, true);
  assert.equal(capabilitiesFor("SUPERVISOR", "CLMS").allocateHours, false);
  assert.equal(capabilitiesFor("SUPERVISOR", "CLMS").selectTeam, true, "the Timesheet page is where he works instead");
});

/* ------------------------------------------------------------------ *
 * The PROJECTS scope — a Project Manager reads exactly his assignments
 * ------------------------------------------------------------------ */

test("a PROJECT_MANAGER reads exactly its assigned projects, and nothing when unassigned", () => {
  assert.deepEqual(
    reportScopeFor("PROJECT_MANAGER", 4, [7, 3]),
    { kind: "PROJECTS", projectIds: [3, 7] },
    "deduplicated and sorted, so the provenance line and the filters hash are stable"
  );
  assert.deepEqual(reportScopeFor("PROJECT_MANAGER", 4, []), { kind: "NONE" }, "no assignment -> nothing");
  assert.deepEqual(reportScopeFor("PROJECT_MANAGER", 4, null), { kind: "NONE" }, "unknown assignment -> nothing");
  assert.deepEqual(reportScopeFor("PROJECT_MANAGER", null, [7]), { kind: "PROJECTS", projectIds: [7] },
    "a project scope needs no Department");
  assert.deepEqual(reportScopeFor("PROJECT_MANAGER", 4, [0, -3, 2.5, 9]), { kind: "PROJECTS", projectIds: [9] },
    "junk ids are dropped, never turned into a scope");
});

test("assignments are consulted for the PROJECT_MANAGER role ONLY, so a stray row cannot narrow anyone", () => {
  // THE security property: the loader reads assignments only for that one role, and the pure rule
  // backs it up — an Admin/HOD that somehow carried an assignment row still reads what it read before.
  for (const role of ["PM", "ADMIN", "COO"]) {
    assert.deepEqual(reportScopeFor(role, 4, [7]), { kind: "ORGANISATION" }, `${role} stays organisation-wide`);
  }
  assert.deepEqual(reportScopeFor("HOD", 4, [7]), { kind: "DEPARTMENT", departmentId: 4 }, "an HOD stays in its Department");
  assert.deepEqual(reportScopeFor("SUPERVISOR", 4, [7]), { kind: "NONE" }, "a non-account role reads nothing");
});

test("intersectProjectFilter INTERSECTS the request with the assignment, never trusts it", () => {
  const scoped = reportScopeFor("PROJECT_MANAGER", null, [3, 7]);
  const org = reportScopeFor("PM", 4);
  const dept = reportScopeFor("HOD", 4);
  const none = reportScopeFor("PROJECT_MANAGER", null, []);

  assert.deepEqual(intersectProjectFilter(scoped, null), [3, 7], "no request -> the assignment");
  assert.deepEqual(intersectProjectFilter(scoped, [7]), [7], "a request narrows WITHIN the assignment");
  assert.deepEqual(intersectProjectFilter(scoped, [7, 9]), [7], "the foreign id is dropped, never added");
  assert.deepEqual(intersectProjectFilter(scoped, [9]), [],
    "a disjoint request is the EMPTY set (zero rows), NOT the assignment substituted back in");

  assert.deepEqual(intersectProjectFilter(org, [9]), [9], "organisation: the request passes through");
  assert.equal(intersectProjectFilter(org, null), null, "organisation: no request -> no filter");
  assert.deepEqual(intersectProjectFilter(dept, null), null,
    "a Department scope says nothing about projects, so no project predicate is added");
  assert.deepEqual(intersectProjectFilter(none, null), [], "NONE matches nothing");
});

test("the Project Manager role is read-only, lands on the portfolio, and is EC-No login", () => {
  const pm = capabilitiesFor("PROJECT_MANAGER", "PAYROLL");
  assert.equal(pm.viewPortfolioDashboard, true, "the role exists for this screen");
  for (const capability of MUTATING_CAPABILITIES) {
    // My Hours is the one exception, and it is not an exception to the read-only promise: it is a
    // person booking HIS OWN hours, exactly as PM already does. Everything that acts on OTHER
    // people's work stays false.
    if (capability === "allocateHours") continue;
    assert.equal(pm[capability], false, `PROJECT_MANAGER must not be able to ${capability}`);
  }
  assert.equal(pm.viewSummary, false, "the Summary router does not admit the role");
  assert.equal(pm.viewTimesheetCoverage, false, "an employee roster is not a project scope");
  assert.equal(pm.viewEmployees, false);
  assert.equal(landingPathFor("PROJECT_MANAGER"), "/portfolio");
  // A payroll manager books his own hours, exactly like PM.
  assert.equal(pm.allocateHours, true);
  assert.equal(canUseMyHours("PROJECT_MANAGER", "PAYROLL"), true);
  assert.equal(canUseMyHours("PROJECT_MANAGER", "CLMS"), false);
  // EC-No sign-in: any linked account has it, so a role can never brick the door up again.
  assert.equal(usesEcNoLogin(5), true);
  assert.equal(usesEcNoLogin(null), false, "an unlinked account falls back to e-mail");
});

test("legacy behaviour is untouched: every pre-existing role resolves to the same scope", () => {
  // The regression lock for this change. Adding a scope kind must not move any existing role.
  assert.deepEqual(reportScopeFor("PM", 4), { kind: "ORGANISATION" });
  assert.deepEqual(reportScopeFor("ADMIN", null), { kind: "ORGANISATION" });
  assert.deepEqual(reportScopeFor("COO", 9), { kind: "ORGANISATION" });
  assert.deepEqual(reportScopeFor("HOD", 4), { kind: "DEPARTMENT", departmentId: 4 });
  assert.deepEqual(reportScopeFor("DEPT_HEAD", 4), { kind: "DEPARTMENT", departmentId: 4 });
  assert.deepEqual(reportScopeFor("HOD", null), { kind: "NONE" });
});

test("landingPathFor is unchanged, so a contract supervisor still lands on Select Team", () => {
  assert.equal(landingPathFor("SUPERVISOR"), "/select-team");
  assert.equal(landingPathFor("EMPLOYEE"), "/allocations");
  assert.equal(landingPathFor("HOD"), "/approvals");
});