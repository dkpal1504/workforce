import assert from "node:assert/strict";
import test from "node:test";
import { AGE_BUCKETS, ageBucket, isOpenEscalation, summariseEscalationsByAge, type EscalationMessage, type ThreadReply } from "./reviewEscalations";

const now = new Date("2026-10-24T00:00:00Z");
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);

function escalation(overrides: Partial<EscalationMessage> & { id: number; createdAt: Date }): EscalationMessage {
  return {
    threadId: overrides.id,
    threadStatus: "OPEN",
    authorEmail: "pm@example.com",
    dueAt: null,
    acknowledgedAt: null,
    jobOrderId: null,
    jobOrderCode: null,
    ...overrides,
  };
}

test("a reply by somebody else closes an escalation; the author replying does not", () => {
  const raised = escalation({ id: 1, createdAt: daysAgo(5) });
  const otherPerson: ThreadReply = { threadId: 1, createdAt: daysAgo(4), authorEmail: "HOD@example.com" };
  const ownChase: ThreadReply = { threadId: 1, createdAt: daysAgo(4), authorEmail: "pm@example.com" };

  assert.equal(isOpenEscalation(raised, [otherPerson]), false, "an answer is an answer");
  assert.equal(isOpenEscalation(raised, [ownChase]), true, "chasing your own escalation is not an answer");
  assert.equal(isOpenEscalation(raised, []), true);
  assert.equal(
    isOpenEscalation(escalation({ id: 2, createdAt: daysAgo(5), threadStatus: "RESOLVED" }), []),
    false,
    "a closed thread has no open escalation, whatever the messages say"
  );
});

test("a reply BEFORE the escalation is not a reply to it", () => {
  const raised = escalation({ id: 3, createdAt: daysAgo(2) });
  const earlier: ThreadReply = { threadId: 3, createdAt: daysAgo(6), authorEmail: "someone@example.com" };
  assert.equal(isOpenEscalation(raised, [earlier]), true);
});

test("bucket edges are inclusive on the low side and pinned", () => {
  assert.equal(ageBucket(0), "0-2");
  assert.equal(ageBucket(2.9), "0-2");
  assert.equal(ageBucket(3), "3-7", "exactly three days is 3-7, not 0-2");
  assert.equal(ageBucket(7), "3-7");
  assert.equal(ageBucket(8), "8-14");
  assert.equal(ageBucket(15), "15-30");
  assert.equal(ageBucket(30), "15-30");
  assert.equal(ageBucket(31), ">30");
  assert.equal(AGE_BUCKETS.length, 5);
});

test("the summary counts open escalations only, flags overdue and acknowledged-but-unanswered", () => {
  const summary = summariseEscalationsByAge({
    now,
    oldestLimit: 2,
    escalations: [
      escalation({ id: 1, createdAt: daysAgo(45), dueAt: daysAgo(10) }),
      escalation({ id: 2, createdAt: daysAgo(5), acknowledgedAt: daysAgo(4) }),
      escalation({ id: 3, createdAt: daysAgo(1) }),
      escalation({ id: 4, createdAt: daysAgo(20), threadStatus: "RESOLVED" }),
    ],
    replies: [{ threadId: 2, createdAt: daysAgo(3), authorEmail: "answer@example.com" }],
  });

  assert.equal(summary.examined, 4);
  assert.equal(summary.total, 2, "the answered one and the resolved one are not open");
  assert.equal(summary.buckets.find((bucket) => bucket.key === ">30")?.count, 1);
  assert.equal(summary.buckets.find((bucket) => bucket.key === "0-2")?.count, 1);
  assert.equal(summary.overdue, 1);
  assert.equal(summary.acknowledgedUnanswered, 0, "the acknowledged one was answered, so it is closed");
  assert.deepEqual(summary.oldest.map((row) => row.id), [1, 3], "oldest first, capped at the limit");
  assert.equal(summary.oldest[0].ageDays, 45);
});

test("acknowledged but unanswered stays open and is flagged, because acknowledging is not answering", () => {
  const summary = summariseEscalationsByAge({
    now,
    escalations: [escalation({ id: 9, createdAt: daysAgo(12), acknowledgedAt: daysAgo(11) })],
    replies: [],
  });
  assert.equal(summary.total, 1);
  assert.equal(summary.acknowledgedUnanswered, 1);
  assert.equal(summary.buckets.find((bucket) => bucket.key === "8-14")?.count, 1);
});
