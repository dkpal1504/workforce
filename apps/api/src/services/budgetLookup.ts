/**
 * Effective-dated Job Order budget lookup and the derived quantity figures the
 * Job Order Summary needs. Pure functions only (no Prisma import) so every rule
 * is unit-testable without a database.
 *
 * Master-data contract, rule 1: consumption is compared against the budget
 * revision in force on the WORK DATE (the latest `effective_from` that is on or
 * before that date), never against whatever the current revision happens to be.
 * A Job Order with no revision row in force yet falls back to its own budget
 * columns, so a Job Order created without a revision still reads as a budget
 * instead of a zero.
 *
 * Master-data contract, rule 4: achieved quantity is the `cumulative_quantity`
 * of the latest APPROVED progress entry, and percentages clamp at 0 when the
 * budget is 0. Hours and quantity are independent measures - nothing here ever
 * blends them.
 */

export type BudgetRevisionLike = {
  revisionNo: number;
  budgetedHours: number;
  budgetedQuantity: number;
  uomId?: number | null;
  effectiveFrom: Date | string | number;
};

/** The Job Order's own budget columns, used when no revision is in force. */
export type JobOrderBudgetLike = {
  budgetedHours: number | null;
  budgetedQuantity: number | null;
  uomId?: number | null;
};

export type ResolvedBudget = {
  budgetedHours: number;
  budgetedQuantity: number;
  /** null when the numbers came from the Job Order's own columns. */
  uomId: number | null;
  /** Revision that supplied the numbers; null when the fallback was used. */
  revisionNo: number | null;
  effectiveFrom: Date | null;
  source: "revision" | "current";
};

export type ProgressEntryLike = {
  id?: number;
  status: string;
  progressDate: Date | string | number;
  cumulativeQuantity: number;
  revisionNo?: number;
};

/**
 * Epoch milliseconds for a revision/progress date. An unusable date returns NaN so
 * the callers can skip that row instead of silently treating it as "now".
 */
function timeOf(value: Date | string | number): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  return new Date(value).getTime();
}

/** Epoch milliseconds of an effective date, or NaN when it cannot be read. */
function effectiveTime(value: Date | string | number): number {
  const ms = timeOf(value);
  return Number.isFinite(ms) ? ms : Number.NaN;
}

/** Latest revision in force on `workDate`, or null when none is in force yet. */
export function pickRevisionInForce(
  revisions: readonly BudgetRevisionLike[],
  workDate: Date | string | number
): BudgetRevisionLike | null {
  const at = timeOf(workDate);
  if (!Number.isFinite(at)) return null;
  let chosen: BudgetRevisionLike | null = null;
  for (const revision of revisions) {
    if (revision == null) continue;
    const from = effectiveTime(revision.effectiveFrom);
    if (!Number.isFinite(from) || from > at) continue;
    if (
      chosen == null ||
      from > effectiveTime(chosen.effectiveFrom) ||
      // Two revisions effective the same day: the higher revision number is the
      // correction that supersedes the other one.
      (from === effectiveTime(chosen.effectiveFrom) && revision.revisionNo > chosen.revisionNo)
    ) {
      chosen = revision;
    }
  }
  return chosen;
}

/**
 * The budget a Job Order had on `workDate`: the revision in force, or the Job
 * Order's current budget when no revision row exists (or none is in force yet).
 */
export function resolveBudgetInForce(
  revisions: readonly BudgetRevisionLike[],
  workDate: Date | string | number,
  current: JobOrderBudgetLike
): ResolvedBudget {
  const revision = pickRevisionInForce(revisions, workDate);
  if (!revision) {
    return {
      budgetedHours: current.budgetedHours ?? 0,
      budgetedQuantity: current.budgetedQuantity ?? 0,
      uomId: current.uomId ?? null,
      revisionNo: null,
      effectiveFrom: null,
      source: "current",
    };
  }
  return {
    budgetedHours: revision.budgetedHours ?? 0,
    budgetedQuantity: revision.budgetedQuantity ?? 0,
    uomId: revision.uomId ?? current.uomId ?? null,
    revisionNo: revision.revisionNo,
    effectiveFrom: new Date(timeOf(revision.effectiveFrom)),
    source: "revision",
  };
}

/**
 * Whole-percent share of `value` against `budget`. A zero (or missing) budget has
 * no percentage to report, so it clamps at 0. Over-budget rows keep their true
 * value above 100 - only the bar width is capped, in the presentation layer.
 */
export function percentOf(value: number, budget: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(budget) || budget <= 0) return 0;
  return Math.max(0, Math.round((value / budget) * 100));
}

/** Budget minus achieved. Negative means the Job Order is over budget. */
export function balanceOf(budget: number, achieved: number): number {
  return (Number.isFinite(budget) ? budget : 0) - (Number.isFinite(achieved) ? achieved : 0);
}

/**
 * The latest APPROVED progress entry: quantity progress is cumulative, so the
 * highest (progressDate, revisionNo) pair carries the achieved quantity. Returns
 * null when nothing has been approved yet - that is "not reported", not zero.
 */
export function latestApprovedProgress(
  entries: readonly ProgressEntryLike[]
): { cumulativeQuantity: number; progressDate: Date | null; revisionNo: number | null } | null {
  let best: ProgressEntryLike | null = null;
  for (const entry of entries) {
    if (!entry || entry.status !== "APPROVED") continue;
    if (best == null) {
      best = entry;
      continue;
    }
    if (isLaterProgressEntry(entry, best)) best = entry;
  }
  if (!best) return null;
  const ms = timeOf(best.progressDate);
  return {
    cumulativeQuantity: best.cumulativeQuantity ?? 0,
    progressDate: Number.isFinite(ms) ? new Date(ms) : null,
    revisionNo: best.revisionNo ?? 1,
  };
}

function isLaterProgressEntry(candidate: ProgressEntryLike, current: ProgressEntryLike): boolean {
  const candidateAt = timeOf(candidate.progressDate);
  const currentAt = timeOf(current.progressDate);
  if (candidateAt !== currentAt) return candidateAt > currentAt;
  const candidateRevision = candidate.revisionNo ?? 1;
  const currentRevision = current.revisionNo ?? 1;
  if (candidateRevision !== currentRevision) return candidateRevision > currentRevision;
  return (candidate.id ?? 0) > (current.id ?? 0);
}
