#!/usr/bin/env node
/**
 * Did the sync actually run, and what did it do?
 *
 * WHY THIS EXISTS AS A FILE
 *   The equivalent one-liner (`node -e "...p.$disconnect()..."`) is unusable from PowerShell: the
 *   shell expands `$disconnect` inside double quotes, so the code arrives as `p.()` and Node throws
 *   `SyntaxError: Unexpected token '('`. Single-quoting works in principle but PowerShell 5.1
 *   mangles embedded double quotes when passing an argument to a native command, which turns the
 *   fix into a coin flip. A file has no quoting to get wrong.
 *
 *   Same pattern as the other operator scripts in this directory (sync-labourworks.mjs,
 *   why-supervisor-disabled.mjs, check-scope-migration.mjs, diagnose-supervisor-source.mjs): run it
 *   INSIDE the api container so it inherits DATABASE_URL and the BADGEVIEW_* settings.
 *
 *   docker compose --env-file infra/docker/.env.production \
 *     -f infra/docker/compose.production.yml exec api \
 *     node apps/api/scripts/sync-run-status.mjs
 *
 * READ-ONLY.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const LIMIT = Number(process.argv[2] || 10);

/** Which trigger fired the run, in words an operator recognises. */
function triggerLabel(action) {
  if (action === "SYNC_SCHEDULED_RUN") return "the schedule (unattended)";
  if (action === "SYNC_ONE_SHOT_RUN") return "a one-shot run in the container";
  if (action === "ADMIN_BADGEVIEW_SYNC") return "the admin refresh button";
  return action;
}

function fmt(date) {
  if (!date) return "—";
  // Labelled UTC: these columns hold UTC while the operator reads IST (UTC+5:30).
  const utc = new Date(date).toISOString().replace("T", " ").slice(0, 19);
  const ist = new Date(new Date(date).getTime() + 5.5 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 16);
  return `${utc} UTC  (${ist} IST)`;
}

async function main() {
  const runs = await prisma.auditLog.findMany({
    where: { action: { in: ["SYNC_SCHEDULED_RUN", "SYNC_ONE_SHOT_RUN", "ADMIN_BADGEVIEW_SYNC"] } },
    orderBy: { createdAt: "desc" },
    take: LIMIT,
    select: { action: true, createdAt: true, metadata: true },
  });

  const cron = process.env.BADGEVIEW_SYNC_CRON || "0 6,18 * * *";
  const enabled = String(process.env.BADGEVIEW_SYNC_ENABLED || "false").toLowerCase() === "true";
  console.log(`scheduled sync : ${enabled ? `ENABLED (${cron})` : "DISABLED (BADGEVIEW_SYNC_ENABLED != true)"}`);
  console.log(`active-only    : ${process.env.BADGEVIEW_SYNC_ACTIVE_ONLY ?? "(unset -> true)"}`);
  console.log(`\nlast ${runs.length} sync run(s), newest first:\n`);

  if (!runs.length) {
    console.log("  NONE. No sync run has ever recorded itself — check that the scheduler is armed");
    console.log("  and that a run has been triggered at least once.");
  }

  for (const run of runs) {
    let meta = {};
    try { meta = JSON.parse(run.metadata ?? "{}"); } catch { /* a malformed row must not break this */ }
    const ok = meta.ok === true ? "OK" : meta.ok === false ? "FAILED" : "unknown";
    console.log(`  ${fmt(run.createdAt)}`);
    console.log(`    trigger    : ${triggerLabel(run.action)}`);
    console.log(`    result     : ${ok}${meta.error ? ` — ${meta.error}` : ""}`);
    const counters = ["workersUpserted", "supervisorsLinked", "terminated", "reactivated", "exceptions", "credentialsQueued"]
      .filter((k) => meta[k] !== undefined)
      .map((k) => `${k}=${meta[k]}`)
      .join("  ");
    if (counters) console.log(`    counters   : ${counters}`);
  }

  // Freshness, from the column the sync stamps on every row it writes.
  const newest = await prisma.employee.findFirst({
    where: { lastSyncedAt: { not: null } },
    orderBy: { lastSyncedAt: "desc" },
    select: { lastSyncedAt: true },
  });
  if (newest?.lastSyncedAt) {
    const hours = Math.round(((Date.now() - newest.lastSyncedAt.getTime()) / 3_600_000) * 10) / 10;
    console.log(`\ndata last written by a sync: ${fmt(newest.lastSyncedAt)}  (${hours}h ago)`);
  }

  const disabled = await prisma.user.count({ where: { role: "SUPERVISOR", active: false } });
  console.log(`disabled supervisors right now: ${disabled}`);

  console.log(`\nNOTE: logs rotate and restart with the container, so the audit rows above are the`);
  console.log(`      record — a missing log line is not evidence either way.`);
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error("[sync-run-status] failed:", error instanceof Error ? error.message : error);
  await prisma.$disconnect();
  process.exit(1);
});
