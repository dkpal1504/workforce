/**
 * The planned window rules: the ONE place a Job Order's schedule is judged.
 *
 * A Job Order may carry a planned window (`Start_Date` / `End_Date` from the upload template, or set
 * on the Master Data screen). Most of the yard's work is continual, so the window is OPTIONAL and
 * `NULL` is a first-class state, not missing data:
 *
 *   no window  -> NOT_SCHEDULED. It is never "on time" and never "late". Every aggregate that shows
 *                  a schedule figure states how many Job Orders it covers, because a portfolio whose
 *                  rows carry no dates must not read as a portfolio that is punctual.
 *   start only  -> ON_PLAN, open-ended. Nothing to breach, so nothing is claimed.
 *   end only    -> judged on its deadline alone ("deadline only").
 *   both        -> judged against the window, with the calendar burn beside the quantity progress.
 *
 * WHY THIS IS SEPARATE FROM THE HOURS BAND: a Job Order that is GREEN on hours and past its end date
 * is the most dangerous row in the portfolio, and folding the two judgements into one column would
 * erase exactly that combination. Schedule is its own axis, with its own band and its own reasons.
 *
 * Everything here is PURE so the rules can be read, printed and tested without a database. The
 * numbers the operator asked for are the published ones: a projection more than seven days beyond
 * the planned end is AT RISK, and a window closing within seven days is DUE SOON.
 */

import type { Band } from "./portfolioReporting";

/** The schedule judgement, in the order a reader should care about it. */
export type ScheduleBand = "DELAYED" | "AT_RISK" | "DUE_SOON" | "ON_PLAN" | "NOT_SCHEDULED";

/**
 * The published thresholds, as data. They are printed in the report's definitions block next to the
 * hours bands and the attention weights, so a reader can trace a flag back to the number that
 * produced it — and so tuning the noise level is one edit here, not a hunt through the UI.
 */
export const SCHEDULE_RULES = {
  /** A projection landing more than this many days beyond the planned end is AT_RISK. */
  atRiskProjectedSlipDays: 7,
  /** A planned end within this many days, with quantity outstanding, is DUE_SOON. */
  dueSoonDays: 7,
} as const;

/**
 * What the schedule axis adds to the attention score, and the reason string each weight produces.
 * Mirrored as named constants by the report's definitions block (see `portfolioReport.ts`), exactly
 * like the hours/quantity weights: changing one without the other fails a test on purpose.
 */
export const SCHEDULE_ATTENTION_WEIGHTS = {
  delayedNotComplete: 35,
  atRisk: 15,
  dueSoon: 10,
} as const;

const MS_PER_DAY = 86_400_000;

/** The planned-window band rule as printable data, alongside the report's other definitions. */
export const SCHEDULE_BAND_DEFINITIONS: Record<ScheduleBand, { label: string }> = {
  DELAYED: { label: "the planned end date has passed with quantity outstanding" },
  AT_RISK: { label: `the projected finish is more than ${SCHEDULE_RULES.atRiskProjectedSlipDays} days beyond the planned end` },
  DUE_SOON: { label: `the planned end is within ${SCHEDULE_RULES.dueSoonDays} days and quantity is outstanding` },
  ON_PLAN: { label: "inside the planned window, quantity tracking the calendar" },
  NOT_SCHEDULED: { label: "no planned window (continual / standing work)" },
};

/** One APPROVED progress entry. Only approved figures may drive a projection. */
export type ProgressPoint = { date: Date; quantity: number };

export type ScheduleInput = {
  plannedStart: Date | null;
  plannedEnd: Date | null;
  /** Budgeted quantity, and the achieved quantity of the latest APPROVED entry. */
  targetQty: number;
  achievedQty: number;
  /** `qtyCompletePct`: completed fraction, ALWAYS finite (0 when there is no quantity budget). */
  qtyCompletePct: number;
  /** APPROVED progress, oldest first. The rate comes from here, never from a single point. */
  progress: ProgressPoint[];
  now: Date;
};

export type ScheduleFacts = {
  scheduleBand: ScheduleBand;
  /** Whole days from today to the planned end; negative once it has passed. Null without an end date. */
  daysToEnd: number | null;
  /** Calendar elapsed as a fraction of the window, clamped to 0..1. Null without a full window. */
  planElapsedPct: number | null;
  /** `planElapsedPct - qtyCompletePct`: POSITIVE means the calendar has run ahead of the work
   *  (behind plan); negative means the work is ahead of the calendar. Null without a full window. */
  scheduleGapPct: number | null;
  /** Quantity per day the remaining window needs. Null once the window has closed or closed-out. */
  requiredRate: number | null;
  /** Quantity per day achieved across the approved series. Null when it cannot be measured. */
  actualRate: number | null;
  /** The projected finish day at the achieved rate. Null when it cannot honestly be projected. */
  projectedFinish: Date | null;
  /** Days the projection lands beyond the planned end (negative = early). Null as above. */
  projectedSlipDays: number | null;
  /** Human-readable reasons, in the report's voice: each one carries the numbers behind it. */
  reasons: string[];
};

/** Calendar days between two instants, counted in whole days from midnight to midnight. */
function daysBetween(from: Date, to: Date): number {
  const a = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const b = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  return Math.round((b - a) / MS_PER_DAY);
}

/** The day, printed the way every other date column in this app prints one. */
function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) + days * MS_PER_DAY);
}

/** Round to a fixed number of decimals, so a printed figure is the figure that was computed. */
function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * The achieved quantity per day across the APPROVED series.
 *
 * Refuses to measure from less than two entries, from a non-advancing series, or from a rate that is
 * not a finite positive number: a projection built on one punch, or on an average that divides by
 * zero, would produce a completion date that looks authoritative and is not. `null` means "not
 * measurable", and every caller must print that rather than a date.
 */
export function achievedRatePerDay(progress: ProgressPoint[]): number | null {
  if (progress.length < 2) return null;
  const first = progress[0];
  const last = progress[progress.length - 1];
  const days = daysBetween(first.date, last.date);
  if (days <= 0) return null;
  const rate = (last.quantity - first.quantity) / days;
  if (!Number.isFinite(rate) || rate <= 0) return null;
  return rate;
}

/**
 * Judge one Job Order's schedule.
 *
 * The returned `reasons` are written in the same voice as the hours/quantity reasons — each names
 * what happened and by how much — so a RED or AMBER schedule flag is auditable by a reader who never
 * opens this file.
 */
export function scheduleFor(input: ScheduleInput): ScheduleFacts {
  const { plannedStart, plannedEnd, targetQty, achievedQty, qtyCompletePct, progress, now } = input;

  const facts: ScheduleFacts = {
    scheduleBand: "NOT_SCHEDULED",
    daysToEnd: null,
    planElapsedPct: null,
    scheduleGapPct: null,
    requiredRate: null,
    actualRate: null,
    projectedFinish: null,
    projectedSlipDays: null,
    reasons: [],
  };

  if (!plannedStart && !plannedEnd) return facts;

  const complete = Number.isFinite(qtyCompletePct) && qtyCompletePct >= 1;
  const balance = Number.isFinite(targetQty) ? Math.max(0, targetQty - (Number.isFinite(achievedQty) ? achievedQty : 0)) : 0;
  const qtyPct = Number.isFinite(qtyCompletePct) ? Math.max(0, Math.min(1, qtyCompletePct)) : 0;

  if (plannedEnd) {
    facts.daysToEnd = daysBetween(now, plannedEnd);
  }
  if (plannedStart && plannedEnd) {
    const windowDays = daysBetween(plannedStart, plannedEnd);
    if (windowDays > 0) {
      const elapsed = Math.max(0, Math.min(windowDays, daysBetween(plannedStart, now)));
      facts.planElapsedPct = elapsed / windowDays;
      facts.scheduleGapPct = roundTo(facts.planElapsedPct - qtyPct, 3);
    }
  }

  const measured = achievedRatePerDay(progress);
  facts.actualRate = measured === null ? null : roundTo(measured, 2);
  if (plannedEnd && facts.daysToEnd !== null && facts.daysToEnd > 0 && balance > 0) {
    facts.requiredRate = roundTo(balance / facts.daysToEnd, 2);
  }
  if (facts.actualRate !== null && balance > 0) {
    const projectedFinish = addDays(now, Math.ceil(balance / facts.actualRate));
    facts.projectedFinish = projectedFinish;
    if (plannedEnd) facts.projectedSlipDays = daysBetween(plannedEnd, projectedFinish);
  }

  // ── The band, most serious first. Only facts that cannot be argued with produce a flag. ──────────
  if (plannedEnd && facts.daysToEnd !== null && facts.daysToEnd < 0 && !complete) {
    facts.scheduleBand = "DELAYED";
    facts.reasons.push(
      `planned end ${dayKey(plannedEnd)} passed ${Math.abs(facts.daysToEnd)} day(s) ago at `
      + `${Math.round(qtyPct * 100)}% of quantity`,
    );
  } else if (facts.projectedSlipDays !== null && facts.projectedSlipDays > SCHEDULE_RULES.atRiskProjectedSlipDays) {
    facts.scheduleBand = "AT_RISK";
    facts.reasons.push(
      `projected finish ${dayKey(facts.projectedFinish!)} is ${facts.projectedSlipDays} days beyond the planned end `
      + `${plannedEnd ? dayKey(plannedEnd) : "(none)"}, at ${facts.actualRate?.toFixed(2)} per day`,
    );
  } else if (
    plannedEnd && facts.daysToEnd !== null && facts.daysToEnd >= 0 &&
    facts.daysToEnd <= SCHEDULE_RULES.dueSoonDays && !complete
  ) {
    facts.scheduleBand = "DUE_SOON";
    facts.reasons.push(
      `planned end ${dayKey(plannedEnd)} is ${facts.daysToEnd} day(s) away with `
      + `${Math.round((1 - qtyPct) * 100)}% of quantity outstanding`,
    );
  } else {
    facts.scheduleBand = "ON_PLAN";
  }

  // The required rate is worth stating whenever it is materially above what the Job Order is
  // achieving — that is the one number a project manager can act on today.
  if (
    facts.requiredRate !== null && facts.actualRate !== null &&
    facts.requiredRate > facts.actualRate && facts.daysToEnd !== null && facts.daysToEnd > 0
  ) {
    facts.reasons.push(
      `needs ${facts.requiredRate.toFixed(2)} per day for the remaining ${facts.daysToEnd} day(s); `
      + `achieving ${facts.actualRate.toFixed(2)}`,
    );
  }

  return facts;
}

/**
 * The attention score's schedule component, kept beside the rules that produce the reasons so the
 * two can never disagree: a weight is only added when its reason string was pushed.
 */
export function scheduleAttention(reasons: string[], band: ScheduleBand): number {
  switch (band) {
    case "DELAYED":
      return SCHEDULE_ATTENTION_WEIGHTS.delayedNotComplete;
    case "AT_RISK":
      return SCHEDULE_ATTENTION_WEIGHTS.atRisk;
    case "DUE_SOON":
      return SCHEDULE_ATTENTION_WEIGHTS.dueSoon;
    default:
      return 0;
  }
}

/** The hours `Band` vocabulary is reused for the schedule so both columns read the same way. */
export type ScheduleBandKind = Band;

/**
 * The DAY of a stored planned date, or null. The form sends a day, the column stores UTC midnight and
 * every surface prints the day, so this is the single conversion between them: comparing or printing
 * a planned date anywhere else would be one place where a time of day could leak into a plan.
 */
export function plannedDayKey(value: Date | null | undefined): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}
