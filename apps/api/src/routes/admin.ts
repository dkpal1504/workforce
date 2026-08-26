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

adminRouter.post("/departments", async (req, res) => {
  const { name, code } = req.body;
  const department = await prisma.department.create({ data: { name, code } });
  await writeAudit(req.user!.id, "ADMIN_CREATE_DEPT", "department", department.id);
  res.status(201).json({ department });
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
