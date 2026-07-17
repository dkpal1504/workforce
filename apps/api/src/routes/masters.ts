import { Router } from "express";
import { prisma } from "../db";
import { requireAuth } from "../middleware/auth";

export const mastersRouter = Router();

mastersRouter.use(requireAuth);

mastersRouter.get("/departments", async (_req, res) => {
  const departments = await prisma.department.findMany({ orderBy: { name: "asc" } });
  res.json({ departments });
});

mastersRouter.get("/employees", async (req, res) => {
  const departmentId = req.query.department_id
    ? Number(req.query.department_id)
    : undefined;
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const employees = await prisma.employee.findMany({
    where: {
      active: true,
      ...(departmentId ? { departmentId } : {}),
      ...(q
        ? {
            OR: [{ name: { contains: q } }, { ecNo: { contains: q } }],
          }
        : {}),
    },
    include: { department: { select: { id: true, name: true } } },
    orderBy: { name: "asc" },
  });
  res.json({ employees });
});

mastersRouter.get("/projects-wbs", async (_req, res) => {
  const projects = await prisma.projectWbs.findMany({
    where: { active: true },
    orderBy: { colorKey: "asc" },
  });
  res.json({ projects });
});

mastersRouter.get("/supervisors", async (req, res) => {
  const departmentId = req.query.department_id
    ? Number(req.query.department_id)
    : undefined;
  const supervisors = await prisma.user.findMany({
    where: {
      role: "SUPERVISOR",
      ...(departmentId ? { departmentId } : {}),
    },
    select: {
      id: true,
      name: true,
      email: true,
      departmentId: true,
      department: { select: { id: true, name: true } },
    },
    orderBy: { name: "asc" },
  });
  res.json({ supervisors });
});
