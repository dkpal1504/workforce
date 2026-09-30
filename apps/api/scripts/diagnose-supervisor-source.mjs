#!/usr/bin/env node
/**
 * Is LabourWorks really reporting this supervisor as terminated?
 *
 * WHY THIS EXISTS
 *   A supervisor showed as DISABLED in Workforce while appearing ACTIVE in the LabourWorks
 *   database. The sync can end up disabling an account in four ways, and the fix is different
 *   for each — so the first job is to find out which one applied, from the SOURCE row.
 *
 * THE FOUR WAYS A SUPERVISOR ACCOUNT BECOMES DISABLED (badgeViewSync.ts)
 *   1. line 293 — the ABSENCE SWEEP: the employee is missing from a validated snapshot, so the
 *      row is soft-terminated and the login disabled. Audited as SYNC_ABSENCE_SWEEP with the
 *      reason and `accountDisabled`, which makes it distinguishable after the fact.
 *   2. line 298 — the person is soft-terminated (same sweep path) and their login is switched off.
 *   3. line 523 — `employee.active` is false (source says IsTerminated, or already soft-terminated)
 *      -> `user.active = false`.
 *   4. line 574 — the employee is no longer considered a supervisor (NatureOfWork changed, and no
 *      live SupervisorOverride) -> "Supervisor eligibility removed."
 *
 * THE SUBTLE ONE, AND THE LIKELY CAUSE HERE
 *   BADGEVIEW_SYNC_ACTIVE_ONLY (default true) FILTERS terminated rows out of the snapshot BEFORE
 *   the sync runs:
 *       snapshot = rows.filter(row => !sourceTerminated(row.IsTerminated))
 *   The sync then only ever sees ACTIVE people, so it never learns that a previously terminated
 *   person has since been un-terminated — and because they are absent from the snapshot, the
 *   absence sweep can keep them disabled. A record that looks ACTIVE in LabourWorks can therefore
 *   stay disabled here indefinitely.
 *
 * HOW THE FLAG IS READ (sourceTerminated, line 72)
 *   true => true, 1, "1", "true", "yes" (trimmed, case-insensitive). Everything else, INCLUDING
 *   NULL, is treated as ACTIVE.
 *
 * READ-ONLY: one SELECT. It writes nothing in either database.
 *
 *   docker compose --env-file infra/docker/.env.production \
 *     -f infra/docker/compose.production.yml exec api \
 *     node apps/api/scripts/diagnose-supervisor-source.mjs [ECNO] [--all-disabled]
 *
 * With no arguments it checks every DISABLED supervisor in Workforce against the source row.
 */
import sql from "mssql";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const args = process.argv.slice(2);
const allDisabled = args.includes("--all-disabled") || args.length === 0;
const ecNoArg = args.find((a) => !a.startsWith("--")) ?? null;

/** The sync's own reading of the flag — replicated here so the diagnosis cannot disagree with it. */
function sourceTerminated(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return value === true || value === 1 || normalized === "1" || normalized === "true" || normalized === "yes";
}

function envRequired(name) {
  const value = (process.env[name] ?? "").trim();
  if (!value) throw new Error(`${name} is not set.`);
  return value;
}

async function fetchRows(ecNos) {
  const pool = await new sql.ConnectionPool({
    server: envRequired("BADGEVIEW_DB_HOST"),
    port: Number(process.env.BADGEVIEW_DB_PORT || 1433),
    user: envRequired("BADGEVIEW_DB_USER"),
    password: envRequired("BADGEVIEW_DB_PASSWORD"),
    database: envRequired("BADGEVIEW_DB_NAME"),
    options: {
      encrypt: String(process.env.BADGEVIEW_DB_ENCRYPT || "false").toLowerCase() === "true",
      trustServerCertificate: true,
      readOnlyIntent: true,
    },
  }).connect();
  try {
    const view = envRequired("BADGEVIEW_DB_VIEW");
    if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(view)) {
      throw new Error("BADGEVIEW_DB_VIEW must be an identifier such as dbo.BadgeView.");
    }
    const safeView = view.split(".").map((p) => `[${p}]`).join(".");
    const request = pool.request();
    request.input("cardType", sql.NVarChar(32), "ASSOCIATES");
    // The sync's exact projection, plus the raw flag for reporting.
    const result = await request.query(`
      SELECT IDCardNo AS EcNo, [Workmen Name] AS Name, [Workmen Division] AS Division,
             [Workmen Section] AS Section, [Nature Of Work] AS NatureOfWork, IsTerminated
      FROM ${safeView}
      WHERE [Card Type] = @cardType
    `);
    const rows = result.recordset ?? [];
    if (!ecNos || ecNos.length === 0) return { rows, matched: rows };
    const wanted = new Set(ecNos.map((e) => String(e).trim().toUpperCase()));
    return { rows, matched: rows.filter((r) => wanted.has(String(r.EcNo ?? "").trim().toUpperCase())) };
  } finally {
    await pool.close();
  }
}

async function main() {
  console.log(`BADGEVIEW_SYNC_ACTIVE_ONLY = ${process.env.BADGEVIEW_SYNC_ACTIVE_ONLY ?? "(unset -> defaults to true)"}`);
  console.log("  ...when true, terminated rows are FILTERED OUT of the snapshot before the sync runs,\n" +
    "     so an un-terminated record can stay disabled here. This is the case to rule in or out.\n");

  const disabled = ecNoArg
    ? await prisma.user.findMany({
        where: { role: "SUPERVISOR", employee: { ecNo: ecNoArg } },
        select: { id: true, name: true, active: true, source: true, employee: { select: { id: true, ecNo: true, active: true, terminatedAt: true, lastSyncedAt: true, natureOfWork: true } } },
      })
    : await prisma.user.findMany({
        where: { role: "SUPERVISOR", active: false },
        select: { id: true, name: true, active: true, source: true, employee: { select: { id: true, ecNo: true, active: true, terminatedAt: true, lastSyncedAt: true, natureOfWork: true } } },
        orderBy: { name: "asc" },
      });

  if (!disabled.length) {
    console.log("No matching supervisor found in Workforce.");
    await prisma.$disconnect();
    return;
  }
  if (!allDisabled && !ecNoArg) console.log("(no EcNo given: checking every disabled supervisor)");

  const ecNos = disabled.map((u) => u.employee?.ecNo).filter(Boolean);
  const { rows, matched } = await fetchRows(ecNos);
  console.log(`LabourWorks returned ${rows.length} ASSOCIATES row(s); matched ${matched.length} of the ${ecNos.length} queried.\n`);

  const byEc = new Map(matched.map((r) => [String(r.EcNo ?? "").trim().toUpperCase(), r]));

  for (const user of disabled) {
    const ecNo = String(user.employee?.ecNo ?? "").trim().toUpperCase();
    const row = byEc.get(ecNo);
    console.log("──────────────────────────────────────────────────────────");
    console.log(`${user.name}  (ecNo ${user.employee?.ecNo ?? "n/a"}, user #${user.id})`);
    console.log(`  Workforce       : account.active=${user.active} employee.active=${user.employee?.active}`);
    console.log(`  terminatedAt    : ${user.employee?.terminatedAt ? new Date(user.employee.terminatedAt).toISOString() : "—"}`);
    console.log(`  lastSyncedAt    : ${user.employee?.lastSyncedAt ? new Date(user.employee.lastSyncedAt).toISOString() : "—"}`);
    console.log(`  stored NatureOfWork: ${user.employee?.natureOfWork ?? "—"}`);

    if (!row) {
      console.log(`  LabourWorks     : NO ROW for this ecNo in [${process.env.BADGEVIEW_DB_VIEW}].`);
      console.log(`                    -> the ABSENCE SWEEP path: they are missing from the snapshot.`);
      console.log(`                    If they have genuinely left, this state is CORRECT.`);
      continue;
    }

    const terminated = sourceTerminated(row.IsTerminated);
    console.log(`  LabourWorks     : IsTerminated=${JSON.stringify(row.IsTerminated)} -> sync reads this as ${terminated ? "TERMINATED" : "ACTIVE"}`);
    console.log(`  LabourWorks     : Name=${row.Name} Division=${row.Division} Section=${row.Section} NatureOfWork=${row.NatureOfWork}`);

    if (!terminated) {
      console.log(`  DIAGNOSIS       : LabourWorks reports them ACTIVE while Workforce has them disabled.`);
      console.log(`                    This is NOT a LabourWorks data problem. Two candidate causes:`);
      console.log(`                      a) ACTIVE_ONLY filtered them out during the run that disabled them,`);
      console.log(`                         and the absence sweep then soft-terminated an "absent" employee`);
      console.log(`                         who in fact still exists as active;`);
      console.log(`                      b) their NatureOfWork no longer reads "Supervisor" and no live`);
      console.log(`                         SupervisorOverride exists ("Supervisor eligibility removed.").`);
      console.log(`                    Check the audit trail:`);
      console.log(`                      SELECT * FROM audit_log WHERE action IN ('SYNC_ABSENCE_SWEEP')`);
      console.log(`                        AND entity_id = '${user.employee?.id}';`);
      console.log(`  NEXT SYNC       : WILL re-enable this account — the row is in the snapshot and active.`);
      console.log(`                    If it has not after two runs, (a) or (b) is the reason, and ACTIVE_ONLY`);
      console.log(`                    is the first lever to test.`);
    } else {
      console.log(`  DIAGNOSIS       : LabourWorks genuinely reports them TERMINATED.`);
      console.log(`                    The Disabled state is CORRECT and the sync will keep enforcing it.`);
      console.log(`                    Fix the record in LabourWorks if that is wrong.`);
    }
  }

  console.log("\nNOTE: this script only reads. Nothing was changed in either database.");
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error("[diagnose-supervisor-source] failed:", error instanceof Error ? error.message : error);
  await prisma.$disconnect();
  process.exit(1);
});
