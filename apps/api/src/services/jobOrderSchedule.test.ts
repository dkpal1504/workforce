/**
 * The planned-window rules. Every test is pure: no database, no server, no clock.
 *
 * The rules the operator agreed to are pinned here: a window that has closed with quantity
 * outstanding is DELAYED, a projection more than SEVEN days beyond the planned end is AT RISK, and a
 * window closing within seven days with quantity outstanding is DUE SOON. A Job Order with no window
 * is NOT SCHEDULED — never "on time", which is the whole reason the band exists.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  SCHEDULE_ATTENTION_WEIGHTS,
  SCHEDULE_RULES,
  achievedRatePerDay,
  scheduleAttention,
  scheduleFor,
  type ScheduleInput,
} from "./jobOrderSchedule";

const NOW = new Date("2026-10-16T09:00:00.000Z");

function input(overrides: Partial<ScheduleInput> = {}): ScheduleInput {
  return {
    plannedStart: null,
    plannedEnd: null,
    targetQty: 100,
    achievedQty: 0,
    qtyCompletePct: 0,
    progress: [],
    now: NOW,
    ...overrides,
  };
}

// ----------------------------------------------------------------- no window

test("a Job Order with no planned window is NOT SCHEDULED, and claims nothing", () => {
  const facts = scheduleFor(input({ achievedQty: 40, qtyCompletePct: 0.4 }));
  assert.equal(facts.scheduleBand, "NOT_SCHEDULED");
  assert.deepEqual(
    {
      daysToEnd: facts.daysToEnd,
      planElapsedPct: facts.planElapsedPct,
      scheduleGapPct: facts.scheduleGapPct,
      requiredRate: facts.requiredRate,
      projectedFinish: facts.projectedFinish,
      reasons: facts.reasons,
    },
    { daysToEnd: null, planElapsedPct: null, scheduleGapPct: null, requiredRate: null, projectedFinish: null, reasons: [] }
  );
  assert.equal(scheduleAttention(facts.reasons, facts.scheduleBand), 0, "no window adds no attention");
});

test("a start with no end is open-ended: ON PLAN, and nothing is claimed", () => {
  const facts = scheduleFor(input({ plannedStart: new Date("2026-01-01T00:00:00.000Z"), achievedQty: 10, qtyCompletePct: 0.1 }));
  assert.equal(facts.scheduleBand, "ON_PLAN");
  assert.equal(facts.daysToEnd, null);
  assert.equal(facts.planElapsedPct, null, "a window needs both ends");
  assert.deepEqual(facts.reasons, []);
});

test("an end with no start is judged on its deadline alone", () => {
  const soon = scheduleFor(input({ plannedEnd: new Date("2026-10-20T00:00:00.000Z"), achievedQty: 10, qtyCompletePct: 0.1 }));
  assert.equal(soon.scheduleBand, "DUE_SOON");
  assert.equal(soon.daysToEnd, 4);
  assert.equal(soon.planElapsedPct, null);

  const passed = scheduleFor(input({ plannedEnd: new Date("2026-10-06T00:00:00.000Z"), achievedQty: 10, qtyCompletePct: 0.1 }));
  assert.equal(passed.scheduleBand, "DELAYED");
  assert.equal(passed.daysToEnd, -10);
});

// ----------------------------------------------------------------- the window

test("the calendar burn and the schedule gap are computed against the window", () => {
  const facts = scheduleFor(input({
    plannedStart: new Date("2026-09-01T00:00:00.000Z"),
    plannedEnd: new Date("2026-12-31T00:00:00.000Z"),
    achievedQty: 30,
    qtyCompletePct: 0.3,
  }));
  // 2026-09-01 -> 2026-10-16 is 45 days of a 121-day window; 30% of the quantity is done.
  assert.equal(Math.round(facts.planElapsedPct! * 1000) / 1000, 0.372);
  assert.equal(facts.scheduleGapPct, 0.072, "the calendar has run ahead of the work: behind plan");
  assert.equal(facts.daysToEnd, 76);
  assert.equal(facts.scheduleBand, "ON_PLAN", "three days behind is not yet a flag");
});

test("a planned end that has passed with quantity outstanding is DELAYED, and says by how much", () => {
  const facts = scheduleFor(input({
    plannedStart: new Date("2026-08-01T00:00:00.000Z"),
    plannedEnd: new Date("2026-10-10T00:00:00.000Z"),
    targetQty: 100,
    achievedQty: 62,
    qtyCompletePct: 0.62,
  }));
  assert.equal(facts.scheduleBand, "DELAYED");
  assert.equal(facts.daysToEnd, -6);
  assert.deepEqual(facts.reasons, ["planned end 2026-10-10 passed 6 day(s) ago at 62% of quantity"]);
  assert.equal(scheduleAttention(facts.reasons, facts.scheduleBand), SCHEDULE_ATTENTION_WEIGHTS.delayedNotComplete);
});

test("a window that closed on schedule is NOT delayed: finishing is not late", () => {
  const facts = scheduleFor(input({
    plannedStart: new Date("2026-08-01T00:00:00.000Z"),
    plannedEnd: new Date("2026-10-10T00:00:00.000Z"),
    achievedQty: 100,
    qtyCompletePct: 1,
  }));
  assert.equal(facts.scheduleBand, "ON_PLAN");
  assert.deepEqual(facts.reasons, [], "nothing to report about work that closed out");
});

test("a projection more than seven days beyond the planned end is AT RISK, with both rates", () => {
  const facts = scheduleFor(input({
    plannedStart: new Date("2026-09-01T00:00:00.000Z"),
    plannedEnd: new Date("2026-12-31T00:00:00.000Z"),
    targetQty: 100,
    achievedQty: 30,
    qtyCompletePct: 0.3,
    progress: [
      { date: new Date("2026-09-01T00:00:00.000Z"), quantity: 10 },
      { date: new Date("2026-10-01T00:00:00.000Z"), quantity: 30 },
    ],
  }));
  assert.equal(facts.scheduleBand, "AT_RISK");
  assert.equal(facts.actualRate, 0.67, "20 units over 30 days");
  assert.equal(facts.requiredRate, 0.92, "70 units over the remaining 76 days");
  assert.equal(facts.projectedFinish?.toISOString().slice(0, 10), "2027-01-29");
  assert.equal(facts.projectedSlipDays! > SCHEDULE_RULES.atRiskProjectedSlipDays, true);
  assert.match(facts.reasons[0], /^projected finish 2027-01-29 is 29 days beyond the planned end 2026-12-31, at 0\.67 per day$/);
  assert.match(facts.reasons[1], /^needs 0\.92 per day for the remaining 76 day\(s\); achieving 0\.67$/);
  assert.equal(scheduleAttention(facts.reasons, facts.scheduleBand), SCHEDULE_ATTENTION_WEIGHTS.atRisk);
});

test("a projection inside the tolerance is ON PLAN and states no rate it does not need", () => {
  const facts = scheduleFor(input({
    plannedStart: new Date("2026-09-01T00:00:00.000Z"),
    plannedEnd: new Date("2026-12-31T00:00:00.000Z"),
    targetQty: 100,
    achievedQty: 80,
    qtyCompletePct: 0.8,
    progress: [
      { date: new Date("2026-09-01T00:00:00.000Z"), quantity: 60 },
      { date: new Date("2026-10-01T00:00:00.000Z"), quantity: 80 },
    ],
  }));
  assert.equal(facts.scheduleBand, "ON_PLAN");
  assert.equal(facts.actualRate, 0.67, "20 units over 30 days");
  assert.equal(facts.projectedFinish?.toISOString().slice(0, 10), "2026-11-15", "projected EARLY of the end date");
  assert.equal(facts.projectedSlipDays! < 0, true, "a projection inside the window is not a slip");
  assert.deepEqual(facts.reasons, [], "0.67/day against a 0.26/day need: no reason to print");
});

test("a window closing within seven days with quantity outstanding is DUE SOON", () => {
  const facts = scheduleFor(input({
    plannedStart: new Date("2026-09-01T00:00:00.000Z"),
    plannedEnd: new Date("2026-10-21T00:00:00.000Z"),
    targetQty: 100,
    achievedQty: 60,
    qtyCompletePct: 0.6,
  }));
  assert.equal(facts.scheduleBand, "DUE_SOON");
  assert.equal(facts.daysToEnd, 5);
  assert.deepEqual(facts.reasons, ["planned end 2026-10-21 is 5 day(s) away with 40% of quantity outstanding"]);
  assert.equal(scheduleAttention(facts.reasons, facts.scheduleBand), SCHEDULE_ATTENTION_WEIGHTS.dueSoon);
});

test("the end date today is not late yet, and not yet due soon: it is due TODAY", () => {
  const facts = scheduleFor(input({
    plannedStart: new Date("2026-09-01T00:00:00.000Z"),
    plannedEnd: new Date("2026-10-16T00:00:00.000Z"),
    achievedQty: 50,
    qtyCompletePct: 0.5,
  }));
  assert.equal(facts.daysToEnd, 0);
  assert.equal(facts.scheduleBand, "DUE_SOON");
  assert.match(facts.reasons[0], /is 0 day\(s\) away/);
});

// ------------------------------------------------- the projection's honesty guards

test("a projection is refused from less than two approved entries", () => {
  assert.equal(achievedRatePerDay([]), null);
  assert.equal(achievedRatePerDay([{ date: new Date("2026-10-01T00:00:00.000Z"), quantity: 30 }]), null);

  const facts = scheduleFor(input({
    plannedStart: new Date("2026-09-01T00:00:00.000Z"),
    plannedEnd: new Date("2026-12-31T00:00:00.000Z"),
    achievedQty: 30,
    qtyCompletePct: 0.3,
    progress: [{ date: new Date("2026-10-01T00:00:00.000Z"), quantity: 30 }],
  }));
  assert.equal(facts.actualRate, null);
  assert.equal(facts.projectedFinish, null, "unknown, never a fabricated completion date");
  assert.equal(facts.projectedSlipDays, null);
  assert.equal(facts.scheduleBand, "ON_PLAN", "unknown is not a flag");
});

test("a projection is refused when the series does not advance, or lands on one day", () => {
  const flat = [
    { date: new Date("2026-09-01T00:00:00.000Z"), quantity: 30 },
    { date: new Date("2026-10-01T00:00:00.000Z"), quantity: 30 },
  ];
  assert.equal(achievedRatePerDay(flat), null, "no progress, no rate");
  assert.equal(achievedRatePerDay([
    { date: new Date("2026-09-01T00:00:00.000Z"), quantity: 40 },
    { date: new Date("2026-10-01T00:00:00.000Z"), quantity: 30 },
  ]), null, "a falling figure has no rate");
  assert.equal(achievedRatePerDay([
    { date: new Date("2026-10-01T00:00:00.000Z"), quantity: 30 },
    { date: new Date("2026-10-01T12:00:00.000Z"), quantity: 40 },
  ]), null, "the same day is not a span to divide by");
});

test("a Job Order with no quantity budget is never given a projection", () => {
  const facts = scheduleFor(input({
    plannedStart: new Date("2026-09-01T00:00:00.000Z"),
    plannedEnd: new Date("2026-12-31T00:00:00.000Z"),
    targetQty: 0,
    achievedQty: 0,
    qtyCompletePct: 0,
    progress: [
      { date: new Date("2026-09-01T00:00:00.000Z"), quantity: 0 },
      { date: new Date("2026-10-01T00:00:00.000Z"), quantity: 0 },
    ],
  }));
  assert.equal(facts.requiredRate, null, "no balance, no need");
  assert.equal(facts.projectedFinish, null, "no balance, no projection");
  assert.equal(facts.scheduleBand, "ON_PLAN");
});
