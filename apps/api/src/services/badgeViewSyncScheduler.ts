import cron, { ScheduledTask } from "node-cron";
import { runBadgeViewSync } from "./badgeViewSync";

/**
 * In-process BadgeView sync scheduler.
 *
 * Gated by BADGEVIEW_SYNC_ENABLED (default false). Reads the cron expression
 * from BADGEVIEW_SYNC_CRON (default: 0 6,18 * * * = 06:00 and 18:00 daily).
 *
 * Overlap guard: if a previous run is still in flight when the next tick fires,
 * that tick is skipped (logged) so a slow sync can't double-fire.
 */

let running = false;
let scheduledTask: ScheduledTask | null = null;

function isEnabled(): boolean {
  return String(process.env.BADGEVIEW_SYNC_ENABLED || "false").toLowerCase() === "true";
}

function getCronExpr(): string {
  return process.env.BADGEVIEW_SYNC_CRON || "0 6,18 * * *";
}

async function runOnce(): Promise<void> {
  if (running) {
    console.warn("[badgeViewSync] Skipping tick — previous run still in progress (overlap guard).");
    return;
  }
  running = true;
  try {
    const result = await runBadgeViewSync();
    if (result.ok) {
      console.log(
        `[badgeViewSync] OK — workers=${result.workersUpserted} supervisorsLinked=${result.supervisorsLinked} ` +
          `departments=${result.departmentsCreated} softDeparted=${result.softDeparted} ` +
          `(${result.startedAt.toISOString()} → ${result.finishedAt.toISOString()})`
      );
    } else {
      console.error(`[badgeViewSync] FAILED — ${result.error}`);
    }
  } finally {
    running = false;
  }
}

/** Start the scheduler if enabled. Safe to call once at API boot. */
export function startBadgeViewSyncScheduler(): void {
  if (scheduledTask) return; // already started
  if (!isEnabled()) {
    console.log("[badgeViewSync] Disabled (BADGEVIEW_SYNC_ENABLED != true). No-op.");
    return;
  }
  const expr = getCronExpr();
  if (!cron.validate(expr)) {
    console.error(`[badgeViewSync] Invalid BADGEVIEW_SYNC_CRON expression: "${expr}". Sync not scheduled.`);
    return;
  }
  scheduledTask = cron.schedule(expr, () => {
    void runOnce();
  });
  console.log(`[badgeViewSync] Scheduled with cron "${expr}".`);
}

/** Run one sync pass immediately (used by tests / manual trigger). */
export async function runBadgeViewSyncNow(): Promise<void> {
  await runOnce();
}
