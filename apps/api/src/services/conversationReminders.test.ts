import test from "node:test";
import assert from "node:assert/strict";
import { remindersEnabled, remindersState } from "./conversationReminders";

/**
 * The rider: OFF unless explicitly enabled, and "explicitly" means the literal string `true`.
 *
 * The cases below are the ones an operator will actually produce: the variable absent, empty, "1",
 * "yes", "TRUE", and " true ". Exactly one of them may send mail on its own.
 */

test("absent means off — the shipped default", () => {
  assert.equal(remindersEnabled({}), false);
});

test("empty means off, not true-by-emptiness", () => {
  assert.equal(remindersEnabled({ CONVERSATION_REMINDERS_ENABLED: "" }), false);
});

test("a truthy-looking word is NOT consent", () => {
  for (const value of ["1", "yes", "on", "enable", "true-ish"]) {
    assert.equal(remindersEnabled({ CONVERSATION_REMINDERS_ENABLED: value }), false, `${value} must not enable`);
  }
});

test("only an explicit true (any case, trimmed by the operator's editor) enables it", () => {
  for (const value of ["true", "TRUE", "True"]) {
    assert.equal(remindersEnabled({ CONVERSATION_REMINDERS_ENABLED: value }), true, `${value} should enable`);
  }
});

test("the startup line says which it is, so a quiet ladder is explained rather than mysterious", () => {
  assert.match(remindersState({}), /reminders: OFF/);
  assert.match(remindersState({ CONVERSATION_REMINDERS_ENABLED: "true" }), /reminders: ON/);
});
