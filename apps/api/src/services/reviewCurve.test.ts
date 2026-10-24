import assert from "node:assert/strict";
import test from "node:test";
import { bucketsBetween, buildSCurve, normaliseWeights, spreadLinear, type CurveWbs } from "./reviewCurve";

const jan = (day: number) => new Date(`2026-01-${String(day).padStart(2, "0")}T00:00:00.000Z`);
const iso = (day: number) => `2026-01-${String(day).padStart(2, "0")}T00:00:00.000Z`;

function wbs(overrides: Partial<CurveWbs> & { id: number }): CurveWbs {
  return {
    wbsCode: `WBS-${overrides.id}`,
    plannedWeight: null,
    jobOrders: [{ id: overrides.id * 10, budgetHours: 100, plannedStartDate: jan(1), plannedEndDate: jan(31) }],
    ...overrides,
  };
}

test("a Job Order's budget spreads linearly across its window", () => {
  // 100 h over 1..31 Jan: at 16 Jan (half the window, 30 days) half the hours have accrued.
  assert.equal(spreadLinear(100, jan(1), jan(31), jan(16)), 50);
  assert.equal(spreadLinear(100, jan(1), jan(31), jan(1)), 0, "before the window nothing has accrued");
  assert.equal(spreadLinear(100, jan(1), jan(31), jan(31)), 100, "at the end the whole share has accrued");
  assert.equal(spreadLinear(100, jan(1), jan(31), new Date("2026-03-01T00:00:00Z")), 100, "clamped after the end");
});

test("a window that never opened, or a zero-length one, cannot divide by zero", () => {
  assert.equal(spreadLinear(100, null, jan(31), jan(16)), 0, "no start date means no planned hours");
  assert.equal(spreadLinear(100, jan(5), null, jan(6)), 0, "no end date is no plan, not a day-one step");
  assert.equal(spreadLinear(100, jan(5), jan(5), jan(9)), 100, "a one-day Job Order is a step, not a NaN");
  assert.ok(Number.isFinite(spreadLinear(Number.NaN, jan(1), jan(31), jan(16))));
  assert.equal(spreadLinear(-50, jan(1), jan(31), jan(16)), 0, "a negative budget accrues nothing");
});

test("with no weights configured every WBS node weighs the same", () => {
  const shares = normaliseWeights([wbs({ id: 1 }), wbs({ id: 2 }), wbs({ id: 3 }), wbs({ id: 4 })]);
  for (const id of [1, 2, 3, 4]) assert.equal(shares.get(id), 0.25);
});

test("configured weights normalise, and an unconfigured node takes the average weight", () => {
  const shares = normaliseWeights([
    wbs({ id: 1, plannedWeight: 3 }),
    wbs({ id: 2, plannedWeight: 1 }),
    wbs({ id: 3, plannedWeight: null }),
  ]);
  // Average of the configured weights is 2, so the total is 3 + 1 + 2 = 6.
  assert.equal(shares.get(1), 3 / 6);
  assert.equal(shares.get(2), 1 / 6);
  assert.equal(shares.get(3), 2 / 6);
  const total = [...shares.values()].reduce((sum, value) => sum + value, 0);
  assert.equal(Math.round(total * 1e9) / 1e9, 1, "shares always sum to 1");
});

test("a WBS with no scheduled Job Order is counted, never plotted", () => {
  const curve = buildSCurve({
    buckets: bucketsBetween(new Date("2026-01-01T00:00:00Z"), new Date("2026-01-31T00:00:00Z"), "week"),
    wbs: [
      wbs({ id: 1 }),
      wbs({
        id: 2,
        jobOrders: [{ id: 20, budgetHours: 100, plannedStartDate: null, plannedEndDate: null }],
      }),
    ],
    budgetHours: 200,
    actualHoursByBucket: [],
  });
  assert.equal(curve.coverage.wbsTotal, 2);
  assert.equal(curve.coverage.wbsScheduled, 1);
  assert.equal(curve.coverage.wbsUnscheduled, 1);
  assert.equal(curve.coverage.weightsEqualShare, 2);
  // Only half the budget is in the plan, because only one WBS has a window.
  assert.equal(curve.coverage.plannedInCurveHours, 100);
  assert.equal(curve.coverage.unscheduledHours, 100);
  assert.equal(curve.coverage.scheduledBudgetShare, 0.5);
  assert.ok(
    curve.assumptions.some((line) => line.includes("1 of 2 WBS node(s)") && line.includes("50%")),
    "the chart must be able to print what it covers, in numbers"
  );
});

test("weights move planned hours between WBS nodes without changing the total", () => {
  const buckets = [{ key: "2026-01-31", start: iso(1), end: `${iso(31)}T23:59:59.999Z` }];
  const equal = buildSCurve({
    buckets,
    wbs: [wbs({ id: 1 }), wbs({ id: 2 })],
    budgetHours: 200,
    actualHoursByBucket: [],
  });
  const weighted = buildSCurve({
    buckets,
    wbs: [wbs({ id: 1, plannedWeight: 3 }), wbs({ id: 2, plannedWeight: 1 })],
    budgetHours: 200,
    actualHoursByBucket: [],
  });
  assert.equal(equal.points[0].plannedCum, 200);
  assert.equal(weighted.points[0].plannedCum, 200, "weights change the shape, not the total");
  assert.equal(weighted.coverage.weightsConfigured, 2);

  // The 3:1 split must show in an intermediate point, not only at the end.
  const mid = buildSCurve({
    buckets: [{ key: "2026-01-16", start: iso(1), end: `${iso(16)}T23:59:59.999Z` }],
    wbs: [
      wbs({ id: 1, plannedWeight: 3, jobOrders: [{ id: 10, budgetHours: 100, plannedStartDate: jan(1), plannedEndDate: jan(11) }] }),
      wbs({ id: 2, plannedWeight: 1, jobOrders: [{ id: 20, budgetHours: 100, plannedStartDate: jan(1), plannedEndDate: jan(31) }] }),
    ],
    budgetHours: 200,
    actualHoursByBucket: [],
  });
  // WBS-1 holds 150 h and its window closes on the 11th, so all of it has accrued. WBS-2 holds 50 h over
  // 1..31 Jan, and the bucket ends at the LAST instant of the 16th: 16 of 30 days = 26.67 h. Total 176.67.
  assert.equal(mid.points[0].plannedCum, 176.67);
});

test("actual hours accumulate independently and a bucket with no data reads zero, not NaN", () => {
  const curve = buildSCurve({
    buckets: [
      { key: "2026-01-07", start: iso(1), end: `${iso(7)}T23:59:59.999Z` },
      { key: "2026-01-14", start: iso(8), end: `${iso(14)}T23:59:59.999Z` },
    ],
    wbs: [wbs({ id: 1 })],
    budgetHours: 100,
    actualHoursByBucket: [10, Number.NaN],
  });
  assert.equal(curve.points[0].actualCum, 10);
  assert.equal(curve.points[1].actualCum, 10, "a missing bucket contributes nothing");
  assert.ok(curve.points.every((point) => Number.isFinite(point.plannedCum) && Number.isFinite(point.actualCum)));
});

test("an empty project is empty, not a confident flat line", () => {
  const curve = buildSCurve({ buckets: [], wbs: [], budgetHours: 0, actualHoursByBucket: [] });
  assert.equal(curve.empty, true);
  assert.equal(curve.coverage.scheduledBudgetShare, 0);
  assert.equal(curve.points.length, 0);
});

test("weekly buckets start on Monday and never run past the requested end", () => {
  const buckets = bucketsBetween(new Date("2026-10-14T00:00:00Z"), new Date("2026-10-27T00:00:00Z"), "week");
  assert.equal(buckets[0].key, "2026-10-12", "14 Oct 2026 is a Wednesday, so the week starts Monday the 12th");
  assert.equal(buckets[buckets.length - 1].end, "2026-10-27");
  assert.equal(buckets.length, 3);
});
