import { Router } from "express";

import { prisma } from "../db";
import { requireAuth, requireRoles } from "../middleware/auth";
import { writeAudit } from "../audit";
import {
  colorKeyConflictMessage,
  findColorKeyConflict,
  findNetworkCodeConflict,
  findProjectCodeConflict,
  findUomCodeConflict,
  findWbsCodeConflict,
  networkCodeConflictMessage,
  networkSourceForWrite,
  prismaConflictMessage,
  projectCodeConflictMessage,
  projectLabel,
  referencedDeleteMessage,
  uomCodeConflictMessage,
  uomHelpText,
  validateNetworkInput,
  validateProjectInput,
  validateUomInput,
  validateWbsInput,
  jobOrderNetworkWbsError,
  jobOrderWbsMoveError,
  validateJobOrderBudgetInput,
  nextBudgetRevisionNo,
  isUnchangedBudget,
  resolveNetworkWbs,
  wbsCodeConflictMessage,
  type FieldError,
  type MasterEntity,
} from "../services/masterDataRules";

/**
 * Master-data maintenance for the Project -> WBS -> Job Order hierarchy plus the
 * UoM and per-project Network masters.
 *
 * Reads follow the ordinary authenticated pattern. Every write is limited to
 * ADMIN and PM, and every write is audited.
 *
 * A row that another table can point at is DEACTIVATED (`active = false`) rather
 * than deleted: a hard delete would either fail on the foreign key or move
 * approved history. DELETE is therefore offered only for a row nothing references.
 *
 * A duplicate is answered with 409 and a message that names the conflicting row.
 * A raw Prisma error is never returned to the client.
 */
export const masterDataRouter = Router();

masterDataRouter.use(requireAuth);

const WRITE_ROLES = ["ADMIN", "PM"] as const;
const writeOnly = requireRoles(...WRITE_ROLES);

/** Row shapes the rules work on, mapped from the stored masters. */
const projectRowSelect = { id: true, code: true, name: true, colorKey: true, isNonProject: true, sortOrder: true, active: true } as const;
const uomRowSelect = { id: true, code: true, name: true, example: true, active: true } as const;

function validationError(res: import("express").Response, errors: FieldError[]) {
  return res.status(400).json({ error: errors[0]?.message ?? "Invalid master-data payload.", code: "VALIDATION_FAILED", errors });
}

function notFound(res: import("express").Response, message: string, code: string) {
  return res.status(404).json({ error: message, code });
}

/** Map any unexpected failure to a safe message; the detail goes to the log. */
function failed(res: import("express").Response, what: string, error: unknown, entity: MasterEntity) {
  const conflict = prismaConflictMessage(error, entity);
  if (conflict) return res.status(409).json({ error: conflict, code: `${entity.toUpperCase()}_CONFLICT` });
  console.error(`${what} failed:`, error);
  return res.status(500).json({ error: `${what} could not be saved. Try again or contact support.`, code: "MASTER_DATA_WRITE_FAILED" });
}

async function projectOrNull(projectId: number) {
  if (!Number.isInteger(projectId)) return null;
  return prisma.project.findUnique({ where: { id: projectId }, select: projectRowSelect });
}

/**
 * Every WBS row, each carrying the code and name of its own project. A refusal that a
 * Network names a WBS of another project can then name that project instead of its id.
 */
async function allWbsRowsWithProject() {
  const rows = await prisma.projectWbs.findMany({
    select: { id: true, projectId: true, wbsCode: true, name: true, active: true, project: { select: { code: true, name: true } } },
  });
  return rows.map(({ project, ...row }) => ({ ...row, projectCode: project.code, projectName: project.name }));
}

/* ============================== reads ==================================== */

/**
 * Every project with its WBS rows and Networks, active and inactive, for maintenance.
 *
 * Each Network is reported with its `wbsId` and the `wbsCode` of the WBS element it
 * belongs to, so the screen can show and filter a WBS column without a second call.
 */
masterDataRouter.get("/projects", async (_req, res) => {
  const projects = await prisma.project.findMany({
    orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
    include: {
      wbsRows: { orderBy: [{ sortOrder: "asc" }, { wbsCode: "asc" }] },
      networks: {
        orderBy: [{ code: "asc" }],
        include: {
          wbs: { select: { id: true, wbsCode: true, name: true } },
          // Sent so the Network tab can show how many Job Orders point at each row.
          _count: { select: { jobOrders: true } },
        },
      },
      _count: { select: { jobOrders: true, timesheetEntries: true } },
    },
  });
  res.json({
    projects: projects.map((project) => ({
      ...project,
      networks: project.networks.map(({ wbs, ...network }) => ({
        ...network,
        wbsCode: wbs?.wbsCode ?? null,
        wbsName: wbs?.name ?? null,
      })),
    })),
  });
});

/** The WBS rows of one project. `wbs_code` is unique inside the project. */
masterDataRouter.get("/projects/:projectId/wbs", async (req, res) => {
  const project = await projectOrNull(Number(req.params.projectId));
  if (!project) return notFound(res, "Project not found.", "PROJECT_NOT_FOUND");
  const wbs = await prisma.projectWbs.findMany({
    where: { projectId: project.id },
    orderBy: [{ sortOrder: "asc" }, { wbsCode: "asc" }],
    include: { _count: { select: { jobOrders: true } } },
  });
  res.json({ project, wbs });
});

/** The Networks of one project. `code` is unique inside the project. */
masterDataRouter.get("/projects/:projectId/networks", async (req, res) => {
  const project = await projectOrNull(Number(req.params.projectId));
  if (!project) return notFound(res, "Project not found.", "PROJECT_NOT_FOUND");
  const networks = await prisma.network.findMany({
    where: { projectId: project.id },
    orderBy: [{ code: "asc" }],
    include: { _count: { select: { jobOrders: true } } },
  });
  res.json({ project, networks });
});

/** The UoM master. `helpText` is the on-screen help string built from `example`. */
masterDataRouter.get("/uom", async (_req, res) => {
  const rows = await prisma.uom.findMany({ orderBy: [{ code: "asc" }], include: { _count: { select: { jobOrders: true } } } });
  const uom = rows.map((row) => ({ ...row, helpText: uomHelpText(rows, row.code) }));
  res.json({ uom });
});

/* ============================= projects ================================== */

masterDataRouter.post("/projects", writeOnly, async (req, res) => {
  const parsed = validateProjectInput(req.body ?? {});
  if (!parsed.ok) return validationError(res, parsed.errors);
  const { code, name, colorKey, isNonProject, sortOrder } = parsed.data;

  const projects = await prisma.project.findMany({ select: projectRowSelect });
  const codeClash = findProjectCodeConflict(projects, code);
  if (codeClash) return res.status(409).json({ error: projectCodeConflictMessage(codeClash), code: "PROJECT_CODE_EXISTS" });
  const keyClash = findColorKeyConflict(projects, colorKey);
  if (keyClash) return res.status(409).json({ error: colorKeyConflictMessage(keyClash), code: "COLOR_KEY_EXISTS" });

  try {
    const project = await prisma.project.create({ data: { code, name, colorKey, isNonProject, sortOrder } });
    await writeAudit(req.user!.id, "ADMIN_CREATE_PROJECT", "project", project.id, { by: req.user!.role, code, name, colorKey, isNonProject, sortOrder });
    return res.status(201).json({ project });
  } catch (error) {
    return failed(res, "The project", error, "project");
  }
});

masterDataRouter.put("/projects/:id", writeOnly, async (req, res) => {
  const id = Number(req.params.id);
  const existing = await prisma.project.findUnique({ where: { id }, select: projectRowSelect });
  if (!existing) return notFound(res, "Project not found.", "PROJECT_NOT_FOUND");

  // An update may send only the changed fields; the rest keep their stored value.
  const body = (req.body ?? {}) as Record<string, unknown>;
  const parsed = validateProjectInput({
    code: body.code ?? existing.code,
    name: body.name ?? existing.name,
    colorKey: body.colorKey ?? existing.colorKey,
    isNonProject: body.isNonProject ?? existing.isNonProject,
    sortOrder: body.sortOrder ?? existing.sortOrder,
  });
  if (!parsed.ok) return validationError(res, parsed.errors);
  const { code, name, colorKey, isNonProject, sortOrder } = parsed.data;

  const projects = await prisma.project.findMany({ select: projectRowSelect });
  const codeClash = findProjectCodeConflict(projects, code, id);
  if (codeClash) return res.status(409).json({ error: projectCodeConflictMessage(codeClash), code: "PROJECT_CODE_EXISTS" });
  const keyClash = findColorKeyConflict(projects, colorKey, id);
  if (keyClash) return res.status(409).json({ error: colorKeyConflictMessage(keyClash), code: "COLOR_KEY_EXISTS" });

  try {
    const project = await prisma.project.update({ where: { id }, data: { code, name, colorKey, isNonProject, sortOrder } });
    await writeAudit(req.user!.id, "ADMIN_UPDATE_PROJECT", "project", id, {
      by: req.user!.role,
      previous: { code: existing.code, name: existing.name, colorKey: existing.colorKey, isNonProject: existing.isNonProject, sortOrder: existing.sortOrder },
      next: { code, name, colorKey, isNonProject, sortOrder },
    });
    return res.json({ project });
  } catch (error) {
    return failed(res, "The project", error, "project");
  }
});

/* ============================== project WBS =============================== */

masterDataRouter.post("/projects/:projectId/wbs", writeOnly, async (req, res) => {
  const project = await projectOrNull(Number(req.params.projectId));
  if (!project) return notFound(res, "Project not found. A WBS code must belong to a project.", "PROJECT_NOT_FOUND");

  const parsed = validateWbsInput(req.body ?? {});
  if (!parsed.ok) return validationError(res, parsed.errors);
  const { wbsCode, name, sortOrder } = parsed.data;

  const rows = await prisma.projectWbs.findMany({ where: { projectId: project.id }, select: { id: true, projectId: true, wbsCode: true, name: true } });
  const clash = findWbsCodeConflict(rows, project.id, wbsCode);
  if (clash) return res.status(409).json({ error: wbsCodeConflictMessage(clash, project), code: "WBS_CODE_EXISTS" });

  try {
    const wbs = await prisma.projectWbs.create({ data: { projectId: project.id, wbsCode, name, sortOrder } });
    await writeAudit(req.user!.id, "ADMIN_CREATE_WBS", "project_wbs", wbs.id, { by: req.user!.role, projectId: project.id, projectCode: project.code, wbsCode, name, sortOrder });
    return res.status(201).json({ wbs });
  } catch (error) {
    return failed(res, "The WBS row", error, "project_wbs");
  }
});

masterDataRouter.put("/wbs/:id", writeOnly, async (req, res) => {
  const id = Number(req.params.id);
  const existing = await prisma.projectWbs.findUnique({ where: { id }, select: { id: true, projectId: true, wbsCode: true, name: true, sortOrder: true, active: true } });
  if (!existing) return notFound(res, "WBS row not found.", "WBS_NOT_FOUND");
  const project = await projectOrNull(existing.projectId);
  if (!project) return notFound(res, "The WBS row has no parent project.", "PROJECT_NOT_FOUND");

  const body = (req.body ?? {}) as Record<string, unknown>;
  const parsed = validateWbsInput({
    wbsCode: body.wbsCode ?? existing.wbsCode,
    name: body.name ?? existing.name,
    sortOrder: body.sortOrder ?? existing.sortOrder,
  });
  if (!parsed.ok) return validationError(res, parsed.errors);
  const { wbsCode, name, sortOrder } = parsed.data;

  const rows = await prisma.projectWbs.findMany({ where: { projectId: project.id }, select: { id: true, projectId: true, wbsCode: true, name: true } });
  const clash = findWbsCodeConflict(rows, project.id, wbsCode, id);
  if (clash) return res.status(409).json({ error: wbsCodeConflictMessage(clash, project), code: "WBS_CODE_EXISTS" });

  try {
    const wbs = await prisma.projectWbs.update({ where: { id }, data: { wbsCode, name, sortOrder } });
    await writeAudit(req.user!.id, "ADMIN_UPDATE_WBS", "project_wbs", id, {
      by: req.user!.role,
      projectCode: project.code,
      previous: { wbsCode: existing.wbsCode, name: existing.name, sortOrder: existing.sortOrder },
      next: { wbsCode, name, sortOrder },
    });
    return res.json({ wbs });
  } catch (error) {
    return failed(res, "The WBS row", error, "project_wbs");
  }
});

/* ============================== UoM master =============================== */

masterDataRouter.post("/uom", writeOnly, async (req, res) => {
  const parsed = validateUomInput(req.body ?? {});
  if (!parsed.ok) return validationError(res, parsed.errors);
  const { code, name, example } = parsed.data;

  const rows = await prisma.uom.findMany({ select: { id: true, code: true, name: true, example: true } });
  const clash = findUomCodeConflict(rows, code);
  if (clash) return res.status(409).json({ error: uomCodeConflictMessage(clash), code: "UOM_CODE_EXISTS" });

  try {
    const uom = await prisma.uom.create({ data: { code, name, example } });
    await writeAudit(req.user!.id, "ADMIN_CREATE_UOM", "uom", uom.id, { by: req.user!.role, code, name, example });
    return res.status(201).json({ uom });
  } catch (error) {
    return failed(res, "The UoM row", error, "uom");
  }
});

masterDataRouter.put("/uom/:id", writeOnly, async (req, res) => {
  const id = Number(req.params.id);
  const existing = await prisma.uom.findUnique({ where: { id }, select: { id: true, code: true, name: true, example: true, active: true } });
  if (!existing) return notFound(res, "UoM row not found.", "UOM_NOT_FOUND");

  const body = (req.body ?? {}) as Record<string, unknown>;
  const parsed = validateUomInput({ code: body.code ?? existing.code, name: body.name ?? existing.name, example: body.example ?? existing.example });
  if (!parsed.ok) return validationError(res, parsed.errors);
  const { code, name, example } = parsed.data;

  const rows = await prisma.uom.findMany({ select: { id: true, code: true, name: true, example: true } });
  const clash = findUomCodeConflict(rows, code, id);
  if (clash) return res.status(409).json({ error: uomCodeConflictMessage(clash), code: "UOM_CODE_EXISTS" });

  try {
    const uom = await prisma.uom.update({ where: { id }, data: { code, name, example } });
    await writeAudit(req.user!.id, "ADMIN_UPDATE_UOM", "uom", id, {
      by: req.user!.role,
      previous: { code: existing.code, name: existing.name, example: existing.example },
      next: { code, name, example },
    });
    return res.json({ uom });
  } catch (error) {
    return failed(res, "The UoM row", error, "uom");
  }
});

/* ============================== Networks ================================= */

/**
 * Create a Network under ONE WBS element of the project.
 *
 * `wbsId` is required: one Network number cannot span two WBS elements of a project.
 * The WBS decides the project, so a WBS that belongs to another project is a client
 * error, and an inactive WBS is refused. The code stays unique inside the project.
 */
masterDataRouter.post("/projects/:projectId/networks", writeOnly, async (req, res) => {
  const project = await projectOrNull(Number(req.params.projectId));
  if (!project) return notFound(res, "Project not found. A Network code must belong to a project.", "PROJECT_NOT_FOUND");

  const parsed = validateNetworkInput(req.body ?? {});
  if (!parsed.ok) return validationError(res, parsed.errors);
  const { wbsId, code, name } = parsed.data;
  // A Network row written here is always MANUAL; SAP-sourced rows come from the feed.
  const source = networkSourceForWrite(req.body?.source);

  const scope = resolveNetworkWbs(await allWbsRowsWithProject(), project, wbsId);
  if (!scope.ok) return validationError(res, [scope.error]);

  const rows = await prisma.network.findMany({ where: { projectId: project.id }, select: { id: true, projectId: true, code: true, name: true, wbsId: true } });
  const clash = findNetworkCodeConflict(rows, project.id, code);
  if (clash) return res.status(409).json({ error: networkCodeConflictMessage(clash, project), code: "NETWORK_CODE_EXISTS" });

  try {
    const network = await prisma.network.create({ data: { projectId: project.id, wbsId: scope.wbs.id, code, name, source } });
    await writeAudit(req.user!.id, "ADMIN_CREATE_NETWORK", "network", network.id, {
      by: req.user!.role, projectId: project.id, projectCode: project.code, wbsId: scope.wbs.id, wbsCode: scope.wbs.wbsCode, code, name, source,
    });
    return res.status(201).json({ network });
  } catch (error) {
    return failed(res, "The Network row", error, "network");
  }
});

/**
 * Edit a Network: its WBS element, its code and its name.
 *
 * The WBS may change, but only to another WBS element of the SAME project (the
 * project of a Network is fixed), and never to an inactive one. `source` is never
 * rewritten, so a row the ERP feed owns stays owned by it.
 */
masterDataRouter.put("/networks/:id", writeOnly, async (req, res) => {
  const id = Number(req.params.id);
  const existing = await prisma.network.findUnique({ where: { id }, select: { id: true, projectId: true, wbsId: true, code: true, name: true, source: true, active: true } });
  if (!existing) return notFound(res, "Network row not found.", "NETWORK_NOT_FOUND");
  const project = await projectOrNull(existing.projectId);
  if (!project) return notFound(res, "The Network row has no parent project.", "PROJECT_NOT_FOUND");

  const body = (req.body ?? {}) as Record<string, unknown>;
  const parsed = validateNetworkInput({ wbsId: body.wbsId ?? existing.wbsId, code: body.code ?? existing.code, name: body.name ?? existing.name });
  if (!parsed.ok) return validationError(res, parsed.errors);
  const { wbsId, code, name } = parsed.data;

  const wbsRows = await allWbsRowsWithProject();
  const scope = resolveNetworkWbs(wbsRows, project, wbsId);
  if (!scope.ok) return validationError(res, [scope.error]);

  const rows = await prisma.network.findMany({ where: { projectId: project.id }, select: { id: true, projectId: true, code: true, name: true, wbsId: true } });
  const clash = findNetworkCodeConflict(rows, project.id, code, id);
  if (clash) return res.status(409).json({ error: networkCodeConflictMessage(clash, project), code: "NETWORK_CODE_EXISTS" });

  try {
    const network = await prisma.network.update({ where: { id }, data: { wbsId: scope.wbs.id, code, name } });
    await writeAudit(req.user!.id, "ADMIN_UPDATE_NETWORK", "network", id, {
      by: req.user!.role,
      projectCode: project.code,
      previous: { wbsId: existing.wbsId, wbsCode: wbsRows.find((row) => row.id === existing.wbsId)?.wbsCode ?? null, code: existing.code, name: existing.name },
      next: { wbsId: scope.wbs.id, wbsCode: scope.wbs.wbsCode, code, name },
    });
    return res.json({ network });
  } catch (error) {
    return failed(res, "The Network row", error, "network");
  }
});

/* ===================== activation (preferred to delete) =================== */

type Activation = {
  singular: string;
  entityType: string;
  exists: (id: number) => Promise<boolean>;
  setActive: (id: number, active: boolean) => Promise<void>;
  deactivateAction: string;
  activateAction: string;
};

/**
 * `POST /<path>/:id/deactivate` and `/activate` for one master. A master row that
 * other tables reference is retired this way: `active = false` keeps every
 * foreign key and every frozen attribution snapshot intact.
 */
function registerActivation(basePath: string, activation: Activation) {
  for (const active of [false, true]) {
    masterDataRouter.post(`${basePath}/:id/${active ? "activate" : "deactivate"}`, writeOnly, async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || !(await activation.exists(id))) {
        return notFound(res, `${activation.singular} not found.`, "MASTER_DATA_NOT_FOUND");
      }
      try {
        await activation.setActive(id, active);
        await writeAudit(req.user!.id, active ? activation.activateAction : activation.deactivateAction, activation.entityType, id, { by: req.user!.role, active });
        return res.json({ ok: true, id, active });
      } catch (error) {
        console.error(`${activation.singular} activation failed:`, error);
        return res.status(500).json({ error: `The ${activation.singular.toLowerCase()} could not be updated. Try again.`, code: "MASTER_DATA_WRITE_FAILED" });
      }
    });
  }
}

registerActivation("/projects", {
  singular: "Project",
  entityType: "project",
  exists: async (id) => Boolean(await prisma.project.findUnique({ where: { id }, select: { id: true } })),
  setActive: async (id, active) => { await prisma.project.update({ where: { id }, data: { active } }); },
  deactivateAction: "ADMIN_DEACTIVATE_PROJECT",
  activateAction: "ADMIN_ACTIVATE_PROJECT",
});

registerActivation("/wbs", {
  singular: "WBS row",
  entityType: "project_wbs",
  exists: async (id) => Boolean(await prisma.projectWbs.findUnique({ where: { id }, select: { id: true } })),
  setActive: async (id, active) => { await prisma.projectWbs.update({ where: { id }, data: { active } }); },
  deactivateAction: "ADMIN_DEACTIVATE_WBS",
  activateAction: "ADMIN_ACTIVATE_WBS",
});

registerActivation("/uom", {
  singular: "UoM row",
  entityType: "uom",
  exists: async (id) => Boolean(await prisma.uom.findUnique({ where: { id }, select: { id: true } })),
  setActive: async (id, active) => { await prisma.uom.update({ where: { id }, data: { active } }); },
  deactivateAction: "ADMIN_DEACTIVATE_UOM",
  activateAction: "ADMIN_ACTIVATE_UOM",
});

registerActivation("/networks", {
  singular: "Network row",
  entityType: "network",
  exists: async (id) => Boolean(await prisma.network.findUnique({ where: { id }, select: { id: true } })),
  setActive: async (id, active) => { await prisma.network.update({ where: { id }, data: { active } }); },
  deactivateAction: "ADMIN_DEACTIVATE_NETWORK",
  activateAction: "ADMIN_ACTIVATE_NETWORK",
});

/* ============================== deletes ================================== */

/**
 * A hard delete is allowed only while nothing references the row. Otherwise the
 * answer is 409 with the reference counts, and the caller deactivates instead.
 */
masterDataRouter.delete("/projects/:id", writeOnly, async (req, res) => {
  const id = Number(req.params.id);
  const project = await prisma.project.findUnique({ where: { id }, select: { id: true, code: true, name: true } });
  if (!project) return notFound(res, "Project not found.", "PROJECT_NOT_FOUND");
  const [wbsRows, networks, jobOrders, timesheetEntries, allocations] = await Promise.all([
    prisma.projectWbs.count({ where: { projectId: id } }),
    prisma.network.count({ where: { projectId: id } }),
    prisma.jobOrder.count({ where: { projectId: id } }),
    prisma.timesheetEntry.count({ where: { projectId: id } }),
    prisma.employeeAllocation.count({ where: { projectId: id } }),
  ]);
  const references = [
    { what: "WBS rows", count: wbsRows },
    { what: "Networks", count: networks },
    { what: "Job Orders", count: jobOrders },
    { what: "timesheet rows", count: timesheetEntries },
    { what: "allocation hours", count: allocations },
  ];
  if (references.some((reference) => reference.count > 0)) {
    return res.status(409).json({ error: referencedDeleteMessage(projectLabel(project), references), code: "PROJECT_IN_USE" });
  }
  try {
    await prisma.project.delete({ where: { id } });
    await writeAudit(req.user!.id, "ADMIN_DELETE_PROJECT", "project", id, { by: req.user!.role, code: project.code, name: project.name });
    return res.json({ ok: true, deleted: id });
  } catch (error) {
    console.error("Delete project failed:", error);
    return res.status(500).json({ error: "The project could not be deleted. Deactivate it instead.", code: "MASTER_DATA_WRITE_FAILED" });
  }
});

masterDataRouter.delete("/wbs/:id", writeOnly, async (req, res) => {
  const id = Number(req.params.id);
  const wbs = await prisma.projectWbs.findUnique({ where: { id }, select: { id: true, wbsCode: true, projectId: true } });
  if (!wbs) return notFound(res, "WBS row not found.", "WBS_NOT_FOUND");
  const [jobOrders, timesheetEntries, allocations] = await Promise.all([
    prisma.jobOrder.count({ where: { projectWbsId: id } }),
    prisma.timesheetEntry.count({ where: { projectWbsId: id } }),
    prisma.employeeAllocation.count({ where: { projectWbsId: id } }),
  ]);
  const references = [
    { what: "Job Orders", count: jobOrders },
    { what: "timesheet rows", count: timesheetEntries },
    { what: "allocation hours", count: allocations },
  ];
  if (references.some((reference) => reference.count > 0)) {
    return res.status(409).json({ error: referencedDeleteMessage(`WBS code "${wbs.wbsCode}"`, references), code: "WBS_IN_USE" });
  }
  try {
    await prisma.projectWbs.delete({ where: { id } });
    await writeAudit(req.user!.id, "ADMIN_DELETE_WBS", "project_wbs", id, { by: req.user!.role, projectId: wbs.projectId, wbsCode: wbs.wbsCode });
    return res.json({ ok: true, deleted: id });
  } catch (error) {
    console.error("Delete WBS failed:", error);
    return res.status(500).json({ error: "The WBS row could not be deleted. Deactivate it instead.", code: "MASTER_DATA_WRITE_FAILED" });
  }
});

masterDataRouter.delete("/uom/:id", writeOnly, async (req, res) => {
  const id = Number(req.params.id);
  const uom = await prisma.uom.findUnique({ where: { id }, select: { id: true, code: true, name: true } });
  if (!uom) return notFound(res, "UoM row not found.", "UOM_NOT_FOUND");
  const [jobOrders, budgetRevisions] = await Promise.all([
    prisma.jobOrder.count({ where: { uomId: id } }),
    prisma.jobOrderBudgetRevision.count({ where: { uomId: id } }),
  ]);
  const references = [
    { what: "Job Orders", count: jobOrders },
    { what: "budget revisions", count: budgetRevisions },
  ];
  if (references.some((reference) => reference.count > 0)) {
    return res.status(409).json({ error: referencedDeleteMessage(`UoM code "${uom.code}"`, references), code: "UOM_IN_USE" });
  }
  try {
    await prisma.uom.delete({ where: { id } });
    await writeAudit(req.user!.id, "ADMIN_DELETE_UOM", "uom", id, { by: req.user!.role, code: uom.code, name: uom.name });
    return res.json({ ok: true, deleted: id });
  } catch (error) {
    console.error("Delete UoM failed:", error);
    return res.status(500).json({ error: "The UoM row could not be deleted. Deactivate it instead.", code: "MASTER_DATA_WRITE_FAILED" });
  }
});

masterDataRouter.delete("/networks/:id", writeOnly, async (req, res) => {
  const id = Number(req.params.id);
  const network = await prisma.network.findUnique({ where: { id }, select: { id: true, code: true, projectId: true } });
  if (!network) return notFound(res, "Network row not found.", "NETWORK_NOT_FOUND");
  const jobOrders = await prisma.jobOrder.count({ where: { networkId: id } });
  if (jobOrders > 0) {
    return res.status(409).json({ error: referencedDeleteMessage(`Network code "${network.code}"`, [{ what: "Job Orders", count: jobOrders }]), code: "NETWORK_IN_USE" });
  }
  try {
    await prisma.network.delete({ where: { id } });
    await writeAudit(req.user!.id, "ADMIN_DELETE_NETWORK", "network", id, { by: req.user!.role, projectId: network.projectId, code: network.code });
    return res.json({ ok: true, deleted: id });
  } catch (error) {
    console.error("Delete Network failed:", error);
    return res.status(500).json({ error: "The Network row could not be deleted. Deactivate it instead.", code: "MASTER_DATA_WRITE_FAILED" });
  }
});

/* ============================== Job Orders =============================== */

const JOB_ORDER_STATUSES = ["active", "inactive"] as const;

/**
 * Job Order maintenance list. It lives here because a Job Order is created by the
 * CSV upload and nothing else used to change it afterwards, so an In-Active Job
 * Order could not be set at all. An In-Active Job Order cannot be booked and
 * cannot have quantity progress punched against it.
 */
masterDataRouter.get("/job-orders", async (req, res) => {
  const projectId = req.query.project_id ? Number(req.query.project_id) : undefined;
  const status = typeof req.query.status === "string" && req.query.status !== "all" ? req.query.status : undefined;
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (status && !(JOB_ORDER_STATUSES as readonly string[]).includes(status)) {
    return res.status(400).json({ error: "status must be active or inactive.", code: "INVALID_STATUS" });
  }
  const jobOrders = await prisma.jobOrder.findMany({
    where: {
      ...(projectId ? { projectId } : {}),
      ...(status ? { status } : {}),
      ...(q ? { OR: [{ code: { contains: q } }, { name: { contains: q } }] } : {}),
    },
    orderBy: [{ projectId: "asc" }, { code: "asc" }],
    select: {
      id: true, code: true, name: true, status: true, budgetedHours: true, budgetedQuantity: true, sectionId: true,
      project: {
        select: {
          id: true, code: true, name: true, colorKey: true,
          // Sent with each row so the mapping form can offer only the WBS rows of THIS
          // Job Order's project, and, inside each WBS row, only that WBS's Networks: a
          // Network belongs to one WBS element, never to the whole project.
          wbsRows: {
            select: {
              id: true, wbsCode: true, name: true, active: true,
              networks: { select: { id: true, code: true, name: true, active: true }, orderBy: { code: "asc" } },
            },
            orderBy: [{ sortOrder: "asc" }, { wbsCode: "asc" }],
          },
        },
      },
      projectWbs: { select: { id: true, wbsCode: true, name: true } },
      _count: { select: { timesheetEntries: true, employeeAllocations: true } },
      // The last few budget revisions, newest first, so the form can show what the budget
      // is and when it was last revised.
      budgetRevisions: {
        select: {
          revisionNo: true, budgetedHours: true, budgetedQuantity: true,
          effectiveFrom: true, reason: true,
          createdBy: { select: { name: true, role: true } },
        },
        orderBy: { revisionNo: "desc" },
        take: 5,
      },
      department: { select: { id: true, name: true } },
      section: { select: { id: true, name: true } },
      uom: { select: { id: true, code: true } },
      network: { select: { id: true, code: true } },
    },
  });
  res.json({ jobOrders, statuses: JOB_ORDER_STATUSES });
});

/**
 * Change one Job Order's status. Two states only: active or inactive.
 * The CSV upload sets the status at creation and skips existing rows, so this is
 * the only way to retire a Job Order whose work has finished.
 */
masterDataRouter.post("/job-orders/:id/status", writeOnly, async (req, res) => {
  const id = Number(req.params.id);
  const next = typeof req.body?.status === "string" ? req.body.status.trim().toLowerCase() : "";
  if (!(JOB_ORDER_STATUSES as readonly string[]).includes(next)) {
    return res.status(400).json({
      error: 'status must be "active" or "inactive". "closed" and "on_hold" no longer exist.',
      code: "INVALID_STATUS",
    });
  }
  const existing = await prisma.jobOrder.findUnique({
    where: { id },
    select: { id: true, code: true, status: true, project: { select: { code: true } }, projectWbs: { select: { wbsCode: true } } },
  });
  if (!existing) return notFound(res, "Job Order not found.", "JOB_ORDER_NOT_FOUND");
  if (existing.status === next) return res.json({ jobOrder: existing, changed: false });

  try {
    const jobOrder = await prisma.jobOrder.update({
      where: { id },
      data: { status: next },
      select: { id: true, code: true, status: true },
    });
    await writeAudit(req.user!.id, next === "active" ? "ADMIN_ACTIVATE_JOB_ORDER" : "ADMIN_DEACTIVATE_JOB_ORDER", "job_order", id, {
      by: req.user!.role,
      projectCode: existing.project.code,
      wbsCode: existing.projectWbs.wbsCode,
      previousStatus: existing.status,
      nextStatus: next,
    });
    return res.json({ jobOrder, changed: true });
  } catch (error) {
    return failed(res, "The Job Order status", error, "job_order");
  }
});

/**
 * Change an existing Job Order's WBS row and/or Network.
 *
 * The CSV import creates a Job Order and then SKIPS it, so without this there was no
 * way to correct a wrong WBS or Network afterwards: the ADMIN remap screen handles the
 * department, and nothing handled the Network at all.
 *
 * Rules:
 *  - The Project is fixed. An uploaded Job Order is keyed on (project, code), so moving
 *    it to another Project would change its identity and could collide. A WBS row or
 *    Network from another Project is refused with a clear message.
 *  - A WBS move is refused once hours are booked, because every booked row carries a
 *    frozen attribution snapshot. Use the Admin mapping screen if the Project itself
 *    has to change. The Network is informational and may always be corrected - but it
 *    must belong to the WBS the Job Order ends up on, because a Network belongs to one
 *    WBS element and never to the whole project.
 *  - ADMIN and PM only, and audited with the previous and next values.
 */
masterDataRouter.put("/job-orders/:id/mapping", writeOnly, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return notFound(res, "Job Order not found.", "JOB_ORDER_NOT_FOUND");

  const jobOrder = await prisma.jobOrder.findUnique({
    where: { id },
    select: {
      id: true, code: true, name: true, projectId: true, projectWbsId: true, networkId: true,
      project: { select: { id: true, code: true, name: true } },
      projectWbs: { select: { id: true, wbsCode: true } },
      network: { select: { id: true, code: true } },
    },
  });
  if (!jobOrder) return notFound(res, "Job Order not found.", "JOB_ORDER_NOT_FOUND");

  const body = (req.body ?? {}) as Record<string, unknown>;
  const wantsWbs = body.projectWbsId !== undefined && body.projectWbsId !== null;
  const wantsNetwork = body.networkId !== undefined && body.networkId !== null;
  if (!wantsWbs && !wantsNetwork) {
    return res.status(400).json({ error: "Send a WBS row, a Network, or both.", code: "NOTHING_TO_UPDATE" });
  }

  let nextWbsId = jobOrder.projectWbsId;
  if (wantsWbs) {
    const target = await prisma.projectWbs.findUnique({
      where: { id: Number(body.projectWbsId) },
      select: { id: true, projectId: true, wbsCode: true },
    });
    if (!target) return notFound(res, "WBS row not found.", "WBS_NOT_FOUND");
    if (target.projectId !== jobOrder.projectId) {
      return res.status(400).json({
        error: `WBS "${target.wbsCode}" belongs to another project. A Job Order keeps its own Project; ask an Admin to use the Job Order Mapping screen if the Project itself must change.`,
        code: "WBS_OTHER_PROJECT",
      });
    }
    nextWbsId = target.id;
  }

  let nextNetworkId = jobOrder.networkId;
  if (wantsNetwork) {
    const target = await prisma.network.findUnique({
      where: { id: Number(body.networkId) },
      select: { id: true, projectId: true, code: true },
    });
    if (!target) return notFound(res, "Network row not found.", "NETWORK_NOT_FOUND");
    if (target.projectId !== jobOrder.projectId) {
      return res.status(400).json({
        error: `Network "${target.code}" belongs to another project.`,
        code: "NETWORK_OTHER_PROJECT",
      });
    }
    nextNetworkId = target.id;
  }

  if (nextWbsId !== jobOrder.projectWbsId) {
    const [bookedTimesheetEntries, bookedAllocationSlots] = await Promise.all([
      prisma.timesheetEntry.count({ where: { jobOrderId: id } }),
      prisma.employeeAllocation.count({ where: { jobOrderId: id } }),
    ]);
    const moveError = jobOrderWbsMoveError({
      jobOrderCode: jobOrder.code,
      currentWbsId: jobOrder.projectWbsId,
      targetWbsId: nextWbsId,
      bookedTimesheetEntries,
      bookedAllocationSlots,
    });
    if (moveError) return res.status(409).json({ error: moveError, code: "JOB_ORDER_WBS_LOCKED" });
  }

  // A Network belongs to ONE WBS element, so it must belong to the WBS the Job Order
  // ends up on - not merely to its project. When the request moves the WBS, the Network
  // must be valid for the NEW WBS. The refusal names both WBS rows, so the operator
  // knows which Network to pick instead. A Network-only change on an unchanged WBS is
  // still checked against that WBS, and a row that keeps both values is left alone.
  if (nextWbsId !== jobOrder.projectWbsId || nextNetworkId !== jobOrder.networkId) {
    const [targetWbs, targetNetwork] = await Promise.all([
      prisma.projectWbs.findUnique({ where: { id: nextWbsId }, select: { id: true, wbsCode: true } }),
      prisma.network.findUnique({ where: { id: nextNetworkId }, select: { id: true, code: true, wbsId: true, wbs: { select: { wbsCode: true } } } }),
    ]);
    if (targetWbs && targetNetwork) {
      const mismatch = jobOrderNetworkWbsError({
        jobOrderCode: jobOrder.code,
        networkCode: targetNetwork.code,
        networkWbsId: targetNetwork.wbsId,
        networkWbsCode: targetNetwork.wbs.wbsCode,
        targetWbsId: targetWbs.id,
        targetWbsCode: targetWbs.wbsCode,
      });
      if (mismatch) return res.status(400).json({ error: mismatch, code: "NETWORK_WBS_MISMATCH" });
    }
  }

  try {
    const updated = await prisma.jobOrder.update({
      where: { id },
      data: { projectWbsId: nextWbsId, networkId: nextNetworkId },
      select: {
        id: true, code: true, name: true, status: true,
        projectWbs: { select: { id: true, wbsCode: true } },
        network: { select: { id: true, code: true, wbs: { select: { wbsCode: true } } } },
      },
    });
    await writeAudit(req.user!.id, "ADMIN_UPDATE_JOB_ORDER_MAPPING", "job_order", id, {
      by: req.user!.role,
      projectCode: jobOrder.project.code,
      previous: { wbsCode: jobOrder.projectWbs.wbsCode, networkCode: jobOrder.network.code },
      next: { wbsCode: updated.projectWbs.wbsCode, networkCode: updated.network.code, networkWbsCode: updated.network.wbs.wbsCode },
    });
    return res.json({ jobOrder: updated });
  } catch (error) {
    return failed(res, "The Job Order mapping", error, "job_order");
  }
});
/**
 * Revise a Job Order's budget: Budget hours and Budget quantity, nothing else.
 *
 * The Project / WBS / Network / UoM / Department / Section of an uploaded Job Order are
 * read-only on the screen and are refused here, so this route cannot re-point an existing
 * Job Order. Every save writes a NEW effective-dated revision (one more than the highest)
 * with the date and time it was made, the reason if given, and the user who made it, so the
 * consumption of a past month is still measured against the budget that was in force then.
 * ADMIN and PM only, and audited with the previous and next figures.
 */
masterDataRouter.put("/job-orders/:id/budget", writeOnly, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return notFound(res, "Job Order not found.", "JOB_ORDER_NOT_FOUND");

  const jobOrder = await prisma.jobOrder.findUnique({
    where: { id },
    select: {
      id: true, code: true, name: true, status: true,
      budgetedHours: true, budgetedQuantity: true, uomId: true,
      uom: { select: { code: true } },
      budgetRevisions: { select: { revisionNo: true }, orderBy: { revisionNo: "desc" }, take: 1 },
    },
  });
  if (!jobOrder) return notFound(res, "Job Order not found.", "JOB_ORDER_NOT_FOUND");

  const parsed = validateJobOrderBudgetInput(req.body ?? {});
  if (!parsed.ok) return validationError(res, parsed.errors);
  const { budgetedHours, budgetedQuantity, reason } = parsed.data;

  if (isUnchangedBudget(jobOrder, { budgetedHours, budgetedQuantity })) {
    return res.status(400).json({
      error: `Budget hours and quantity are unchanged (${budgetedHours} ${jobOrder.uom.code}, ${budgetedQuantity} qty), so there is nothing to save.`,
      code: "BUDGET_UNCHANGED",
    });
  }

  const revisionNo = nextBudgetRevisionNo(jobOrder.budgetRevisions);
  try {
    const [updated, revision] = await prisma.$transaction([
      prisma.jobOrder.update({
        where: { id },
        data: { budgetedHours, budgetedQuantity },
      }),
      prisma.jobOrderBudgetRevision.create({
        data: {
          jobOrderId: id,
          revisionNo,
          budgetedHours,
          budgetedQuantity,
          uomId: jobOrder.uomId,
          effectiveFrom: new Date(),
          reason: reason ?? `Budget revised by ${req.user!.role}`,
          createdById: req.user!.id,
        },
      }),
    ]);
    await writeAudit(req.user!.id, "ADMIN_UPDATE_JOB_ORDER_BUDGET", "job_order", id, {
      by: req.user!.role,
      code: jobOrder.code,
      revisionNo,
      previous: { budgetedHours: jobOrder.budgetedHours, budgetedQuantity: jobOrder.budgetedQuantity },
      next: { budgetedHours, budgetedQuantity },
      reason: revision.reason,
    });
    return res.json({
      jobOrder: {
        id: updated.id, code: updated.code, name: updated.name, status: updated.status,
        budgetedHours: updated.budgetedHours, budgetedQuantity: updated.budgetedQuantity,
      },
      revision: {
        revisionNo: revision.revisionNo,
        budgetedHours: revision.budgetedHours,
        budgetedQuantity: revision.budgetedQuantity,
        effectiveFrom: revision.effectiveFrom,
        reason: revision.reason,
      },
    });
  } catch (error) {
    return failed(res, "The Job Order budget", error, "job_order");
  }
});
