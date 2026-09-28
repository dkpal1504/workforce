import test from "node:test";
import assert from "node:assert/strict";
import { resetActionLabel, resetAvailability, signInNote } from "./payrollResetAvailability";

/**
 * The bug these tests pin down: production showed a payroll employee promoted to PM as
 * "Login disabled" while the account was active, which sent an operator looking for a
 * disabled account (and me looking for a disable mechanism) that did not exist.
 */
test("an ACTIVE account is never described as disabled, whatever its role", () => {
  for (const role of ["EMPLOYEE", "SUPERVISOR", "HOD", "DEPT_HEAD", "PM", "HR", "FINANCE", "ADMIN"]) {
    const availability = resetAvailability(true, role);
    const words = `${resetActionLabel(availability, role)} ${signInNote(true, role, true)}`;
    assert.ok(!/disabled/i.test(words), `${role} must not read as disabled: "${words}"`);
  }
});

test("a role above Employee/Supervisor names the role and the screen that owns it", () => {
  const availability = resetAvailability(true, "PM");
  assert.equal(availability, "ROLE_OWNED");
  assert.equal(resetActionLabel(availability, "PM"), "Role PM — change it on Role Assignment");
  assert.equal(resetActionLabel(resetAvailability(true, "ADMIN"), "ADMIN"), "Role ADMIN — change it on Role Assignment");
});

test("an inactive account is reported as inactive even when the role is also role-owned", () => {
  // Precedence matters: Role Assignment refuses an inactive account outright, so telling
  // the operator to go there would be a dead end. "Reactivate first" is the real action.
  const availability = resetAvailability(false, "HOD");
  assert.equal(availability, "INACTIVE");
  assert.equal(resetActionLabel(availability, "HOD"), "Account inactive — reactivate it first");
  assert.equal(signInNote(false, "HOD", true), "Login disabled");
});

test("employee and supervisor are the two resettable roles", () => {
  assert.equal(resetAvailability(true, "EMPLOYEE"), "RESETTABLE");
  assert.equal(resetAvailability(true, "SUPERVISOR"), "RESETTABLE_SUPERVISOR");
  assert.equal(resetActionLabel("RESETTABLE", "EMPLOYEE"), "Reset password");
  assert.equal(resetActionLabel("RESETTABLE_SUPERVISOR", "SUPERVISOR"), "Reset password");
});

test("the sign-in note distinguishes an ecNo login from an e-mail login", () => {
  // The 1098 case: an ADMIN account with no ecNo login shows its e-mail, not its ecNo.
  assert.equal(signInNote(true, "ADMIN", false), "Signs in with e-mail");
  assert.equal(signInNote(true, "EMPLOYEE", true), "Signs in with EC No");
});
