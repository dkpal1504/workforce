import crypto from "crypto";
import sql from "mssql";
import bcrypt from "bcryptjs";
import { Prisma } from "@prisma/client";
import { prisma } from "../db";

/** One row from the LabourWorks BadgeView source. */
export type BadgeViewRow = {
  EcNo: string | null;
  BuName: string | null;
  Department: string | null;
  Section: string | null;
  Division: string | null;
  WorkmenName: string | null;
  NatureOfWork: string | null;
  mobile: string | number | null;
  IsTerminated: boolean;
};

export type SyncResult = {
  ok: boolean;
  workersUpserted: number;
  supervisorsLinked: number;
  departmentsCreated: number;
  sectionsCreated: number;
  terminated: number;
  reactivated: number;
  exceptions: number;
  credentialsQueued: number;
  startedAt: Date;
  finishedAt: Date;
  error?: string;
};

type Tx = Prisma.TransactionClient;

function envRequired(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`[badgeViewSync] Missing required env var: ${name}`);
  return value.trim();
}

function normalizeText(value: unknown): string {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

function normalizeEcNo(value: unknown): string {
  // Preserve LabourWorks IDCardNo as the canonical ecNo. Case folding is used
  // only for collision detection, never to rewrite the source identifier.
  return normalizeText(value);
}

function ecNoKey(value: unknown): string {
  return normalizeEcNo(value).toUpperCase();
}

function normalizeMobile(value: unknown): string | null {
  let digits = String(value ?? "").replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  return digits.length === 10 ? digits : null;
}

function isNaturalSupervisor(value: unknown): boolean {
  return normalizeText(value).toLowerCase() === "supervisor";
}

function sourceTerminated(value: unknown): boolean {
  const normalized = normalizeText(value).toLowerCase();
  return value === true || value === 1 || normalized === "1" || normalized === "true" || normalized === "yes";
}

function normalizeOrgKey(value: unknown): string {
  return normalizeText(value).toLocaleLowerCase("en-US");
}

function stableCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "UNASSIGNED";
}

function collisionSuffix(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 8).toUpperCase();
}

async function departmentFor(tx: Tx, name: string, result: SyncResult) {
  // Prisma SQLite does not support case-insensitive string filters. Compare a
  // normalized key in application code while retaining the first display name.
  const existing = (await tx.department.findMany()).find(
    (candidate) => normalizeOrgKey(candidate.name) === normalizeOrgKey(name)
  );
  if (existing) {
    return existing.active ? existing : tx.department.update({ where: { id: existing.id }, data: { active: true } });
  }

  const base = stableCode(name);
  const codeOwner = await tx.department.findUnique({ where: { code: base } });
  const code = codeOwner ? `${base}_${collisionSuffix(name)}` : base;
  const department = await tx.department.create({ data: { name, code, source: "SYNC", active: true } });
  result.departmentsCreated += 1;
  return department;
}

async function sectionFor(tx: Tx, departmentId: number, name: string, result: SyncResult) {
  const existing = (await tx.section.findMany({ where: { departmentId } })).find(
    (candidate) => normalizeOrgKey(candidate.name) === normalizeOrgKey(name)
  );
  if (existing) {
    return existing.active ? existing : tx.section.update({ where: { id: existing.id }, data: { active: true } });
  }

  const base = stableCode(name);
  const codeOwner = await tx.section.findUnique({
    where: { departmentId_code: { departmentId, code: base } },
  });
  const code = codeOwner ? `${base}_${collisionSuffix(name)}` : base;
  const section = await tx.section.create({
    data: { departmentId, name, code, source: "SYNC", active: true },
  });
  result.sectionsCreated += 1;
  return section;
}

async function recordException(
  externalKey: string,
  ecNo: string | null,
  mobile: string | null,
  errorCode: string,
  message: string
): Promise<void> {
  await prisma.syncException.upsert({
    where: {
      sourceSystem_externalKey_errorCode: {
        sourceSystem: "LABOURWORKS",
        externalKey,
        errorCode,
      },
    },
    create: { sourceSystem: "LABOURWORKS", externalKey, ecNo, mobile, errorCode, message },
    update: {
      ecNo,
      mobile,
      message,
      occurrences: { increment: 1 },
      status: "OPEN",
      lastSeenAt: new Date(),
      resolvedAt: null,
    },
  });
}

async function resolveExceptions(tx: Tx, externalKey: string): Promise<void> {
  await tx.syncException.updateMany({
    where: { sourceSystem: "LABOURWORKS", externalKey, status: "OPEN" },
    data: { status: "RESOLVED", resolvedAt: new Date(), lastSeenAt: new Date() },
  });
}

function credentialRecipient(): string {
  return process.env.CREDENTIAL_DELIVERY_RECIPIENT?.trim() || "itsupport.shipyard@swan.co.in";
}

async function queueCredential(tx: Tx, userId: number, purpose: "NEW_SUPERVISOR" | "REACTIVATION") {
  const alreadyQueued = await tx.credentialDelivery.findFirst({
    where: { userId, status: { in: ["PENDING", "PROCESSING"] } },
    select: { id: true },
  });
  if (alreadyQueued) return false;
  await tx.credentialDelivery.create({
    data: { userId, recipient: credentialRecipient(), purpose, status: "PENDING" },
  });
  return true;
}

async function uniqueSyncEmail(tx: Tx, ecNo: string): Promise<string> {
  const local = ecNo.toLowerCase().replace(/[^a-z0-9._-]/g, "_") || "supervisor";
  let email = `${local}@sync.local`;
  let suffix = 1;
  while (await tx.user.findUnique({ where: { email }, select: { id: true } })) {
    email = `${local}.${suffix}@sync.local`;
    suffix += 1;
  }
  return email;
}

async function fetchBadgeViewRows(): Promise<BadgeViewRow[]> {
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
    const safeView = view.split(".").map((part) => `[${part}]`).join(".");
    const request = pool.request();
    request.input("cardType", sql.NVarChar(32), "ASSOCIATES");
    const response = await request.query(`
      SELECT
        IDCardNo AS EcNo,
        BuName,
        CONCAT(LTRIM(RTRIM(BuName)), ' - ', LTRIM(RTRIM([Workmen Division]))) AS Department,
        [Workmen Section] AS Section,
        [Workmen Division] AS Division,
        [Workmen Name] AS WorkmenName,
        [Nature Of Work] AS NatureOfWork,
        mobile,
        IsTerminated
      FROM ${safeView}
      WHERE [Card Type] = @cardType
    `);
    return (response.recordset as BadgeViewRow[]) || [];
  } finally {
    await pool.close();
  }
}

async function assertCompleteSnapshot(rows: BadgeViewRow[]): Promise<void> {
  const minimumRows = Math.max(1, Number(process.env.BADGEVIEW_SYNC_MIN_ROWS || 1));
  if (rows.length < minimumRows) {
    throw new Error(`Completeness guard rejected ${rows.length} rows (minimum ${minimumRows}).`);
  }

  const validEcNos = new Set(rows.map((row) => normalizeEcNo(row.EcNo)).filter(Boolean));
  if (!validEcNos.size) throw new Error("Completeness guard found no valid EcNo values.");

  const existingCount = await prisma.employee.count({ where: { source: "SYNC" } });
  const minimumRatio = Number(process.env.BADGEVIEW_SYNC_MIN_RATIO || 0.9);
  if (!Number.isFinite(minimumRatio) || minimumRatio <= 0 || minimumRatio > 1) {
    throw new Error("BADGEVIEW_SYNC_MIN_RATIO must be greater than 0 and at most 1.");
  }
  if (existingCount > 0 && validEcNos.size < Math.ceil(existingCount * minimumRatio)) {
    throw new Error(
      `Completeness guard rejected ${validEcNos.size} distinct employees; expected at least ${Math.ceil(existingCount * minimumRatio)}.`
    );
  }
}

/**
 * Synchronize canonical Employee/Department/Section/Supervisor data from LabourWorks.
 * Source fetch and credential delivery happen outside DB transactions. Each source row
 * is isolated so an identity exception cannot corrupt or suppress unrelated workers.
 */
export async function syncBadgeViewRows(rows: BadgeViewRow[]): Promise<SyncResult> {
  const startedAt = new Date();
  const result: SyncResult = {
    ok: false,
    workersUpserted: 0,
    supervisorsLinked: 0,
    departmentsCreated: 0,
    sectionsCreated: 0,
    terminated: 0,
    reactivated: 0,
    exceptions: 0,
    credentialsQueued: 0,
    startedAt,
    finishedAt: startedAt,
  };

  try {
    await assertCompleteSnapshot(rows);
    const now = new Date();
    const seenEmployeeIds = new Set<number>();

    const employeesByEcKey = new Map<string, Awaited<ReturnType<typeof prisma.employee.findMany>>>();
    for (const employee of await prisma.employee.findMany()) {
      const key = ecNoKey(employee.ecNo);
      const matches = employeesByEcKey.get(key) || [];
      matches.push(employee);
      employeesByEcKey.set(key, matches);
    }

    const rowsByEcNo = new Map<string, BadgeViewRow[]>();
    for (const row of rows) {
      const key = ecNoKey(row.EcNo);
      const group = rowsByEcNo.get(key) || [];
      group.push(row);
      rowsByEcNo.set(key, group);
    }

    for (const row of rows) {
      const ecNo = normalizeEcNo(row.EcNo);
      const mobile = normalizeMobile(row.mobile);
      const externalKey = ecNo || `ROW_${collisionSuffix(JSON.stringify(row))}`;

      if (!ecNo) {
        await recordException(externalKey, null, mobile, "INVALID_ECNO", "LabourWorks row has a blank EcNo.");
        result.exceptions += 1;
        continue;
      }
      if ((rowsByEcNo.get(ecNoKey(ecNo))?.length || 0) > 1) {
        const existing = employeesByEcKey.get(ecNoKey(ecNo))?.[0];
        if (existing?.source === "SYNC") seenEmployeeIds.add(existing.id);
        // Record the duplicate once, not once per duplicate source row.
        if (rowsByEcNo.get(ecNoKey(ecNo))?.[0] === row) {
          await recordException(externalKey, ecNo, mobile, "DUPLICATE_SOURCE_ECNO", "Multiple LabourWorks rows have the same normalized EcNo.");
          result.exceptions += 1;
        }
        continue;
      }

      const buName = normalizeText(row.BuName);
      const division = normalizeText(row.Division);
      const departmentName = buName && division ? `${buName} - ${division}` : "";
      const employeeName = normalizeText(row.WorkmenName);
      if (!departmentName || !employeeName) {
        const existing = employeesByEcKey.get(ecNoKey(ecNo))?.[0];
        if (existing?.source === "SYNC") seenEmployeeIds.add(existing.id);
        await recordException(externalKey, ecNo, mobile, "INVALID_MASTER_DATA", "Department, BuName, Division, and Workmen Name are required.");
        result.exceptions += 1;
        continue;
      }

      const exactMatches = employeesByEcKey.get(ecNoKey(ecNo)) || [];
      if (exactMatches.length > 1) {
        for (const candidate of exactMatches.filter((item) => item.source === "SYNC")) seenEmployeeIds.add(candidate.id);
        await recordException(externalKey, ecNo, mobile, "ECNO_IDENTITY_CONFLICT", "Multiple Employee records match the normalized EcNo.");
        result.exceptions += 1;
        continue;
      }
      const exact = exactMatches[0] || null;
      if (exact && exact.source !== "SYNC") {
        await recordException(externalKey, ecNo, mobile, "ECNO_SOURCE_COLLISION", "EcNo belongs to a non-CLMS Employee; row was not applied.");
        result.exceptions += 1;
        continue;
      }

      let matched = exact;
      if (!matched && mobile) {
        const mobileMatches = await prisma.employee.findMany({
          where: { source: "SYNC", mobile },
          orderBy: { id: "asc" },
        });
        const inactiveMatches = mobileMatches.filter((candidate) => !candidate.active);
        if (mobileMatches.length === 1 && inactiveMatches.length === 1) {
          matched = inactiveMatches[0];
        } else if (mobileMatches.length > 0) {
          for (const candidate of mobileMatches) seenEmployeeIds.add(candidate.id);
          await recordException(
            externalKey,
            ecNo,
            mobile,
            "MOBILE_IDENTITY_CONFLICT",
            "Mobile fallback did not resolve to exactly one inactive CLMS Employee."
          );
          result.exceptions += 1;
          continue;
        }
      }

      const wasInactive = Boolean(matched && !matched.active);
      const terminated = sourceTerminated(row.IsTerminated);
      const naturalSupervisor = isNaturalSupervisor(row.NatureOfWork);

      const applied = await prisma.$transaction(async (tx) => {
        const department = await departmentFor(tx, departmentName, result);
        const sectionName = normalizeText(row.Section);
        const section = sectionName ? await sectionFor(tx, department.id, sectionName, result) : null;

        let employee;
        if (matched) {
          employee = await tx.employee.update({
            where: { id: matched.id },
            data: {
              ecNo,
              mobile,
              name: employeeName,
              departmentId: department.id,
              designation: normalizeText(row.NatureOfWork) || matched.designation,
              category: "CONTRACTOR",
              employmentType: "CLMS",
              natureOfWork: normalizeText(row.NatureOfWork) || null,
              active: !terminated,
              lastSyncedAt: now,
              terminatedAt: terminated ? matched.terminatedAt || now : null,
            },
          });
        } else {
          employee = await tx.employee.create({
            data: {
              ecNo,
              mobile,
              name: employeeName,
              departmentId: department.id,
              designation: normalizeText(row.NatureOfWork),
              category: "CONTRACTOR",
              source: "SYNC",
              employmentType: "CLMS",
              natureOfWork: normalizeText(row.NatureOfWork) || null,
              active: !terminated,
              lastSyncedAt: now,
              terminatedAt: terminated ? now : null,
            },
          });
        }

        const override = await tx.supervisorOverride.findUnique({
          where: { employeeId: employee.id },
          select: { revokedAt: true },
        });
        const effectiveSupervisor = naturalSupervisor || Boolean(override && override.revokedAt == null);

        if (section && !effectiveSupervisor) {
          await tx.employeeSectionAssignment.upsert({
            where: { employeeId: employee.id },
            create: { employeeId: employee.id, sectionId: section.id, source: "SYNC" },
            update: { sectionId: section.id, source: "SYNC" },
          });
        } else if (effectiveSupervisor) {
          const assignment = await tx.employeeSectionAssignment.findUnique({
            where: { employeeId: employee.id },
            include: { section: { select: { departmentId: true } } },
          });
          if (assignment && assignment.section.departmentId !== department.id) {
            await tx.employeeSectionAssignment.delete({ where: { employeeId: employee.id } });
          }
        }

        let credentialsQueued = false;
        let supervisorLinked = false;
        let user = await tx.user.findUnique({ where: { employeeId: employee.id } });
        if (user && user.departmentId !== employee.departmentId) {
          user = await tx.user.update({ where: { id: user.id }, data: { departmentId: employee.departmentId } });
        }
        if (!employee.active) {
          if (user?.active) {
            await tx.user.update({
              where: { id: user.id },
              data: { active: false, tokenVersion: { increment: 1 } },
            });
          }
          if (user) await tx.credentialDelivery.updateMany({ where: { userId: user.id, status: { in: ["PENDING", "PROCESSING"] } }, data: { status: "CANCELLED", lastError: "Employee terminated." } });
        } else if (effectiveSupervisor) {
          if (!user) {
            user = await tx.user.create({
              data: {
                email: await uniqueSyncEmail(tx, ecNo),
                passwordHash: await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 10),
                name: employee.name,
                role: "SUPERVISOR",
                source: "SYNC",
                employeeId: employee.id,
                departmentId: employee.departmentId,
                active: true,
                mustChangePassword: true,
                // Deny login until the outbox activates and emails a fresh secret.
                passwordExpiresAt: now,
              },
            });
            credentialsQueued = await queueCredential(tx, user.id, wasInactive ? "REACTIVATION" : "NEW_SUPERVISOR");
          } else {
            const becomingSupervisor = user.role !== "SUPERVISOR";
            const needsReactivationCredential = !user.active || wasInactive || becomingSupervisor;
            user = await tx.user.update({
              where: { id: user.id },
              data: {
                name: employee.name,
                role: "SUPERVISOR",
                departmentId: employee.departmentId,
                active: true,
                ...(needsReactivationCredential
                  ? {
                      passwordHash: await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 10),
                      mustChangePassword: true,
                      passwordExpiresAt: now,
                      credentialSentAt: null,
                      tokenVersion: { increment: 1 },
                    }
                  : {}),
              },
            });
            if (needsReactivationCredential) {
              credentialsQueued = await queueCredential(tx, user.id, becomingSupervisor ? "NEW_SUPERVISOR" : "REACTIVATION");
            }
          }
          supervisorLinked = true;
        } else if (user?.active && user.role === "SUPERVISOR") {
          await tx.user.update({
            where: { id: user.id },
            data: { active: false, tokenVersion: { increment: 1 } },
          });
          await tx.credentialDelivery.updateMany({ where: { userId: user.id, status: { in: ["PENDING", "PROCESSING"] } }, data: { status: "CANCELLED", lastError: "Supervisor eligibility removed." } });
        }

        await resolveExceptions(tx, externalKey);
        return { employeeId: employee.id, credentialsQueued, supervisorLinked };
      });

      seenEmployeeIds.add(applied.employeeId);
      result.workersUpserted += 1;
      if (applied.supervisorLinked) result.supervisorsLinked += 1;
      if (applied.credentialsQueued) result.credentialsQueued += 1;
      if (terminated && (!matched || matched.active)) result.terminated += 1;
      if (!terminated && wasInactive) result.reactivated += 1;
    }

    // Absence remains a soft termination, but only after the snapshot passes the
    // absolute and relative completeness guards above. Preserve Employee/User/history.
    // Filtering a large snapshot with `id: { notIn: [...] }` exceeds SQLite's
    // bound-parameter limit. Fetch the active CLMS identities without a large
    // negated filter, then compare against the staged snapshot in memory.
    const activeSyncEmployees = await prisma.employee.findMany({
      where: { source: "SYNC", active: true },
      select: { id: true, user: { select: { id: true, active: true } } },
    });
    const absent = activeSyncEmployees.filter((employee) => !seenEmployeeIds.has(employee.id));
    for (const employee of absent) {
      await prisma.$transaction(async (tx) => {
        await tx.employee.update({
          where: { id: employee.id },
          data: { active: false, terminatedAt: now, lastSyncedAt: now },
        });
        if (employee.user?.active) {
          await tx.user.update({
            where: { id: employee.user.id },
            data: { active: false, tokenVersion: { increment: 1 } },
          });
        }
        if (employee.user) await tx.credentialDelivery.updateMany({ where: { userId: employee.user.id, status: { in: ["PENDING", "PROCESSING"] } }, data: { status: "CANCELLED", lastError: "Employee absent from validated LabourWorks snapshot." } });
      });
      result.terminated += 1;
    }

    result.ok = true;
    result.finishedAt = new Date();
    return result;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    result.finishedAt = new Date();
    return result;
  }
}

/** Fetch LabourWorks and apply the resulting staged snapshot. */
export async function runBadgeViewSync(): Promise<SyncResult> {
  const startedAt = new Date();
  try {
    return await syncBadgeViewRows(await fetchBadgeViewRows());
  } catch (error) {
    return {
      ok: false,
      workersUpserted: 0,
      supervisorsLinked: 0,
      departmentsCreated: 0,
      sectionsCreated: 0,
      terminated: 0,
      reactivated: 0,
      exceptions: 0,
      credentialsQueued: 0,
      startedAt,
      finishedAt: new Date(),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
