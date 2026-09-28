/**
 * The absence sweep must leave an audit trail.
 *
 * Why this test exists: the sweep is the ONLY code path that disables a login without a
 * human clicking anything, and it used to report only to stdout. Diagnosing "the app
 * disabled my employee" from the database was therefore impossible — the trail now has to
 * be a row in audit_log with a null actor (the integration, not a person).
 *
 * It drives `sweepAbsentEmployees` with an explicit list rather than `syncBadgeViewRows`.
 * That is deliberate: the sync's own sweep selects every active SYNC employee the snapshot
 * omits, so a fixture aimed at one employee terminates the entire dev dataset, and the only
 * way to reach the sweep through a whole sync is to lower the completeness guard — which is
 * precisely what makes the global sweep destructive. Testing the extracted helper removes
 * that hazard entirely.
 *
 * Runs against the dev SQLite database like the other service tests, and removes every row
 * it creates.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../db";
import { sweepAbsentEmployees } from "./badgeViewSync";

/** A department to hang fixtures off. The first existing one is fine. */
async function anyDepartmentId(): Promise<number> {
  const department = await prisma.department.findFirst({ select: { id: true } });
  assert.ok(department, "the dev database needs at least one department");
  return department!.id;
}

/** A SYNC-owned employee plus a login, shaped the way the sync creates them. */
async function sweepFixture(ecNo: string, active: boolean) {
  const employee = await prisma.employee.create({
    data: {
      ecNo,
      name: `Sweep ${ecNo}`,
      departmentId: await anyDepartmentId(),
      designation: "Fitter",
      category: "Skilled",
      source: "SYNC",
      employmentType: "CLMS",
      active: true,
    },
    select: { id: true },
  });
  const user = await prisma.user.create({
    data: {
      email: `${ecNo.toLowerCase()}@sync.local`,
      name: `Sweep ${ecNo}`,
      role: "SUPERVISOR",
      source: "SYNC",
      active,
      passwordHash: "x",
      employeeId: employee.id,
    },
    select: { id: true },
  });
  return { employeeId: employee.id, userId: user.id as number | null };
}

async function removeFixture(ids: { employeeId: number; userId: number | null }) {
  if (ids.userId != null) await prisma.credentialDelivery.deleteMany({ where: { userId: ids.userId } });
  await prisma.auditLog.deleteMany({ where: { entityType: "employee", entityId: String(ids.employeeId) } });
  if (ids.userId != null) await prisma.user.deleteMany({ where: { id: ids.userId } });
  await prisma.employee.deleteMany({ where: { id: ids.employeeId } });
}

test("an employee absent from a validated snapshot is terminated and audited", async () => {
  const ids = await sweepFixture("SWEEPTEST1", true);
  try {
    const before = await prisma.user.findUniqueOrThrow({ where: { id: ids.userId! }, select: { active: true, tokenVersion: true } });

    const terminated = await sweepAbsentEmployees([{ id: ids.employeeId, user: { id: ids.userId!, active: true } }], new Date());

    const after = await prisma.user.findUniqueOrThrow({ where: { id: ids.userId! }, select: { active: true, tokenVersion: true } });
    const swept = await prisma.employee.findUniqueOrThrow({ where: { id: ids.employeeId }, select: { active: true, terminatedAt: true } });

    assert.equal(terminated, 1, "the sweep counts the employee");
    assert.equal(after.active, false, "the login is disabled by the sweep");
    assert.equal(after.tokenVersion, before.tokenVersion + 1, "live sessions are ended");
    assert.equal(swept.active, false, "the employee record is terminated");
    assert.ok(swept.terminatedAt, "terminatedAt is stamped");

    // The point of the change: this is now answerable from the database.
    const audit = await prisma.auditLog.findFirst({
      where: { action: "SYNC_ABSENCE_SWEEP", entityType: "employee", entityId: String(ids.employeeId) },
      orderBy: { id: "desc" },
    });
    assert.ok(audit, "the sweep writes an audit row");
    assert.equal(audit!.userId, null, "the actor is the integration, not a person");
    const meta = JSON.parse(audit!.metadata!) as { accountDisabled: boolean; reason: string };
    assert.equal(meta.accountDisabled, true, "the trail records that a login was switched off");
    assert.match(meta.reason, /Absent/);
  } finally {
    await removeFixture(ids);
  }
});

test("an already-inactive login is swept but not recorded as disabled", async () => {
  const ids = await sweepFixture("SWEEPTEST2", false);
  try {
    await sweepAbsentEmployees([{ id: ids.employeeId, user: { id: ids.userId!, active: false } }], new Date());

    const audit = await prisma.auditLog.findFirst({
      where: { action: "SYNC_ABSENCE_SWEEP", entityId: String(ids.employeeId) },
      orderBy: { id: "desc" },
    });
    assert.ok(audit, "the sweep is still recorded for the employee");
    const meta = JSON.parse(audit!.metadata!) as { accountDisabled: boolean };
    assert.equal(meta.accountDisabled, false, "no login was switched off, and the trail says so");
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: ids.userId! } })).active, false);
  } finally {
    await removeFixture(ids);
  }
});

test("an employee with no login is swept without a phantom disable", async () => {
  const employee = await prisma.employee.create({
    data: {
      ecNo: "SWEEPTEST3",
      name: "Sweep SWEEPTEST3",
      departmentId: await anyDepartmentId(),
      designation: "Fitter",
      category: "Skilled",
      source: "SYNC",
      employmentType: "CLMS",
      active: true,
    },
    select: { id: true },
  });
  try {
    const terminated = await sweepAbsentEmployees([{ id: employee.id, user: null }], new Date());
    assert.equal(terminated, 1);
    assert.equal((await prisma.employee.findUniqueOrThrow({ where: { id: employee.id } })).active, false, "the employee is still terminated");

    const audit = await prisma.auditLog.findFirst({ where: { action: "SYNC_ABSENCE_SWEEP", entityId: String(employee.id) } });
    assert.ok(audit, "a login-less employee is still recorded");
    assert.equal((JSON.parse(audit!.metadata!) as { accountDisabled: boolean }).accountDisabled, false, "nothing was disabled");
  } finally {
    await removeFixture({ employeeId: employee.id, userId: null });
  }
});
