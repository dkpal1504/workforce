import { Router } from "express";
import { prisma } from "../db";
import { requireAuth, requireRoles } from "../middleware/auth";
import { departmentScope } from "../services/roleAccess";

export const mastersRouter = Router();

mastersRouter.use(requireAuth);

mastersRouter.get("/departments", async (req, res) => {
  const scopedDepartmentId = departmentScope(req.user!.role, req.user!.departmentId);
  const departments = await prisma.department.findMany({
    where: scopedDepartmentId !== undefined ? { id: scopedDepartmentId } : undefined,
    orderBy: { name: "asc" },
  });
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
      ...(req.user!.role === "HOD" ? { sectionAssignment: { sectionId: req.user!.sectionId ?? -1 } } : {}),
      ...(q
        ? {
            OR: [{ name: { contains: q } }, { ecNo: { contains: q } }],
          }
        : {}),
    },
    include: {
      department: { select: { id: true, name: true } },
      sectionAssignment: { include: { section: { include: { costCenter: true } } } },
      user: { select: { id: true, role: true, active: true } },
    },
    orderBy: { name: "asc" },
  });
  res.json({ employees });
});

/**
 * Project -> WBS picker feed. The retired `projects_wbs` table held one row per
 * project and carried the display token itself. The WBS level now hangs under
 * `projects`, so the token (`color_key`) belongs to the project and its WBS rows
 * come back nested inside it; `wbs_code` is what a Job Order is disambiguated by.
 * `projects` keeps its old key and shape (id, code, name, colorKey) because the
 * Project Summary filter chips read it. `wbs` is the same data as a flat list.
 */
mastersRouter.get("/projects-wbs", async (_req, res) => {
  const projects = await prisma.project.findMany({
    where: { active: true },
    orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
    include: {
      wbsRows: {
        where: { active: true },
        orderBy: [{ sortOrder: "asc" }, { wbsCode: "asc" }],
        select: { id: true, projectId: true, wbsCode: true, name: true, sortOrder: true },
      },
    },
  });
  res.json({
    projects: projects.map((project) => ({ ...project, wbs: project.wbsRows })),
    wbs: projects.flatMap((project) =>
      project.wbsRows.map((row) => ({
        ...row,
        project: { id: project.id, code: project.code, name: project.name, colorKey: project.colorKey },
      }))
    ),
  });
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
        // Only the two Job Order states exist now, and assignability is
        // "Job Order active + Project active + Department active". The old
        // `name contains " - "` test was dropped when the picker stopped using it.
        where: { status: { in: ["active", "inactive"] }, department: { active: true } },
        orderBy: { code: "asc" },
        select: {
          id: true,
          code: true,
          name: true,
          status: true,
          budgetedHours: true,
          departmentId: true,
          // The WBS number is RETURNED so the picker can disambiguate two Job
          // Orders that share a number across projects. The UI hides it by default.
          projectWbs: { select: { id: true, wbsCode: true } },
        },
      },
      // The WBS level and the per-project Network list, for the pickers that
      // filter a Job Order by project.
      wbsRows: { where: { active: true }, orderBy: [{ sortOrder: "asc" }, { wbsCode: "asc" }], select: { id: true, wbsCode: true, name: true, sortOrder: true } },
      networks: { where: { active: true }, orderBy: { code: "asc" }, select: { id: true, code: true, name: true, source: true } },
    },
  });
  res.json({ projects });
});


/** Active section picker, optionally scoped to a department. */
mastersRouter.get("/sections", async (req, res) => {
  const requestedDepartmentId = req.query.department_id ? Number(req.query.department_id) : undefined;
  const scopedDepartmentId = departmentScope(req.user!.role, req.user!.departmentId);
  const departmentId = scopedDepartmentId !== undefined ? scopedDepartmentId : requestedDepartmentId;
  const hodSectionId = req.user!.role === "HOD" ? (req.user!.sectionId ?? -1) : undefined;
  const sections = await prisma.section.findMany({
    where: { active: true, ...(departmentId !== undefined ? { departmentId } : {}), ...(hodSectionId !== undefined ? { id: hodSectionId } : {}) },
    select: { id: true, code: true, name: true, departmentId: true, costCenter: { select: { id: true, code: true, name: true, active: true } } },
    orderBy: { name: "asc" },
  });
  res.json({ sections });
});

/** Active cost-centre picker; section/department filters are optional. */
mastersRouter.get("/cost-centers", async (req, res) => {
  const requestedSectionId = req.query.section_id ? Number(req.query.section_id) : undefined;
  const sectionId = req.user!.role === "HOD" ? (req.user!.sectionId ?? -1) : requestedSectionId;
  const requestedDepartmentId = req.query.department_id ? Number(req.query.department_id) : undefined;
  const scopedDepartmentId = departmentScope(req.user!.role, req.user!.departmentId);
  const departmentId = scopedDepartmentId !== undefined ? scopedDepartmentId : requestedDepartmentId;
  const costCenters = await prisma.costCenter.findMany({
    where: { active: true, ...(sectionId ? { sectionId } : {}), ...(departmentId ? { section: { departmentId } } : {}) },
    select: { id: true, code: true, name: true, sectionId: true, section: { select: { id: true, code: true, name: true, departmentId: true } } },
    orderBy: { code: "asc" },
  });
  res.json({ costCenters });
});

/**
 * UoM picker. The Job Order form needs the unit of measure and, on screen, the
 * `example` string that explains it. Inactive units are withheld unless
 * `?include_inactive=true` is asked for by a maintenance screen.
 */
mastersRouter.get("/uom", async (req, res) => {
  const includeInactive = req.query.include_inactive === "true";
  const uom = await prisma.uom.findMany({
    ...(includeInactive ? {} : { where: { active: true } }),
    select: { id: true, code: true, name: true, example: true, active: true },
    orderBy: { code: "asc" },
  });
  res.json({ uom });
});

/**
 * Network picker, scoped to one project (`?project_id=`, or the project resolved
 * from `?project_code=`). A Network code is unique inside its project only.
 */
mastersRouter.get("/networks", async (req, res) => {
  const includeInactive = req.query.include_inactive === "true";
  const projectId = req.query.project_id ? Number(req.query.project_id) : undefined;
  const projectCode = typeof req.query.project_code === "string" && req.query.project_code.trim()
    ? req.query.project_code.trim().toUpperCase()
    : undefined;
  const networks = await prisma.network.findMany({
    where: {
      ...(includeInactive ? {} : { active: true }),
      ...(projectId ? { projectId } : {}),
      ...(projectCode ? { project: { code: projectCode } } : {}),
    },
    select: { id: true, projectId: true, code: true, name: true, source: true, active: true },
    orderBy: { code: "asc" },
  });
  res.json({ networks });
});

/**
 * WBS picker, optionally scoped to one project. `wbs_code` is unique per project,
 * so the project must be known before a code can be trusted.
 */
mastersRouter.get("/project-wbs", async (req, res) => {
  const includeInactive = req.query.include_inactive === "true";
  const projectId = req.query.project_id ? Number(req.query.project_id) : undefined;
  const wbs = await prisma.projectWbs.findMany({
    where: { ...(includeInactive ? {} : { active: true }), ...(projectId ? { projectId } : {}) },
    select: { id: true, projectId: true, wbsCode: true, name: true, sortOrder: true, active: true },
    orderBy: [{ projectId: "asc" }, { sortOrder: "asc" }, { wbsCode: "asc" }],
  });
  res.json({ wbs });
});
