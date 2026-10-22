import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SLA,
  ageingBucket,
  elapsedHours,
  expectsReply,
  nextLadderStep,
  resolvePolicy,
  responseStats,
  slaChip,
} from "./sla";

/**
 * The clock the COO will quote and the ladder the sweep walks. Each case pins a decision that would
 * otherwise be made differently by the screen, the query and the cron.
 */

const NOW = new Date("2026-10-21T12:00:00Z");
const ago = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

test("only an escalation or a recovery expects a reply", () => {
  assert.equal(expectsReply("ESCALATION"), true);
  assert.equal(expectsReply("RECOVERY"), true);
  for (const kind of ["FOLLOW_UP", "INSTRUCTION", "REPLY", "DECISION", "SYSTEM"]) {
    assert.equal(expectsReply(kind), false, `${kind} must not start a clock`);
  }
});

test("a department row overrides the default, and an inactive row is ignored", () => {
  const rows = [
    { ...DEFAULT_SLA.ESCALATION },
    { ...DEFAULT_SLA.ESCALATION, departmentId: 21, responseHours: 2, remindHours: 4, escalateHours: 12 },
    { ...DEFAULT_SLA.ESCALATION, departmentId: 22, responseHours: 1, remindHours: 2, escalateHours: 3, active: false },
  ];
  assert.equal(resolvePolicy("ESCALATION", rows, 21).responseHours, 2);
  assert.equal(resolvePolicy("ESCALATION", rows, 99).responseHours, 4, "unknown department falls back to the default");
  assert.equal(resolvePolicy("ESCALATION", rows, 22).responseHours, 4, "an inactive override is not in force");
  assert.equal(resolvePolicy("RECOVERY", rows, 21).responseHours, 24, "a policy is per kind");
});

test("a fresh message is OPEN, and the last quarter of its window is DUE_SOON", () => {
  const dueAt = new Date(ago(-1).getTime() + 4 * 3_600_000); // posted 1h ago, 4h target
  assert.equal(slaChip({ postedAt: ago(1), dueAt, answeredAt: null, now: NOW, targetHours: 4 }).state, "OPEN");

  const threeAndAHalf = slaChip({ postedAt: ago(3.5), dueAt: new Date(ago(3.5).getTime() + 4 * 3_600_000), answeredAt: null, now: NOW, targetHours: 4 });
  assert.equal(threeAndAHalf.state, "DUE_SOON", "inside the final quarter");
  assert.ok(threeAndAHalf.remainingHours > 0);
});

test("DUE_SOON scales with the window: a 24h target does not shout at 3h", () => {
  const posted = ago(3);
  const dueAt = new Date(posted.getTime() + 24 * 3_600_000);
  assert.equal(slaChip({ postedAt: posted, dueAt, answeredAt: null, now: NOW, targetHours: 24 }).state, "OPEN");
});

test("past its due time it is OVERDUE, and the chip carries the hours late", () => {
  const posted = ago(35);
  const dueAt = new Date(posted.getTime() + 4 * 3_600_000);
  const chip = slaChip({ postedAt: posted, dueAt, answeredAt: null, now: NOW, targetHours: 4 });
  assert.equal(chip.state, "OVERDUE");
  assert.equal(Math.round(chip.elapsedHours), 35);
  assert.ok(chip.remainingHours < 0);
});

test("an answered message reports how long it took, not how old it is", () => {
  const posted = ago(40);
  const chip = slaChip({
    postedAt: posted,
    dueAt: new Date(posted.getTime() + 4 * 3_600_000),
    answeredAt: ago(34),
    now: NOW,
    targetHours: 4,
  });
  assert.equal(chip.state, "ANSWERED");
  assert.equal(Math.round(chip.elapsedHours), 6, "6h to answer, though the message is 40h old");
});

test("a message with no clock says NONE rather than pretending it is on time", () => {
  assert.equal(slaChip({ postedAt: NOW, dueAt: null, answeredAt: null, now: NOW, targetHours: 4 }).state, "NONE");
});

test("ageing buckets do not overlap and cover every age", () => {
  assert.equal(ageingBucket(0), "under4");
  assert.equal(ageingBucket(3.99), "under4");
  assert.equal(ageingBucket(4), "4to8");
  assert.equal(ageingBucket(7.99), "4to8");
  assert.equal(ageingBucket(8), "8to24");
  assert.equal(ageingBucket(23.99), "8to24");
  assert.equal(ageingBucket(24), "over24");
});

test("the median is a median, so one three-week-old escalation does not condemn a department", () => {
  const rows = [
    { postedAt: ago(2), dueAt: ago(-2), answeredAt: ago(1), targetHours: 4 },      // 1h
    { postedAt: ago(5), dueAt: ago(-1), answeredAt: ago(2), targetHours: 4 },      // 3h
    { postedAt: ago(504), dueAt: ago(480), answeredAt: ago(480), targetHours: 4 }, // 24h
  ];
  const stats = responseStats(rows, NOW);
  assert.equal(stats.medianHours, 3);
  assert.equal(stats.answered, 3);
  assert.equal(stats.overdue24, 0);
});

test("the within-target share is computed against each message's OWN target", () => {
  const rows = [
    { postedAt: ago(10), dueAt: ago(-6), answeredAt: ago(7), targetHours: 4 },  // 3h vs 4h -> within
    { postedAt: ago(10), dueAt: ago(-6), answeredAt: ago(2), targetHours: 4 },  // 8h vs 4h -> late
    { postedAt: ago(30), dueAt: ago(-6), answeredAt: ago(5), targetHours: 24 }, // 25h vs 24h -> late
    { postedAt: ago(30), dueAt: ago(-6), answeredAt: ago(11), targetHours: 24 }, // 19h vs 24h -> within
  ];
  const stats = responseStats(rows, NOW);
  assert.equal(stats.withinTargetPct, 50);
});

test("unanswered messages are bucketed, and 24h+ is counted separately", () => {
  const rows = [
    { postedAt: ago(1), dueAt: ago(-3), answeredAt: null, targetHours: 4 },
    { postedAt: ago(6), dueAt: ago(2), answeredAt: null, targetHours: 4 },
    { postedAt: ago(12), dueAt: ago(8), answeredAt: null, targetHours: 4 },
    { postedAt: ago(30), dueAt: ago(26), answeredAt: null, targetHours: 4 },
    { postedAt: ago(50), dueAt: ago(46), answeredAt: null, targetHours: 4 },
  ];
  const stats = responseStats(rows, NOW);
  assert.deepEqual(stats.open, { under4: 1, "4to8": 1, "8to24": 1, over24: 2 });
  assert.equal(stats.overdue24, 2);
  assert.equal(stats.medianHours, null);
  assert.equal(stats.withinTargetPct, null);
});

test("the ladder climbs one rung at a time and never repeats itself", () => {
  const policy = DEFAULT_SLA.ESCALATION;
  const base = { postedAt: ago(9), now: NOW, answeredAt: null, acknowledgedAt: null, policy };

  assert.equal(nextLadderStep({ ...base, lastStep: "NONE" }), "REMIND_HOD", "9h: remind the HOD");
  assert.equal(nextLadderStep({ ...base, lastStep: "REMIND_HOD" }), "NONE", "the same rung is never taken twice");
  assert.equal(nextLadderStep({ ...base, postedAt: ago(25), lastStep: "REMIND_HOD" }), "ESCALATE_COO");
  assert.equal(nextLadderStep({ ...base, postedAt: ago(25), lastStep: "ESCALATE_COO" }), "NONE");
});

test("an answer or an acknowledgement stops the ladder however old the message is", () => {
  const policy = DEFAULT_SLA.ESCALATION;
  const old = { postedAt: ago(200), now: NOW, lastStep: "NONE" as const, policy };
  assert.equal(nextLadderStep({ ...old, answeredAt: ago(199), acknowledgedAt: null }), "NONE");
  assert.equal(nextLadderStep({ ...old, answeredAt: null, acknowledgedAt: ago(150) }), "NONE");
});

test("elapsed hours are floored, so a chip says 31h and not 31.4", () => {
  assert.equal(elapsedHours(ago(31.4), NOW), 31);
});
