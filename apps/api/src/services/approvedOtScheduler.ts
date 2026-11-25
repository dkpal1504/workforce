import cron, { ScheduledTask } from "node-cron";
import { refreshApprovedOt } from "./approvedOt";

/**
 * Nightly backfill of the CLMS-APPROVED overtime.
 *
 * WHY IT EXISTS, IN THE CUSTOMER'S OWN TERMS: CLMS approves overtime between 2 and 15 days AFTER the
 * day worked. The sync hook and the 06:00 settlement both re-read a window, but neither is a guarantee
 * that a day approved on its twelfth day is picked up on the day it lands — the sync only refreshes
 * the last APPROVED_OT_LOOKBACK_DAYS, and the settlement only the dates it settles. This job exists so
 * the rule is stated once: EVERY approved figure inside APPROVED_OT_BACKFILL_DAYS is re-read every
 * night, so an approval that arrives late (or a correction to one already written) is stamped by the
 * morning, with no operator action.
 *
 * WHY IT IS CHEAP: the read is one query per date that actually holds a non-draft sheet, and the write
 * skips every day whose figure already matches. A 30-day window over a settled period therefore costs
 * 30 reads and zero writes — the same thing the sync does twice a day.
 *
 * WHY IT IS ON BY DEFAULT (unlike the other integrations here): it writes nothing but a figure CLMS has
 * ALREADY approved, and every screen now reports that figure — leaving it off would leave reports
 * showing zero overtime for days the yard had approved. It is still gated, and the Admin endpoints can
 * backfill by hand if it is ever switched off.
 *
 * Overlap guard: a tick is skipped while the previous one is still reading, so a slow yard server cannot
 * stack two passes.
 */

let running = false;
let scheduledTask: ScheduledTask | null = null;

function isEnabled(): boolean {
  return String(process.env.APPROVED_OT_SCHEDULE_ENABLED ?? "true").toLowerCase() !== "false";
}

function getCronExpr(): string {
  // 02:00 daily: after the 06:00/18:00 syncs, before the 06:00 settlement, and inside the yard's
  // off-peak window. Deliberately NOT the same minute as either of them.
  return process.env.APPROVED_OT_CRON || "0 2 * * *";
}

/** Days the nightly job re-reads. Must stay comfortably above CLMS's 15-day approval lag. */
export function backfillDays(): number {
  const raw = Number(process.env.APPROVED_OT_BACKFILL_DAYS || 30);
  if (!Number.isFinite(raw) || raw < 1) return 30;
  return Math.min(Math.floor(raw), 400);
}

/** The window the nightly job covers, ending today (the register clamps the future anyway). */
export function backfillWindow(now: Date = new Date()): { dateFrom: string; dateTo: string } {
  const dateTo = now.toISOString().slice(0, 10);
  const dateFrom = new Date(now.getTime() - backfillDays() * 86_400_000).toISOString().slice(0, 10);
  return { dateFrom, dateTo };
}

async function runOnce(): Promise<void> {
  if (running) {
    console.warn("[approvedOt] Skipping tick — previous backfill still in progress (overlap guard).");
    return;
  }
  running = true;
  try {
    const { dateFrom, dateTo } = backfillWindow();
    const result = await refreshApprovedOt({ dateFrom, dateTo });
    if (result.errors.length) {
      console.error(
        `[approvedOt] backfill: ${result.errors.length} date(s) could not be read — ${result.errors[0].message}`
      );
    }
    console.log(
      `[approvedOt] backfill ${dateFrom}..${dateTo}: sheets=${result.sheets} withApprovedOt=${result.withApprovedOt} ` +
        `written=${result.updated} unchanged=${result.unchanged} manual=${result.manualSkipped} ` +
        `datesRead=${result.datesRead.length}`
    );
  } catch (error) {
    console.error("[approvedOt] Backfill failed:", error instanceof Error ? error.message : error);
  } finally {
    running = false;
  }
}

/** Start the nightly job if enabled. Safe to call once at API boot. */
export function startApprovedOtScheduler(): void {
  if (scheduledTask) return;
  if (!isEnabled()) {
    console.log("[approvedOt] Backfill disabled (APPROVED_OT_SCHEDULE_ENABLED=false).");
    return;
  }
  const expr = getCronExpr();
  if (!cron.validate(expr)) {
    console.error(`[approvedOt] Invalid APPROVED_OT_CRON expression: "${expr}". Backfill not scheduled.`);
    return;
  }
  scheduledTask = cron.schedule(expr, () => { void runOnce(); });
  const { dateFrom, dateTo } = backfillWindow();
  console.log(
    `[approvedOt] Backfill scheduled with cron "${expr}" over ${backfillDays()} day(s) (next window ${dateFrom}..${dateTo}).`
  );
}

/** Run one backfill now (tests and the Admin trigger). */
export async function runApprovedOtBackfillNow(): Promise<void> {
  await runOnce();
}

/** Stop scheduled work during graceful process shutdown. */
export function stopApprovedOtScheduler(): void {
  scheduledTask?.stop();
  scheduledTask = null;
}
