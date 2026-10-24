import cron, { ScheduledTask } from "node-cron";
import { captureAllReviewSnapshots } from "./reviewSnapshot";
import { defaultPeriod } from "./reviewData";

/**
 * Weekly and monthly review freezes.
 *
 * Gated by REVIEW_SNAPSHOT_ENABLED (default FALSE): a job that writes a frozen row for every project is
 * switched on deliberately, never by a deploy. The same rule the attendance settlement follows.
 *
 * Two schedules, both the owner's business clock:
 *   - weekly, Monday 00:30, freezes the week that ended Sunday 23:59:59
 *   - monthly, 1st at 01:30, freezes the calendar month that ended
 *
 * A monthly snapshot is its OWN capture, never a re-aggregation of weekly ones: re-aggregating would give one
 * month two different numbers depending on which endpoint you asked.
 *
 * The overlap guard matters more here than for most jobs: a freeze walks every project and each one costs a
 * full payload build. A slow run must finish before the next tick starts, or two runs would fight over the
 * same period and the second would find nothing to do anyway.
 */

let running = false;
let weeklyTask: ScheduledTask | null = null;
let monthlyTask: ScheduledTask | null = null;

function isEnabled(): boolean {
  return String(process.env.REVIEW_SNAPSHOT_ENABLED || "false").toLowerCase() === "true";
}

/** The week that just ended: previous Monday 00:00 to Sunday 23:59:59. */
export function previousWeekWindow(now: Date): { start: string; end: string } {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const weekday = (day.getUTCDay() + 6) % 7; // Monday = 0
  const thisMonday = new Date(day.getTime() - weekday * 86_400_000);
  const previousMonday = new Date(thisMonday.getTime() - 7 * 86_400_000);
  const previousSunday = new Date(thisMonday.getTime() - 86_400_000);
  return { start: iso(previousMonday), end: iso(previousSunday) };
}

/** The calendar month that just ended. */
export function previousMonthWindow(now: Date): { start: string; end: string } {
  const firstOfThisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const lastOfPreviousMonth = new Date(firstOfThisMonth.getTime() - 86_400_000);
  const firstOfPreviousMonth = new Date(
    Date.UTC(lastOfPreviousMonth.getUTCFullYear(), lastOfPreviousMonth.getUTCMonth(), 1)
  );
  return { start: iso(firstOfPreviousMonth), end: iso(lastOfPreviousMonth) };
}

async function runOnce(kind: "WEEKLY" | "MONTHLY"): Promise<void> {
  if (running) {
    console.warn("[reviewSnapshot] Skipping tick — the previous freeze is still running.");
    return;
  }
  running = true;
  const startedAt = new Date();
  try {
    const now = new Date();
    const window = kind === "WEEKLY" ? previousWeekWindow(now) : previousMonthWindow(now);
    const result = await captureAllReviewSnapshots({
      period: { kind, start: window.start, end: window.end },
      trigger: "SCHEDULED",
      now,
    });
    console.log(
      `[reviewSnapshot] ${kind} ${window.start}..${window.end} captured=${result.captured} skipped=${result.skipped} ` +
        `failed=${result.failed} in ${Date.now() - startedAt.getTime()}ms`
    );
    if (result.failed) console.warn("[reviewSnapshot] failures:", result.failures);
  } catch (error) {
    console.error("[reviewSnapshot] run failed:", error);
  } finally {
    running = false;
  }
}

export function startReviewSnapshotScheduler(): void {
  if (!isEnabled()) {
    console.log("[reviewSnapshot] Disabled (REVIEW_SNAPSHOT_ENABLED is not true). No-op.");
    return;
  }
  const weekly = process.env.REVIEW_SNAPSHOT_WEEKLY_CRON || "30 0 * * 1";
  const monthly = process.env.REVIEW_SNAPSHOT_MONTHLY_CRON || "30 1 1 * *";
  if (!cron.validate(weekly) || !cron.validate(monthly)) {
    console.error("[reviewSnapshot] Invalid cron expression; the scheduler will not start.");
    return;
  }
  weeklyTask = cron.schedule(weekly, () => void runOnce("WEEKLY"), { timezone: process.env.TZ || "UTC" });
  monthlyTask = cron.schedule(monthly, () => void runOnce("MONTHLY"), { timezone: process.env.TZ || "UTC" });
  console.log(`[reviewSnapshot] Scheduled weekly "${weekly}" and monthly "${monthly}".`);
}

export function stopReviewSnapshotScheduler(): void {
  weeklyTask?.stop();
  monthlyTask?.stop();
  weeklyTask = null;
  monthlyTask = null;
}

/** Exported for the deploy-time catch-up script, which must not wait for a Monday. */
export { runOnce as runReviewSnapshotOnce };

function iso(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** The default window if a caller only names a kind — kept here so the script and the cron agree. */
export function windowForKind(kind: "WEEKLY" | "MONTHLY", now = new Date()): { start: string; end: string } {
  return kind === "WEEKLY" ? previousWeekWindow(now) : previousMonthWindow(now);
}

export { defaultPeriod };
