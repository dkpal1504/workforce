import test from "node:test";
import assert from "node:assert/strict";
import { loginIdentifierFor, payrollPasswordResettable, resetTargetLabel } from "./payrollPasswordReset";

test("a payroll employee and a supervisor may be reset; roles above them may not", () => {
  assert.equal(payrollPasswordResettable("EMPLOYEE"), true);
  assert.equal(payrollPasswordResettable("SUPERVISOR"), true);
  // Each of these has its own lever (Role Assignment re-provisions the account), so a
  // payroll reset must refuse rather than silently re-point someone's approver login.
  for (const role of ["HOD", "DEPT_HEAD", "PM", "HR", "FINANCE", "ADMIN"]) {
    assert.equal(payrollPasswordResettable(role), false, `${role} must not be resettable from here`);
  }
});

test("the screen names the identifier that actually logs in", () => {
  // ecNo-login roles: the EC No, never the internal @sync.local / @employee.local address.
  assert.equal(loginIdentifierFor("EMPLOYEE", "1098", "1098@employee.local"), "1098");
  assert.equal(loginIdentifierFor("SUPERVISOR", "FRNEGJ063", "frnegj063@sync.local"), "FRNEGJ063");
  assert.equal(loginIdentifierFor("HOD", "1098", "1098@employee.local"), "1098");
  // Administrative roles kept an e-mail login; showing an EC No there would be a lie.
  assert.equal(loginIdentifierFor("HR", "1098", "hr@company.com"), "hr@company.com");
  assert.equal(loginIdentifierFor("FINANCE", null, "finance@company.com"), "finance@company.com");
});

test("a missing identifier degrades to an empty string, not 'null'", () => {
  assert.equal(loginIdentifierFor("EMPLOYEE", null, "x@y.z"), "");
  assert.equal(loginIdentifierFor("HR", "1098", null), "");
});

test("reset label names the role the operator sees in the table", () => {
  assert.equal(resetTargetLabel("EMPLOYEE"), "Employee");
  assert.equal(resetTargetLabel("SUPERVISOR"), "Supervisor");
  // Anything else falls through as its raw role, which the API refuses to reset anyway.
  assert.equal(resetTargetLabel("HOD"), "HOD");
});
