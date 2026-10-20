import test from "node:test";
import assert from "node:assert/strict";
import { isMessageOrigin, originLabel, tabForOrigin } from "./conversationOrigins";
import { hoursToFirstReply, medianHours, summariseEscalations, type EscalationFact } from "./escalationStats";

/** The closed origin list, and the only number the dashboard button exists to produce. */

test("the origin list is closed", () => {
  assert.equal(isMessageOrigin("PORTFOLIO_NEEDS_PUSH"), true);
  assert.equal(isMessageOrigin("PORTFOLIO_SCHEDULE"), true);
  assert.equal(isMessageOrigin("PORTFOLIO_STRUCTURE"), true);
  assert.equal(isMessageOrigin("portfolio_needs_push"), false);
  assert.equal(isMessageOrigin("WHATEVER"), false);
  assert.equal(isMessageOrigin(null), false);
  assert.equal(isMessageOrigin(42), false);
});

test("a label and a return tab are printed for each origin, and nothing for null", () => {
  assert.equal(originLabel("PORTFOLIO_NEEDS_PUSH"), "Portfolio · Needs push");
  assert.equal(originLabel(null), null);
  assert.equal(tabForOrigin("PORTFOLIO_SCHEDULE"), "schedule-delays");
  assert.equal(tabForOrigin("PORTFOLIO_STRUCTURE"), "project-structure");
  assert.equal(tabForOrigin("nonsense"), null);
});

test("the median is the middle value, and the mean of the middle pair when even", () => {
  assert.equal(medianHours([]), null);
  assert.equal(medianHours([5]), 5);
  assert.equal(medianHours([9, 1, 5]), 5);
  assert.equal(medianHours([1, 2, 3, 10]), 2.5);
  // One forgotten escalation must not move it: this is why it is a median, not a mean.
  assert.equal(medianHours([1, 2, 2, 3, 720]), 2);
});

test("the clock stops at the first answer by ANOTHER person", () => {
  const base = new Date("2026-10-19T08:00:00Z");
  assert.equal(hoursToFirstReply({ id: 1, seq: 1, createdAt: base, origin: null, acknowledgedAt: null, firstReplyAt: null }), null);
  assert.equal(
    hoursToFirstReply({
      id: 1,
      seq: 1,
      createdAt: base,
      origin: null,
      acknowledgedAt: null,
      firstReplyAt: new Date("2026-10-19T11:30:00Z"),
    }),
    3.5
  );
});

test("the headline separates dashboard escalations from drawer ones, and counts the unanswered", () => {
  const base = new Date("2026-10-01T08:00:00Z");
  const facts: EscalationFact[] = [
    { id: 1, seq: 2, createdAt: base, origin: "PORTFOLIO_NEEDS_PUSH", acknowledgedAt: null, firstReplyAt: new Date("2026-10-01T12:00:00Z") },
    { id: 2, seq: 2, createdAt: base, origin: "PORTFOLIO_NEEDS_PUSH", acknowledgedAt: null, firstReplyAt: new Date("2026-10-01T14:00:00Z") },
    { id: 3, seq: 2, createdAt: base, origin: "PORTFOLIO_STRUCTURE", acknowledgedAt: null, firstReplyAt: null },
    { id: 4, seq: 2, createdAt: base, origin: null, acknowledgedAt: null, firstReplyAt: new Date("2026-10-01T09:00:00Z") },
  ];

  const stats = summariseEscalations(facts);
  assert.equal(stats.raisedFromPortfolio, 3);
  assert.equal(stats.raisedInDrawer, 1);
  assert.equal(stats.answered, 3);
  assert.equal(stats.unanswered, 1);
  // 4h, 6h and 1h answered → median 4, not the mean 3.7.
  assert.equal(stats.medianHoursToFirstReply, 4);
  assert.deepEqual(stats.byOrigin, [
    { origin: "PORTFOLIO_NEEDS_PUSH", count: 2 },
    { origin: "PORTFOLIO_STRUCTURE", count: 1 },
  ]);
});

test("an empty window is zeroed, not a division by zero", () => {
  const stats = summariseEscalations([]);
  assert.equal(stats.raisedFromPortfolio, 0);
  assert.equal(stats.answered, 0);
  assert.equal(stats.unanswered, 0);
  assert.equal(stats.medianHoursToFirstReply, null);
  assert.deepEqual(stats.byOrigin, []);
});
