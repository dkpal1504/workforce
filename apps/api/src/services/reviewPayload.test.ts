import assert from "node:assert/strict";
import test from "node:test";
import { buildReviewPayload, type ReviewPayloadInput } from "./reviewPayload";
import { SLOW_WEIGHTS } from "./reviewRanking";
import { AGE_BUCKETS } from "./reviewEscalations";
import type { JobOrderFacts } from "./portfolioReporting";

const now = new Date("2026-10-24T00:00:00Z");
const day = (value: string) => new Date(`${value}T00:00:00.000Z`);

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
    actualHours: 50,
    burnPct: 0.5,
    hoursBand: "GREEN",
    hoursPerDay: null,
    forecastExhaustedOn: null,
    targetQty: 100,
    achievedQty: 50,
    qtyPct: 0.5,
    qtyCompletePct: 50,
    qtyBand: "GREEN",
    balanceQty: 50,
    lastBooking: day("2026-10-20"),
    daysSinceActivity: 4,
    unapprovedHours: 0,
    oldestUnapprovedAt: null,
    measurableOnHours: true,
    measurableOnQuantity: true,
    plannedStartDate: day("2026-08-01"),
    plannedEndDate: day("2026-11-30"),
    scheduleBand: "ON_PLAN",
    daysToEnd: 37,
    planElapsedPct: 0.8,
    scheduleGapPct: 30,
    requiredRate: null,
    actualRate: null,
    projectedFinish: null,
    projectedSlipDays: null,
    attentionScore: 0,
    reasons: [],
    ...overrides,
  };
}

function input(overrides: Partial<ReviewPayloadInput> = {}): ReviewPayloadInput {
  return {
    project: { id: 1, code: "P1", name: "Project One", departmentName: "Fabrication", projectManager: "A. Manager" },
    period: { kind: "WEEKLY", start: "2026-10-19", end: "2026-10-25", label: "Week of 19 Oct 2026", provisional: false },
    generatedAt: now,
    now,
    buckets: [
      { key: "2026-10-12", start: "2026-10-12", end: "2026-10-18" },
      { key: "2026-10-19", start: "2026-10-19", end: "2026-10-25" },
    ],
    wbs: [
      {
        id: 1,
        wbsCode: "WBS-1",
        plannedWeight: null,
        jobOrders: [{ id: 10, budgetHours: 100, plannedStartDate: day("2026-08-01"), plannedEndDate: day("2026-11-30") }],
      },
    ],
    facts: [facts({ id: 10, code: "JO-1" })],
    budgetHours: 100,
    actualHoursByBucket: [20, 30],
    manpowerBuckets: [
      { key: "2026-10-12", start: "2026-10-12", end: "2026-10-18" },
      { key: "2026-10-19", start: "2026-10-19", end: "2026-10-25" },
    ],
    contractRows: [
      { workDate: "2026-10-13", employeeId: 1, hours: 8 },
      { workDate: "2026-10-20", employeeId: 1, hours: 8 },
      { workDate: "2026-10-20", employeeId: 2, hours: 8 },
    ],
    payrollRows: [{ workDate: "2026-10-20", employeeId: 1, hours: 9 }],
    escalations: {
      buckets: AGE_BUCKETS.map((bucket) => ({ key: bucket.key, label: bucket.label, count: 0 })),
      total: 0,
      overdue: 0,
      acknowledgedUnanswered: 0,
      oldest: [],
      examined: 0,
    },
    items: [],
    attendance: { grounding: null, gap: "NOT_REQUESTED" },
    ...overrides,
  };
}

test("the payload assembles every section from one input, and the pulse agrees with them", () => {
  const payload = buildReviewPayload(input());
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.frozen, false);
  assert.equal(payload.pulse.actualHours, 50);
  assert.equal(payload.pulse.budgetHours, 100);
  assert.equal(payload.pulse.burnPct, 0.5);
  assert.equal(payload.sCurve.points.length, 2);
  assert.equal(payload.sCurve.points[1].actualCum, 50);
  assert.equal(payload.manpower.peakPeople, 2);
  assert.equal(payload.pulse.headcountPeak, 2);
  assert.equal(payload.slowest.rows.length, 1);
});

test("the printed definitions are the same constants the numbers came from", () => {
  const payload = buildReviewPayload(input());
  assert.deepEqual(payload.definitions.slowWeights, { ...SLOW_WEIGHTS });
  assert.deepEqual(
    payload.definitions.ageBuckets.map((bucket) => bucket.key),
    AGE_BUCKETS.map((bucket) => bucket.key)
  );
  assert.ok(payload.definitions.hoursNote.length > 20, "the hours definition must be printed, not implied");
  assert.match(payload.definitions.manpowerNote, /never added together/);
  assert.equal(payload.definitions.curveBasis, payload.sCurve.basis);
  assert.deepEqual(payload.definitions.assumptions, payload.sCurve.assumptions);
});

test("a frozen payload says so, and carries the snapshot it was frozen from", () => {
  const payload = buildReviewPayload(
    input({
      frozen: true,
      snapshot: { id: 7, revision: 2, capturedAt: "2026-10-26T00:31:00.000Z", provisional: false, captureTrigger: "SCHEDULED" },
    })
  );
  assert.equal(payload.frozen, true);
  assert.equal(payload.snapshot?.id, 7);
  assert.equal(payload.snapshot?.revision, 2);
});

test("attendance grounding is null with a reason when the data is not there, never a zero", () => {
  const off = buildReviewPayload(input({ attendance: { grounding: null, gap: "SETTLEMENT_OFF" } }));
  assert.equal(off.attendance.grounding, null);
  assert.match(off.attendance.note, /SETTLE_REPORTS/);

  const settled = buildReviewPayload(
    input({
      attendance: { grounding: { presentManDays: 220, bookedManDays: 190, unbookedManDays: 30, basis: "SETTLED_ATTENDANCE" }, gap: null },
    })
  );
  assert.equal(settled.attendance.grounding?.unbookedManDays, 30);
  assert.match(settled.attendance.note, /30 day\(s\) the yard paid for/);
});

test("a project with no Job Orders is empty and says so, instead of printing confident zeroes", () => {
  const payload = buildReviewPayload(
    input({ facts: [], wbs: [], budgetHours: 0, actualHoursByBucket: [], contractRows: [], payrollRows: [] })
  );
  assert.equal(payload.sCurve.empty, true);
  assert.equal(payload.pulse.burnPct, null, "no budget means burn is unmeasurable, not 0%");
  assert.equal(payload.slowest.rows.length, 0);
  assert.match(payload.readiness.sentences[0], /no Job Orders yet/);
});

test("readiness counts what cannot be judged, and never hides it behind a green number", () => {
  const payload = buildReviewPayload(
    input({
      facts: [
        facts({ id: 10, code: "JO-1" }),
        facts({ id: 11, code: "JO-2", plannedStartDate: null, plannedEndDate: null, scheduleBand: "NOT_SCHEDULED" }),
      ],
    })
  );
  assert.equal(payload.readiness.jobOrders, 2);
  assert.equal(payload.readiness.withoutPlan, 1);
  assert.equal(payload.readiness.planCoverage, 0.5);
  assert.ok(payload.readiness.sentences.some((line) => line.includes("1 of 2 Job Order(s) have no planned")));
  assert.equal(payload.pulse.notScheduled, 1);
});
