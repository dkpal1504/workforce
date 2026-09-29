import test from "node:test";
import assert from "node:assert/strict";
import {
  assignmentNotice,
  changePending,
  findSelection,
  loginFor,
  parseSelection,
  roleTicks,
  rowKey,
  targetSummary,
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
    ...overrides,
  };
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
    ...overrides,
  };
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
