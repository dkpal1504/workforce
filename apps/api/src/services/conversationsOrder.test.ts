import test from "node:test";
import assert from "node:assert/strict";
import { orderThreads, type ThreadOrderRow } from "./conversations";

/**
 * The order of the conversation list.
 *
 * New first, because that is what the screen is opened to find. An unanswered escalation first inside
 * each group, because it is the only row with a clock running. Everything else by recency.
 */

const at = (day: number) => new Date(`2026-10-${String(day).padStart(2, "0")}T09:00:00Z`);

function thread(overrides: Partial<ThreadOrderRow> & { name: string }): ThreadOrderRow & { name: string } {
  return {
    unread: 0,
    lastMessageAt: at(1),
    status: "OPEN",
    lastMessage: { kind: "REPLY", acknowledgedAt: null },
    ...overrides,
  };
}

test("a thread with unread messages outranks a quiet one, however recent the quiet one is", () => {
  const fresh = thread({ name: "fresh", unread: 0, lastMessageAt: at(20) });
  const unread = thread({ name: "unread", unread: 2, lastMessageAt: at(2) });
  assert.deepEqual([fresh, unread].sort(orderThreads).map((row) => row.name), ["unread", "fresh"]);
});

test("inside the unread group, an unanswered escalation leads — it is the one with a clock running", () => {
  const reply = thread({ name: "reply", unread: 1, lastMessageAt: at(19) });
  const escalation = thread({
    name: "escalation",
    unread: 1,
    lastMessageAt: at(2),
    lastMessage: { kind: "ESCALATION", acknowledgedAt: null },
  });
  assert.deepEqual([reply, escalation].sort(orderThreads).map((row) => row.name), ["escalation", "reply"]);
});

test("an ACKNOWLEDGED escalation stops floating: it is history, not a call on your time", () => {
  const answered = thread({
    name: "answered",
    unread: 1,
    lastMessageAt: at(2),
    lastMessage: { kind: "ESCALATION", acknowledgedAt: at(3) },
  });
  const plain = thread({ name: "plain", unread: 1, lastMessageAt: at(9) });
  assert.deepEqual([answered, plain].sort(orderThreads).map((row) => row.name), ["plain", "answered"]);
});

test("a resolved thread does not rank by its old escalation", () => {
  const resolved = thread({
    name: "resolved",
    unread: 0,
    status: "RESOLVED",
    lastMessageAt: at(2),
    lastMessage: { kind: "ESCALATION", acknowledgedAt: null },
  });
  const quiet = thread({ name: "quiet", unread: 0, lastMessageAt: at(8) });
  assert.deepEqual([resolved, quiet].sort(orderThreads).map((row) => row.name), ["quiet", "resolved"]);
});

test("two unread threads fall back to the newest activity, then to the bigger count", () => {
  const newer = thread({ name: "newer", unread: 1, lastMessageAt: at(18) });
  const older = thread({ name: "older", unread: 1, lastMessageAt: at(4) });
  assert.deepEqual([older, newer].sort(orderThreads).map((row) => row.name), ["newer", "older"]);

  const many = thread({ name: "many", unread: 5, lastMessageAt: at(4) });
  const few = thread({ name: "few", unread: 1, lastMessageAt: at(4) });
  assert.deepEqual([few, many].sort(orderThreads).map((row) => row.name), ["many", "few"]);
});

test("all read, no escalation: plain recency", () => {
  const a = thread({ name: "a", lastMessageAt: at(1) });
  const b = thread({ name: "b", lastMessageAt: at(7) });
  const c = thread({ name: "c", lastMessageAt: at(4) });
  assert.deepEqual([a, b, c].sort(orderThreads).map((row) => row.name), ["b", "c", "a"]);
});

test("a thread with no message yet sorts last, and does not throw", () => {
  const empty = thread({ name: "empty", unread: 0, lastMessageAt: at(1), lastMessage: null });
  const live = thread({ name: "live", lastMessageAt: at(1) });
  assert.deepEqual([empty, live].sort(orderThreads).map((row) => row.name), ["live", "empty"]);
});
