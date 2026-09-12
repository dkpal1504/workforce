import test from "node:test";
import assert from "node:assert/strict";
import { canSubmitRetainedDraft, rejectionStatusForEmployee } from "./employeeEligibility";
import { resolveEditLock } from "./timesheetEditLock";
import { canonicalEcNoKey } from "./employeeIdentity";

test("inactive employees may submit only a retained pre-termination DRAFT", () => {
  const terminatedAt = new Date("2026-09-11T12:00:00Z");
  const employee = { active: false, terminatedAt };
  assert.equal(canSubmitRetainedDraft(employee, { status: "DRAFT", createdAt: new Date("2026-09-11T11:00:00Z") }), true);
  assert.equal(canSubmitRetainedDraft(employee, { status: "REJECTED", createdAt: new Date("2026-09-11T11:00:00Z") }), false);
  assert.equal(canSubmitRetainedDraft(employee, { status: "DRAFT", createdAt: new Date("2026-09-11T13:00:00Z") }), false);
  assert.equal(canSubmitRetainedDraft({ active: true, terminatedAt: null }, { status: "DRAFT", createdAt: new Date() }), false);
});

test("FINAL_REJECTED is permanently locked", () => {
  assert.equal(resolveEditLock("FINAL_REJECTED", null).editMode, "locked");
});

test("canonical ecNo collision keys ignore case and surrounding whitespace", () => {
  assert.equal(canonicalEcNoKey("  App001  "), canonicalEcNoKey("app001"));
});

test("inactive rejection is terminal", () => {
  assert.equal(rejectionStatusForEmployee(false, "PLANNING_RETURNED"), "FINAL_REJECTED");
  assert.equal(rejectionStatusForEmployee(true, "PLANNING_RETURNED"), "PLANNING_RETURNED");
});
