import test from "node:test";
import assert from "node:assert/strict";
import { changePasswordSchema } from "@workforce/shared";
import { MIN_PASSWORD_LENGTH, passwordMeetsAllRequirements, passwordRequirementScore, passwordRequirements } from "./passwordRequirements";

const status = (password: string) =>
  Object.fromEntries(passwordRequirements(password).map((r) => [r.key, r.met]));

/** A password the API definitely accepts, used as the "everything is fine" baseline. */
const GOOD = "Workforce@2026";

test("the checklist agrees with the schema that will actually be enforced", () => {
  assert.equal(changePasswordSchema.safeParse({ currentPassword: "something-else-1!", newPassword: GOOD }).success, true, "baseline must be valid");
  assert.equal(passwordMeetsAllRequirements(GOOD), true);

  // Anything the checklist calls complete must be accepted by the API, and vice versa.
  const candidates = [
    GOOD,
    "WorkforceX2026",      // no symbol
    "Workforce@abc",       // no digit
    "workforce@2026",      // no uppercase
    "WORKFORCE@2026",      // no lowercase
    "Workf@2026x",         // 11 chars
    "Aa1!aaaaaaaa",        // exactly 12 with all classes
    "short",
    "",
  ];
  for (const candidate of candidates) {
    const checklistSaysOk = passwordMeetsAllRequirements(candidate);
    const apiSaysOk = changePasswordSchema.safeParse({ currentPassword: "different-1!", newPassword: candidate }).success;
    assert.equal(checklistSaysOk, apiSaysOk, `disagreement for ${JSON.stringify(candidate)}`);
  }
});

test("each unmet rule is the one reported as unmet", () => {
  assert.deepEqual(status("WorkforceX2026"), { length: true, lowercase: true, uppercase: true, number: true, symbol: false });
  assert.deepEqual(status("Workforce@abc"), { length: true, lowercase: true, uppercase: true, number: false, symbol: true });
  assert.deepEqual(status("workforce@2026"), { length: true, lowercase: true, uppercase: false, number: true, symbol: true });
  assert.deepEqual(status("WORKFORCE@2026"), { length: true, lowercase: false, uppercase: true, number: true, symbol: true });
  assert.deepEqual(status("Workf@2026x"), { length: false, lowercase: true, uppercase: true, number: true, symbol: true });
});

test("the length rule uses the schema's own minimum, not a restated number", () => {
  const eleven = "Aa1!aaaaaaa";            // 11
  const twelve = "Aa1!aaaaaaaa";           // 12
  assert.equal(eleven.length, MIN_PASSWORD_LENGTH - 1);
  assert.equal(twelve.length, MIN_PASSWORD_LENGTH);
  assert.equal(status(eleven).length, false);
  assert.equal(status(twelve).length, true);
});

test("an empty password satisfies nothing and scores zero", () => {
  const empty = passwordRequirements("");
  assert.equal(empty.every((r) => !r.met), true);
  assert.deepEqual(passwordRequirementScore(""), { met: 0, total: empty.length });
});

test("the score counts what the checklist shows", () => {
  assert.deepEqual(passwordRequirementScore("WorkforceX2026"), { met: 4, total: 5 });
  assert.deepEqual(passwordRequirementScore(GOOD), { met: 5, total: 5 });
  assert.deepEqual(passwordRequirementScore("abc"), { met: 1, total: 5 });
});

test("every rule has a label a person can read and a stable key", () => {
  const keys = passwordRequirements(GOOD).map((r) => r.key);
  assert.deepEqual(keys, ["length", "lowercase", "uppercase", "number", "symbol"]);
  assert.equal(new Set(keys).size, keys.length, "keys are unique for use as DOM ids");
  for (const requirement of passwordRequirements(GOOD)) {
    assert.ok(requirement.label.trim().length > 0);
  }
});
