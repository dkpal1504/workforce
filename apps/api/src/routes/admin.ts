import { Router } from "express";
import bcrypt from "bcryptjs";
import { prisma } from "../db";
import { requireAuth, requireRoles } from "../middleware/auth";
import { writeAudit } from "../audit";

export const adminRouter = Router();

adminRouter.use(requireAuth, requireRoles("ADMIN", "HR"));

adminRouter.get("/users", async (_req, res) => {
  const users = await prisma.user.findMany({
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      departmentId: true,
      department: true,
    },
    orderBy: { name: "asc" },
  });
  res.json({ users });
});

adminRouter.post("/users", async (req, res) => {
  const { email, password, name, role, departmentId } = req.body;
  const passwordHash = await bcrypt.hash(password || "password123", 10);
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      name,
      role,
      departmentId: departmentId || null,
    },
  });
  await writeAudit(req.user!.id, "ADMIN_CREATE_USER", "user", user.id);
  res.status(201).json({ user });
});

adminRouter.get("/departments", async (_req, res) => {
  const departments = await prisma.department.findMany({ orderBy: { name: "asc" } });
  res.json({ departments });
});

// Manual department management (ADMIN/HR router gated). The sync auto-creates
// departments as source='SYNC'; manual adds are source='MANUAL'. The sync only
// create-missing (never overwrites manual edits), and manual edits must not
// collide with auto-created codes.
adminRouter.post("/departments", async (req, res) => {
  const { name, code } = req.body;
  if (!name || !code) {
    return res.status(400).json({ error: "name and code are required" });
  }
  const existing = await prisma.department.findUnique({ where: { code: code.trim().toUpperCase() } });
  if (existing) {
    return res.status(409).json({ error: "A department with this code already exists.", code: "DEPT_CODE_EXISTS" });
  }
  const department = await prisma.department.create({
    data: { name: name.trim(), code: code.trim().toUpperCase(), source: "MANUAL" },
  });
  await writeAudit(req.user!.id, "ADMIN_CREATE_DEPT", "department", department.id, { name, code, source: "MANUAL" });
  res.status(201).json({ department });
});

// Update a MANUAL department. Sync-owned (source='SYNC') rows are also editable by
// an admin here (promotes them to manual, so the sync stops owning them) — this is
// the explicit path by which a manually-edited auto-created dept survives re-runs.
adminRouter.put("/departments/:id", async (req, res) => {
  const id = Number(req.params.id);
  const { name, code } = req.body;
  const existing = await prisma.department.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: "Department not found" });
  const data: { name?: string; code?: string; source?: string } = {};
  if (name !== undefined) data.name = name.trim();
  if (code !== undefined) {
    const newCode = code.trim().toUpperCase();
    const collides = await prisma.department.findFirst({ where: { code: newCode, id: { not: id } } });
    if (collides) return res.status(409).json({ error: "Department code already in use.", code: "DEPT_CODE_EXISTS" });
    data.code = newCode;
  }
  // Editing an auto-created (SYNC) dept flips it to MANUAL so the sync no longer owns it.
  data.source = "MANUAL";
  const department = await prisma.department.update({ where: { id }, data });
  await writeAudit(req.user!.id, "ADMIN_UPDATE_DEPT", "department", department.id, { name, code });
  res.json({ department });
});

adminRouter.get("/projects-wbs", async (_req, res) => {
  const projects = await prisma.projectWbs.findMany({ orderBy: { colorKey: "asc" } });
  res.json({ projects });
});

adminRouter.post("/projects-wbs", async (req, res) => {
  const { code, name, wbsCode, colorKey } = req.body;
  const project = await prisma.projectWbs.create({
    data: { code, name, wbsCode, colorKey },
  });
  await writeAudit(req.user!.id, "ADMIN_CREATE_PROJECT", "projects_wbs", project.id);
  res.status(201).json({ project });
});

adminRouter.get("/cost-rates", async (_req, res) => {
  const rates = await prisma.costRate.findMany({ orderBy: [{ category: "asc" }, { effectiveFrom: "desc" }] });
  res.json({ rates });
});

adminRouter.post("/cost-rates", async (req, res) => {
  const { category, ratePerHour, effectiveFrom, effectiveTo } = req.body;
  const rate = await prisma.costRate.create({
    data: {
      category,
      ratePerHour,
      effectiveFrom: new Date(effectiveFrom),
      effectiveTo: effectiveTo ? new Date(effectiveTo) : null,
    },
  });
  await writeAudit(req.user!.id, "ADMIN_CREATE_RATE", "cost_rates", rate.id);
  res.status(201).json({ rate });
});
