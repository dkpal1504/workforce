import cron, { ScheduledTask } from "node-cron";
import { neverStampedApprovedOtDates, refreshApprovedOt } from "./approvedOt";

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
 * THE WINDOW ALONE IS NOT ENOUGH, AND THAT IS THE SECOND HALF OF THE JOB. Every writer looks backwards
 * from TODAY, so a month that closed before this feature was switched on — or before a host was down
 * for a few weeks — is never inside any window and stays NULL ("never fetched") for ever. Production
 * showed exactly that: from 26-Oct onward every sheet was stamped, while September and 1-25 October
 * sat at NULL and the reports read them as zero overtime. So after the window pass this job ALSO reads
 * the older dates that still hold a non-draft sheet with no stamp at all (`neverStampedApprovedOtDates`),
 * capped per night, until the hole is closed. `approved_ot_hours IS NULL` is what makes this safe:
 * every successful read stamps an explicit figure, so a NULL is a date nobody ever asked about.
 * A date CLMS cannot answer for stays NULL and is retried tomorrow — one bad date never hides the rest.
 *
 * WHY IT IS CHEAP: the read is one query per date that actually holds a non-draft sheet, and the write
 * skips every day whose figure already matches. A 30-day window over a settled period therefore costs
 * 30 reads and zero writes — the same thing the sync does twice a day — and an empty catch-up costs
 * ONE indexed query.
 *
 * WHY IT IS ON BY DEFAULT (unlike the other integrations here): it writes nothing but a figure CLMS has
 * ALREADY approved, and every screen now reports that figure — leaving it off would leave reports
 * showing zero overtime for days the yard had approved. It is still gated, and the Admin endpoints can
 * backfill by hand if it is ever switched off. For a period older than the catch-up horizon (or a
 * one-off repair), `apps/api/scripts/backfill-approved-ot.mjs --from … --to …` runs the same service.
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

/**
 * How far back a NEVER-STAMPED date is picked up. Older than the nightly window by definition (the
 * window already covers the recent days), and wide enough to take in the month before a deployment.
 * 400 is the service's own upper bound on a refresh range, so a wider setting could not be honoured.
 */
export function catchUpDays(): number {
  const raw = Number(process.env.APPROVED_OT_CATCHUP_DAYS || 120);
  if (!Number.isFinite(raw) || raw < 1) return 120;
  return Math.min(Math.floor(raw), 400);
}

/** How many never-stamped DATES one night repairs. A long outage is closed over several nights. */
export function catchUpDatesPerNight(): number {
  const raw = Number(process.env.APPROVED_OT_CATCHUP_DATES || 90);
  if (!Number.isFinite(raw) || raw < 1) return 90;
  return Math.min(Math.floor(raw), 400);
}

/** The window the nightly job covers, ending today (the register clamps the future anyway). */
export function backfillWindow(now: Date = new Date()): { dateFrom: string; dateTo: string } {
  const dateTo = now.toISOString().slice(0, 10);
  const dateFrom = new Date(now.getTime() - backfillDays() * 86_400_000).toISOString().slice(0, 10);
  return { dateFrom, dateTo };
}

/** The horizon the catch-up looks back over, ENDING THE DAY BEFORE the nightly window starts. */
export function catchUpWindow(now: Date = new Date()): { dateFrom: string; dateTo: string } {
  const window = backfillWindow(now);
  const dayBefore = new Date(new Date(`${window.dateFrom}T00:00:00.000Z`).getTime() - 86_400_000);
  const dateFrom = new Date(now.getTime() - catchUpDays() * 86_400_000).toISOString().slice(0, 10);
  return { dateFrom, dateTo: dayBefore.toISOString().slice(0, 10) };
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

    // The catch-up. Deliberately a SECOND pass over a different set of dates, not a widened window:
    // a widened window would re-read 120 days of CLMS every night for ever, while this reads only
    // the dates that have never been stamped and goes quiet as soon as the hole is closed.
    const gap = catchUpWindow();
    const missing = gap.dateFrom <= gap.dateTo
      ? await neverStampedApprovedOtDates({ dateFrom: gap.dateFrom, dateTo: gap.dateTo, limit: catchUpDatesPerNight() })
      : [];
    if (!missing.length) return;
    const caught = await refreshApprovedOt({
      dateFrom: missing[0],
      dateTo: missing[missing.length - 1],
      dates: missing,
    });
    console.log(
      `[approvedOt] catch-up ${gap.dateFrom}..${gap.dateTo}: ${missing.length} never-stamped date(s) ` +
        `read=${caught.datesRead.length} written=${caught.updated} unchanged=${caught.unchanged} ` +
        `manual=${caught.manualSkipped} errors=${caught.errors.length}`
    );
    if (caught.errors.length) {
      console.error(`[approvedOt] catch-up: ${caught.errors[0].date} — ${caught.errors[0].message}`);
    }
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
  const gap = catchUpWindow();
  console.log(
    `[approvedOt] Backfill scheduled with cron "${expr}" over ${backfillDays()} day(s) (next window ${dateFrom}..${dateTo}); ` +
      `catch-up horizon ${gap.dateFrom}..${gap.dateTo}, ${catchUpDatesPerNight()} date(s) per night.`
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
