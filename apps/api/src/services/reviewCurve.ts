/**
 * The S-curve: planned hours against actual hours, cumulative, over buckets the caller defines.
 *
 * THE PLANNED LINE IS DERIVED, NOT IMPORTED. There is no plan curve in the database — only a planned
 * WINDOW per Job Order (`plannedStartDate..plannedEndDate`). So the planned line spreads each Job Order's
 * budgeted hours linearly across its own window, and every surface that shows it must print the
 * assumption (see `assumptions`). A curve that looks like a baseline when it is an averaging artefact is
 * worse than no curve: a reviewer would hold a manager to a plan nobody wrote.
 *
 * WEIGHTAGE (owner's instruction, 2026-10-24): a project's budget is distributed across its WBS nodes by
 * `project_wbs.planned_weight`. NULL means "equal share" — the rule shipped today — and the weights are
 * normalised by the weights ACTUALLY PRESENT, so a half-configured project still plots instead of
 * dividing by zero. A WBS with no scheduled Job Order contributes nothing to the line and is counted in
 * `coverage.wbsUnscheduled` instead: the curve must never grow for work nobody scheduled.
 */

import { normaliseWeightShares } from "@workforce/shared";

export const CURVE_BASIS = "WBS_WEIGHTED_LINEAR_SPREAD" as const;
export type CurveBasis = typeof CURVE_BASIS;

/** One bucket of the x-axis, inclusive of `start` and `end` (ISO dates, UTC midnight). */
export type CurveBucket = { key: string; start: string; end: string };

/** A Job Order as far as the curve is concerned: its budget and the window someone promised. */
export type CurveJobOrder = {
  id: number;
  budgetHours: number;
  plannedStartDate: Date | null;
  plannedEndDate: Date | null;
};

/** A WBS node with the share it is meant to contribute to the project's planned line. */
export type CurveWbs = {
  id: number;
  wbsCode: string;
  /** Share of the project's planned hours. NULL = equal share among the nodes that have no weight. */
  plannedWeight: number | null;
  jobOrders: readonly CurveJobOrder[];
};

export type CurveCoverage = {
  /** Budgeted hours of the whole project, in force at the period end. */
  budgetHours: number;
  /** How much of that budget the drawn line reaches when the period is complete. */
  plannedInCurveHours: number;
  /** Planned hours the line does NOT reach, because those Job Orders have no window. */
  unscheduledHours: number;
  wbsTotal: number;
  wbsScheduled: number;
  wbsUnscheduled: number;
  weightsConfigured: number;
  weightsEqualShare: number;
  jobOrdersTotal: number;
  jobOrdersScheduled: number;
  /** Scheduled share of the budget, 0..1 — what the line actually covers. */
  scheduledBudgetShare: number;
};

export type CurvePoint = {
  key: string;
  start: string;
  end: string;
  plannedHours: number;
  actualHours: number;
  plannedCum: number;
  actualCum: number;
};

export type SCurve = {
  basis: CurveBasis;
  points: CurvePoint[];
  coverage: CurveCoverage;
  /** Sentences a reviewer must be able to read next to the chart, in the report's voice. */
  assumptions: string[];
  /** True when nothing could be plotted: the chart must say so rather than draw a flat zero. */
  empty: boolean;
};

const DAY_MS = 86_400_000;

function finiteOrZero(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Spread `share` linearly across `[start, end]` and return the hours that had accrued by `at`.
 *
 * A window of zero length (or a missing end) puts the whole share at the start: a one-day Job Order is a
 * step, not a division by zero. Before the window the answer is 0, after it the whole share — clamped, so
 * a caller can ask about any instant without guarding.
 */
export function spreadLinear(
  share: number,
  start: Date | null,
  end: Date | null,
  at: Date
): number {
  const hours = finiteOrZero(share);
  // A window needs BOTH ends. A Job Order with a start and no end is not planned, and pretending it
  // accrues on day one would put hours of phantom work into the planned line.
  if (!start || !end) return 0;
  if (hours === 0) return 0;
  const from = start.getTime();
  const to = end.getTime();
  const now = at.getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to) || !Number.isFinite(now)) return 0;
  if (to < from) return 0;
  if (now <= from) return 0;
  if (to === from || now >= to) return hours;
  return hours * ((now - from) / (to - from));
}

/**
 * Normalised weights, one entry per WBS, summing to 1.
 *
 * A node with a configured weight uses it. A node without one is treated as the AVERAGE of the configured
 * weights — not as zero (which would silently drop a node from the plan) and not as an arbitrary half
 * (which would invent a number). When nothing is configured every node is equal, which is the shipped
 * default and the reason `weightsEqualShare` is printed next to the chart.
 */
export function normaliseWeights(wbs: readonly CurveWbs[]): Map<number, number> {
  // ONE implementation, in `shared`, because the browser previews the same percentages. This wrapper keeps the
  // curve's signature (a full WBS node in, a share out) while the arithmetic lives where both sides can reach it.
  return normaliseWeightShares(wbs);
}


/**
 * Build the curve. `actualHoursByBucket` is supplied by the loader (the booked-hours definition lives in
 * one place, `portfolioReporting.BOOKED_HOURS_STATUSES`); this module never decides what an hour is.
 */
export function buildSCurve(input: {
  buckets: readonly CurveBucket[];
  wbs: readonly CurveWbs[];
  /** Budget in force at the period end, for the whole project. */
  budgetHours: number;
  actualHoursByBucket: readonly number[];
}): SCurve {
  const budget = finiteOrZero(input.budgetHours);
  const buckets = input.buckets;
  const shares = normaliseWeights(input.wbs);

  const wbsScheduled = input.wbs.filter((node) =>
    node.jobOrders.some((order) => order.plannedStartDate && order.plannedEndDate)
  );
  const wbsUnscheduled = input.wbs.length - wbsScheduled.length;
  const weightsConfigured = input.wbs.filter(
    (node) => typeof node.plannedWeight === "number" && Number.isFinite(node.plannedWeight) && (node.plannedWeight ?? 0) > 0
  ).length;

  const jobOrders = input.wbs.flatMap((node) => node.jobOrders);
  const jobOrdersScheduled = jobOrders.filter((order) => order.plannedStartDate && order.plannedEndDate).length;

  // Planned cumulative at a given instant: every scheduled Job Order's slice, spread across its window.
  const plannedAt = (at: Date): number => {
    let total = 0;
    for (const node of input.wbs) {
      const share = shares.get(node.id) ?? 0;
      if (share <= 0) continue;
      // A node's planned share is its WEIGHT of the project budget. A node whose Job Orders were never given a
      // budget still exists and still holds a share — skipping it because `nodeBudget` is zero silently deleted
      // that share from the plan (five of nine nodes on a real project, ~4,900 hours). So the share is split
      // EQUALLY across its scheduled Job Orders instead of being dropped.
      const scheduled = node.jobOrders.filter((order) => order.plannedStartDate && order.plannedEndDate);
      if (!scheduled.length) continue;
      const allocated = share * budget;
      const nodeBudget = node.jobOrders.reduce((sum, order) => sum + finiteOrZero(order.budgetHours), 0);
      for (const order of scheduled) {
        const slice =
          nodeBudget > 0
            ? allocated * (finiteOrZero(order.budgetHours) / nodeBudget)
            : allocated / scheduled.length;
        total += spreadLinear(slice, order.plannedStartDate, order.plannedEndDate, at);
      }
    }
    return total;
  };

  let previousPlanned = 0;
  let plannedCum = 0;
  let actualCum = 0;
  const points: CurvePoint[] = buckets.map((bucket, index) => {
    // `endOfDay` accepts both "2026-01-31" and a full timestamp, because the loader and the tests build
    // buckets differently and a mangled date must never become a silent zero.
    const plannedToDate = round2(plannedAt(endOfDay(bucket.end)));
    const planned = round2(plannedToDate - previousPlanned);
    previousPlanned = plannedToDate;
    const actual = round2(finiteOrZero(input.actualHoursByBucket[index]));
    plannedCum = round2(plannedCum + planned);
    actualCum = round2(actualCum + actual);
    return {
      key: bucket.key,
      start: bucket.start,
      end: bucket.end,
      plannedHours: planned,
      actualHours: actual,
      plannedCum,
      actualCum,
    };
  });

  const plannedInCurveHours = round2(points.length ? points[points.length - 1].plannedCum : 0);
  const scheduledBudgetShare = budget > 0 ? Math.min(1, plannedInCurveHours / budget) : 0;

  const coverage: CurveCoverage = {
    budgetHours: round2(budget),
    plannedInCurveHours,
    unscheduledHours: round2(Math.max(0, budget - plannedInCurveHours)),
    wbsTotal: input.wbs.length,
    wbsScheduled: wbsScheduled.length,
    wbsUnscheduled,
    weightsConfigured,
    weightsEqualShare: input.wbs.length - weightsConfigured,
    jobOrdersTotal: jobOrders.length,
    jobOrdersScheduled,
    scheduledBudgetShare: Math.round(scheduledBudgetShare * 10_000) / 10_000,
  };

  const assumptions: string[] = [
    `Planned hours are DERIVED: each Job Order's budget is spread evenly across its planned window, ` +
      `weighted by WBS (${weightsConfigured} configured, ${coverage.weightsEqualShare} at equal share). ` +
      `This is not an imported baseline.`,
  ];
  if (wbsUnscheduled > 0 || jobOrdersScheduled < jobOrders.length) {
    assumptions.push(
      `The planned line covers ${wbsScheduled.length} of ${input.wbs.length} WBS node(s) and ` +
        `${jobOrdersScheduled} of ${jobOrders.length} Job Order(s) — ` +
        `${Math.round(scheduledBudgetShare * 100)}% of the budgeted hours. ` +
        `Job Orders with no planned window are not in the plan and cannot be judged against it.`
    );
  }

  return {
    basis: CURVE_BASIS,
    points,
    coverage,
    assumptions,
    empty: points.every((point) => point.plannedCum === 0 && point.actualCum === 0),
  };
}

/** The last instant of the day a bucket end names, whether it arrived as a date or a timestamp. */
function endOfDay(value: string): Date {
  return new Date(`${value.slice(0, 10)}T23:59:59.999Z`);
}

/** Whole hours would hide a half-hour booking; two decimals is enough for a chart and a pack. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Bucket helpers, so the loader and the capture job agree on what a bucket is. */
export function bucketsBetween(from: Date, to: Date, size: "day" | "week"): CurveBucket[] {
  const buckets: CurveBucket[] = [];
  const start = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const step = size === "week" ? 7 * DAY_MS : DAY_MS;
  // ISO weeks start on Monday, which is where a review period starts too (D16).
  if (size === "week") {
    const weekday = (start.getUTCDay() + 6) % 7;
    start.setTime(start.getTime() - weekday * DAY_MS);
  }
  for (let cursor = start.getTime(); cursor <= to.getTime(); cursor += step) {
    const bucketStart = new Date(cursor);
    const bucketEnd = new Date(Math.min(cursor + step - DAY_MS, to.getTime()));
    buckets.push({
      key: iso(bucketStart),
      start: iso(bucketStart),
      end: iso(bucketEnd),
    });
  }
  return buckets;
}

export function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}
