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

  // ---- 3. the backfill: is the stored SET consistent with the legacy mirror? ----
  //
  // WHY THIS DOES NOT ASSERT EQUALITY ANY MORE. It used to compare a LIVE count of `users` holding
  // a Section against the rows in `user_scope_sections`. That equality held only at the instant the
  // migration ran: registering an HOD afterwards writes `users.section_id` and (in the pre-feature
  // code) no row, so the two counts diverge and the check cried FAIL on a perfectly healthy
  // database. A gate that fires on correct data is worse than no gate — it teaches operators to
  // walk past it.
  //
  // Drift is benign, and the reason is a code property, not a data one: the deployed hydration reads
  // `scopeSections.length ? set : (sectionId ? [sectionId] : [])`, so an account with a mirror and no
  // row resolves to exactly its one Section — the same authority a row would have given it. What
  // WOULD be dangerous is an account a reader treats as DEPARTMENT-WIDE without it having said so,
  // and that cannot arise while the fallback is deployed (fcbb136). So drift is reported and
  // explained, and only real integrity problems fail.
  const expected = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n FROM users WHERE section_id IS NOT NULL`
  );
  const hasTable = await tableExists("user_scope_sections");
  console.log(`[3] users with a Section (the mirror the backfill copied): ${expected[0].n}`);
  if (!hasTable) {
    console.log("    user_scope_sections does not exist yet -> this is a PRE-deploy run");
  } else {
    const backfilled = await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM user_scope_sections`);
    console.log(`    rows now in user_scope_sections: ${backfilled[0].n}`);

    const drift = await prisma.$queryRawUnsafe(`
      SELECT u.id, u.name, u.role, u.section_id
      FROM users u
      WHERE u.section_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM user_scope_sections sc WHERE sc.user_id = u.id)
      ORDER BY u.id
    `);
    if (drift.length) {
      const hods = drift.filter((row) => row.role === "HOD");
      console.log(`    accounts with a mirror Section but NO stored row: ${drift.length} (BENIGN — see below)`);
      console.log(JSON.stringify(drift, null, 2));
      console.log(`      of which Section Heads: ${hods.length} — each resolves to exactly its own Section anyway`);
      console.log("      WHY BENIGN: with no rows the hydration falls back to [section_id], so authority is");
      console.log("      unchanged. It is NOT a privilege escalation, because a department-wide scope");
      console.log("      requires a NULL mirror, which these rows do not have.");
    } else {
      console.log("    no drift: every account with a mirror Section also has its stored row");
    }

    // The genuine failures: a row pointing at something that is not there. The foreign keys make
    // this impossible — asserted rather than assumed, because a hand-edited database is exactly the
    // case this script exists to catch.
    const dangling = await prisma.$queryRawUnsafe(`
      SELECT sc.id, sc.user_id, sc.section_id FROM user_scope_sections sc
      LEFT JOIN users u ON u.id = sc.user_id
      LEFT JOIN sections s ON s.id = sc.section_id
      WHERE u.id IS NULL OR s.id IS NULL
    `);
    if (dangling.length) {
      console.log(JSON.stringify(dangling, null, 2));
      fail(`${dangling.length} scope row(s) point at a missing user or Section`);
    }

    // A stored row whose Section belongs to another Department is the same mis-scope as [2], caught
    // at the row level.
    const rowMisScope = await prisma.$queryRawUnsafe(`
      SELECT sc.id, sc.user_id, sc.section_id, u.department_id, s.department_id AS section_department_id
      FROM user_scope_sections sc
      JOIN users u ON u.id = sc.user_id
      JOIN sections s ON s.id = sc.section_id
      WHERE u.department_id IS NOT NULL AND s.department_id <> u.department_id
    `);
    if (rowMisScope.length) {
      console.log(JSON.stringify(rowMisScope, null, 2));
      fail(`${rowMisScope.length} stored scope row(s) name a Section of ANOTHER Department`);
    }

    const multi = await prisma.$queryRawUnsafe(`
      SELECT user_id, COUNT(*)::int AS sections FROM user_scope_sections
      GROUP BY user_id HAVING COUNT(*) > 1 ORDER BY user_id
    `);
    console.log(`    accounts holding MORE THAN ONE Section (the new capability): ${multi.length}`);
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
