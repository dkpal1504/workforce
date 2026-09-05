import sql from "mssql";
import { prisma } from "../db";

/**
 * BadgeView master-data sync (LabourWorks SQL Server) — unified Employee, soft-depart.
 *
 * Reads the external BadgeView (columns: Workmen, IDCardNo, BuName, WorkmenName,
 * ValidFrom, ValidUpto, BgCode, contractor, NatureOfWork) filtered to IsTerminated='0'
 * AND Card Type IN (ASSOCIATES, ASSOCIATE SEZ) at the SOURCE query, then UPSERTS into
 * the unified `Employee` master table (CR#2). Contract workers + supervisors land in
 * `Employee` alongside seeded/payroll rows, distinguished by `source`.
 *
 * CR#2 locked semantics (option A — soft-depart):
 *   1. Upsert an `Employee` row for EVERY source row (all 555, supervisors included),
 *      keyed by `idCardNo`. Sync sets section (Workmen Section), plant (Workmen Division),
 *      grade (Nature of Work), source='SYNC', active=true on SYNC rows only.
 *   2. Auto-create Departments from distinct BuName values (idempotent on stable code;
 *      default "Unassigned" department for empty/unmappable BuName so the FK insert succeeds).
 *   3. Derive `ecNo` from `idCardNo` (deterministic; unique requirement).
 *   4. Link each SYNC supervisor's User row to their Employee.id via idCardNo (so the
 *      supervisor self-row resolves the correct employeeId).
 *   5. Soft-depart: SYNC rows absent from the source snapshot -> active=false (NEVER delete,
 *      so FK Restrict on historical timesheets won't break the sync and the liability trail
 *      survives). Picker filters on active.
 *   6. Prune orphaned pins whose idCardNo ∉ current BadgeView.
 *
 * Guards:
 *   - Partial-write: sync only ever touches source='SYNC' Employee rows (keyed by idCardNo).
 *     Seeded/payroll rows (no idCardNo or source != 'SYNC') are NEVER upserted, soft-departed
 *     (active flipped), or field-mutated by a sync run.
 *   - supervisor `User ↔ Employee` linkage is set on the User row but never grants a login
 *     (SYNC users keep empty passwordHash); grade/role changes stay audited admin actions.
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
  Section: string | null;
  Division: string | null;
};

export type SyncResult = {
  ok: boolean;
  workersUpserted: number;
  supervisorsLinked: number;
  departmentsCreated: number;
  softDeparted: number;
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

/** Stable department code from a BuName (uppercased, non-alphanumeric -> underscore). */
function deptCode(buName: string): string {
  return buName.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "UNASSIGNED";
}

/** Deterministic ecNo derived from idCardNo (unique requirement on Employee). */
function deriveEcNo(idCardNo: string): string {
  return `SYNC_${idCardNo}`;
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
        [Nature Of Work] AS NatureOfWork,
        [Workmen Section] AS Section,
        [Workmen Division] AS Division
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
    workersUpserted: 0,
    supervisorsLinked: 0,
    departmentsCreated: 0,
    softDeparted: 0,
    pinsPruned: 0,
    startedAt,
    finishedAt: startedAt,
  };

  try {
    const rows = await fetchBadgeViewRows();
    const currentIdCardNos = new Set(rows.map((r) => r.IDCardNo));
    const now = new Date();
    const maxDailyHours = 0; // unused here

    await prisma.$transaction(async (tx) => {
      // --- Auto-create Departments from distinct BuName (idempotent on stable code) ---
      const buNames = new Set<string>();
      for (const r of rows) buNames.add((r.BuName || "").trim());
      // Ensure a default "Unassigned" department exists for empty/unmappable BuName.
      const allDeptNames = new Set(["Unassigned"]);
      for (const n of buNames) if (n) allDeptNames.add(n);
      for (const name of allDeptNames) {
        const code = deptCode(name || "Unassigned");
        const existing = await tx.department.findUnique({ where: { code } });
        if (!existing) {
          // Sync-owned department: source='SYNC' so the UI can tag it and manual
          // edits are never clobbered (sync only create-missing).
          await tx.department.create({ data: { name, code, source: "SYNC" } });
          result.departmentsCreated++;
        }
      }
      // Build a name->id map for BuName -> departmentId.
      const depts = await tx.department.findMany();
      const deptByName = new Map<string, number>();
      for (const d of depts) deptByName.set(d.name, d.id);

      const unassignedDept = deptByName.get("Unassigned")!;

      // --- Upsert every source row into unified `Employee` (source='SYNC', keyed by idCardNo) ---
      for (const r of rows) {
        const idCardNo = r.IDCardNo;
        const deptId = (r.BuName && r.BuName.trim() && deptByName.get(r.BuName.trim())) || unassignedDept;

        const existingEmp = await tx.employee.findUnique({ where: { idCardNo } });
        if (existingEmp) {
          // Partial-write guard: only touch SYNC rows. NEVER mutate MANUAL/PAYROLL rows.
          if (existingEmp.source === "SYNC") {
            await tx.employee.update({
              where: { id: existingEmp.id },
              data: {
                name: r.WorkmenName,
                departmentId: deptId,
                section: r.Section,
                plant: r.Division,
                grade: r.NatureOfWork,
                active: true,
                designation: r.NatureOfWork || existingEmp.designation,
              },
            });
          }
          // MANUAL/PAYROLL row with a matching idCardNo: skip (sync never clobbers them).
          result.workersUpserted++;
          continue;
        }

        // New SYNC employee row.
        await tx.employee.create({
          data: {
            ecNo: deriveEcNo(idCardNo),
            idCardNo,
            name: r.WorkmenName,
            departmentId: deptId,
            designation: r.NatureOfWork || "",
            category: "CONTRACTOR",
            source: "SYNC",
            section: r.Section,
            plant: r.Division,
            grade: r.NatureOfWork,
            active: true,
          },
        });
        result.workersUpserted++;
      }

      // --- Soft-depart: SYNC rows absent from source -> active=false (never delete) ---
      const softDepart = await tx.employee.updateMany({
        where:
          currentIdCardNos.size === 0
            ? { source: "SYNC" }
            : { source: "SYNC", idCardNo: { notIn: [...currentIdCardNos] } },
        data: { active: false },
      });
      result.softDeparted = softDepart.count;

      // --- Link each SYNC supervisor's User.employeeId to their Employee row ---
      // Supervisor = source-marked (Nature of Work = 'Supervisor') OR pinned.
      const pins = await tx.supervisorPin.findMany({ select: { idCardNo: true } });
      const pinnedIds = new Set(pins.map((p) => p.idCardNo));
      const supervisors = rows.filter((r) => r.NatureOfWork === "Supervisor" || pinnedIds.has(r.IDCardNo));

      for (const r of supervisors) {
        const emp = await tx.employee.findUnique({ where: { idCardNo: r.IDCardNo }, select: { id: true } });
        if (!emp) continue;
        // Update/create the SYNC supervisor's User row (read-only, no login) and link employeeId.
        const existingUser = await tx.user.findUnique({ where: { idCardNo: r.IDCardNo }, select: { id: true, source: true } });
        if (existingUser) {
          if (existingUser.source === "SYNC") {
            await tx.user.update({
              where: { id: existingUser.id },
              data: { name: r.WorkmenName, source: "SYNC", employeeId: emp.id },
            });
            result.supervisorsLinked++;
          }
          // MANUAL user: skip, never clobber.
        } else {
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
              passwordHash: "", // no login for SYNC supervisors
              name: r.WorkmenName,
              role: "SUPERVISOR",
              source: "SYNC",
              idCardNo: r.IDCardNo,
              employeeId: emp.id,
            },
          });
          result.supervisorsLinked++;
        }
      }

      // --- Prune SYNC User rows no longer in the current supervisor set ---
      const supervisorIdCardNos = new Set(supervisors.map((r) => r.IDCardNo));
      await tx.user.deleteMany({
        where:
          supervisorIdCardNos.size === 0
            ? { source: "SYNC" }
            : { source: "SYNC", idCardNo: { notIn: [...supervisorIdCardNos] } },
      });

      // --- Prune orphaned pins ---
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
