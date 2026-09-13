import { Router } from "express";
import { defaultWorkforceCredentialState, hashDefaultWorkforcePassword } from "../services/defaultLoginCredentials";
import { prisma } from "../db";
import { requireAuth, requireRoles } from "../middleware/auth";
import { writeAudit } from "../audit";
import { canonicalEcNo, findEmployeeByCanonicalEcNo } from "../services/employeeIdentity";

export const supervisorRegistrationRouter = Router();

function credentialRecipient(): string {
  return process.env.CREDENTIAL_DELIVERY_RECIPIENT?.trim() || "itsupport.shipyard@swan.co.in";
}

async function uniqueSupervisorEmail(ecNo: string): Promise<string> {
  const local = ecNo.toLowerCase().replace(/[^a-z0-9._-]/g, "_") || "supervisor";
  let email = `${local}@sync.local`;
  for (let suffix = 1; await prisma.user.findUnique({ where: { email }, select: { id: true } }); suffix += 1) {
    email = `${local}.${suffix}@sync.local`;
  }
  return email;
}

supervisorRegistrationRouter.use(requireAuth, requireRoles("ADMIN", "HR"));

const supervisorSelect = {
  id: true, name: true, email: true, role: true, source: true, active: true,
  employeeId: true, departmentId: true, createdAt: true,
  department: { select: { id: true, code: true, name: true } },
  employee: { select: { id: true, ecNo: true, mobile: true, active: true, employmentType: true,
    sectionAssignment: { include: { section: { include: { costCenter: true } } } } } },
} as const;

supervisorRegistrationRouter.get("/", async (_req, res) => {
  const supervisors = await prisma.user.findMany({ where: { role: "SUPERVISOR" }, select: supervisorSelect, orderBy: { name: "asc" } });
  res.json({ supervisors });
});

/** Register the canonical Employee, section assignment and linked User atomically. */
supervisorRegistrationRouter.post("/", async (req, res) => {
  const { ecNo, name, email, mobile, departmentId, sectionId, designation, category } = req.body ?? {};
  if (!ecNo || !name || !email || !departmentId || !sectionId) {
    return res.status(400).json({ error: "ecNo, name, email, departmentId and sectionId are required" });
  }
  const section = await prisma.section.findUnique({ where: { id: Number(sectionId) } });
  if (!section || !section.active || section.departmentId !== Number(departmentId)) {
    return res.status(400).json({ error: "sectionId must be an active section in departmentId", code: "INVALID_SECTION" });
  }
  const normalizedEcNo = canonicalEcNo(ecNo);
  const normalizedEmail = String(email).trim().toLowerCase();
  if (await findEmployeeByCanonicalEcNo(normalizedEcNo)) return res.status(409).json({ error: "ecNo already exists", code: "ECNO_EXISTS" });
  if (await prisma.user.findUnique({ where: { email: normalizedEmail } })) return res.status(409).json({ error: "email already exists", code: "EMAIL_EXISTS" });
  const passwordHash = await hashDefaultWorkforcePassword();
  const user = await prisma.$transaction(async (tx) => {
    const employee = await tx.employee.create({ data: {
      ecNo: normalizedEcNo, name: String(name).trim(), mobile: mobile ? String(mobile).trim() : null,
      departmentId: Number(departmentId), designation: String(designation || ""), category: String(category || "PAYROLL"),
      employmentType: "PAYROLL", source: "PAYROLL", active: true,
    } });
    await tx.employeeSectionAssignment.create({ data: { employeeId: employee.id, sectionId: Number(sectionId), source: "MANUAL" } });
    const created = await tx.user.create({ data: {
      employeeId: employee.id, name: employee.name, email: normalizedEmail, passwordHash, role: "SUPERVISOR",
      source: "MANUAL", departmentId: employee.departmentId, active: true, ...defaultWorkforceCredentialState,
    } });
    await tx.credentialDelivery.create({ data: { userId: created.id, recipient: credentialRecipient(), purpose: "INITIAL" } });
    return created;
  });
  await writeAudit(req.user!.id, "SUPERVISOR_CREATE", "user", user.id, { ecNo: normalizedEcNo, employeeId: user.employeeId, sectionId, credentialQueued: true });
  const result = await prisma.user.findUnique({ where: { id: user.id }, select: supervisorSelect });
  res.status(201).json({ user: result, credentialQueued: true });
});

supervisorRegistrationRouter.put("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const existing = await prisma.user.findUnique({ where: { id }, include: { employee: true } });
  if (!existing || existing.role !== "SUPERVISOR") return res.status(404).json({ error: "Supervisor not found" });
  const { name, email, mobile, sectionId, active } = req.body ?? {};
  const syncOwned = existing.source === "SYNC" || existing.employee?.employmentType === "CLMS";
  if (syncOwned && [name, email, mobile, active].some((value) => value !== undefined)) {
    return res.status(409).json({ error: "LabourWorks owns CLMS identity and lifecycle fields. Only Section may be changed here.", code: "CLMS_SYNC_OWNED" });
  }
  if (sectionId !== undefined) {
    const section = await prisma.section.findUnique({ where: { id: Number(sectionId) } });
    if (!section || !section.active || (existing.employee && section.departmentId !== existing.employee.departmentId)) return res.status(400).json({ error: "Section must be active and belong to the Supervisor Department", code: "INVALID_SECTION" });
  }
  const reactivating = active === true && !existing.active;
  const deactivating = active === false && existing.active;
  const passwordHash = reactivating ? await hashDefaultWorkforcePassword() : null;
  let credentialQueued = false;
  await prisma.$transaction(async (tx) => {
    if (existing.employeeId) {
      await tx.employee.update({ where: { id: existing.employeeId }, data: {
        ...(name !== undefined ? { name: String(name).trim() } : {}), ...(mobile !== undefined ? { mobile: mobile ? String(mobile).trim() : null } : {}),
        ...(active !== undefined ? { active: Boolean(active), terminatedAt: active ? null : new Date() } : {}),
      } });
      if (sectionId !== undefined) await tx.employeeSectionAssignment.upsert({ where: { employeeId: existing.employeeId }, create: { employeeId: existing.employeeId, sectionId: Number(sectionId), source: "MANUAL" }, update: { sectionId: Number(sectionId), source: "MANUAL" } });
    }
    await tx.user.update({ where: { id }, data: {
      ...(name !== undefined ? { name: String(name).trim() } : {}), ...(email !== undefined ? { email: String(email).trim().toLowerCase() } : {}),
      ...(active !== undefined ? { active: Boolean(active) } : {}),
      ...(reactivating ? { passwordHash: passwordHash!, ...defaultWorkforceCredentialState, tokenVersion: { increment: 1 } } : {}),
      ...(deactivating ? { tokenVersion: { increment: 1 } } : {}),
    } });
    if (reactivating) {
      const pending = await tx.credentialDelivery.findFirst({ where: { userId: id, status: { in: ["PENDING", "PROCESSING"] } } });
      if (!pending) {
        await tx.credentialDelivery.create({ data: { userId: id, recipient: credentialRecipient(), purpose: "REACTIVATION" } });
        credentialQueued = true;
      }
    }
  });
  await writeAudit(req.user!.id, "SUPERVISOR_UPDATE", "user", id, { sectionId, active, credentialQueued });
  res.json({ user: await prisma.user.findUnique({ where: { id }, select: supervisorSelect }), credentialQueued });
});

/** Queue a reset. No password is accepted, stored, audited, logged, or returned. */
supervisorRegistrationRouter.post("/:id/credential-reset", async (req, res) => {
  const id = Number(req.params.id);
  const existing = await prisma.user.findUnique({ where: { id }, include: { employee: { select: { active: true } } } });
  if (!existing || existing.role !== "SUPERVISOR") return res.status(404).json({ error: "Supervisor not found" });
  if (!existing.active || (existing.employeeId != null && !existing.employee?.active)) {
    return res.status(409).json({ error: "Credentials cannot be reset for an inactive Supervisor.", code: "ACCOUNT_INACTIVE" });
  }
  const pending = await prisma.credentialDelivery.findFirst({ where: { userId: id, status: { in: ["PENDING", "PROCESSING"] } } });
  const passwordHash = await hashDefaultWorkforcePassword();
  const delivery = await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id }, data: {
      passwordHash, ...defaultWorkforceCredentialState,
      tokenVersion: { increment: 1 },
    } });
    return pending ?? tx.credentialDelivery.create({ data: { userId: id, recipient: credentialRecipient(), purpose: "RESET" } });
  });
  await writeAudit(req.user!.id, "SUPERVISOR_CREDENTIAL_RESET", "user", id, { deliveryId: delivery.id, oneTimeCredential: true });
  res.status(202).json({ reset: true, queued: true, deliveryId: delivery.id, alreadyPending: Boolean(pending) });
});

/** Create or reactivate an audited CLMS supervisor override by employeeId or ecNo. */
supervisorRegistrationRouter.post("/overrides", async (req, res) => {
  const { employeeId, ecNo, reason } = req.body ?? {};
  if ((!employeeId && !ecNo) || !String(reason || "").trim()) return res.status(400).json({ error: "employeeId or ecNo, and reason are required" });
  const employee = employeeId ? await prisma.employee.findUnique({ where: { id: Number(employeeId) } }) : await findEmployeeByCanonicalEcNo(ecNo);
  if (!employee) return res.status(404).json({ error: "Employee not found" });
  if (!employee.active || employee.employmentType !== "CLMS") return res.status(409).json({ error: "Only active CLMS employees can be overridden", code: "NOT_ACTIVE_CLMS" });
  const existingUser = await prisma.user.findUnique({ where: { employeeId: employee.id } });
  const needsCredential = !existingUser?.active || existingUser.role !== "SUPERVISOR";
  const passwordHash = needsCredential ? await hashDefaultWorkforcePassword() : null;
  const loginEmail = existingUser?.email || await uniqueSupervisorEmail(employee.ecNo);
  const result = await prisma.$transaction(async (tx) => {
    const override = await tx.supervisorOverride.upsert({
      where: { employeeId: employee.id },
      create: { employeeId: employee.id, createdById: req.user!.id, reason: String(reason).trim() },
      update: { createdById: req.user!.id, reason: String(reason).trim(), revokedAt: null },
    });
    let user = existingUser;
    if (!user) {
      user = await tx.user.create({ data: {
        employeeId: employee.id, email: loginEmail, name: employee.name, role: "SUPERVISOR",
        source: "SYNC", departmentId: employee.departmentId, active: true,
        passwordHash: passwordHash!, ...defaultWorkforceCredentialState,
      } });
    } else if (needsCredential) {
      user = await tx.user.update({ where: { id: user.id }, data: {
        name: employee.name, role: "SUPERVISOR", departmentId: employee.departmentId, active: true,
        passwordHash: passwordHash!, ...defaultWorkforceCredentialState,
        credentialSentAt: null, tokenVersion: { increment: 1 },
      } });
    }
    let delivery = null;
    if (needsCredential) {
      const pending = await tx.credentialDelivery.findFirst({ where: { userId: user.id, status: { in: ["PENDING", "PROCESSING"] } } });
      if (!pending) {
        delivery = await tx.credentialDelivery.create({ data: {
          userId: user.id, recipient: credentialRecipient(), purpose: existingUser ? "REACTIVATION" : "NEW_SUPERVISOR",
        } });
      }
    }
    return { override, user, delivery };
  });
  await writeAudit(req.user!.id, "SUPERVISOR_OVERRIDE", "supervisor_override", result.override.id, { employeeId: employee.id, ecNo: employee.ecNo, reason: String(reason).trim(), credentialQueued: Boolean(result.delivery) });
  res.status(201).json({ override: result.override, user: {
    id: result.user.id, email: result.user.email, name: result.user.name, role: result.user.role,
    employeeId: result.user.employeeId, departmentId: result.user.departmentId, active: result.user.active,
  }, credentialQueued: Boolean(result.delivery) });
});

supervisorRegistrationRouter.delete("/overrides/:id", async (req, res) => {
  const id = Number(req.params.id);
  const current = await prisma.supervisorOverride.findUnique({ where: { id } });
  if (!current) return res.status(404).json({ error: "Supervisor override not found" });
  if (current.revokedAt) return res.status(409).json({ error: "Supervisor override is already revoked", code: "ALREADY_REVOKED" });
  const employee = await prisma.employee.findUnique({ where: { id: current.employeeId }, select: { natureOfWork: true, user: { select: { id: true } } } });
  const remainsNaturalSupervisor = employee?.natureOfWork?.trim().toLowerCase() === "supervisor";
  const override = await prisma.$transaction(async (tx) => {
    const updated = await tx.supervisorOverride.update({ where: { id }, data: { revokedAt: new Date() } });
    if (!remainsNaturalSupervisor && employee?.user) {
      await tx.user.update({ where: { id: employee.user.id }, data: { active: false, tokenVersion: { increment: 1 } } });
    }
    return updated;
  });
  await writeAudit(req.user!.id, "SUPERVISOR_OVERRIDE_REVOKE", "supervisor_override", id, { employeeId: current.employeeId, accountDisabled: !remainsNaturalSupervisor });
  res.json({ override });
});

supervisorRegistrationRouter.get("/overrides", async (_req, res) => {
  const overrides = await prisma.supervisorOverride.findMany({ include: { employee: { include: { department: true } }, createdBy: { select: { id: true, name: true } } }, orderBy: { createdAt: "desc" } });
  res.json({ overrides });
});

/** Soft-disable login; the canonical employee and historical records remain. */
supervisorRegistrationRouter.delete("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const existing = await prisma.user.findUnique({ where: { id }, include: { employee: { select: { employmentType: true } } } });
  if (!existing || existing.role !== "SUPERVISOR") return res.status(404).json({ error: "Supervisor not found" });
  if (existing.source === "SYNC" || existing.employee?.employmentType === "CLMS") {
    return res.status(409).json({ error: "LabourWorks owns CLMS lifecycle. Revoke a manual override or update the source record.", code: "CLMS_SYNC_OWNED" });
  }
  await prisma.user.update({ where: { id }, data: { active: false, tokenVersion: { increment: 1 } } });
  await writeAudit(req.user!.id, "SUPERVISOR_DISABLE", "user", id);
  res.json({ ok: true });
});
