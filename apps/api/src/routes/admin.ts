import { Router } from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { prisma } from "../db";
import { requireAuth, requireRoles } from "../middleware/auth";
import { writeAudit } from "../audit";
import { runBadgeViewSync } from "../services/badgeViewSync";
import { processCredentialDeliveries } from "../services/credentialDelivery";
import { canonicalEcNo, findEmployeeByCanonicalEcNo } from "../services/employeeIdentity";
import { hashDefaultWorkforcePassword } from "../services/defaultLoginCredentials";

export const adminRouter = Router();

function workforceCredentialRecipient(): string {
  return process.env.CREDENTIAL_DELIVERY_RECIPIENT?.trim() || "itsupport.shipyard@swan.co.in";
}

async function uniqueEmployeeLoginEmail(ecNo: string): Promise<string> {
  const local = ecNo.toLowerCase().replace(/[^a-z0-9._-]/g, "_") || "employee";
  let email = `${local}@employee.local`;
  for (let suffix = 1; await prisma.user.findUnique({ where: { email }, select: { id: true } }); suffix += 1) {
    email = `${local}.${suffix}@employee.local`;
  }
  return email;
}

adminRouter.use(requireAuth, requireRoles("ADMIN", "HR"));

adminRouter.get("/users", requireRoles("ADMIN"), async (_req, res) => {
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

adminRouter.post("/users", requireRoles("ADMIN"), async (req, res) => {
  const { email, name, role, departmentId } = req.body ?? {};
  if (!email || !name || !role) return res.status(400).json({ error: "email, name and role are required" });
  if (!["ADMIN", "HR", "HOD", "PM", "FINANCE"].includes(String(role))) {
    return res.status(400).json({ error: "Invalid role", code: "INVALID_ROLE" });
  }
  // The API never accepts or returns an initial password. The delivery worker
  // creates the one-time secret when it processes this durable queue row.
  const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 10);
  const user = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({ data: {
      email: String(email).trim().toLowerCase(), passwordHash, name: String(name).trim(), role,
      departmentId: departmentId ? Number(departmentId) : null, mustChangePassword: true,
    } });
    await tx.credentialDelivery.create({ data: { userId: created.id, recipient: created.email, purpose: "INITIAL" } });
    return created;
  });
  await writeAudit(req.user!.id, "ADMIN_CREATE_USER", "user", user.id, { credentialQueued: true });
  const { passwordHash: _passwordHash, ...safeUser } = user;
  res.status(201).json({ user: safeUser, credentialQueued: true });
});

adminRouter.get("/departments", requireRoles("ADMIN"), async (_req, res) => {
  const departments = await prisma.department.findMany({ orderBy: { name: "asc" } });
  res.json({ departments });
});

// Manual department management (ADMIN/HR router gated). The sync auto-creates
// departments as source='SYNC'; manual adds are source='MANUAL'. The sync only
// create-missing (never overwrites manual edits), and manual edits must not
// collide with auto-created codes.
adminRouter.post("/departments", requireRoles("ADMIN"), async (req, res) => {
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
adminRouter.put("/departments/:id", requireRoles("ADMIN"), async (req, res) => {
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

adminRouter.get("/projects-wbs", requireRoles("ADMIN"), async (_req, res) => {
  const projects = await prisma.projectWbs.findMany({ orderBy: { colorKey: "asc" } });
  res.json({ projects });
});

adminRouter.post("/projects-wbs", requireRoles("ADMIN"), async (req, res) => {
  const { code, name, wbsCode, colorKey } = req.body;
  const project = await prisma.projectWbs.create({
    data: { code, name, wbsCode, colorKey },
  });
  await writeAudit(req.user!.id, "ADMIN_CREATE_PROJECT", "projects_wbs", project.id);
  res.status(201).json({ project });
});

adminRouter.get("/cost-rates", requireRoles("ADMIN"), async (_req, res) => {
  const rates = await prisma.costRate.findMany({ orderBy: [{ category: "asc" }, { effectiveFrom: "desc" }] });
  res.json({ rates });
});

adminRouter.post("/cost-rates", requireRoles("ADMIN"), async (req, res) => {
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


/** Register a payroll employee and their canonical section assignment. */
adminRouter.post("/employees", async (req, res) => {
  const { ecNo, name, departmentId, sectionId, designation, category, mobile, email } = req.body ?? {};
  if (!ecNo || !name || !departmentId || !sectionId) return res.status(400).json({ error: "ecNo, name, departmentId and sectionId are required" });
  const section = await prisma.section.findUnique({ where: { id: Number(sectionId) } });
  if (!section || !section.active || section.departmentId !== Number(departmentId)) return res.status(400).json({ error: "sectionId must be an active section in departmentId", code: "INVALID_SECTION" });
  const normalizedEcNo = canonicalEcNo(ecNo);
  const normalizedEmail = email ? String(email).trim().toLowerCase() : null;
  if (await findEmployeeByCanonicalEcNo(normalizedEcNo)) return res.status(409).json({ error: "ecNo already exists", code: "ECNO_EXISTS" });
  if (normalizedEmail && await prisma.user.findUnique({ where: { email: normalizedEmail } })) return res.status(409).json({ error: "email already exists", code: "EMAIL_EXISTS" });
  const loginEmail = normalizedEmail || await uniqueEmployeeLoginEmail(normalizedEcNo);
  const passwordHash = await hashDefaultWorkforcePassword();
  const result = await prisma.$transaction(async (tx) => {
    const employee = await tx.employee.create({ data: {
      ecNo: normalizedEcNo, name: String(name).trim(), departmentId: Number(departmentId), designation: String(designation || ""),
      category: String(category || "PAYROLL"), employmentType: "PAYROLL", source: "PAYROLL", mobile: mobile ? String(mobile).trim() : null,
    } });
    const sectionAssignment = await tx.employeeSectionAssignment.create({ data: { employeeId: employee.id, sectionId: Number(sectionId), source: "MANUAL" } });
    const user = await tx.user.create({ data: {
      employeeId: employee.id, email: loginEmail, passwordHash, name: employee.name,
      role: "EMPLOYEE", source: "MANUAL", departmentId: employee.departmentId,
      mustChangePassword: false, passwordExpiresAt: null,
    } });
    await tx.credentialDelivery.create({
      data: { userId: user.id, recipient: normalizedEmail || workforceCredentialRecipient(), purpose: "INITIAL" },
    });
    return { employee, sectionAssignment, user };
  });
  await writeAudit(req.user!.id, "EMPLOYEE_REGISTER", "employee", result.employee.id, { ecNo: normalizedEcNo, sectionId, userId: result.user?.id, credentialQueued: Boolean(result.user) });
  const safeUser = result.user ? {
    id: result.user.id, email: result.user.email, name: result.user.name, role: result.user.role,
    employeeId: result.user.employeeId, departmentId: result.user.departmentId, active: result.user.active,
  } : null;
  res.status(201).json({ employee: result.employee, sectionAssignment: result.sectionAssignment, user: safeUser, credentialQueued: Boolean(result.user) });
});

// Section and cost-centre masters affect allocation routing and are ADMIN-only.
adminRouter.get("/sections", requireRoles("ADMIN"), async (req, res) => {
  const departmentId = req.query.department_id ? Number(req.query.department_id) : undefined;
  const sections = await prisma.section.findMany({
    where: departmentId ? { departmentId } : undefined,
    include: { department: { select: { id: true, code: true, name: true } }, costCenter: true },
    orderBy: [{ departmentId: "asc" }, { name: "asc" }],
  });
  res.json({ sections });
});

adminRouter.post("/sections", requireRoles("ADMIN"), async (req, res) => {
  const { departmentId, code, name } = req.body ?? {};
  if (!departmentId || !code || !name) return res.status(400).json({ error: "departmentId, code and name are required" });
  const section = await prisma.section.create({ data: {
    departmentId: Number(departmentId), code: String(code).trim().toUpperCase(), name: String(name).trim(), source: "MANUAL",
  } });
  await writeAudit(req.user!.id, "ADMIN_CREATE_SECTION", "section", section.id);
  res.status(201).json({ section });
});

adminRouter.put("/sections/:id", requireRoles("ADMIN"), async (req, res) => {
  const id = Number(req.params.id);
  const current = await prisma.section.findUnique({ where: { id }, include: { _count: { select: { employeeAssignments: true } } } });
  if (!current) return res.status(404).json({ error: "Section not found" });
  const { departmentId, code, name, active } = req.body ?? {};
  if (departmentId !== undefined && Number(departmentId) !== current.departmentId && current._count.employeeAssignments > 0) {
    return res.status(409).json({ error: "Cannot move a Section with Employee assignments to another Department.", code: "SECTION_IN_USE" });
  }
  const section = await prisma.section.update({ where: { id }, data: {
    ...(departmentId !== undefined ? { departmentId: Number(departmentId) } : {}),
    ...(code !== undefined ? { code: String(code).trim().toUpperCase() } : {}),
    ...(name !== undefined ? { name: String(name).trim() } : {}),
    ...(active !== undefined ? { active: Boolean(active) } : {}), source: "MANUAL",
  } });
  await writeAudit(req.user!.id, "ADMIN_UPDATE_SECTION", "section", id);
  res.json({ section });
});

adminRouter.delete("/sections/:id", requireRoles("ADMIN"), async (req, res) => {
  const id = Number(req.params.id);
  const section = await prisma.section.findUnique({ where: { id }, include: { _count: { select: { employeeAssignments: true } }, costCenter: true } });
  if (!section) return res.status(404).json({ error: "Section not found" });
  if (section._count.employeeAssignments || section.costCenter) return res.status(409).json({ error: "Section is in use; deactivate it instead", code: "SECTION_IN_USE" });
  await prisma.section.delete({ where: { id } });
  await writeAudit(req.user!.id, "ADMIN_DELETE_SECTION", "section", id);
  res.json({ ok: true });
});

adminRouter.get("/cost-centers", requireRoles("ADMIN"), async (_req, res) => {
  const costCenters = await prisma.costCenter.findMany({
    include: { section: { include: { department: { select: { id: true, code: true, name: true } } } } }, orderBy: { code: "asc" },
  });
  res.json({ costCenters });
});

adminRouter.post("/cost-centers", requireRoles("ADMIN"), async (req, res) => {
  const { sectionId, code, name } = req.body ?? {};
  if (!sectionId || !code || !name) return res.status(400).json({ error: "sectionId, code and name are required" });
  const section = await prisma.section.findUnique({ where: { id: Number(sectionId) }, include: { costCenter: true } });
  if (!section?.active || section.costCenter) return res.status(409).json({ error: "Section is inactive or already has a Cost Center.", code: "SECTION_COST_CENTER_EXISTS" });
  const costCenter = await prisma.costCenter.create({ data: { sectionId: Number(sectionId), code: String(code).trim().toUpperCase(), name: String(name).trim() } });
  await writeAudit(req.user!.id, "ADMIN_CREATE_COST_CENTER", "cost_center", costCenter.id);
  res.status(201).json({ costCenter });
});

adminRouter.put("/cost-centers/:id", requireRoles("ADMIN"), async (req, res) => {
  const id = Number(req.params.id);
  if (!await prisma.costCenter.findUnique({ where: { id } })) return res.status(404).json({ error: "Cost center not found" });
  const { sectionId, code, name, active } = req.body ?? {};
  if (sectionId !== undefined) {
    const target = await prisma.section.findUnique({ where: { id: Number(sectionId) }, include: { costCenter: true } });
    if (!target?.active || (target.costCenter && target.costCenter.id !== id)) {
      return res.status(409).json({ error: "Target Section is inactive or already has a Cost Center.", code: "SECTION_COST_CENTER_EXISTS" });
    }
  }
  const costCenter = await prisma.costCenter.update({ where: { id }, data: {
    ...(sectionId !== undefined ? { sectionId: Number(sectionId) } : {}), ...(code !== undefined ? { code: String(code).trim().toUpperCase() } : {}),
    ...(name !== undefined ? { name: String(name).trim() } : {}), ...(active !== undefined ? { active: Boolean(active) } : {}),
  } });
  await writeAudit(req.user!.id, "ADMIN_UPDATE_COST_CENTER", "cost_center", id);
  res.json({ costCenter });
});

adminRouter.delete("/cost-centers/:id", requireRoles("ADMIN"), async (req, res) => {
  const id = Number(req.params.id);
  if (!await prisma.costCenter.findUnique({ where: { id } })) return res.status(404).json({ error: "Cost center not found" });
  await prisma.costCenter.update({ where: { id }, data: { active: false } });
  await writeAudit(req.user!.id, "ADMIN_DEACTIVATE_COST_CENTER", "cost_center", id);
  res.json({ ok: true, active: false });
});

adminRouter.get("/job-orders", requireRoles("ADMIN"), async (_req, res) => {
  const jobOrders = await prisma.jobOrder.findMany({
    include: { project: true, projectWbs: true, department: true },
    orderBy: { code: "asc" },
  });
  res.json({ jobOrders });
});

/** Remap a Job Order. sectionId/costCenterId are accepted and resolve to the owning department. */
adminRouter.put("/job-orders/:id/remap", requireRoles("ADMIN"), async (req, res) => {
  const id = Number(req.params.id);
  if (!await prisma.jobOrder.findUnique({ where: { id } })) return res.status(404).json({ error: "Job order not found" });
  const { projectId, projectWbsId, departmentId, sectionId, costCenterId } = req.body ?? {};
  let resolvedDepartmentId = departmentId === null ? null : departmentId !== undefined ? Number(departmentId) : undefined;
  if (sectionId !== undefined) {
    const section = await prisma.section.findUnique({ where: { id: Number(sectionId) } });
    if (!section) return res.status(404).json({ error: "Section not found" });
    resolvedDepartmentId = section.departmentId;
  }
  if (costCenterId !== undefined) {
    const cc = await prisma.costCenter.findUnique({ where: { id: Number(costCenterId) }, include: { section: true } });
    if (!cc) return res.status(404).json({ error: "Cost center not found" });
    resolvedDepartmentId = cc.section.departmentId;
  }
  if (!resolvedDepartmentId) return res.status(400).json({ error: "A combined Department is required", code: "DEPARTMENT_REQUIRED" });
  const targetDepartment = await prisma.department.findUnique({ where: { id: resolvedDepartmentId } });
  if (!targetDepartment?.active || !targetDepartment.name.includes(" - ")) {
    return res.status(400).json({ error: "Job Orders must map to an active BuName - Division Department.", code: "COMBINED_DEPARTMENT_REQUIRED" });
  }
  const jobOrder = await prisma.jobOrder.update({ where: { id }, data: {
    ...(projectId !== undefined ? { projectId: Number(projectId) } : {}),
    ...(projectWbsId !== undefined ? { projectWbsId: projectWbsId === null ? null : Number(projectWbsId) } : {}),
    ...(resolvedDepartmentId !== undefined ? { departmentId: resolvedDepartmentId } : {}),
  } });
  await writeAudit(req.user!.id, "ADMIN_REMAP_JOB_ORDER", "job_order", id, { projectId, projectWbsId, departmentId: resolvedDepartmentId, sectionId, costCenterId });
  res.json({ jobOrder });
});

adminRouter.post("/sync/badgeview", requireRoles("ADMIN"), async (req, res) => {
  const result = await runBadgeViewSync();
  await writeAudit(req.user!.id, "ADMIN_BADGEVIEW_SYNC", "sync", "LABOURWORKS", { ...result, startedAt: result.startedAt.toISOString(), finishedAt: result.finishedAt.toISOString() });
  res.status(result.ok ? 200 : 502).json({ result });
});

adminRouter.get("/sync/exceptions", requireRoles("ADMIN"), async (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : "OPEN";
  const exceptions = await prisma.syncException.findMany({ where: status === "ALL" ? undefined : { status }, orderBy: { lastSeenAt: "desc" }, take: 500 });
  res.json({ exceptions });
});

adminRouter.post("/credentials/process", requireRoles("ADMIN"), async (req, res) => {
  const result = await processCredentialDeliveries();
  await writeAudit(req.user!.id, "ADMIN_CREDENTIAL_DELIVERY_RUN", "credential_delivery", "QUEUE", result);
  res.json({ result });
});

adminRouter.get("/credentials", requireRoles("ADMIN"), async (_req, res) => {
  const deliveries = await prisma.credentialDelivery.findMany({
    select: { id: true, userId: true, recipient: true, purpose: true, status: true, attempts: true, lastError: true, createdAt: true, updatedAt: true, sentAt: true, user: { select: { name: true, email: true, employee: { select: { ecNo: true } } } } },
    orderBy: { createdAt: "desc" }, take: 500,
  });
  res.json({ deliveries });
});
