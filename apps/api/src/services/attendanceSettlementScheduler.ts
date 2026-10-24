import cron, { ScheduledTask } from "node-cron";
import { settleAttendance, settleWindow } from "./attendanceSettlementRun";

/**
 * Nightly attendance settlement.
 *
 * Gated by ATTENDANCE_SETTLEMENT_ENABLED (default false, like every other external integration here: a
 * job that writes thousands of rows is switched on deliberately, never by a deploy).
 *
 * Each tick settles TODAY and the ATTENDANCE_SETTLEMENT_LOOKBACK_DAYS days before it (default 7). The
 * window exists for the same reason the hours refresh has one: LabourWorks receives punches, regularisations
 * and OT approvals AFTER the shift, so yesterday's answer can change for days. Re-settling is safe by
 * construction — every row is upserted on its natural key — so a corrected punch simply overwrites the
 * settled value and nothing is duplicated.
 *
 * Overlap guard: a tick is skipped while the previous pass is still running, so a slow source cannot stack
 * two settlements on top of each other.
 */

let running = false;
let scheduledTask: ScheduledTask | null = null;

function isEnabled(): boolean {
  return String(process.env.ATTENDANCE_SETTLEMENT_ENABLED || "false").toLowerCase() === "true";
}

function lookbackDays(): number {
  const raw = Number(process.env.ATTENDANCE_SETTLEMENT_LOOKBACK_DAYS || 7);
  return Number.isFinite(raw) && raw >= 0 ? Math.min(90, Math.trunc(raw)) : 7;
}

async function runOnce(): Promise<void> {
  if (running) {
    console.warn("[attendanceSettlement] Skipping tick — previous settlement still in progress.");
    return;
  }
  running = true;
  try {
    const { from, to } = settleWindow(undefined, lookbackDays());
    const result = await settleAttendance({ from, to });
    console.log(
      `[attendanceSettlement] ${result.from}..${result.to} source=${result.source} ` +
        `man-days=${result.daysWritten} dates=${result.calendarWritten} run=${result.runId} ` +
        `unmatched=${result.anomalies.unmatchedRegisterIds.length} missingDates=${result.anomalies.missingDates.length}`
    );
  } catch (error) {
    // The run row carries the FAILED status; the log carries the sentence a human needs at 02:10.
    console.error(
      "[attendanceSettlement] FAILED:",
      error instanceof Error ? error.message : error
    );
  } finally {
    running = false;
  }
}

export function startAttendanceSettlementScheduler(): void {
  if (!isEnabled()) {
    console.log("[attendanceSettlement] Disabled (ATTENDANCE_SETTLEMENT_ENABLED is not true).");
    return;
  }
  const expr = process.env.ATTENDANCE_SETTLEMENT_CRON || "10 2 * * *";
  if (!cron.validate(expr)) {
    console.error(`[attendanceSettlement] Invalid ATTENDANCE_SETTLEMENT_CRON: "${expr}".`);
    return;
  }
  scheduledTask = cron.schedule(expr, () => {
    void runOnce();
  });
  console.log(
    `[attendanceSettlement] Scheduled "${expr}" over the last ${lookbackDays()} day(s).`
  );
}

export function stopAttendanceSettlementScheduler(): void {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
  }
}

/** Test seam: run one pass exactly as the cron tick does. */
export const runSettlementOnce = runOnce;
