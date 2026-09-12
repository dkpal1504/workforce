import cron, { ScheduledTask } from "node-cron";
import { runBadgeViewSync } from "./badgeViewSync";
import { processCredentialDeliveries } from "./credentialDelivery";

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
let delivering = false;
let scheduledTask: ScheduledTask | null = null;
let credentialTask: ScheduledTask | null = null;

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
          `departments=${result.departmentsCreated} sections=${result.sectionsCreated} ` +
          `terminated=${result.terminated} reactivated=${result.reactivated} exceptions=${result.exceptions} ` +
          `credentialsQueued=${result.credentialsQueued} ` +
          `(${result.startedAt.toISOString()} → ${result.finishedAt.toISOString()})`
      );
    } else {
      console.error(`[badgeViewSync] FAILED — ${result.error}`);
    }

  } finally {
    running = false;
  }
}

async function runCredentialDeliveryOnce(): Promise<void> {
  if (delivering) return;
  delivering = true;
  try {
    const delivery = await processCredentialDeliveries();
    if (delivery.disabled) {
      if (delivery.pending > 0) console.warn(`[credentialDelivery] SMTP is not configured; ${delivery.pending} item(s) remain pending.`);
    } else {
      console.log(`[credentialDelivery] processed=${delivery.processed} sent=${delivery.sent} failed=${delivery.failed} pending=${delivery.pending}`);
    }
  } catch (error) {
    console.error("[credentialDelivery] Worker failed:", error instanceof Error ? error.message : error);
  } finally {
    delivering = false;
  }
}

/** Start the scheduler if enabled. Safe to call once at API boot. */
export function startBadgeViewSyncScheduler(): void {
  if (!credentialTask && String(process.env.CREDENTIAL_DELIVERY_ENABLED || "true").toLowerCase() === "true") {
    const credentialExpr = process.env.CREDENTIAL_DELIVERY_CRON || "*/5 * * * *";
    if (cron.validate(credentialExpr)) {
      credentialTask = cron.schedule(credentialExpr, () => { void runCredentialDeliveryOnce(); });
      void runCredentialDeliveryOnce();
      console.log(`[credentialDelivery] Scheduled with cron "${credentialExpr}".`);
    } else {
      console.error(`[credentialDelivery] Invalid CREDENTIAL_DELIVERY_CRON: "${credentialExpr}".`);
    }
  }
  if (scheduledTask) return;
  if (!isEnabled()) {
    console.log("[badgeViewSync] Disabled (BADGEVIEW_SYNC_ENABLED != true). No-op.");
    return;
  }
  const expr = getCronExpr();
  if (!cron.validate(expr)) {
    console.error(`[badgeViewSync] Invalid BADGEVIEW_SYNC_CRON expression: "${expr}". Sync not scheduled.`);
    return;
  }
  scheduledTask = cron.schedule(expr, () => { void runOnce(); });
  console.log(`[badgeViewSync] Scheduled with cron "${expr}".`);
}

/** Run one sync pass immediately (used by tests / manual trigger). */
export async function runBadgeViewSyncNow(): Promise<void> {
  await runOnce();
  await runCredentialDeliveryOnce();
}

/** Stop scheduled work during graceful process shutdown. */
export function stopBadgeViewSyncScheduler(): void {
  scheduledTask?.stop();
  credentialTask?.stop();
  scheduledTask = null;
  credentialTask = null;
}
