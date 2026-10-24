import type { Band } from "./portfolioReporting";
import type { ScheduleBand } from "./jobOrderSchedule";
import type { JobOrderFacts } from "./portfolioReporting";

/**
 * "Slow" is a named score, not a vibe.
 *
 * Every component is a number the reviewer can check on the row itself, every weight ships as printable
 * data, and a Job Order with neither a plan nor a single booking is NOT MEASURABLE — counted separately and
 * never ranked as though it were fine. The alternative (a single opaque index) lets a reviewer argue with
 * the number instead of the evidence.
 *
 * The weights are a judgement call, deliberately conservative: being past your promised end date costs
 * more than anything else, an unanswered escalation on the same Job Order costs double, and a missing
 * quantity update costs least because the data is often absent for reasons outside the Job Order.
 */
export const SLOW_WEIGHTS = {
  /** Days past the planned end, or projected to land past it — whichever is worse. Per day. */
  slipDays: 1,
  /** Percentage points by which the calendar has run ahead of the work. */
  scheduleGapPct: 0.5,
  /** Days since the last booking on a Job Order that is supposed to be running. */
  noActivityDays: 0.5,
  /** An open, unanswered escalation on this Job Order. Doubled: silence is expensive. */
  openEscalations: 2,
  /** Days the oldest unapproved hours have been waiting — effort nobody has signed off. */
  unapprovedAgingDays: 1,
  /** Percentage points of quantity still to do, when a quantity budget exists at all. */
  qtyBehindPct: 0.3,
} as const;

export type SlowComponentKey = keyof typeof SLOW_WEIGHTS;

export type SlowComponents = Record<SlowComponentKey, number>;

export type SlowExtras = {
  /** Open, unanswered escalations on this Job Order (D5 rule). */
  openEscalations: number;
  /** Open hindrances recorded against the Job Order's WBS. */
  openHindrances?: number;
  now: Date;
};

export type SlowScore = {
  score: number;
  components: SlowComponents;
  measurable: boolean;
  reasons: string[];
};

export type SlowRow = {
  jobOrderId: number;
  code: string;
  displayName: string;
  wbsCode: string;
  departmentName: string;
  sectionName: string | null;
  plannedEndDate: Date | null;
  projectedFinish: Date | null;
  scheduleBand: ScheduleBand;
  hoursBand: Band;
  burnPct: number | null;
  qtyPct: number | null;
  components: SlowComponents;
  score: number;
  measurable: boolean;
  reasons: string[];
};

const DAY_MS = 86_400_000;

function days(a: Date, b: Date): number {
  return (a.getTime() - b.getTime()) / DAY_MS;
}

/** A ratio that is not computable contributes 0 to the score, never NaN. */
function positive(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Same, for a value that may be legitimately zero or negative. */
function finite(value: number | null | undefined, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function slowScore(facts: JobOrderFacts, extras: SlowExtras): SlowScore {
  const hasPlan = facts.scheduleBand !== "NOT_SCHEDULED" && Boolean(facts.plannedEndDate);
  const hasActivity = facts.lastBooking !== null || facts.daysSinceActivity !== null;
  // Neither a promise nor a booking: there is nothing to be slow against. Saying "fast" here would be a lie.
  const measurable = hasPlan || hasActivity;

  // Latent lateness is only computable against a promise. Without a planned end there is no "late", and
  // borrowing a projected-slip number from a window that does not exist would invent one.
  const overdueDays = hasPlan ? Math.max(0, -finite(facts.daysToEnd)) : 0;
  const projectedSlip = hasPlan ? positive(facts.projectedSlipDays) : 0;
  const slipDays = Math.round(Math.max(overdueDays, projectedSlip) * 100) / 100;

  // `scheduleGapPct` and `qtyCompletePct` are FRACTIONS on the facts (0.45 = 45 percentage points), while the
  // printed components are points. Mixing the two units put "0.45 point(s) behind" on a row that was 45 points
  // behind — a demo with real progress data is what surfaced it.
  const components: SlowComponents = {
    slipDays,
    scheduleGapPct: Math.round(positive(facts.scheduleGapPct) * 100 * 100) / 100,
    noActivityDays: hasPlan ? Math.round(positive(facts.daysSinceActivity) * 100) / 100 : 0,
    openEscalations: Math.max(0, Math.round(extras.openEscalations || 0)),
    unapprovedAgingDays: facts.oldestUnapprovedAt
      ? Math.round(Math.max(0, days(extras.now, facts.oldestUnapprovedAt)) * 100) / 100
      : 0,
    qtyBehindPct:
      facts.measurableOnQuantity && Number.isFinite(facts.qtyCompletePct)
        ? Math.round(Math.min(100, Math.max(0, (1 - facts.qtyCompletePct) * 100)) * 100) / 100
        : 0,
  };

  const score = measurable
    ? Math.round(
        (Object.keys(SLOW_WEIGHTS) as SlowComponentKey[]).reduce(
          (sum, key) => sum + components[key] * SLOW_WEIGHTS[key],
          0
        ) * 100
      ) / 100
    : 0;

  const reasons: string[] = [];
  // The slip COLUMN is the worse of the two, so the reason must name the same one — otherwise the row shows
  // 102 days late beside a sentence about 12.
  if (slipDays > 0) {
    reasons.push(
      projectedSlip > overdueDays
        ? `projected to land ${projectedSlip.toFixed(0)} day(s) late`
        : `${overdueDays.toFixed(0)} day(s) past the planned end`
    );
  }
  if (components.scheduleGapPct > 0) {
    reasons.push(`${components.scheduleGapPct.toFixed(0)} point(s) behind the calendar`);
  }
  if (components.noActivityDays > 0) reasons.push(`nothing booked for ${components.noActivityDays.toFixed(0)} day(s)`);
  if (components.openEscalations > 0) reasons.push(`${components.openEscalations} unanswered escalation(s)`);
  if (components.unapprovedAgingDays > 0) {
    reasons.push(`${components.unapprovedAgingDays.toFixed(0)} day(s) of hours awaiting approval`);
  }
  if (components.qtyBehindPct > 0) reasons.push(`${components.qtyBehindPct.toFixed(0)}% of the quantity outstanding`);
  if (extras.openHindrances) reasons.push(`${extras.openHindrances} open hindrance(s)`);
  if (!measurable) reasons.push("no planned window and no booking — nothing to measure");
  else if (!hasPlan) reasons.push("no planned window: not judged against a plan");

  return { score, components, measurable, reasons };
}

export function slowRowFor(facts: JobOrderFacts, extras: SlowExtras): SlowRow {
  const scored = slowScore(facts, extras);
  return {
    jobOrderId: facts.id,
    code: facts.code,
    displayName: facts.displayName,
    wbsCode: facts.wbs.wbsCode,
    departmentName: facts.department.name,
    sectionName: facts.section?.name ?? null,
    plannedEndDate: facts.plannedEndDate,
    projectedFinish: facts.projectedFinish,
    scheduleBand: facts.scheduleBand,
    hoursBand: facts.hoursBand,
    burnPct: facts.burnPct,
    qtyPct: facts.qtyPct,
    components: scored.components,
    score: scored.score,
    measurable: scored.measurable,
    reasons: scored.reasons,
  };
}

export type SlowRanking = {
  rows: SlowRow[];
  /** Ranked but outside the limit — so the screen can say "10 of 34". */
  ranked: number;
  /** Job Orders that cannot be judged at all (no plan, no booking). */
  notMeasurable: number;
};

/**
 * Rank the measurable Job Orders, worst first, and keep the unmeasurable ones out of the ranking while
 * still counting them. Ties break on code, so two runs of the same data never reorder the table.
 */
export function rankSlowest(rows: readonly SlowRow[], limit = 10): SlowRanking {
  const measurable = rows.filter((row) => row.measurable);
  const sorted = [...measurable].sort((a, b) => b.score - a.score || a.code.localeCompare(b.code));
  return {
    rows: sorted.slice(0, Math.max(0, limit)),
    ranked: sorted.length,
    notMeasurable: rows.length - measurable.length,
  };
}
