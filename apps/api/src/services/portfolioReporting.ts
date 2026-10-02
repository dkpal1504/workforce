/**
 * Portfolio & Job-Work reporting — the rules, with no database access.
 *
 * This module is deliberately PURE: it takes already-fetched budget, hours and
 * progress rows and turns them into per-job-order and per-project facts plus a
 * documented RAG band.
 *
 * WIRING (re-verified 2026-10-02): `routes/reports.ts` exposes THREE read-only
 * endpoints — `GET /api/reports/portfolio` (the JSON screen), plus
 * `GET /api/reports/portfolio.xlsx` and `GET /api/reports/portfolio.pdf` — all gated to
 * PM / ADMIN / COO. Every one of them parses its query with `parsePortfolioFilters` and
 * builds its rows through `buildPortfolioReport`, whose single database-touching function
 * fetches once and calls the pure `buildJobOrderFacts` here; the two downloads then render
 * that SAME assembled report via `portfolioExport.ts`, which re-derives no number. So the
 * screen, the workbook and the PDF cannot disagree about a band or a score.
 * (An earlier header claimed the XLSX/PDF routes when only the JSON endpoint existed;
 * this line records the state actually present in `routes/reports.ts`.)
 *
 * Two conventions matter everywhere below:
 *
 *   1. NOT_MEASURABLE is a first-class band, never a shade of GREEN. An unbudgeted
 *      or unbooked job order that is painted GREEN is a dashboard lying to the COO,
 *      which is worse than one that admits it has nothing to measure. Every band
 *      function therefore refuses to return GREEN for a missing denominator.
 *
 *   2. Budget semantics are NOT re-derived here. The revision in force is whatever
 *      `budgetInForce()` from `jobOrderProgress.ts` says, and the achieved quantity is
 *      whatever `achievedQuantity()` says, because `GET /api/summary/job-order` already
 *      established that convention and the two endpoints must agree.
 */

import {
  achievedQuantity,
  budgetInForce,
  jobOrderDisplay,
  quantityBalance,
  type BudgetRevisionRow,
  type ProgressRow,
} from "./jobOrderProgress";

// The activity-window DEFAULT is owned by portfolioFilters.ts and imported here rather than
// re-typed as a literal 7: the parser, the attention rule and the pulse count must all fall
// back to the SAME number, or a caller that omits `activityDays` would silently reintroduce
// the very drift this module is being fixed for. portfolioFilters is pure (node:crypto only)
// and imports nothing from this file, so there is no cycle.
import { DEFAULT_ACTIVITY_DAYS } from "./portfolioFilters";

/* --------------------------------------------------------------------------- *
 * Bands
 * ------------------------------------------------------------------------- */

/** RAG plus the honest "we have nothing to measure" band. */
export type Band = "RED" | "AMBER" | "GREEN" | "NOT_MEASURABLE";

const MS_PER_DAY = 86_400_000;

/** Midnight UTC of the calendar day. Rates and spans are counted in whole days. */
function startOfUtcDay(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/** Whole calendar days between two instants, floored (never negative in practice). */
function daysSince(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / MS_PER_DAY);
}

/** The `YYYY-MM-DD` key the budget/progress rules compare and print. */
function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The hours-burn band.
 *
 * `burnPct = actualHours / budgetHours`. The denominator is the budget IN FORCE at
 * the report date, and a budget of zero is not a denominator at all: the work is
 * unmeasurable and is banded NOT_MEASURABLE. That ordering (measurability check
 * FIRST) is what stops an unbudgeted job order with hours booked against it from
 * being painted GREEN.
 *
 * WHY BOTH OPERANDS ARE CHECKED: a band is only meaningful when BOTH `budgetHours`
 * and `actualHours` are finite numbers. A non-finite numerator (NaN from a bad SUM,
 * Infinity from a broken join) is corrupt input, and every comparison below is false
 * against NaN/Infinity — so it would fall through to the final `return "GREEN"` and
 * paint garbage as healthy. That is precisely the lie this module exists to prevent,
 * and it would flow into the export and onto the COO's screen. Corrupt input therefore
 * resolves to NOT_MEASURABLE (never GREEN), consistent with the missing-denominator
 * case: we do not have a number to measure, so we say so instead of inventing a colour.
 */
export function hoursBand(budgetHours: number, actualHours: number): Band {
  // BOTH operands must be finite positive/number values: `!(x > 0)` also catches NaN and
  // negatives, and `Number.isFinite` catches Infinity in EITHER position (a finite
  // budget with an Infinity numerator, or an Infinity budget that would divide down to
  // a fake 0% burn and paint GREEN).
  if (!Number.isFinite(budgetHours) || !(budgetHours > 0) || !Number.isFinite(actualHours)) {
    return "NOT_MEASURABLE";
  }
  const pct = actualHours / budgetHours;
  if (pct >= 1) return "RED";
  if (pct >= 0.75) return "AMBER";
  return "GREEN";
}

/**
 * Hours burned as a fraction of budget, or `null` when there is no budget to burn.
 *
 * Returns `null` for a non-finite numerator too: `NaN` or `Infinity` as a burn
 * percentage is not a measurement, and printing it would corrupt the column and any
 * arithmetic downstream. This mirrors `hoursBand`'s NOT_MEASURABLE for corrupt input.
 */
export function burnPct(budgetHours: number, actualHours: number): number | null {
  // Same both-operands guard as hoursBand: Infinity in either position is not a burn.
  if (!Number.isFinite(budgetHours) || !(budgetHours > 0) || !Number.isFinite(actualHours)) {
    return null;
  }
  return actualHours / budgetHours;
}

/**
 * The quantity-achievement band — the SAME vocabulary, read in the opposite direction.
 *
 * DO NOT "SIMPLIFY" THIS BACK INTO `hoursBand(targetQty, achievedQty)`. The colours on
 * that call are arithmetically right but the VOCABULARY is inverted for a human reader:
 * with `hoursBand(target, achieved)` a job order that achieved 0 of 100 comes out GREEN,
 * while the very same row's attention reason says "quantity behind target". A reader
 * comparing the hours and quantity columns then cannot tell that GREEN means "healthy
 * burn" in one column and "nothing achieved" in the other — a genuine readability trap.
 *
 * So quantity is judged in its OWN natural direction, on the SAME thresholds that the
 * hours rule uses (25% short is the band edge, and — like the attention weight below —
 * that edge is INCLUSIVE on the "behind" side):
 *
 *   achieved / target >  0.75  -> GREEN  (more than 75% delivered)
 *   achieved / target >= 0.25  -> AMBER  (between 25% and 75%)
 *   achieved / target <  0.25  -> RED    (behind by 75% or more)
 *
 * WHY GREEN IS STRICTLY `> 0.75` AND NOT `>=`: `attentionFor` fires its "quantity
 * behind target" reason at `qtyPct <= 0.75` (the inclusive 25%-short edge documented
 * there). If this band painted exactly 0.75 GREEN, that one row would show GREEN while
 * its own reason said "quantity behind target" — the exact contradiction this task
 * exists to remove. So exactly 75% lands on the AMBER side, and the colour and the
 * reason agree for every input. The band edge is preserved: 75% is where GREEN ends.
 *
 * A target of zero (or non-finite operands) is NOT_MEASURABLE, exactly as the hours
 * rule treats a missing denominator: no target means there is nothing to achieve.
 * `Number.isFinite(achievedQty)` is checked for the same reason `hoursBand` checks its
 * numerator — corrupt input must never resolve to GREEN.
 */
export function quantityBand(targetQty: number, achievedQty: number): Band {
  if (!(targetQty > 0) || !Number.isFinite(achievedQty)) return "NOT_MEASURABLE";
  const pct = achievedQty / targetQty;
  if (pct > 0.75) return "GREEN";
  if (pct >= 0.25) return "AMBER";
  return "RED";
}

/* --------------------------------------------------------------------------- *
 * Forecast exhaustion
 * ------------------------------------------------------------------------- */

/**
 * Average hours per booked day: `actualHours / observed days`.
 *
 * The observed window is the first booking to the last, INCLUSIVE of both ends (a
 * booking on the 26th and the 30th is 5 working days). A single booking is a point,
 * not a rate, so a zero-day span yields `null` rather than dividing by anything.
 *
 * Two spec ambiguities are RESOLVED here, deliberately, and pinned by tests:
 *
 *   1. The denominator stays the INCLUSIVE count `elapsed + 1`. Booking on the 26th
 *      and the 30th is 5 calendar days of work, which is the number an operations
 *      manager reasons with — not the 4 whole days a bare date subtraction yields.
 *   2. A same-day span still returns `null`. With one booking there is no observable
 *      RATE, and inventing one from zero elapsed days would produce a forecast the
 *      data does not support; honesty beats a manufactured number.
 */
export function hoursPerDay(params: {
  actualHours: number;
  firstBooking: Date | null;
  lastBooking: Date | null;
}): number | null {
  if (!(params.actualHours > 0)) return null;
  if (params.firstBooking === null || params.lastBooking === null) return null;
  const elapsed = Math.floor(
    (startOfUtcDay(params.lastBooking) - startOfUtcDay(params.firstBooking)) / MS_PER_DAY
  );
  if (elapsed <= 0) return null; // no observable rate from a single day
  return params.actualHours / (elapsed + 1);
}

/**
 * The day the budget runs out at the observed rate — the "needs a push" number.
 *
 * `null` whenever no rate can be observed (no budget, no hours, one/no booking).
 * An already-exhausted budget (`remaining <= 0`) returns the last booking date: the
 * budget is gone NOW, and dating that in the past would be misleading.
 *
 * BOTH branches return the SAME shape — a Date normalised to UTC midnight. The date
 * is one report column, so a caller must never see a raw time-of-day in one branch
 * and a UTC-midnight boundary in the other, and date comparisons must not turn on a
 * stray time component.
 *
 * Note this is a RATE projection, not a schedule: neither Project nor JobOrder has a
 * planned finish date (verified 2026-10-02), so "slipping against plan" is not yet
 * computable. This is the honest substitute.
 */
export function forecastExhaustedOn(params: {
  budgetHours: number;
  actualHours: number;
  firstBooking: Date | null;
  lastBooking: Date | null;
}): Date | null {
  // A non-finite budget or burn cannot produce a finite projection: `Infinity - 50`
  // is Infinity and `remaining / rate` is then Infinity, whose `new Date(...)` is an
  // INVALID Date that silently serialises to null and poisons every date comparison.
  // Refuse it here, in the same null-returning style as the other unmeasurable cases.
  if (!(params.budgetHours > 0)) return null;
  if (!(params.actualHours > 0)) return null;
  if (!Number.isFinite(params.budgetHours) || !Number.isFinite(params.actualHours)) return null;
  if (params.lastBooking === null) return null;

  const rate = hoursPerDay(params);
  if (rate === null || !Number.isFinite(rate)) return null;

  const remaining = params.budgetHours - params.actualHours;
  // Normalised to UTC midnight, exactly like the projection branch below, so the one
  // printed column carries a single kind of value whichever branch produced it.
  if (remaining <= 0) return new Date(startOfUtcDay(params.lastBooking)); // already exhausted
  const days = Math.ceil(remaining / rate);
  // Defensive last line: the module's contract is "a Date or null". If arithmetic ever
  // yields a non-finite instant (a future bug, an exotic input), return null rather than
  // hand a caller an Invalid Date that looks like a valid value.
  const projectedMs = startOfUtcDay(params.lastBooking) + days * MS_PER_DAY;
  if (!Number.isFinite(projectedMs)) return null;
  return new Date(projectedMs);
}

/* --------------------------------------------------------------------------- *
 * Attention score
 * ------------------------------------------------------------------------- */

/**
 * The facts the attention score needs. Deliberately a subset of JobOrderFacts so the
 * weights can be unit-tested without building a whole row.
 */
export type AttentionFacts = {
  budgetHours: number;
  actualHours: number;
  burnPct: number | null;
  hoursBand: Band;
  measurableOnHours: boolean;
  measurableOnQuantity: boolean;
  qtyPct: number | null;
  lastBooking: Date | null;
  unapprovedHours: number;
  oldestUnapprovedAt: Date | null;
  /**
   * The operator's activity window, in whole days. A booking older than this many days makes
   * measurable work "no activity". REQUIRED (not optional) so a caller cannot forget it and
   * silently fall back to a different number: the whole point of the fix is that ONE value
   * drives the attention reason, the pulse count and the printed note. Callers that legitimately
   * want today's behaviour pass `DEFAULT_ACTIVITY_DAYS`; `buildJobOrderFacts` supplies it.
   */
  activityDays: number;
};

/**
 * The window-dependent phrase used by every "no activity" reason string.
 *
 * The reason must state the window ACTUALLY USED, never a stale hardcoded 7. Deliberate
 * wording: the familiar phrase is kept verbatim for the default 7-day window (so every existing
 * reader, screenshot and test still recognises it), and any other window names its real value
 * ("... in the last 14 days"). Both branches are derived from the single `activityDays` input,
 * so a reason string can never contradict the printed rule or the pulse count.
 */
function noActivityReason(days: number): string {
  return `no hours booked in the last ${days} day${days === 1 ? "" : "s"}`;
}

/**
 * How many hours are booked against the budget.
 *
 * Deliberately explicit weights so the ranking is ARGUABLE rather than mysterious:
 * every point has a named reason a COO can trace back to its input. The weights are
 * additive; they are not a probability and are not normalised.
 *
 *   +40  hours RED        — the budget is spent
 *   +25  hours AMBER      — >=75% consumed
 *   +30  no activity 7d   — measurable work that has stopped
 *   +30  missing booking  — hours exist but lastBooking is null (see below)
 *   +20  approval ageing  — unapproved hours stuck > 3 days
 *   +15  qty behind       — measurable quantity <= 75% of target (>=25% below)
 *   +10  no budget        — unmanageable until a budget is set
 */
export function attentionFor(row: AttentionFacts, now: Date): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];

  if (row.hoursBand === "RED") {
    score += 40;
    reasons.push("hours budget exhausted");
  } else if (row.hoursBand === "AMBER") {
    score += 25;
    const pct = Math.round((row.burnPct ?? 0) * 100);
    reasons.push(`hours budget ${pct}% consumed`);
  }

  // Effort has stopped on work we CAN measure. An unmeasurable job order is not
  // "stalled" — it is simply unknown, and already scores via "no hours budget set".
  // The window is the OPERATOR'S activity window (`row.activityDays`), NOT a fixed 7: a
  // report requested with ?activityDays=14 must not flag work that sits inside the window
  // the operator asked for. The count, the reason string and the printed definitions note
  // therefore all derive from this one value. The edge is deliberately INCLUSIVE: a booking
  // exactly `activityDays` old is still "in the last N days" and does NOT trigger, while
  // day N+1 does. So the test is `> activityDays`, not `>= activityDays`.
  //
  // WHY THE NULL CASE IS SPLIT IN TWO: `lastBooking === null` alone does NOT prove the
  // work stalled. If `actualHours > 0` the hours demonstrably exist, so activity
  // happened and only the booking DATE is missing. Treating that as "stalled" prints
  // "no hours booked in the last N days" on a row that the branch above just told the
  // COO has "hours budget exhausted" — two mutually exclusive sentences for ONE job
  // order, and the operator cannot tell which is true. We keep a weight (the missing
  // date is a genuine data-health signal) but give it a DISTINCT, accurate reason so
  // the two lines can never contradict each other. Only a truly never-booked row
  // (`actualHours === 0`, `lastBooking === null`) is honest as "no activity".
  const stalledByDate =
    row.lastBooking !== null && daysSince(row.lastBooking, now) > row.activityDays;
  const missingDate = row.lastBooking === null && row.actualHours > 0;
  if (row.measurableOnHours && (stalledByDate || missingDate)) {
    score += 30;
    reasons.push(
      missingDate
        ? "activity recorded but no booking date"
        : noActivityReason(row.activityDays)
    );
  } else if (row.measurableOnHours && row.lastBooking === null) {
    // Never booked AND no hours: the real stall, not a missing date.
    score += 30;
    reasons.push(noActivityReason(row.activityDays));
  }

  // Work that is punched but not approved is invisible to every approved-hours
  // report, so ageing unapproved hours are a data-health signal, not a work signal.
  if (
    row.unapprovedHours > 0 &&
    row.oldestUnapprovedAt !== null &&
    daysSince(row.oldestUnapprovedAt, now) > 3
  ) {
    score += 20;
    reasons.push(`${row.unapprovedHours} h awaiting approval since ${dateKey(row.oldestUnapprovedAt)}`);
  }

  // The weight applies when quantity is AT LEAST 25% below target, i.e.
  // qtyPct <= 0.75. The boundary is inclusive: landing exactly 25% short is behind,
  // and excluding it would silently drop the worst measurable case a COO cares about.
  if (row.measurableOnQuantity && row.qtyPct !== null && row.qtyPct <= 0.75) {
    score += 15;
    reasons.push("quantity behind target");
  }

  if (!(row.budgetHours > 0)) {
    score += 10;
    reasons.push("no hours budget set");
  }

  return { score, reasons };
}

/** Descending attention score, ties broken by descending budgeted hours. */
export function sortByAttention<T extends { attentionScore: number; budgetHours: number }>(
  rows: readonly T[]
): T[] {
  return rows
    .slice()
    .sort((a, b) => b.attentionScore - a.attentionScore || b.budgetHours - a.budgetHours);
}

/* --------------------------------------------------------------------------- *
 * Job-order facts
 * ------------------------------------------------------------------------- */

export type JobOrderIdentity = {
  id: number;
  code: string;
  name: string;
  status: string;
  budgetedHours: number;
  budgetedQuantity: number;
  uom?: string | null;
  project: { id: number; code: string; name: string };
  wbs: { id: number; wbsCode: string; name: string };
  department: { id: number; name: string };
  section: { id: number; name: string } | null;
};

export type BudgetRevisionFact = {
  revisionNo: number;
  budgetedHours: number;
  budgetedQuantity: number;
  effectiveFrom: Date;
};

export type ProgressFactRow = {
  status: string;
  cumulativeQuantity: number;
  progressDate: Date;
  revisionNo: number;
};

export type BuildJobOrderFactsInput = {
  jobOrder: JobOrderIdentity;
  budgetRevisions: BudgetRevisionFact[];
  actualHours: number;
  unapprovedHours: number;
  oldestUnapprovedAt: Date | null;
  firstBooking: Date | null;
  lastBooking: Date | null;
  progressRows: ProgressFactRow[];
  asOf: Date;
  now: Date;
  /**
   * The operator's activity window in whole days, threaded down from the report filters so the
   * attention reason names the SAME window the pulse count and the printed definitions note use.
   * Optional with a default of `DEFAULT_ACTIVITY_DAYS` so every existing caller keeps today's
   * behaviour; the report loader always passes `filters.activityDays` explicitly.
   */
  activityDays?: number;
};

export type JobOrderFacts = {
  id: number;
  code: string;
  name: string;
  displayName: string;
  project: { id: number; code: string; name: string };
  wbs: { id: number; wbsCode: string; name: string };
  department: { id: number; name: string };
  section: { id: number; name: string } | null;
  status: string;
  uom: string | null;
  budgetHours: number;
  actualHours: number;
  burnPct: number | null;
  hoursBand: Band;
  hoursPerDay: number | null;
  forecastExhaustedOn: Date | null;
  targetQty: number;
  achievedQty: number;
  qtyPct: number | null;
  qtyBand: Band;
  balanceQty: number;
  lastBooking: Date | null;
  daysSinceActivity: number | null;
  unapprovedHours: number;
  oldestUnapprovedAt: Date | null;
  measurableOnHours: boolean;
  measurableOnQuantity: boolean;
  attentionScore: number;
  reasons: string[];
};

/**
 * Build one reportable job-order row from already-fetched rows.
 *
 * Budget and achieved quantity are NOT recomputed: revisions are mapped onto the
 * `BudgetRevisionRow` shape and handed to `budgetInForce()`, and progress rows onto
 * the `ProgressRow` shape handed to `achievedQuantity()`. That reuses the exact
 * revision/approval semantics of `GET /api/summary/job-order` instead of growing a
 * second, subtly different copy of them.
 */
export function buildJobOrderFacts(input: BuildJobOrderFactsInput): JobOrderFacts {
  const { jobOrder } = input;
  const asOfKey = dateKey(input.asOf);

  // budgetInForce carries the revision semantics but is shaped for quantity, so map
  // the revisions twice — once exposing budgetedHours, once budgetedQuantity — and
  // fall back to the job order's own current figure when no revision is in force.
  const revisionsForHours: BudgetRevisionRow[] = input.budgetRevisions.map((revision) => ({
    revisionNo: revision.revisionNo,
    effectiveFrom: dateKey(revision.effectiveFrom),
    budgetedQuantity: revision.budgetedHours,
  }));
  const revisionsForQty: BudgetRevisionRow[] = input.budgetRevisions.map((revision) => ({
    revisionNo: revision.revisionNo,
    effectiveFrom: dateKey(revision.effectiveFrom),
    budgetedQuantity: revision.budgetedQuantity,
  }));

  const budgetHours = budgetInForce(revisionsForHours, asOfKey, jobOrder.budgetedHours);
  const targetQty = budgetInForce(revisionsForQty, asOfKey, jobOrder.budgetedQuantity);

  const progressRows: ProgressRow[] = input.progressRows.map((row) => ({
    progressDate: dateKey(row.progressDate),
    revisionNo: row.revisionNo,
    cumulativeQuantity: row.cumulativeQuantity,
    status: row.status,
  }));
  const achievedQty = achievedQuantity(progressRows);

  const measurableOnHours = budgetHours > 0;
  // Quantity is measurable only when there is a target AND at least one APPROVED
  // entry: a target nobody has punched against is a plan, not a measurement.
  const measurableOnQuantity =
    targetQty > 0 && input.progressRows.some((row) => row.status === "APPROVED");

  const burn = burnPct(budgetHours, input.actualHours);
  const band = hoursBand(budgetHours, input.actualHours);
  const balance = quantityBalance(targetQty, achievedQty).balance;

  const qtyPct = measurableOnQuantity ? achievedQty / targetQty : null;
  // quantityBand, NOT hoursBand(targetQty, achievedQty): quantity is judged in its own
  // direction (more achieved is better), so a row can never say "quantity behind
  // target" while showing GREEN. See the function's docstring for why not to simplify.
  const qtyBand = measurableOnQuantity ? quantityBand(targetQty, achievedQty) : "NOT_MEASURABLE";

  const rate = hoursPerDay({
    actualHours: input.actualHours,
    firstBooking: input.firstBooking,
    lastBooking: input.lastBooking,
  });
  const forecast = forecastExhaustedOn({
    budgetHours,
    actualHours: input.actualHours,
    firstBooking: input.firstBooking,
    lastBooking: input.lastBooking,
  });

  const attention = attentionFor(
    {
      budgetHours,
      actualHours: input.actualHours,
      burnPct: burn,
      hoursBand: band,
      measurableOnHours,
      measurableOnQuantity,
      qtyPct,
      lastBooking: input.lastBooking,
      unapprovedHours: input.unapprovedHours,
      oldestUnapprovedAt: input.oldestUnapprovedAt,
      // ONE source of truth for the window: the operator's activityDays when supplied, the
      // documented default otherwise. Never re-hardcode 7 here.
      activityDays: input.activityDays ?? DEFAULT_ACTIVITY_DAYS,
    },
    input.now
  );

  return {
    id: jobOrder.id,
    code: jobOrder.code,
    name: jobOrder.name,
    displayName: jobOrderDisplay(jobOrder.code, jobOrder.name),
    project: jobOrder.project,
    wbs: jobOrder.wbs,
    department: jobOrder.department,
    section: jobOrder.section,
    status: jobOrder.status,
    uom: jobOrder.uom ?? null,
    budgetHours,
    actualHours: input.actualHours,
    burnPct: burn,
    hoursBand: band,
    hoursPerDay: rate,
    forecastExhaustedOn: forecast,
    targetQty,
    achievedQty,
    qtyPct,
    qtyBand,
    balanceQty: balance,
    lastBooking: input.lastBooking,
    daysSinceActivity:
      input.lastBooking === null ? null : daysSince(input.lastBooking, input.now),
    unapprovedHours: input.unapprovedHours,
    oldestUnapprovedAt: input.oldestUnapprovedAt,
    measurableOnHours,
    measurableOnQuantity,
    attentionScore: attention.score,
    reasons: attention.reasons,
  };
}

/* --------------------------------------------------------------------------- *
 * Roll-ups
 * ------------------------------------------------------------------------- */

/** Worst band wins; the rank is what makes "worst" comparable. */
const BAND_RANK: Record<Band, number> = {
  NOT_MEASURABLE: 0,
  GREEN: 1,
  AMBER: 2,
  RED: 3,
};

function worstBand(bands: readonly Band[]): Band {
  let worst: Band = "NOT_MEASURABLE";
  for (const band of bands) {
    if (BAND_RANK[band] > BAND_RANK[worst]) worst = band;
  }
  return worst;
}

type RollUpCounts = {
  budgetHours: number;
  actualHours: number;
  burnPct: number | null;
  /**
   * `hoursBand` — the headline band: the WORST individual job-order band in the group
   * (via `worstBand`). This is what the screen colours, because one RED job order
   * makes a project red whatever the average burn says ("a fire is not diluted by the
   * green jobs beside it").
   */
  hoursBand: Band;
  /**
   * `burnBand` — NOT the same thing as `hoursBand`, and not in the original spec:
   * this is the band recomputed from the group's SUMMED hours (`sum(actual)` over
   * `sum(budget)`) using the ordinary `hoursBand()` rule, i.e. it answers "how burnt
   * is the project overall?", whereas `hoursBand` answers "is any single job order in
   * trouble?". A group can be RED on one job order yet GREEN on its totals; both are
   * true, and keeping them separate lets a reader tell which question a colour answers.
   */
  burnBand: Band;
  jobOrderCount: number;
  redCount: number;
  amberCount: number;
  greenCount: number;
  notMeasurableCount: number;
  attentionScore: number;
  lastBooking: Date | null;
};

export type ProjectRollUp = RollUpCounts & {
  project: { id: number; code: string; name: string };
};

export type DepartmentRollUp = RollUpCounts & {
  department: { id: number; name: string };
  /** Distinct sections represented among the group's job orders. */
  sectionCount: number;
};

function summarise(facts: readonly JobOrderFacts[]): RollUpCounts {
  let budgetHours = 0;
  let actualHours = 0;
  let attentionScore = 0;
  let lastBooking: Date | null = null;
  const bands: Band[] = [];
  let redCount = 0;
  let amberCount = 0;
  let greenCount = 0;
  let notMeasurableCount = 0;

  for (const fact of facts) {
    budgetHours += fact.budgetHours;
    actualHours += fact.actualHours;
    attentionScore += fact.attentionScore;
    bands.push(fact.hoursBand);
    if (fact.hoursBand === "RED") redCount += 1;
    else if (fact.hoursBand === "AMBER") amberCount += 1;
    else if (fact.hoursBand === "GREEN") greenCount += 1;
    else notMeasurableCount += 1;

    if (fact.lastBooking !== null && (lastBooking === null || fact.lastBooking > lastBooking)) {
      lastBooking = fact.lastBooking;
    }
  }

  return {
    budgetHours,
    actualHours,
    burnPct: burnPct(budgetHours, actualHours),
    hoursBand: worstBand(bands),
    burnBand: hoursBand(budgetHours, actualHours),
    jobOrderCount: facts.length,
    redCount,
    amberCount,
    greenCount,
    notMeasurableCount,
    attentionScore,
    lastBooking,
  };
}

/** Group job orders by project, worst band headline, sorted by summed attention. */
export function rollUpProjects(facts: readonly JobOrderFacts[]): ProjectRollUp[] {
  const groups = new Map<number, JobOrderFacts[]>();
  for (const fact of facts) {
    const bucket = groups.get(fact.project.id);
    if (bucket) bucket.push(fact);
    else groups.set(fact.project.id, [fact]);
  }

  const rolls: ProjectRollUp[] = [];
  for (const bucket of groups.values()) {
    rolls.push({ project: bucket[0].project, ...summarise(bucket) });
  }
  return rolls.sort((a, b) => b.attentionScore - a.attentionScore);
}

/** Group job orders by department, same shape plus a distinct-section count. */
export function rollUpDepartments(facts: readonly JobOrderFacts[]): DepartmentRollUp[] {
  const groups = new Map<number, JobOrderFacts[]>();
  for (const fact of facts) {
    const bucket = groups.get(fact.department.id);
    if (bucket) bucket.push(fact);
    else groups.set(fact.department.id, [fact]);
  }

  const rolls: DepartmentRollUp[] = [];
  for (const bucket of groups.values()) {
    const sectionIds = new Set<number>();
    for (const fact of bucket) {
      if (fact.section !== null) sectionIds.add(fact.section.id);
    }
    rolls.push({
      department: bucket[0].department,
      sectionCount: sectionIds.size,
      ...summarise(bucket),
    });
  }
  return rolls.sort((a, b) => b.attentionScore - a.attentionScore);
}
