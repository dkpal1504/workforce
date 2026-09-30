#!/usr/bin/env node
/**
 * Pre- and post-deploy data checks for the multi-section Section Head scope.
 *
 * WHY THIS EXISTS: the migration 20260929000000_multi_section_hod_scope is ADDITIVE (one new
 * table, inserted into) and cannot modify existing rows — but two PRE-EXISTING data problems can
 * still spoil the deploy, and neither is visible from the migration itself:
 *
 *   1. an orphaned `users.section_id` makes the backfill's INSERT fail on an FK violation, and
 *      because a Prisma migration runs in a transaction, the whole migration rolls back;
 *   2. an HOD whose Section now lives in ANOTHER department stops matching after the change,
 *      because the read rule gates on Department first. That is a pre-existing mis-scope this
 *      deploy would SURFACE — it must be reported and corrected deliberately, never "fixed" by
 *      widening a scope.
 *
 * Run it BEFORE the deploy (to confirm it is safe) and AFTER (to confirm the backfill landed).
 * It only reads; it never writes.
 *
 *   docker compose --env-file infra/docker/.env.production \
 *     -f infra/docker/compose.production.yml exec api \
 *     node apps/api/scripts/check-scope-migration.mjs
 *
 * Exit code 0 = safe / verified. 1 = do not proceed (or the backfill is incomplete).
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
let failures = 0;
const fail = (message) => { failures += 1; console.log(`  FAIL  ${message}`); };

async function tableExists(name) {
  try {
    await prisma.$queryRawUnsafe(`SELECT 1 FROM "${name}" LIMIT 1`);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  // ---- 1. orphaned section_id: would FAIL the migration on an FK violation ----
  const orphans = await prisma.$queryRawUnsafe(`
    SELECT u.id, u.name, u.section_id
    FROM users u LEFT JOIN sections s ON s.id = u.section_id
    WHERE u.section_id IS NOT NULL AND s.id IS NULL
  `);
  console.log(`[1] users whose section_id points at a missing Section: ${orphans.length}`);
  if (orphans.length) {
    console.log(JSON.stringify(orphans, null, 2));
    fail("the backfill's INSERT would violate the FK and roll the whole migration back");
  }

  // ---- 2. mis-scope: authority would change for these rows ----
  const misScoped = await prisma.$queryRawUnsafe(`
    SELECT u.id, u.name, u.role, u.department_id, u.section_id, s.department_id AS section_department_id
    FROM users u JOIN sections s ON s.id = u.section_id
    WHERE u.role = 'HOD' AND s.department_id <> u.department_id
  `);
  console.log(`[2] Section Heads whose Section is in ANOTHER Department: ${misScoped.length}`);
  if (misScoped.length) {
    console.log(JSON.stringify(misScoped, null, 2));
    fail("these would silently lose approval scope — correct the mapping deliberately, do not widen a scope");
  }

  // ---- 3. the backfill gate: rows inserted must equal users holding a section ----
  const expected = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n FROM users WHERE section_id IS NOT NULL`
  );
  const hasTable = await tableExists("user_scope_sections");
  console.log(`[3] users with a Section (rows the backfill inserts): ${expected[0].n}`);
  if (hasTable) {
    const backfilled = await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM user_scope_sections`);
    console.log(`    rows now in user_scope_sections: ${backfilled[0].n}`);
    if (backfilled[0].n !== expected[0].n) {
      fail(`backfill mismatch: expected ${expected[0].n}, found ${backfilled[0].n} — do NOT start the API`);
    } else {
      console.log("    gate PASSES (equal)");
    }
    const multi = await prisma.$queryRawUnsafe(`
      SELECT user_id, COUNT(*)::int AS sections FROM user_scope_sections
      GROUP BY user_id HAVING COUNT(*) > 1 ORDER BY user_id
    `);
    console.log(`    accounts holding MORE THAN ONE Section (the new capability): ${multi.length}`);
  } else {
    console.log("    user_scope_sections does not exist yet -> this is a PRE-deploy run");
  }

  // ---- 4. the data this migration must not touch: a baseline to compare by eye ----
  const counts = await prisma.$queryRawUnsafe(`
    SELECT (SELECT COUNT(*)::int FROM timesheet_days)          AS timesheet_days,
           (SELECT COUNT(*)::int FROM timesheet_entries)       AS timesheet_entries,
           (SELECT COUNT(*)::int FROM employee_allocation_days) AS allocation_days,
           (SELECT COUNT(*)::int FROM approvals)               AS approvals
  `);
  console.log(`[4] existing data (must be IDENTICAL before and after): ${JSON.stringify(counts[0])}`);
  const pending = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n FROM timesheet_days WHERE status IN ('SUBMITTED','DRAFT')`
  );
  console.log(`    awaiting approval (SUBMITTED/DRAFT): ${pending[0].n}`);

  console.log(
    failures === 0
      ? "\nVERDICT: OK — the migration is additive and its backfill will preserve every existing scope."
      : `\nVERDICT: STOP — ${failures} problem(s) above. Resolve them before deploying.`
  );
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error("[check-scope-migration] failed:", error instanceof Error ? error.message : error);
  await prisma.$disconnect();
  process.exit(1);
});
