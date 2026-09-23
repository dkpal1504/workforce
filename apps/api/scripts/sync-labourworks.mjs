#!/usr/bin/env node
/**
 * Run the LabourWorks (BadgeView) master-data sync ONCE, inside the api container.
 *
 * Why this exists: the sync creates the Departments, Sections, contract Employees and
 * Supervisors that every other screen depends on - an Employee registration cannot pick a
 * Department until it has run - and the only other trigger is the authenticated endpoint
 * POST /api/admin/sync/badgeview, which the browser reaches through nginx (60 s proxy read
 * timeout, so a first full sync can answer 504 while still finishing server-side).
 *
 *   docker compose --env-file infra/docker/.env.production \
 *     -f infra/docker/compose.production.yml exec api \
 *     node apps/api/scripts/sync-labourworks.mjs
 *
 * It reads the same environment as the API (DATABASE_URL, BADGEVIEW_DB_*), prints the full
 * result and exits 0 on success / 1 on failure, so it can be scripted. The scheduled job is
 * the same service: BADGEVIEW_SYNC_ENABLED + BADGEVIEW_SYNC_CRON (default 06:00 and 18:00).
 */
import { runBadgeViewSync } from "../dist/services/badgeViewSync.js";

const started = new Date();
try {
  const result = await runBadgeViewSync();
  const summary = {
    ok: result.ok,
    workersUpserted: result.workersUpserted,
    supervisorsLinked: result.supervisorsLinked,
    departmentsCreated: result.departmentsCreated,
    sectionsCreated: result.sectionsCreated,
    terminated: result.terminated,
    reactivated: result.reactivated,
    exceptions: result.exceptions,
    credentialsQueued: result.credentialsQueued,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    seconds: Math.round((result.finishedAt.getTime() - result.startedAt.getTime()) / 100) / 10,
    error: result.error ?? null,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!result.ok) {
    console.error("[sync] FAILED — the database was left as it was; fix the cause and run again.");
    console.error(`[sync] If the error mentions connecting to the source, check BADGEVIEW_DB_* and that the yard's SQL Server firewall allows this Docker host.`);
  } else {
    console.log("[sync] Done. Departments, Sections, contract Employees and Supervisors are up to date.");
    console.log("[sync] Employees -> Register payroll employee can now select a Department.");
  }
  process.exit(result.ok ? 0 : 1);
} catch (error) {
  console.error(`[sync] FAILED after ${Math.round((Date.now() - started.getTime()) / 100) / 10}s:`, error instanceof Error ? error.message : error);
  process.exit(1);
}
