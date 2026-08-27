import sql from "mssql";
import { prisma } from "../db";

/**
 * BadgeView master-data sync (LabourWorks SQL Server) — strict-prune model.
 *
 * Reads the external BadgeView (columns: Workmen, IDCardNo, BuName, WorkmenName,
 * ValidFrom, ValidUpto, BgCode, contractor) filtered to IsTerminated = '0' at the
 * SOURCE query (never post-fetch), then performs a SCOPED atomic overwrite inside
 * ONE transaction so a failed run leaves prior data intact.
 *
 * Locked semantics (no stale data; pins mark PRESENT workers only, never retain):
 *   1. DELETE FROM contract_workers WHERE source = 'SYNC'
 *   2. INSERT fresh BadgeView rows with source = 'SYNC' (isSupervisor = idCardNo in pins)
 *   3. Upsert pinned supervisors into `User` as read-only SYNC rows (no password).
 *      Partial write: never overwrites password/role on a MANUAL row.
 *   4. Prune: delete SYNC User rows whose idCardNo ∉ current BadgeView.
 *   5. Prune: delete orphaned pins whose idCardNo ∉ current BadgeView.
 *
 * Steps 4 and 5 key on PRESENCE IN THE CURRENT BadgeView ALONE (not pin state),
 * so a pinned-but-departed worker falls out of both — no stale picker entry.
 */

export type BadgeViewRow = {
  IDCardNo: string;
  BuName: string | null;
  WorkmenName: string;
  ValidFrom: Date | null;
  ValidUpto: Date | null;
  BgCode: string | null;
  contractor: string | null;
  NatureOfWork: string | null;
};

export type SyncResult = {
  ok: boolean;
  workersInserted: number;
  supervisorsUpserted: number;
  usersPruned: number;
  pinsPruned: number;
  startedAt: Date;
  finishedAt: Date;
  error?: string;
};

function envRequired(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(`[badgeViewSync] Missing required env var: ${name}`);
  }
  return v.trim();
}

function parseDate(v: Date | string | null | undefined): Date | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

/** Read the BadgeView rows from the external SQL Server (read-only, parameterized). */
async function fetchBadgeViewRows(): Promise<BadgeViewRow[]> {
  const host = envRequired("BADGEVIEW_DB_HOST");
  const user = envRequired("BADGEVIEW_DB_USER");
  const password = envRequired("BADGEVIEW_DB_PASSWORD");
  const database = envRequired("BADGEVIEW_DB_NAME");
  const view = envRequired("BADGEVIEW_DB_VIEW");
  const port = Number(process.env.BADGEVIEW_DB_PORT || 1433);
  const encrypt = String(process.env.BADGEVIEW_DB_ENCRYPT || "false").toLowerCase() === "true";

  const pool = await new sql.ConnectionPool({
    server: host,
    port,
    user,
    password,
    database,
    options: {
      encrypt,
      trustServerCertificate: true,
      // Read-only intent: never allow writes from this connection.
      readOnlyIntent: true,
    },
  }).connect();

  try {
    // Parameterized query — view name validated against a safe allowlist to
    // prevent injection even though it comes from env.
    const safeView = /^[A-Za-z0-9_.]+$/.test(view) ? view : "BadgeView";
    const request = pool.request();
    request.input("isTerminated", sql.NVarChar, "0");
    const result = await request.query(`
      SELECT
        IDCardNo,
        BuName,
        [Workmen Name]  AS WorkmenName,
        [ValidFromDate] AS ValidFrom,
        [ValidUpto Date] AS ValidUpto,
        BgCode,
        contractor,
        [Nature Of Work] AS NatureOfWork
      FROM [${safeView}]
      WHERE IsTerminated = @isTerminated
        AND [Card Type] IN ('ASSOCIATES', 'ASSOCIATE SEZ')
    `);
    return (result.recordset as BadgeViewRow[]) || [];
  } finally {
    await pool.close();
  }
}

/**
 * Run one sync pass. Returns a SyncResult. Never throws — errors are captured
 * in the result so the cron wrapper can log them without crashing the API.
 */
export async function runBadgeViewSync(): Promise<SyncResult> {
  const startedAt = new Date();
  const result: SyncResult = {
    ok: false,
    workersInserted: 0,
    supervisorsUpserted: 0,
    usersPruned: 0,
    pinsPruned: 0,
    startedAt,
    finishedAt: startedAt,
  };

  try {
    const rows = await fetchBadgeViewRows();

    // idCardNo set of the CURRENT source state — the single source of truth
    // for both the upsert and the prune (never pin state).
    const currentIdCardNos = new Set(rows.map((r) => r.IDCardNo));

    const now = new Date();

    await prisma.$transaction(async (tx) => {
      // 1. Scoped delete — only SYNC rows. Manual rows survive by construction.
      await tx.contractWorker.deleteMany({ where: { source: "SYNC" } });

      // Pins = the current supervisor set. A pin marks a PRESENT worker only.
      const pins = await tx.supervisorPin.findMany({ select: { idCardNo: true } });
      const pinnedIds = new Set(pins.map((p) => p.idCardNo));

      // 2. Insert fresh BadgeView rows.
      if (rows.length) {
        await tx.contractWorker.createMany({
          data: rows.map((r) => ({
            // BadgeView exposes a single [Workmen Name] column; the model keeps
            // workmen (legacy code-style) and workmenName, both sourced from it.
            workmen: r.WorkmenName,
            idCardNo: r.IDCardNo,
            buName: r.BuName,
            workmenName: r.WorkmenName,
            validFrom: parseDate(r.ValidFrom),
            validUpto: parseDate(r.ValidUpto),
            // mssql returns BgCode/contractor as integers; Prisma fields are String.
            bgCode: r.BgCode != null ? String(r.BgCode) : null,
            contractor: r.contractor != null ? String(r.contractor) : null,
            // Combined supervisor predicate: source marks (Nature Of Work='Supervisor')
            // as baseline, pin/convert stays as audited manual override.
            isSupervisor: r.NatureOfWork === "Supervisor" || pinnedIds.has(r.IDCardNo),
            source: "SYNC",
            lastSyncedAt: now,
          })),
        });
      }
      result.workersInserted = rows.length;

      // 3. Upsert supervisors into User as read-only SYNC rows (partial write).
      //    A row is a supervisor if source-marked (Nature Of Work='Supervisor')
      //    OR pinned (manual override). Both are promoted into the picker.
      for (const r of rows) {
        const isSup = r.NatureOfWork === "Supervisor" || pinnedIds.has(r.IDCardNo);
        if (!isSup) continue;
        const existing = await tx.user.findUnique({
          where: { idCardNo: r.IDCardNo },
          select: { id: true, source: true },
        });
        if (existing) {
          // Partial write: only update identity/source fields. Never touch
          // passwordHash, role, or MANUAL-only fields on a colliding row.
          if (existing.source === "SYNC") {
            await tx.user.update({
              where: { id: existing.id },
              data: { name: r.WorkmenName, source: "SYNC" },
            });
            result.supervisorsUpserted++;
          }
          // If existing.source === 'MANUAL', skip entirely — sync never clobbers a manual supervisor.
        } else {
          // New SYNC supervisor: no password, cannot log in. The email is a
          // placeholder never used for login, so on the (rare) collision with a
          // MANUAL user who holds `${idCardNo}@sync.local`, fall back to a
          // guaranteed-unique suffix rather than failing the whole transaction.
          const baseEmail = `${r.IDCardNo}@sync.local`;
          let email = baseEmail;
          let suffix = 1;
          while (await tx.user.findUnique({ where: { email }, select: { id: true } })) {
            email = `${baseEmail.split("@")[0]}.${suffix}@sync.local`;
            suffix++;
          }
          await tx.user.create({
            data: {
              email,
              passwordHash: "", // empty — cannot authenticate
              name: r.WorkmenName,
              role: "SUPERVISOR",
              source: "SYNC",
              idCardNo: r.IDCardNo,
            },
          });
          result.supervisorsUpserted++;
        }
      }

      // 4. Prune SYNC User rows whose idCardNo is NOT in the current supervisor
      //    set (source-marked OR pinned). This drops BOTH departed workers (not
      //    in source) AND present-but-unpinned workers (no longer supervisors),
      //    so the picker never carries a stale SYNC supervisor. Empty source ⇒ prune all.
      const supervisorIdCardNos = new Set(
        rows.filter((r) => r.NatureOfWork === "Supervisor" || pinnedIds.has(r.IDCardNo)).map((r) => r.IDCardNo)
      );
      const pruneResult = await tx.user.deleteMany({
        where:
          supervisorIdCardNos.size === 0
            ? { source: "SYNC" }
            : { source: "SYNC", idCardNo: { notIn: [...supervisorIdCardNos] } },
      });
      result.usersPruned = pruneResult.count;

      // 5. Prune orphaned pins whose idCardNo ∉ current BadgeView.
      const pinPrune = await tx.supervisorPin.deleteMany({
        where: currentIdCardNos.size === 0 ? {} : { idCardNo: { notIn: [...currentIdCardNos] } },
      });
      result.pinsPruned = pinPrune.count;
    });

    result.ok = true;
    result.finishedAt = new Date();
    return result;
  } catch (err) {
    result.ok = false;
    result.finishedAt = new Date();
    result.error = err instanceof Error ? err.message : String(err);
    return result;
  }
}
