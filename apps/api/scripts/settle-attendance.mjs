#!/usr/bin/env node
/**
 * Settle attendance for a date range, from the command line.
 *
 *   npm run settle:attendance -- --from 2026-09-21 --to 2026-10-23 --dry-run
 *   npm run settle:attendance -- --from 2026-09-21            (to = today)
 *
 * A thin wrapper over the compiled service, for the same reason the holiday reconciliation is one: the
 * production image installs `npm ci --omit=dev`, so a TypeScript runner would not exist there. Everything
 * here runs from `dist`.
 *
 * The dry run reads the register, resolves the day types, plans every row and prints the anomalies WITHOUT
 * writing anything — the way to see a settlement before it exists.
 */
import { settleAttendance, formatSettlementSummary } from "../dist/services/attendanceSettlementRun.js";
import { todayInAppZone } from "../dist/services/attendanceRegisterSource.js";

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

async function main() {
  const to = arg("to", todayInAppZone());
  const from = arg("from", to);
  if (!isDate(from) || !isDate(to)) throw new Error(`dates must be YYYY-MM-DD (got ${from}..${to})`);

  const result = await settleAttendance({ from, to, dryRun: flag("dry-run") });
  console.log(formatSettlementSummary(result));

  if (!result.dryRun && result.anomalies.unmatchedRegisterIds.length) {
    console.log("");
    console.log("First unmatched register ids (no Employee row):");
    for (const id of result.anomalies.unmatchedRegisterIds.slice(0, 10)) console.log(`  ${id}`);
  }
}

main().catch((error) => {
  console.error(`[settle] FAILED: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
