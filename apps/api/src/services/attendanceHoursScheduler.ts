import cron, { ScheduledTask } from "node-cron";
import { refreshInOutHours, scheduledRefreshWindow } from "./attendanceHours";

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
 * (default 3) for non-draft sheets. The window exists because attendance for a shift
 * lands in LabourWorks after the shift ends: the 21:00 tick usually fills the same
 * day, and the 09:00 tick catches anything that arrived overnight. Running it twice
 * changes nothing, because the write skips values that already match.
 *
 * Overlap guard: a tick is skipped while a previous run is still in flight, so a slow
 * source cannot stack two refreshes.
 */

let running = false;
let scheduledTask: ScheduledTask | null = null;

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
}

export function stopAttendanceHoursScheduler(): void {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
  }
}
