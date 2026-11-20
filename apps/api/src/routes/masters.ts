import { Router } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { requireAuth, requireRoles } from "../middleware/auth";
import { assignedProjectIdsFor, projectPickerWhere } from "../services/projectScope";
import { departmentScope } from "../services/roleAccess";
import { hodScopeDepartmentIds, hodScopeNamedSectionIds, type HodScope } from "../services/hodScope";
import { employeeListScopeFor, employeeListWhere } from "../services/employeeListScope";

export const mastersRouter = Router();

mastersRouter.use(requireAuth);

mastersRouter.get("/departments", async (req, res) => {
  // A Sectional Head over two plants must see BOTH Departments in every picker. `departmentScope`
  // answers with one id; the grant set is what knows there are two.
  const scopedDepartmentId = pickerDepartmentFilter(req.user!.role, req.user!.hodScope);
  const departments = await prisma.department.findMany({
    where: scopedDepartmentId !== undefined ? { id: scopedDepartmentId } : undefined,
    orderBy: { name: "asc" },
  });
  res.json({ departments });
});

mastersRouter.get("/employees", requireRoles("SUPERVISOR", "HOD", "DEPT_HEAD", "PM", "ADMIN", "HR"), async (req, res) => {
  // One endpoint, three kinds of caller. The visibility rule — and in particular why a HOD's listing
  // is department-wide even when his account is narrowed to one Section — is in
  // services/employeeListScope.ts, where it is unit-tested.
  // The grant set, not the single scalar: a Sectional Head over Yardservice EOU + SEZ lists both rosters.
  const scope = employeeListScopeFor({
    role: req.user!.role,
    departmentId: req.user!.departmentId,
    departmentIds: hodScopeDepartmentIds(req.user!.hodScope),
    sectionId: req.user!.sectionId,
  });
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const employees = await prisma.employee.findMany({
    where: {
      active: true,
      ...employeeListWhere(scope),
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
  res.json({ employees, scope: scope.kind });
});

/**
 * Project -> WBS picker feed. The retired `projects_wbs` table held one row per
 * project and carried the display token itself. The WBS level now hangs under
 * `projects`, so the token (`color_key`) belongs to the project and its WBS rows
 * come back nested inside it; `wbs_code` is what a Job Order is disambiguated by.
 * `projects` keeps its old key and shape (id, code, name, colorKey) because the
 * Project Summary filter chips read it. `wbs` is the same data as a flat list.
 */
mastersRouter.get("/projects-wbs", async (req, res) => {
  // DISCLOSURE, not authorisation: the report is already clamped, but a dropdown that listed every
  // project would still show a Project Manager the shape of the whole portfolio. `null` (every other
  // role) adds no predicate at all, so their feed is byte-identical to before.
  const projectIds = await assignedProjectIdsFor(req.user!);
  const projects = await prisma.project.findMany({
    where: { active: true, ...projectPickerWhere(projectIds) },
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
mastersRouter.get("/projects", async (req, res) => {
  const projectIds = await assignedProjectIdsFor(req.user!);
  const projects = await prisma.project.findMany({
    where: projectPickerWhere(projectIds),
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


/**
 * The Section filter an HOD's pickers may offer, from the SET of Sections they cover.
 *
 * An EMPTY set keeps this file's existing meaning: it matches NOTHING. That is what
 * `sectionId == null` produced here (`?? -1`), and a Section Head with no Section today sees
 * no sections in these pickers. This change adds a MULTI-Section scope; it does not widen a
 * department-wide HOD. `{ in: [-1] }` is used rather than `{ in: [] }` so the intent is
 * explicit at the query and can never be read as 'no filter'.
 */
/** One id, `{ in: [...] }` for a head of several Departments, `undefined` = no filter. */
function pickerDepartmentFilter(role: string, scope: HodScope): number | { in: number[] } | undefined {
  if (departmentScope(role, null) === undefined) return undefined; // organisation-wide roles
  const ids = hodScopeDepartmentIds(scope);
  if (ids.length === 0) return -1;
  return ids.length === 1 ? ids[0] : { in: ids };
}

/**
 * The Sections a head may pick from: every Section of a Department he holds IN FULL, plus the Sections
 * he holds BY NAME.
 *
 * The old rule filtered on `sectionScope` alone, so a Department-wide head (empty set) was handed
 * `{ in: [-1] }` and every picker came back EMPTY — invisible for a Sectional Head over whole plants.
 */
function hodSectionPickerWhere(scope: HodScope): Prisma.SectionWhereInput {
  if (scope.grants.length === 0) return { id: -1 };
  const wholeDepartments = scope.grants.filter((grant) => grant.sectionIds.length === 0).map((grant) => grant.departmentId);
  const namedSections = hodScopeNamedSectionIds(scope);
  const branches = [
    ...(wholeDepartments.length ? [{ departmentId: { in: wholeDepartments } }] : []),
    ...(namedSections.length ? [{ id: { in: namedSections } }] : []),
  ];
  if (branches.length === 0) return { id: -1 };
  return branches.length === 1 ? branches[0] : { OR: branches };
}

/** Active section picker, optionally scoped to a department. */
mastersRouter.get("/sections", async (req, res) => {
  const requestedDepartmentId = req.query.department_id ? Number(req.query.department_id) : undefined;
  const scopedDepartmentId = pickerDepartmentFilter(req.user!.role, req.user!.hodScope);
  const departmentId = scopedDepartmentId !== undefined ? scopedDepartmentId : requestedDepartmentId;
  const hodSectionWhere = req.user!.role === "HOD" ? hodSectionPickerWhere(req.user!.hodScope) : undefined;
  const sections = await prisma.section.findMany({
    where: { active: true, ...(departmentId !== undefined ? { departmentId } : {}), ...(hodSectionWhere ?? {}) },
    select: { id: true, code: true, name: true, departmentId: true, costCenter: { select: { id: true, code: true, name: true, active: true } } },
    orderBy: { name: "asc" },
  });
  res.json({ sections });
});

/** Active cost-centre picker; section/department filters are optional. */
mastersRouter.get("/cost-centers", async (req, res) => {
  const requestedSectionId = req.query.section_id ? Number(req.query.section_id) : undefined;
  const requestedDepartmentId = req.query.department_id ? Number(req.query.department_id) : undefined;
  const role = req.user!.role;
  const hodWhere = role === "HOD" ? hodSectionPickerWhere(req.user!.hodScope) : null;
  // A cost centre hangs off a Section, so the grant set is applied through `section`: every Section of
  // a whole-Department grant, or the named Sections themselves. The requested Department still narrows
  // an ADMIN/PM picker and is ignored for an HOD, whose Departments come from his grants.
  const scopedDepartmentId = pickerDepartmentFilter(role, req.user!.hodScope);
  const departmentId = scopedDepartmentId !== undefined ? scopedDepartmentId : requestedDepartmentId;
  const costCenters = await prisma.costCenter.findMany({
    where: {
      active: true,
      ...(hodWhere ? { section: hodWhere } : {}),
      ...(requestedSectionId != null && role !== "HOD" ? { sectionId: requestedSectionId } : {}),
      ...(departmentId && role !== "HOD" ? { section: { departmentId } } : {}),
    },
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
  // A project-scoped actor sees the WBS of its assignment only. The request can NARROW that but
  // never add to it, so a foreign `project_id` intersects to the empty set (zero rows) rather than
  // being substituted back — the same rule the report applies to the same two ids.
  const scopedProjectIds = await assignedProjectIdsFor(req.user!);
  const projectFilter =
    scopedProjectIds === null
      ? projectId ? { projectId } : {}
      : { projectId: { in: projectId ? scopedProjectIds.filter((id) => id === projectId) : scopedProjectIds } };
  const wbs = await prisma.projectWbs.findMany({
    where: { ...(includeInactive ? {} : { active: true }), ...projectFilter },
    select: { id: true, projectId: true, wbsCode: true, name: true, sortOrder: true, active: true },
    orderBy: [{ projectId: "asc" }, { sortOrder: "asc" }, { wbsCode: "asc" }],
  });
  res.json({ wbs });
});
