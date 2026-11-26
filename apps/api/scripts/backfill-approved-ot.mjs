#!/usr/bin/env node
/**
 * Backfill the CLMS-APPROVED overtime for an explicit date range, from the command line.
 *
 *   node apps/api/scripts/backfill-approved-ot.mjs --from 2026-09-01 --to 2026-10-31 --dry-run
 *   node apps/api/scripts/backfill-approved-ot.mjs --from 2026-09-01 --to 2026-10-31
 *   node apps/api/scripts/backfill-approved-ot.mjs --month 2026-09          (whole calendar month)
 *
 * WHY IT EXISTS: the automatic writers only ever re-read a WINDOW (`APPROVED_OT_LOOKBACK_DAYS` = 21 on
 * the sync hook, `APPROVED_OT_BACKFILL_DAYS` = 30 on the nightly job), so nothing reaches a month that
 * closed BEFORE the feature was switched on. Prod showed exactly that: every sheet from 26-Oct was
 * stamped and the whole of September plus 1-25 October stayed NULL ("never fetched"), which reads in
 * the reports as zero overtime.
 *
 * A thin wrapper over the compiled service, the same convention as `settle-attendance.mjs`: the
 * production image installs `npm ci --omit=dev`, so a TypeScript runner would not exist there.
 * Everything here runs from `dist`, and it calls the SAME `refreshApprovedOt` the nightly job calls —
 * one definition of the read, the match and the write, and idempotent (a day whose figure already
 * matches is not written again). `MANUAL` days are never touched: an Admin's figure is a decision.
 *
 * Dry run prints what would change and writes NOTHING — use it first on any range you have not run.
 */
import { refreshApprovedOt, formatApprovedOtSummary } from "../dist/services/approvedOt.js";

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`--${name} needs a value`);
  return value;
}

function flag(name) {
  return process.argv.includes(`--${name}`);
}

const isDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value);

/** `2026-09` -> { dateFrom: "2026-09-01", dateTo: "2026-09-30" } (UTC, like every date here). */
function monthRange(month) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`--month must be YYYY-MM (got ${month})`);
  const start = new Date(`${month}-01T00:00:00.000Z`);
  if (Number.isNaN(start.getTime())) throw new Error(`--month is not a real month (${month})`);
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
  return { dateFrom: start.toISOString().slice(0, 10), dateTo: end.toISOString().slice(0, 10) };
}

async function main() {
  // Either ONE month or an explicit range; a half-given range is refused rather than guessed,
  // because the guess would silently stamp a period nobody asked about.
  const month = arg("month", null);
  const from = arg("from", null);
  const to = arg("to", null);
  let range;
  if (month) {
    if (from || to) throw new Error("Use either --month or --from/--to, not both.");
    range = monthRange(month);
  } else {
    if (!from || !to) throw new Error("Give --from and --to (YYYY-MM-DD), or --month YYYY-MM.");
    if (!isDate(from) || !isDate(to)) throw new Error(`dates must be YYYY-MM-DD (got ${from}..${to})`);
    range = { dateFrom: from, dateTo: to };
  }

  const result = await refreshApprovedOt({
    ...range,
    dryRun: flag("dry-run"),
    includeDraft: flag("include-draft"),
  });
  console.log(formatApprovedOtSummary(result));

  // A range where CLMS answered for NOTHING is a failed read, not "no overtime": say so and exit
  // non-zero, so a runbook stops instead of leaving a month looking approved-at-zero.
  if (result.sheets > 0 && result.datesRead.length === 0) {
    console.error(
      `\nCLMS answered for none of ${range.dateFrom}..${range.dateTo}. Nothing was stamped.` +
        (result.errors.length ? ` First error: ${result.errors[0].message}` : "")
    );
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
