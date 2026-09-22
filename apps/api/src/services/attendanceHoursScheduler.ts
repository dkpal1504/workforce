import cron, { ScheduledTask } from "node-cron";
import { attendancePolicy, refreshInOutHours, scheduledRefreshWindow, sweepPendingInOutHours } from "./attendanceHours";

/**
 * Clocked attendance hours (in/out) scheduler.
 *
 * Gated by ATTENDANCE_HOURS_ENABLED (default false, like BADGEVIEW_SYNC_ENABLED: an
 * external integration is switched on deliberately, never by accident). The cron
 * expression comes from ATTENDANCE_HOURS_CRON (default `0 9,21 * * *` = 09:00 and
 * 21:00 daily), which the owner asked for so the yard's off-peak window is used and
 * the Admin does not have to press the button.
 *
 * Each tick refreshes TODAY and the ATTENDANCE_HOURS_LOOKBACK_DAYS days before it
 * (default 7, sized to the yard's regularization SLA) for non-draft sheets. The window
 * exists because attendance for a shift lands in LabourWorks after the shift ends, and
 * because a regularized day can change days later: the 21:00 tick usually fills the
 * same day, and every later tick re-reads the whole window and corrects what changed.
 * Running it twice changes nothing, because the write skips values that already match.
 *
 * A second, weekly job (ATTENDANCE_HOURS_SWEEP_CRON, default Sunday 04:00) sweeps the
 * WHOLE regularization horizon (ATTENDANCE_HOURS_MAX_AGE_DAYS, default 45) but only for
 * days that still have nothing usable. That is the safety net for regularization that
 * took longer than the daily window: it is cheap because it reads the database first
 * and only asks LabourWorks about the dates that are actually still pending.
 *
 * Overlap guard: a tick is skipped while a previous run is still in flight, so a slow
 * source cannot stack two refreshes.
 */

let running = false;
let sweeping = false;
let scheduledTask: ScheduledTask | null = null;
let sweepTask: ScheduledTask | null = null;

function isEnabled(): boolean {
  return String(process.env.ATTENDANCE_HOURS_ENABLED || "false").toLowerCase() === "true";
}

async function runOnce(): Promise<void> {
  if (running) {
    console.warn("[attendanceHours] Skipping tick — previous run still in progress (overlap guard).");
    return;
  }
  running = true;
  try {
    const { dateFrom, dateTo } = scheduledRefreshWindow();
    const result = await refreshInOutHours({ dateFrom, dateTo });
    if (result.errors.length) {
      console.error(
        `[attendanceHours] FAILED for ${result.errors.length} day(s) — ${result.errors[0].message}`
      );
    }
    console.log(
      `[attendanceHours] ${dateFrom}..${dateTo} sheets=${result.sheets} matched=${result.matched} ` +
        `updated=${result.updated} unchanged=${result.unchanged} unmatched=${result.unmatched}`
    );
  } catch (error) {
    console.error("[attendanceHours] Worker failed:", error instanceof Error ? error.message : error);
  } finally {
    running = false;
  }
}

async function sweepOnce(): Promise<void> {
  if (sweeping) {
    console.warn("[attendanceHours] Skipping sweep — previous sweep still in progress (overlap guard).");
    return;
  }
  sweeping = true;
  try {
    const horizon = attendancePolicy().maxAgeDays;
    const result = await sweepPendingInOutHours({ maxAgeDays: horizon });
    if (result.errors.length) {
      console.error(`[attendanceHours] sweep FAILED for ${result.errors.length} day(s) — ${result.errors[0].message}`);
    }
    console.log(
      `[attendanceHours] sweep over ${horizon} day(s): pendingBefore=${result.pendingBefore} ` +
        `checked=${result.sheets} updated=${result.updated} pendingAfter=${result.pending}`
    );
  } catch (error) {
    console.error("[attendanceHours] Sweep failed:", error instanceof Error ? error.message : error);
  } finally {
    sweeping = false;
  }
}

/** Start the scheduler if enabled. Safe to call once at API boot. */
export function startAttendanceHoursScheduler(): void {
  if (scheduledTask) return;
  if (!isEnabled()) {
    console.log("[attendanceHours] Disabled (ATTENDANCE_HOURS_ENABLED != true). No-op.");
    return;
  }
  const expr = process.env.ATTENDANCE_HOURS_CRON || "0 9,21 * * *";
  if (!cron.validate(expr)) {
    console.error(`[attendanceHours] Invalid ATTENDANCE_HOURS_CRON: "${expr}".`);
    return;
  }
  scheduledTask = cron.schedule(expr, () => { void runOnce(); });
  console.log(`[attendanceHours] Scheduled with cron "${expr}".`);

  if (String(process.env.ATTENDANCE_HOURS_SWEEP_ENABLED || "true").toLowerCase() !== "false") {
    const sweepExpr = process.env.ATTENDANCE_HOURS_SWEEP_CRON || "0 4 * * 0";
    if (cron.validate(sweepExpr)) {
      sweepTask = cron.schedule(sweepExpr, () => { void sweepOnce(); });
      console.log(`[attendanceHours] Sweep scheduled with cron "${sweepExpr}" (horizon ${attendancePolicy().maxAgeDays} days).`);
    } else {
      console.error(`[attendanceHours] Invalid ATTENDANCE_HOURS_SWEEP_CRON: "${sweepExpr}".`);
    }
  }
}

export function stopAttendanceHoursScheduler(): void {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
  }
  if (sweepTask) {
    sweepTask.stop();
    sweepTask = null;
  }
}
