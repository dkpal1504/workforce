import { Router } from "express";
import { prisma } from "../db";
import { requireAuth, requireRoles } from "../middleware/auth";

export const mastersRouter = Router();

mastersRouter.use(requireAuth);

mastersRouter.get("/departments", async (_req, res) => {
  const departments = await prisma.department.findMany({ orderBy: { name: "asc" } });
  res.json({ departments });
});

mastersRouter.get("/employees", requireRoles("SUPERVISOR", "HOD", "PM", "ADMIN", "HR"), async (req, res) => {
  const requestedDepartmentId = req.query.department_id ? Number(req.query.department_id) : undefined;
  const departmentId = ["SUPERVISOR", "HOD"].includes(req.user!.role)
    ? (req.user!.departmentId ?? -1)
    : requestedDepartmentId;
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
    include: {
      department: { select: { id: true, name: true } },
      sectionAssignment: { include: { section: { include: { costCenter: true } } } },
    },
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

/**
 * New Project table (5 projects, 14 Job Orders). Used by the Timesheet
 * Entry "Project" dropdown and the Job Order Summary "Select Projects"
 * multi-select. Sorted by sortOrder so "Project A" comes first.
 */
mastersRouter.get("/projects", async (_req, res) => {
  const projects = await prisma.project.findMany({
    orderBy: { sortOrder: "asc" },
    include: {
      jobOrders: {
        where: { status: { in: ["active", "closed"] }, department: { name: { contains: " - " }, active: true } },
        orderBy: { code: "asc" },
        select: {
          id: true,
          code: true,
          name: true,
          status: true,
          budgetedHours: true,
          departmentId: true,
        },
      },
    },
  });
  res.json({ projects });
});


/** Active section picker, optionally scoped to a department. */
mastersRouter.get("/sections", async (req, res) => {
  const departmentId = req.query.department_id ? Number(req.query.department_id) : undefined;
  const sections = await prisma.section.findMany({
    where: { active: true, ...(departmentId ? { departmentId } : {}) },
    select: { id: true, code: true, name: true, departmentId: true, costCenter: { select: { id: true, code: true, name: true, active: true } } },
    orderBy: { name: "asc" },
  });
  res.json({ sections });
});

/** Active cost-centre picker; section/department filters are optional. */
mastersRouter.get("/cost-centers", async (req, res) => {
  const sectionId = req.query.section_id ? Number(req.query.section_id) : undefined;
  const departmentId = req.query.department_id ? Number(req.query.department_id) : undefined;
  const costCenters = await prisma.costCenter.findMany({
    where: { active: true, ...(sectionId ? { sectionId } : {}), ...(departmentId ? { section: { departmentId } } : {}) },
    select: { id: true, code: true, name: true, sectionId: true, section: { select: { id: true, code: true, name: true, departmentId: true } } },
    orderBy: { code: "asc" },
  });
  res.json({ costCenters });
});
