import assert from "node:assert/strict";
import test from "node:test";
import type { JobOrderFacts } from "./portfolioReporting";
import { SLOW_WEIGHTS, rankSlowest, slowRowFor, slowScore } from "./reviewRanking";

const now = new Date("2026-10-24T00:00:00Z");
const day = (value: string) => new Date(`${value}T00:00:00.000Z`);

/** Only the fields the ranking reads; the rest of JobOrderFacts is irrelevant to these rules. */
function facts(overrides: Partial<JobOrderFacts> & { id: number; code: string }): JobOrderFacts {
  return {
    name: overrides.code,
    displayName: overrides.code,
    project: { id: 1, code: "P1", name: "Project" },
    wbs: { id: 1, wbsCode: "WBS-1", name: "WBS" },
    network: null,
    department: { id: 1, name: "Fabrication" },
    section: null,
    status: "OPEN",
    uom: "MT",
    budgetHours: 100,
    actualHours: 80,
    burnPct: 0.8,
    hoursBand: "AMBER",
    hoursPerDay: null,
    forecastExhaustedOn: null,
    targetQty: 100,
    achievedQty: 80,
    qtyPct: 0.8,
    qtyCompletePct: 80,
    qtyBand: "AMBER",
    balanceQty: 20,
    lastBooking: day("2026-10-20"),
    daysSinceActivity: 4,
    unapprovedHours: 0,
    oldestUnapprovedAt: null,
    measurableOnHours: true,
    measurableOnQuantity: true,
    plannedStartDate: day("2026-08-01"),
    plannedEndDate: day("2026-10-01"),
    scheduleBand: "DELAYED",
    daysToEnd: -23,
    planElapsedPct: 1,
    scheduleGapPct: 20,
    requiredRate: null,
    actualRate: null,
    projectedFinish: day("2026-11-15"),
    projectedSlipDays: 45,
    attentionScore: 0,
    reasons: [],
    ...overrides,
  };
}

test("a Job Order past its window outranks a busy one that is merely burning its budget", () => {
  const late = slowScore(facts({ id: 1, code: "JO-LATE" }), { openEscalations: 0, now });
  const burning = slowScore(
    facts({
      id: 2,
      code: "JO-BUSY",
      daysToEnd: 40,
      scheduleBand: "ON_PLAN",
      scheduleGapPct: 0,
      projectedSlipDays: null,
      projectedFinish: null,
      daysSinceActivity: 1,
      qtyCompletePct: 0.8,
    }),
    { openEscalations: 0, now }
  );
  assert.equal(late.measurable, true);
  assert.ok(late.score > burning.score, `${late.score} should exceed ${burning.score}`);
  assert.equal(late.components.slipDays, 45, "45 projected days beats the 23 already past");
});

test("no plan and no booking is NOT MEASURABLE — counted, never ranked as fast", () => {
  const scored = slowScore(
    facts({
      id: 3,
      code: "JO-BLANK",
      scheduleBand: "NOT_SCHEDULED",
      plannedStartDate: null,
      plannedEndDate: null,
      daysToEnd: null,
      scheduleGapPct: null,
      projectedSlipDays: null,
      projectedFinish: null,
      lastBooking: null,
      daysSinceActivity: null,
      measurableOnQuantity: false,
      qtyPct: null,
    }),
    { openEscalations: 0, now }
  );
  assert.equal(scored.measurable, false);
  assert.equal(scored.score, 0);
  assert.ok(scored.reasons.some((reason) => reason.includes("nothing to measure")));

  const ranking = rankSlowest([
    slowRowFor(facts({ id: 1, code: "JO-A" }), { openEscalations: 0, now }),
    slowRowFor(
      facts({
        id: 3,
        code: "JO-BLANK",
        scheduleBand: "NOT_SCHEDULED",
        lastBooking: null,
        daysSinceActivity: null,
        measurableOnQuantity: false,
      }),
      { openEscalations: 0, now }
    ),
  ]);
  assert.deepEqual(ranking.rows.map((row) => row.code), ["JO-A"]);
  assert.equal(ranking.notMeasurable, 1);
  assert.equal(ranking.ranked, 1);
});

test("a Job Order with no plan but real bookings is measured, and says the plan is missing", () => {
  const scored = slowScore(
    facts({ id: 4, code: "JO-NOPLAN", scheduleBand: "NOT_SCHEDULED", plannedEndDate: null, daysToEnd: null, scheduleGapPct: null }),
    { openEscalations: 0, now }
  );
  assert.equal(scored.measurable, true, "there is activity, so it can be judged on activity");
  assert.equal(scored.components.slipDays, 0);
  assert.ok(scored.reasons.some((reason) => reason.includes("no planned window")));
});

test("every returned reason is derived from a component that is non-zero", () => {
  const scored = slowScore(
    facts({
      id: 5,
      code: "JO-WORST",
      daysToEnd: -5,
      projectedSlipDays: null,
      daysSinceActivity: 20,
      unapprovedHours: 30,
      oldestUnapprovedAt: day("2026-10-04"),
      qtyCompletePct: 0.4,
      scheduleGapPct: 0.15,
    }),
    { openEscalations: 2, openHindrances: 1, now }
  );
  const reasons = scored.reasons.join(" | ");
  assert.match(reasons, /5 day\(s\) past the planned end/);
  assert.match(reasons, /15 point\(s\) behind the calendar/);
  assert.match(reasons, /nothing booked for 20 day\(s\)/);
  assert.match(reasons, /2 unanswered escalation\(s\)/);
  assert.match(reasons, /20 day\(s\) of hours awaiting approval/, "oldest unapproved is 4 Oct, 20 days before the 24th");
  assert.match(reasons, /60% of the quantity outstanding/);
  assert.match(reasons, /1 open hindrance\(s\)/);

  // The printed weights and the score must be the same arithmetic.
  const expected = Object.entries(SLOW_WEIGHTS).reduce(
    (sum, [key, weight]) => sum + scored.components[key as keyof typeof SLOW_WEIGHTS] * weight,
    0
  );
  assert.equal(scored.score, Math.round(expected * 100) / 100);
});

test("ties break on the code so two runs of the same data never reorder the table", () => {
  const ranking = rankSlowest([
    slowRowFor(facts({ id: 1, code: "JO-B" }), { openEscalations: 0, now }),
    slowRowFor(facts({ id: 2, code: "JO-A" }), { openEscalations: 0, now }),
  ]);
  assert.deepEqual(ranking.rows.map((row) => row.code), ["JO-A", "JO-B"]);
});

test("a ratio that cannot be computed contributes zero, never NaN", () => {
  const scored = slowScore(
    facts({
      id: 6,
      code: "JO-NAN",
      daysToEnd: null,
      scheduleGapPct: Number.NaN,
      projectedSlipDays: Number.NaN,
      daysSinceActivity: Number.NaN,
      qtyCompletePct: Number.NaN,
    }),
    { openEscalations: 0, now }
  );
  assert.ok(Number.isFinite(scored.score));
  for (const value of Object.values(scored.components)) assert.ok(Number.isFinite(value));
});
