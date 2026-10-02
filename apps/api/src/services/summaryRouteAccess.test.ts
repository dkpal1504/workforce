/**
 * The COO must be able to EXERCISE its `viewSummary` capability.
 *
 * Why this test exists: `roleAccess.capabilitiesFor("COO").viewSummary` is true and the web app
 * gates `/summary` on exactly that flag, but the summary router's own `requireRoles(...)` list
 * omitted COO — so the capability was advertised in the navigation and refused with 403 by the
 * API. Nothing unit-tested the ROUTER gate, only the capability flag, which is why the drift was
 * invisible. This drives the real Express router over real HTTP so the gate cannot silently drop
 * a role again.
 *
 * Lives under src/services/ (not src/routes/) on purpose: `apps/api`'s test script globs
 * `src/services/*.test.ts`, so a route-level test under src/routes/ would never run. It mounts
 * `summaryRouter` on an ephemeral server exactly as `src/index.ts` does and issues real requests.
 * It creates one COO account for the duration and deletes it afterwards; the dev baseline holds no
 * COO row, and auth reads the role from the DB, so a fixture is required to exercise the role.
 */
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import { prisma } from "../db";
import { summaryRouter } from "../routes/summary";
import { signToken } from "../middleware/auth";
import { departmentScope, isDepartmentViewRole } from "./roleAccess";

const COO_EMAIL = "coo.summary-gate-test@workforce.local";

type Probe = { status: number; body: Record<string, unknown> };

function listen(app: express.Express): Promise<{ base: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({ base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

async function get(base: string, path: string, token?: string): Promise<Probe> {
  const res = await fetch(base + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body: body as Record<string, unknown> };
}

test("the summary router admits the COO (viewSummary) and still gates everyone else", async (t) => {
  const app = express();
  app.use(express.json());
  app.use("/api/summary", summaryRouter); // same mount shape as src/index.ts
  const server = await listen(app);

  await prisma.user.deleteMany({ where: { email: COO_EMAIL } });
  const coo = await prisma.user.create({
    data: { email: COO_EMAIL, passwordHash: "test-fixture", name: "COO Gate Test", role: "COO", active: true },
    select: { id: true, tokenVersion: true },
  });
  t.after(async () => {
    await prisma.user.deleteMany({ where: { email: COO_EMAIL } });
    await server.close();
  });

  const cooToken = signToken({ id: coo.id, tokenVersion: coo.tokenVersion });

  // Scope is organisation-wide by CONSTRUCTION: the COO is not a department-view role, so the
  // Job Order handler's `isDepartmentViewRole(role)` branch (summary.ts) is false and no
  // Department filter is applied. (This is the code path a COO actually takes.)
  assert.equal(isDepartmentViewRole("COO"), false, "COO must not be pinned to one Department");
  assert.equal(departmentScope("COO", 4), undefined, "COO reads every Department");

  // The capability is now exercisable: the COO reaches the Job Order summary.
  const cooRes = await get(server.base, "/api/summary/job-order", cooToken);
  assert.equal(cooRes.status, 200, `COO must not be forbidden (got ${cooRes.status})`);
  assert.equal(cooRes.body.role, "COO");
  assert.equal(cooRes.body.scope, "organization", "the COO sees the whole organisation, not a department");
  assert.ok(Array.isArray(cooRes.body.groups), "a summary body, not an error");

  // The COO is NOT narrowed: an unfiltered report must see at least as much as a Department-filtered
  // one, and the handler must not silently force its own Department.
  const firstDept = await prisma.department.findFirst({ orderBy: { id: "asc" }, select: { id: true } });
  if (firstDept) {
    const narrowed = await get(server.base, `/api/summary/job-order?departmentId=${firstDept.id}`, cooToken);
    assert.equal(narrowed.status, 200);
    const allGroups = (cooRes.body.groups as unknown[]).length;
    const narrowedGroups = (narrowed.body.groups as unknown[]).length;
    assert.ok(allGroups >= narrowedGroups, "the unfiltered COO view covers every department");
  }

  // Unauthenticated: the router gate is still in front of the handler.
  const unauth = await get(server.base, "/api/summary/job-order");
  assert.equal(unauth.status, 401);

  // No regression for EMPLOYEE. The router admits EMPLOYEE (viewSummary, used by the plain
  // summary screen); the Job Order sub-view has its own handler-level restriction.
  const employee = await prisma.user.findFirst({
    where: { role: "EMPLOYEE", active: true, mustChangePassword: false, employeeId: { not: null } },
    orderBy: { id: "asc" },
    select: { id: true, tokenVersion: true },
  });
  assert.ok(employee, "the dev database needs an active employee login");
  const empToken = signToken({ id: employee!.id, tokenVersion: employee!.tokenVersion });
  const empRoot = await get(server.base, "/api/summary/?date=2026-10-02&frequency=monthly", empToken);
  assert.equal(empRoot.status, 200, "EMPLOYEE still reaches the plain summary (router gate unchanged)");
  const empJobOrder = await get(server.base, "/api/summary/job-order", empToken);
  assert.equal(empJobOrder.status, 403, "EMPLOYEE keeps its handler-level Job Order restriction");

  // ADMIN still works (organisation-wide like the COO).
  const admin = await prisma.user.findFirst({
    where: { role: "ADMIN", active: true, mustChangePassword: false },
    orderBy: { id: "asc" },
    select: { id: true, tokenVersion: true },
  });
  if (admin) {
    const adminRes = await get(server.base, "/api/summary/job-order", signToken({ id: admin.id, tokenVersion: admin.tokenVersion }));
    assert.equal(adminRes.status, 200);
  }
});
