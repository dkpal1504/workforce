/**
 * Pure rules for answering "is the LabourWorks refresh happening on time?".
 *
 * Kept out of the router because these are the two decisions that are easy to get wrong and
 * expensive to get wrong in front of an operator:
 *
 *  - **How overdue is overdue?** A fixed "24 hours" contradicts the configured cadence: the
 *    default schedule is `0 6,18 * * *` (twice a day), so a run that has not happened for
 *    20 hours is already late, while a daily 06:00 schedule at 20 hours is perfectly normal.
 *    The threshold is therefore DERIVED from the cron expression's own maximum gap between
 *    runs, plus a grace period. A wrong threshold produces either false alarms every quiet
 *    afternoon or a real outage that reads "FRESH".
 *  - **Absence of a run is different from a failed run.** "Never ran" and "ran and threw" are
 *    different faults with different fixes, so they are different states here.
 *
 * No clock is read in this module: every function takes `now`. That is what makes the
 * boundaries testable, and it keeps the UTC/IST question in one place (the caller).
 */

/** Audit actions that represent a sync RUN (as opposed to a per-record effect). */
export const SYNC_RUN_ACTIONS = ["SYNC_SCHEDULED_RUN", "SYNC_ONE_SHOT_RUN", "ADMIN_BADGEVIEW_SYNC"] as const;

/** Which of those actually means "the schedule fired on its own". */
export const SCHEDULED_RUN_ACTION = "SYNC_SCHEDULED_RUN";

export type FreshnessState = "NEVER" | "FAILED" | "OVERDUE" | "FRESH";

export type SyncCadence = {
  /** How many times a day the schedule fires. */
  runsPerDay: number;
  /** The longest gap between two consecutive runs, in hours. */
  maxGapHours: number;
  /** maxGap + grace: past this the data is reported overdue. */
  overdueAfterHours: number;
};

export type Freshness = {
  state: FreshnessState;
  /** Hours since the last data refresh, or null when there has never been one. */
  ageHours: number | null;
  /** The threshold the state was judged against, or null when the cadence is unknown. */
  overdueAfterHours: number | null;
};

/**
 * The hours a standard 5-field cron fires at, or null when the expression cannot be read.
 *
 * Supports the forms this job actually uses and nothing more: `*`, `H`, `H1,H2,...` and
 * `*&#47;N` in the HOUR field. Anything else returns null, which the caller renders as
 * "cadence unknown" — deliberately, because guessing a cadence is how you publish a
 * confidently wrong overdue badge.
 *
 * The day/month/day-of-week fields must be `*`. A schedule restricted to certain days
 * (`0 6,18 * * MON`) fires weekly, not twice a day, so reading its HOUR field alone would
 * claim a 12-hour cadence and then report the feed OVERDUE on the other six days of the
 * week. An unknown cadence is the honest answer there, and it fails in the safe direction.
 */
export function parseCronHours(expr: string): number[] | null {
  const parts = String(expr ?? "").trim().split(/\s+/);
  if (parts.length !== 5) return null;
  // fields: 0 minute, 1 hour, 2 day-of-month, 3 month, 4 day-of-week
  if (parts[2] !== "*" || parts[3] !== "*" || parts[4] !== "*") return null;
  const hours = new Set<number>();
  for (const piece of parts[1].split(",")) {
    if (piece === "*") {
      for (let hour = 0; hour < 24; hour += 1) hours.add(hour);
    } else if (/^\*\/\d+$/.test(piece)) {
      const step = Number(piece.slice(2));
      if (step < 1 || step > 24) return null;
      for (let hour = 0; hour < 24; hour += step) hours.add(hour);
    } else if (/^\d+$/.test(piece)) {
      const hour = Number(piece);
      if (hour < 0 || hour > 23) return null;
      hours.add(hour);
    } else {
      return null;
    }
  }
  return hours.size ? [...hours].sort((a, b) => a - b) : null;
}

/**
 * The cadence, and the overdue threshold, implied by a cron expression.
 *
 * `graceHours` exists because a run that lands a few minutes after its slot is normal, and a
 * badge that flips the moment the clock passes the slot trains the operator to ignore it.
 */
export function syncCadence(expr: string, graceHours = 2): SyncCadence | null {
  const hours = parseCronHours(expr);
  if (!hours) return null;
  let maxGap = 0;
  for (let index = 0; index < hours.length; index += 1) {
    const next = hours[(index + 1) % hours.length];
    // The last run of the day wraps around midnight to the first.
    const gap = index === hours.length - 1 ? 24 - hours[index] + next : next - hours[index];
    if (gap > maxGap) maxGap = gap;
  }
  return { runsPerDay: hours.length, maxGapHours: maxGap, overdueAfterHours: maxGap + graceHours };
}

/**
 * The state to show, from the last refresh time and how that last run ended.
 *
 * Precedence is deliberate and matches the order the operator would investigate:
 *   NEVER   — no data has ever arrived; nothing else about it matters.
 *   FAILED  — the most recent attempt threw. This outranks OVERDUE because it names the
 *             cause, and a failed run is usually also why the data is old.
 *   OVERDUE — a run is late against the configured cadence.
 *   FRESH   — nothing to report.
 */
export function syncFreshness(args: {
  lastRefreshAt: Date | null;
  lastRunOk: boolean | null;
  now: Date;
  overdueAfterHours: number | null;
}): Freshness {
  const { lastRefreshAt, lastRunOk, now, overdueAfterHours } = args;
  if (!lastRefreshAt) return { state: "NEVER", ageHours: null, overdueAfterHours };
  const ageHours = Math.max(0, (now.getTime() - lastRefreshAt.getTime()) / 3_600_000);
  if (lastRunOk === false) return { state: "FAILED", ageHours, overdueAfterHours };
  if (overdueAfterHours != null && ageHours > overdueAfterHours) return { state: "OVERDUE", ageHours, overdueAfterHours };
  return { state: "FRESH", ageHours, overdueAfterHours };
}

/** Where a run came from, in words an operator recognises. */
export function runTriggerLabel(action: string): string {
  if (action === SCHEDULED_RUN_ACTION) return "the schedule";
  if (action === "SYNC_ONE_SHOT_RUN") return "a one-shot run in the container";
  if (action === "ADMIN_BADGEVIEW_SYNC") return "an admin refresh";
  return action;
}
