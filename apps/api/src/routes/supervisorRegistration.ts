import { Router } from "express";
import bcrypt from "bcryptjs";
import { prisma } from "../db";
import { requireAuth, requireRoles } from "../middleware/auth";
import { writeAudit } from "../audit";

/**
 * Front-end-managed supervisor registration (white-collar / on-payroll).
 *
 * These are MANUAL login accounts (source='MANUAL') — the sync never touches
 * them. Collision policy: a manual registration whose idCardNo already exists
 * as a SYNC row is REJECTED with a clear error (never silently duplicated).
 * Promoting a sync worker to a manual login is an explicit admin action
 * (convert + set password), not an implicit upsert side-effect.
 */

export const supervisorRegistrationRouter = Router();

supervisorRegistrationRouter.use(requireAuth, requireRoles("ADMIN", "HR"));

/** List all supervisors (manual + sync) for the registration screen. */
supervisorRegistrationRouter.get("/", async (_req, res) => {
  const supervisors = await prisma.user.findMany({
    where: { role: "SUPERVISOR" },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      source: true,
      idCardNo: true,
      departmentId: true,
      department: { select: { id: true, name: true } },
      createdAt: true,
    },
    orderBy: { name: "asc" },
  });
  res.json({ supervisors });
});

/** Create a manual supervisor (login account). */
supervisorRegistrationRouter.post("/", async (req, res) => {
  const { name, email, password, idCardNo, departmentId } = req.body ?? {};

  if (!name || !email || !password) {
    return res.status(400).json({ error: "name, email and password are required" });
  }
  if (!idCardNo) {
    return res.status(400).json({ error: "idCardNo is required (ID card / employee code)" });
  }

  // Collision policy: reject if idCardNo already exists as a SYNC row.
  const existingSync = await prisma.user.findUnique({
    where: { idCardNo },
    select: { id: true, source: true },
  });
  if (existingSync) {
    if (existingSync.source === "SYNC") {
      return res.status(409).json({
        error: "This ID card / employee code already exists as a sync-managed supervisor. Use 'Convert to manual login' to promote it.",
        code: "IDCARD_SYNC_EXISTS",
      });
    }
    return res.status(409).json({
      error: "A supervisor with this ID card / employee code already exists.",
      code: "IDCARD_EXISTS",
    });
  }

  const emailExists = await prisma.user.findUnique({ where: { email } });
  if (emailExists) {
    return res.status(409).json({ error: "A user with this email already exists.", code: "EMAIL_EXISTS" });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({
    data: {
      name,
      email,
      passwordHash,
      role: "SUPERVISOR",
      source: "MANUAL",
      idCardNo,
      departmentId: departmentId || null,
    },
  });

  await writeAudit(req.user!.id, "SUPERVISOR_CREATE", "user", user.id, {
    name,
    email,
    idCardNo,
    source: "MANUAL",
  });

  res.status(201).json({
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      source: user.source,
      idCardNo: user.idCardNo,
      departmentId: user.departmentId,
    },
  });
});

/** Update a manual supervisor (name, email, department, optional password reset). */
supervisorRegistrationRouter.put("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const { name, email, password, departmentId } = req.body ?? {};

  const existing = await prisma.user.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: "Supervisor not found" });
  if (existing.source !== "MANUAL") {
    return res.status(403).json({
      error: "Sync-managed supervisors are read-only. Convert to manual login to edit.",
      code: "SYNC_READONLY",
    });
  }

  const data: Record<string, unknown> = {};
  if (name !== undefined) data.name = name;
  if (email !== undefined) data.email = email;
  if (departmentId !== undefined) data.departmentId = departmentId || null;
  if (password) data.passwordHash = await bcrypt.hash(password, 10);

  const user = await prisma.user.update({ where: { id }, data });
  await writeAudit(req.user!.id, "SUPERVISOR_UPDATE", "user", user.id, {
    name,
    email,
    departmentId,
    passwordChanged: Boolean(password),
  });

  res.json({
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      source: user.source,
      idCardNo: user.idCardNo,
      departmentId: user.departmentId,
    },
  });
});

/** Delete a manual supervisor. Sync rows are protected. */
supervisorRegistrationRouter.delete("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const existing = await prisma.user.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: "Supervisor not found" });
  if (existing.source !== "MANUAL") {
    return res.status(403).json({
      error: "Sync-managed supervisors are read-only and cannot be deleted.",
      code: "SYNC_READONLY",
    });
  }

  await prisma.user.delete({ where: { id } });
  await writeAudit(req.user!.id, "SUPERVISOR_DELETE", "user", id, {
    name: existing.name,
    email: existing.email,
    idCardNo: existing.idCardNo,
    source: "MANUAL",
  });

  res.json({ ok: true });
});

/**
 * Explicit admin action: promote a sync supervisor to a manual login account.
 * Sets a password and flips source to MANUAL. This is the ONLY path that
 * converts a sync row — never an implicit upsert side-effect.
 */
supervisorRegistrationRouter.post("/:id/convert", async (req, res) => {
  const id = Number(req.params.id);
  const { password, email } = req.body ?? {};

  const existing = await prisma.user.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: "Supervisor not found" });
  if (existing.source !== "SYNC") {
    return res.status(400).json({ error: "Only sync-managed supervisors can be converted.", code: "NOT_SYNC" });
  }
  if (!password) {
    return res.status(400).json({ error: "password is required to convert to a manual login." });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.update({
    where: { id },
    data: {
      passwordHash,
      source: "MANUAL",
      ...(email ? { email } : {}),
    },
  });

  // Converting to a manual login also pins the worker as a supervisor, so the
  // next sync marks them isSupervisor=true instead of reverting them.
  await prisma.supervisorPin.upsert({
    where: { idCardNo: user.idCardNo! },
    create: { idCardNo: user.idCardNo!, createdBy: req.user!.id },
    update: {},
  });

  await writeAudit(req.user!.id, "SUPERVISOR_CONVERT", "user", user.id, {
    name: user.name,
    idCardNo: user.idCardNo,
    from: "SYNC",
    to: "MANUAL",
    pinned: true,
  });

  res.json({
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      source: user.source,
      idCardNo: user.idCardNo,
      departmentId: user.departmentId,
    },
  });
});

/**
 * Explicitly pin a present contract worker as a supervisor (audited admin action).
 * A pin marks supervisor status of a PRESENT worker only — it never retains a
 * departed worker (strict-prune removes it on the next sync).
 */
supervisorRegistrationRouter.post("/:idCardNo/pin", async (req, res) => {
  const idCardNo = String(req.params.idCardNo);
  const worker = await prisma.contractWorker.findUnique({ where: { idCardNo } });
  if (!worker) {
    return res.status(404).json({ error: "Contract worker not found in master data." });
  }
  const pin = await prisma.supervisorPin.upsert({
    where: { idCardNo },
    create: { idCardNo, createdBy: req.user!.id },
    update: {},
  });
  await writeAudit(req.user!.id, "SUPERVISOR_PIN", "supervisor_pin", pin.id, {
    idCardNo,
    workmenName: worker.workmenName,
  });
  res.status(201).json({ pinned: true, idCardNo });
});

/**
 * Unpin a worker (audited admin action). The worker stays in the master data;
 * they simply no longer appear as a supervisor on the next sync.
 */
supervisorRegistrationRouter.delete("/:idCardNo/pin", async (req, res) => {
  const idCardNo = String(req.params.idCardNo);
  const pin = await prisma.supervisorPin.findUnique({ where: { idCardNo } });
  if (!pin) {
    return res.status(404).json({ error: "Worker is not pinned as a supervisor." });
  }
  await prisma.supervisorPin.delete({ where: { idCardNo } });
  await writeAudit(req.user!.id, "SUPERVISOR_UNPIN", "supervisor_pin", pin.id, {
    idCardNo,
  });
  res.json({ pinned: false, idCardNo });
});

/** List current pins (supervisor set) for the UI. */
supervisorRegistrationRouter.get("/pins", async (_req, res) => {
  const pins = await prisma.supervisorPin.findMany({
    select: { idCardNo: true, createdAt: true },
    orderBy: { idCardNo: "asc" },
  });
  res.json({ pins });
});
