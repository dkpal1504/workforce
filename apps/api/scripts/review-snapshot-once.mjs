#!/usr/bin/env node
/**
 * Freeze one review period now, for every project, without waiting for a Monday.
 *
 * Runs the COMPILED service (the production image installs with --omit=dev and has no tsx), exactly like
 * settle-attendance.mjs and holiday-hours-recon.mjs.
 *
 *   node apps/api/scripts/review-snapshot-once.mjs --kind MONTHLY
 *   node apps/api/scripts/review-snapshot-once.mjs --kind WEEKLY --from 2026-10-12 --to 2026-10-18
 */
import { captureAllReviewSnapshots } from "../dist/services/reviewSnapshot.js";
import { windowForKind } from "../dist/services/reviewSnapshotScheduler.js";

const args = process.argv.slice(2);
const get = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1] ?? null;
};

const kind = String(get("--kind") || "MONTHLY").toUpperCase() === "WEEKLY" ? "WEEKLY" : "MONTHLY";
const fallback = windowForKind(kind);
const from = get("--from") || fallback.start;
const to = get("--to") || fallback.end;

if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
  console.error(`Bad window: ${from}..${to} — expected YYYY-MM-DD.`);
  process.exit(1);
}

console.log(`REVIEW SNAPSHOT — ${kind} ${from}..${to}`);
const startedAt = Date.now();
const result = await captureAllReviewSnapshots({
  period: { kind, start: from, end: to },
  trigger: "ON_DEMAND",
});
console.log(`  captured  ${result.captured}`);
console.log(`  skipped   ${result.skipped} (already frozen, or no Job Orders)`);
console.log(`  failed    ${result.failed}`);
for (const failure of result.failures) console.log(`    project ${failure.projectId}: ${failure.error}`);
console.log(`  elapsed   ${Date.now() - startedAt}ms`);
process.exit(result.failed ? 2 : 0);
