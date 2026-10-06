import test from "node:test";
import assert from "node:assert/strict";
import {
  assignmentNotice,
  changePending,
  deriveScopeSections,
  hodScopeFromPicked,
  scopeConsequence,
  scopeSelectionDiffers,
  findSelection,
  loginFor,
  parseSelection,
  roleChangeAllowed,
  roleChangeBlockers,
  roleTicks,
  rowKey,
  targetSummary,
  unblocksByApprovingOthers,
  type PersonRow,
} from "./roleAssignmentSelection";

/**
 * The reported bug: the picker held only accounts, so a blue-collar (contract) Employee could
 * not be selected at all. The picker now holds both kinds of person in one list, and these
 * tests pin the decoding and the wording that keep the two apart.
 */

function account(overrides: Partial<PersonRow> = {}): PersonRow {
  return {
    kind: "ACCOUNT", id: 34, name: "jay", ecNo: "40032227", currentRole: "EMPLOYEE",
    employmentType: "PAYROLL", designation: "Technician", department: { id: 81, name: "Production - SEZ" },
    section: { id: 103, name: "Hull and Outfitting" }, active: true, self: false,
    creatableRoles: [], roleRefusals: {}, hodScope: null,
    blockers: { pendingApprovals: 0, returnedTimesheetDays: 0 },
    ...overrides,
  } as PersonRow;
}

function contractEmployee(overrides: Partial<PersonRow> = {}): PersonRow {
  return {
    kind: "EMPLOYEE", id: 501, name: "ADITYA RAMESHBHAI CHUDASAMA", ecNo: "BAPL0186", currentRole: null,
    employmentType: "CLMS", designation: "Assistant Technician", department: { id: 77, name: "Shipwright - EOU" },
    section: { id: 210, name: "Blasting & Painting" }, active: true, self: false,
    creatableRoles: ["EMPLOYEE", "SUPERVISOR"],
    roleRefusals: {
      HOD: "HOD needs a payroll (white-collar) Employee.",
      DEPT_HEAD: "DEPT_HEAD needs a payroll (white-collar) Employee.",
      PM: "PM is not created from an Employee record.",
      HR: "HR is not created from an Employee record.",
      FINANCE: "FINANCE is not created from an Employee record.",
      ADMIN: "ADMIN is not created from an Employee record.",
    },
    hodScope: null,
    blockers: { pendingApprovals: 0, returnedTimesheetDays: 0 },
    ...overrides,
  } as PersonRow;
}

test("an account and an Employee with the same numeric id never collide in the picker", () => {
  // Both populations are numbered independently in the database, so the value must carry its
  // kind or picking the Employee would silently select an unrelated account.
  assert.notEqual(rowKey("ACCOUNT", 7), rowKey("EMPLOYEE", 7));
  const rows = [account({ id: 7 }), contractEmployee({ id: 7, name: "Contract Seven" })];
  assert.equal(findSelection(rows, rowKey("EMPLOYEE", 7))?.name, "Contract Seven");
  assert.equal(findSelection(rows, rowKey("ACCOUNT", 7))?.name, "jay");
});

test("a malformed or empty selection resolves to nobody, never to the first row", () => {
  for (const value of ["", "EMPLOYEE", ":5", "ACCOUNT:", "ACCOUNT:abc", "WORKER:3", "ACCOUNT:-2", "ACCOUNT:0", "0"]) {
    assert.equal(parseSelection(value), null, `"${value}" must not resolve`);
    assert.equal(findSelection([account()], value), null);
  }
  assert.deepEqual(parseSelection("ACCOUNT:34"), { kind: "ACCOUNT", id: 34 });
  assert.deepEqual(parseSelection("EMPLOYEE:501"), { kind: "EMPLOYEE", id: 501 });
});

test("a blue-collar Employee with no account has a pending change the moment a role is ticked", () => {
  const worker = contractEmployee();
  assert.equal(changePending(worker, "", "SECTION"), false);
  assert.equal(changePending(worker, "SUPERVISOR", "SECTION"), true);
});

test("re-picking an account's own role is not a change, but widening an HOD's scope is", () => {
  const employee = account({ currentRole: "EMPLOYEE" });
  assert.equal(changePending(employee, "EMPLOYEE", "SECTION"), false);
  assert.equal(changePending(employee, "SUPERVISOR", "SECTION"), true);

  const hod = account({ currentRole: "HOD", hodScope: "SECTION" });
  assert.equal(changePending(hod, "HOD", "SECTION"), false);
  assert.equal(changePending(hod, "HOD", "DEPARTMENT"), true);
});

test("an inactive account or the Admin's own account can never be submitted", () => {
  assert.equal(changePending(account({ active: false }), "SUPERVISOR", "SECTION"), false);
  assert.equal(changePending(account({ self: true, currentRole: "EMPLOYEE" }), "SUPERVISOR", "SECTION"), false);
  assert.equal(changePending(null, "SUPERVISOR", "SECTION"), false);
});

test("the tick list offers every role for an account, and only the creatable ones for an Employee", () => {
  const roles = ["EMPLOYEE", "SUPERVISOR", "HOD", "DEPT_HEAD", "PM", "ADMIN", "HR", "FINANCE"];
  const forAccount = roleTicks(account(), roles);
  assert.equal(forAccount.every((tick) => tick.enabled), true);

  const forWorker = roleTicks(contractEmployee(), roles);
  assert.deepEqual(forWorker.filter((tick) => tick.enabled).map((tick) => tick.role), ["EMPLOYEE", "SUPERVISOR"]);
  // A disabled tick must carry the SERVER's sentence, so the screen explains a refusal the
  // API would give rather than inventing its own reason.
  const hod = forWorker.find((tick) => tick.role === "HOD");
  assert.equal(hod?.enabled, false);
  assert.match(hod!.reason!, /payroll \(white-collar\) Employee/);
});

test("an Employee row with an empty creatable list still explains something", () => {
  const stuck = contractEmployee({ creatableRoles: [], roleRefusals: {} });
  const ticks = roleTicks(stuck, ["SUPERVISOR"]);
  assert.equal(ticks[0].enabled, false);
  assert.match(ticks[0].reason!, /Not available for/);
});

test("the sign-in identifier is the EC No for the roles this screen creates", () => {
  assert.equal(loginFor(contractEmployee()), "BAPL0186");
  assert.equal(loginFor(account()), "40032227");
  // An administrative account keeps its e-mail login, so the panel must not name an EC No
  // that does not work — and an account with neither is not described as an EC No either.
  assert.equal(loginFor(account({ currentRole: "ADMIN", ecNo: null })), "their e-mail address");
});

test("the target summary says which kind of person is selected", () => {
  const worker = targetSummary(contractEmployee());
  assert.match(worker, /BAPL0186/);
  assert.match(worker, /no login yet — assigning a role creates one/);
  const existing = targetSummary(account({ currentRole: "HOD", hodScope: "DEPARTMENT" }));
  assert.match(existing, /currently HOD \(Department-level\)/);
});

test("creating a login tells the operator the identifier AND the first password", () => {
  const notice = assignmentNotice(contractEmployee(), "SUPERVISOR", "SECTION", true, "revealed-first-password");
  assert.match(notice, /is now SUPERVISOR/);
  assert.match(notice, /EC No BAPL0186/);
  assert.match(notice, /revealed-first-password/);
  assert.match(notice, /must set their own password/);
});

test("re-roling an existing account does not claim a login was created", () => {
  const notice = assignmentNotice(account(), "SUPERVISOR", "SECTION", false, "revealed-first-password");
  assert.match(notice, /sessions were revoked/);
  assert.ok(!/revealed-first-password/.test(notice), "an existing account keeps its own password");
  assert.ok(!/login was created/.test(notice));
});

test("an HOD notice names the scope that was actually stored", () => {
  const notice = assignmentNotice(account(), "HOD", "DEPARTMENT", false, "x");
  assert.match(notice, /Department-wide, no Section/);
});

/**
 * The reported bug: "I reassign an HOD as an Employee and the employee is ALWAYS shown as HOD."
 *
 * The API refuses the move while approval work is stranded in the HOD's queue, but the refusal was
 * only visible in a banner at the top of the page while the Update button is far below — so a
 * blocked move looked like a change that silently did not happen. These tests pin the rules that let
 * the panel explain the block before the click and beside the button.
 */
test("a Section HOD with queued approvals is BLOCKED from becoming an Employee, with the count", () => {
  const hod = account({ currentRole: "HOD", section: { id: 8, name: "Hull and Outfitting" }, blockers: { pendingApprovals: 32, returnedTimesheetDays: 0 } });
  const reason = roleChangeBlockers(hod, "EMPLOYEE");
  assert.ok(reason, "the move must be reported as blocked");
  assert.match(reason!, /^Blocked: 32 timesheet day/);
  assert.match(reason!, /approval queue/);
  assert.equal(roleChangeAllowed(hod, "EMPLOYEE"), false);
  // ...and the block is specific to a ROLE change: an HOD whose queue is clear can move.
  assert.equal(roleChangeBlockers(account({ currentRole: "HOD" }), "EMPLOYEE"), null);
});

test("re-picking the SAME role is never reported as blocked (a scope-only move is allowed)", () => {
  // Section -> Department is the same role, so planRoleChange never consults the queue. Reporting a
  // blocker here would disable a legitimate move.
  const hod = account({ currentRole: "HOD", hodScope: "SECTION", blockers: { pendingApprovals: 32, returnedTimesheetDays: 0 } });
  assert.equal(roleChangeBlockers(hod, "HOD"), null);
});

test("a Supervisor with returned timesheets is blocked, and PM/Admin queues count too", () => {
  const supervisor = account({ currentRole: "SUPERVISOR", blockers: { pendingApprovals: 0, returnedTimesheetDays: 3 } });
  const reason = roleChangeBlockers(supervisor, "EMPLOYEE");
  assert.match(reason!, /^Blocked: 3 timesheet/);
  assert.match(reason!, /returned for correction/);

  assert.match(roleChangeBlockers(account({ currentRole: "PM", blockers: { pendingApprovals: 5, returnedTimesheetDays: 0 } }), "EMPLOYEE")!, /5 timesheet day/);
  assert.match(roleChangeBlockers(account({ currentRole: "ADMIN", blockers: { pendingApprovals: 1, returnedTimesheetDays: 0 } }), "EMPLOYEE")!, /1 timesheet day/);
});

test("a non-approver role is never blocked by a queue, and an account-less Employee never is", () => {
  assert.equal(roleChangeBlockers(account({ currentRole: "EMPLOYEE", blockers: { pendingApprovals: 9, returnedTimesheetDays: 9 } }), "SUPERVISOR"), null);
  assert.equal(roleChangeBlockers(contractEmployee(), "SUPERVISOR"), null);
});

test("a row from an older payload without blockers is treated as unblocked, not as blocked", () => {
  const legacy = { ...account({ currentRole: "HOD" }) } as PersonRow;
  delete (legacy as { blockers?: unknown }).blockers;
  assert.equal(roleChangeBlockers(legacy, "EMPLOYEE"), null);
});

test("the panel says how many OTHER approvers could clear their queue instead", () => {
  const hod = account({ id: 35, currentRole: "HOD", blockers: { pendingApprovals: 32, returnedTimesheetDays: 0 } });
  const pm = account({ id: 36, currentRole: "PM" });
  const otherHod = account({ id: 37, currentRole: "HOD", blockers: { pendingApprovals: 4, returnedTimesheetDays: 0 } });
  const rows = [hod, pm, otherHod, account({ id: 38, currentRole: "EMPLOYEE" })];
  // The queue is held by Department/Section, so its 32 days may belong to another approver of the
  // same section — the operator is told how many alternatives exist rather than being sent to clear
  // work that may not be this person's.
  assert.equal(unblocksByApprovingOthers(rows, 35, "EMPLOYEE"), 2);
  assert.equal(unblocksByApprovingOthers(rows, 38, "SUPERVISOR"), 0, "no queue = nothing to explain");
});

/**
 * The multi-Section Section Head. Two facts must never be inferred from the legacy mirror: how
 * many Sections an account heads, and whether the ticks changed anything.
 */

test("the pre-ticked Sections come from the SET, and fall back to the legacy mirror", () => {
  // A migrated account: the set is the truth.
  assert.deepEqual(deriveScopeSections(account({ hodScope: "SECTION", scopeSections: [210, 103], section: { id: 103, name: "Hull" } })), [103, 210]);
  // A department-wide account: no rows, and that MEANS every Section.
  assert.deepEqual(deriveScopeSections(account({ hodScope: "DEPARTMENT", scopeSections: [], section: { id: 103, name: "Hull" } })), []);
  // A half-migrated account with neither: the legacy mirror is its one Section, exactly as
  // requireAuth reads it.
  assert.deepEqual(deriveScopeSections(account({ hodScope: "SECTION", scopeSections: [], section: { id: 103, name: "Hull" } })), [103]);
  assert.deepEqual(deriveScopeSections(account({ hodScope: "SECTION", scopeSections: undefined, section: null })), []);
});

test("re-ticking the same Sections in another order is NOT a change", () => {
  const hod = account({ hodScope: "SECTION", scopeSections: [103, 210], section: { id: 103, name: "Hull" } });
  assert.equal(scopeSelectionDiffers(hod, [103, 210]), false);
  assert.equal(scopeSelectionDiffers(hod, [210, 103]), false, "order is not a scope change");
  assert.equal(scopeSelectionDiffers(hod, [210, 103, 103]), false, "a duplicate is not a scope change");
  assert.equal(scopeSelectionDiffers(hod, [103, 210, 42]), true, "adding one IS");
  assert.equal(scopeSelectionDiffers(hod, [210]), true, "dropping one IS");
  assert.equal(scopeSelectionDiffers(hod, []), true, "widening to the whole Department IS");
  // A department-wide account narrowed to one Section is a change, even though the legacy mirror
  // is non-null in both readings of one Section.
  const wide = account({ hodScope: "DEPARTMENT", scopeSections: [], section: { id: 103, name: "Hull" } });
  assert.equal(scopeSelectionDiffers(wide, []), false);
  assert.equal(scopeSelectionDiffers(wide, [103]), true);
});

test("the legacy scope word is DERIVED from the set, never the other way round", () => {
  assert.equal(hodScopeFromPicked([]), "DEPARTMENT");
  assert.equal(hodScopeFromPicked([103]), "SECTION");
  assert.equal(hodScopeFromPicked([103, 210]), "SECTION", "two Sections are still a Section scope, not Department");
});

test("the tick list states the consequence in words, and names every Section", () => {
  const names: Record<number, string> = { 103: "Hull", 210: "Blasting" };
  const lookup = (id: number) => names[id] ?? null;
  assert.equal(scopeConsequence([], lookup), "Approves timesheets from every Section of this Department.");
  assert.equal(scopeConsequence([103], lookup), "Approves timesheets from Hull.");
  assert.equal(scopeConsequence([210, 103], lookup), "Approves timesheets from Hull and Blasting.");
  assert.equal(scopeConsequence([103, 210, 42], lookup), "Approves timesheets from Section 42 and Hull and Blasting.", "an unknown id is still named, never dropped");
  assert.equal(scopeConsequence([210, 103], lookup), "Approves timesheets from Hull and Blasting.", "the order read back is deterministic, not the click order");
});