import test from "node:test";
import assert from "node:assert/strict";
import { payrollEmail } from "./payrollEmail";

/** The Email column on Supervisors → Employees (Payroll). */

test("a captured address is shown as it is, with no placeholder mark", () => {
  assert.deepEqual(payrollEmail({ email: "ankit.singh@swan.co.in", notificationEmail: null }), {
    address: "ankit.singh@swan.co.in",
    placeholder: false,
    secondary: null,
  });
});

test("an @employee.local handle is marked: it logs in, it does not receive mail", () => {
  const result = payrollEmail({ email: "40032207@employee.local", notificationEmail: null });
  assert.equal(result.address, "40032207@employee.local");
  assert.equal(result.placeholder, true);
});

test("a notification address wins, and the login is shown underneath when it differs", () => {
  const result = payrollEmail({ email: "40032207@employee.local", notificationEmail: "ankit.singh@swan.co.in" });
  assert.equal(result.address, "ankit.singh@swan.co.in");
  assert.equal(result.placeholder, false);
  assert.equal(result.secondary, "login: 40032207@employee.local");
});

test("when both fields hold the same address there is no second line", () => {
  const result = payrollEmail({ email: "a@b.co.in", notificationEmail: "a@b.co.in" });
  assert.equal(result.secondary, null);
});

test("nothing captured prints an em dash, not a blank that looks like a mailbox", () => {
  assert.deepEqual(payrollEmail({ email: null, notificationEmail: null }), {
    address: "",
    placeholder: false,
    secondary: null,
  });
  assert.deepEqual(payrollEmail({ email: "   ", notificationEmail: "" }), {
    address: "",
    placeholder: false,
    secondary: null,
  });
});

test("whitespace is trimmed, so a padded address is neither mis-marked nor mis-searched", () => {
  const result = payrollEmail({ email: " 40032207@employee.local ", notificationEmail: null });
  assert.equal(result.address, "40032207@employee.local");
  assert.equal(result.placeholder, true);
});
