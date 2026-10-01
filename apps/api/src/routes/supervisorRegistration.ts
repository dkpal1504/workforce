import { Router } from "express";
import { initialCredentialState, initialCredentialStateLabel } from "../services/defaultLoginCredentials";
import { loginIdentifierFor, payrollPasswordResettable } from "../services/payrollPasswordReset";
import { prisma } from "../db";
import { requireAuth, requireRoles } from "../middleware/auth";
import { writeAudit } from "../audit";
import { canonicalEcNo, findEmployeeByCanonicalEcNo } from "../services/employeeIdentity";
import { queueCredential, sourceTerminatedForEcNo } from "../services/badgeViewSync";

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

/**
 * Payroll (white-collar) Employees and their own login, for the Admin/HR password reset.
 *
 * One row per payroll Employee that already HAS an account: a payroll Employee with no
 * account has no password to reset (register it from Employee Registration first). The
 * Supervisor rows the first tab owns appear here too, on purpose — a Supervisor IS a
 * payroll Employee and this is the same reset against the same account. Rows whose
 * account has been promoted to an approver/administrative role (HOD / Dept Head / PM) are
 * returned with `resettable: false` rather than hidden: the operator needs to see that the
 * person has a login, and needs to be told which screen owns it.
 */
supervisorRegistrationRouter.get("/payroll-employees", async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const departmentId = req.query.department_id ? Number(req.query.department_id) : undefined;
  const sectionId = req.query.section_id ? Number(req.query.section_id) : undefined;
  const employees = await prisma.employee.findMany({
    where: {
      active: true,
      employmentType: "PAYROLL",
      ...(departmentId ? { departmentId } : {}),
      ...(sectionId ? { sectionAssignment: { sectionId } } : {}),
      ...(q ? { OR: [{ ecNo: { contains: q } }, { name: { contains: q } }, { designation: { contains: q } }] } : {}),
    },
    select: {
      id: true, ecNo: true, name: true, designation: true, category: true, source: true, active: true,
      department: { select: { id: true, code: true, name: true } },
      sectionAssignment: { select: { sectionId: true, section: { select: { id: true, code: true, name: true } } } },
      user: { select: { id: true, role: true, email: true, active: true, source: true, mustChangePassword: true } },
    },
    orderBy: { name: "asc" },
  });

  const rows = employees
    .filter((employee) => employee.user !== null)
    .map((employee) => {
      const user = employee.user!;
      // An ecNo-login role signs in with the EC No; anything else (HR/FINANCE/ADMIN, which
      // never hold an ecNo login) shows its e-mail, or the screen would name an identifier
      // that cannot actually log in.
      const login = loginIdentifierFor(user.role, employee.ecNo, user.email);
      const roleOwned = !payrollPasswordResettable(user.role);
      return {
        employeeId: employee.id,
        ecNo: employee.ecNo,
        name: employee.name,
        designation: employee.designation,
        category: employee.category,
        department: employee.department,
        section: employee.sectionAssignment?.section ?? null,
        userId: user.id,
        role: user.role,
        accountActive: user.active,
        employeeActive: employee.active,
        // WHO owns this row, so the screen can say why it is unmanageable instead of
        // showing a bare "disabled": PAYROLL/MANUAL is ours, SYNC belongs to LabourWorks.
        employeeSource: employee.source,
        accountSource: user.source,
        roleOwned,
        login,
        mustChangePassword: user.mustChangePassword,
        // The ordinary payroll row (Employee/Supervisor). A promoted account is resettable
        // too, but only through an explicit, audited `roleOwned` request.
        resettable: user.active && !roleOwned,
        // Enabling is only offered to a promoted account or an ENABLED one: turning off your
        // own last Admin login from a list is a worse failure than the one we are fixing, and
        // an HR account on this screen could otherwise lock the office out.
        canDisableLogin: user.active && (!roleOwned || req.user!.role === "ADMIN"),
      };
    });

  // The password a reset applied, alongside the rows, so the button's confirmation can
  // name it instead of guessing. Admin/HR only — the same trust boundary that already
  // reads this value out of the environment at the gate.
  res.json({ employees: rows, resetPassword: initialCredentialStateLabel() });
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
  const credential = await initialCredentialState();
  const user = await prisma.$transaction(async (tx) => {
    const employee = await tx.employee.create({ data: {
      ecNo: normalizedEcNo, name: String(name).trim(), mobile: mobile ? String(mobile).trim() : null,
      departmentId: Number(departmentId), designation: String(designation || ""), category: String(category || "PAYROLL"),
      employmentType: "PAYROLL", source: "PAYROLL", active: true,
    } });
    await tx.employeeSectionAssignment.create({ data: { employeeId: employee.id, sectionId: Number(sectionId), source: "MANUAL" } });
    const created = await tx.user.create({ data: {
      employeeId: employee.id, name: employee.name, email: normalizedEmail, ...credential, role: "SUPERVISOR",
      source: "MANUAL", departmentId: employee.departmentId, active: true,
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
  if (sectionId !== undefined && req.user!.role !== "ADMIN") {
    return res.status(403).json({ error: "Only PM/Admin may remap a Supervisor's organisation assignment.", code: "FORBIDDEN" });
  }
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
  const credential = reactivating ? await initialCredentialState() : null;
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
      ...(reactivating ? { ...credential!, tokenVersion: { increment: 1 } } : {}),
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

/**
 * Apply the deployment's shared first credential to one account.
 *
 * NO password is accepted from the caller, stored, audited, logged or returned: the value
 * is always whatever `initialCredentialState()` provisions for a newly created account, so
 * a reset is indistinguishable from a fresh registration. `mustChangePassword` is already
 * true in that state, so the person must set a password of their own at the next login.
 *
 * Two things are non-obvious and both matter:
 *  - sessions are revoked (`tokenVersion` bump). Without it the person's open browser tab
 *    keeps working with a token minted from the OLD password, which is exactly what the
 *    operator is trying to take away.
 *  - an already PENDING/PROCESSING delivery row is REUSED rather than duplicated. The
 *    worker (CREDENTIAL_DELIVERY_CRON, default every five minutes) overwrites the hash with
 *    a fresh random secret when it runs, so a second row would not just be noise: it would
 *    defeat the reset a second time. Reusing the row also means the reset is honoured by
 *    the next worker run — the hash it writes is the same shared first password, because
 *    this deployment has one configured.
 */
async function applySharedFirstCredential(userId: number, purpose: string) {
  const pending = await prisma.credentialDelivery.findFirst({ where: { userId, status: { in: ["PENDING", "PROCESSING"] } } });
  const credential = await initialCredentialState();
  const delivery = await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { ...credential, tokenVersion: { increment: 1 } } });
    return pending ?? tx.credentialDelivery.create({ data: { userId, recipient: credentialRecipient(), purpose } });
  });
  return { delivery, alreadyPending: Boolean(pending) };
}

/**
 * Reset a PAYROLL (white-collar) Employee's own login to the deployment's shared first
 * password. The account is addressed by its EMPLOYEE id, not a User id, because that is
 * what the operator has in front of them on the row (and it is the identifier that is
 * stable when the account is later promoted to another role).
 *
 * Two kinds of account reach the shared-credential path:
 *  - role EMPLOYEE / SUPERVISOR: the payroll tab's own row.
 *  - any role ABOVE that (HOD / DEPT_HEAD / PM / HR / FINANCE / ADMIN) **when the caller
 *    asks for it explicitly** with `{ "roleOwned": true }`. Those payroll employees are
 *    promoted staff — the PM team on this deployment are payroll employees with a PM role —
 *    and their credential is otherwise unreachable: Role Assignment deliberately never
 *    touches a password, so without this an operator has no lever for "the PM forgot their
 *    password" except hand-editing the hash. The flag is required rather than implied so a
 *    mis-click on the payroll tab can never reset an Admin account.
 */
supervisorRegistrationRouter.post("/payroll-employees/:employeeId/credential-reset", async (req, res) => {
  const employeeId = Number(req.params.employeeId);
  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { id: true, ecNo: true, name: true, active: true, employmentType: true, user: { select: { id: true, role: true, active: true } } },
  });
  if (!employee) return res.status(404).json({ error: "Employee not found", code: "EMPLOYEE_NOT_FOUND" });
  if (employee.employmentType !== "PAYROLL") {
    return res.status(400).json({ error: "Only a payroll employee has an EC No login to reset.", code: "NOT_PAYROLL_EMPLOYEE" });
  }
  if (!employee.user) {
    return res.status(404).json({
      error: `${employee.name} (${employee.ecNo}) has no login yet. Register the employee to create one.`,
      code: "ACCOUNT_NOT_FOUND",
    });
  }
  if (!employee.active || !employee.user.active) {
    return res.status(409).json({ error: "Credentials cannot be reset for an inactive employee.", code: "ACCOUNT_INACTIVE" });
  }
  const roleOwned = req.body?.roleOwned === true;
  if (!payrollPasswordResettable(employee.user.role) && !roleOwned) {
    return res.status(409).json({
      error: `${employee.name} signs in as ${employee.user.role}, not as a payroll employee. Change or reset that role from Role Assignment.`,
      code: "ROLE_NOT_RESETTABLE",
    });
  }

  const { delivery, alreadyPending } = await applySharedFirstCredential(employee.user.id, "RESET");
  await writeAudit(req.user!.id, "PAYROLL_EMPLOYEE_CREDENTIAL_RESET", "employee", employee.id, {
    userId: employee.user.id,
    ecNo: employee.ecNo,
    role: employee.user.role,
    deliveryId: delivery.id,
    alreadyPending,
    sharedFirstPassword: true,
    // Recorded so the trail shows a promoted account (PM/ADMIN) was reset deliberately
    // rather than through the ordinary payroll row.
    roleOwnedOverride: roleOwned && !payrollPasswordResettable(employee.user.role),
  });
  // `resetPassword` is what the confirmation names to the operator. It is the shared first
  // password of THIS deployment, never a literal in the source (see the build gate).
  res.status(202).json({
    reset: true,
    queued: true,
    deliveryId: delivery.id,
    alreadyPending,
    employee: { id: employee.id, ecNo: employee.ecNo, name: employee.name, role: employee.user.role },
    resetPassword: initialCredentialStateLabel(),
    mustChangePassword: true,
  });
});

/**
 * Re-open a payroll employee's login, or close it again.
 *
 * WHY the payload is `{ "active": true|false }` rather than two REST-ier routes: the
 * payroll tab is a list with a per-row action, and the operator's intent is one boolean
 * about one row. An explicit boolean also means a replayed request cannot flip the state,
 * which a toggle route could.
 *
 * A payroll Employee's lifecycle is ours to manage (source is PAYROLL, and the LabourWorks
 * sync only ever writes `source: "SYNC"` rows), so unlike the Supervisor Disable action
 * there is no CLMS ownership to defer to. Re-enabling also clears `terminatedAt` so the
 * record is not left looking terminated, and bumps `tokenVersion` in both directions: a
 * disable must end live sessions, and an enable must not resurrect the pre-disable ones.
 */
supervisorRegistrationRouter.post("/payroll-employees/:employeeId/login-status", async (req, res) => {
  const employeeId = Number(req.params.employeeId);
  const desired = req.body?.active;
  if (typeof desired !== "boolean") {
    return res.status(400).json({ error: "active (boolean) is required", code: "INVALID_ACTIVE" });
  }
  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { id: true, ecNo: true, name: true, active: true, employmentType: true, user: { select: { id: true, role: true, active: true } } },
  });
  if (!employee) return res.status(404).json({ error: "Employee not found", code: "EMPLOYEE_NOT_FOUND" });
  if (employee.employmentType !== "PAYROLL") {
    return res.status(400).json({ error: "Only a payroll employee's login can be managed here.", code: "NOT_PAYROLL_EMPLOYEE" });
  }
  if (!employee.user) {
    return res.status(404).json({ error: `${employee.name} (${employee.ecNo}) has no login yet.`, code: "ACCOUNT_NOT_FOUND" });
  }
  if (employee.user.active === desired) {
    // Idempotent: report what is true rather than bumping a session counter for nothing.
    return res.json({ ok: true, changed: false, accountActive: desired, employee: { id: employee.id, ecNo: employee.ecNo, name: employee.name, role: employee.user.role } });
  }

  const updated = await prisma.$transaction(async (tx) => {
    // Enabling a login for a terminated employee would be a contradiction, so the employee
    // record is re-opened with it; disabling a login leaves the employee record alone
    // (they are still on the rolls, they simply cannot sign in) unless it was already off.
    if (desired && !employee.active) {
      await tx.employee.update({ where: { id: employee.id }, data: { active: true, terminatedAt: null } });
    }
    return tx.user.update({
      where: { id: employee.user!.id },
      data: { active: desired, tokenVersion: { increment: 1 } },
      select: { id: true, active: true },
    });
  });

  await writeAudit(req.user!.id, desired ? "PAYROLL_EMPLOYEE_LOGIN_ENABLE" : "PAYROLL_EMPLOYEE_LOGIN_DISABLE", "employee", employee.id, {
    userId: employee.user.id,
    ecNo: employee.ecNo,
    role: employee.user.role,
    employeeReopened: desired && !employee.active,
  });
  res.json({
    ok: true,
    changed: true,
    accountActive: updated.active,
    employee: { id: employee.id, ecNo: employee.ecNo, name: employee.name, role: employee.user.role },
  });
});

/** Queue a reset. No password is accepted, stored, audited, logged, or returned. */
supervisorRegistrationRouter.post("/:id/credential-reset", async (req, res) => {
  const id = Number(req.params.id);
  const existing = await prisma.user.findUnique({ where: { id }, include: { employee: { select: { active: true } } } });
  if (!existing || existing.role !== "SUPERVISOR") return res.status(404).json({ error: "Supervisor not found" });
  if (!existing.active || (existing.employeeId != null && !existing.employee?.active)) {
    return res.status(409).json({ error: "Credentials cannot be reset for an inactive Supervisor.", code: "ACCOUNT_INACTIVE" });
  }
  const { delivery, alreadyPending } = await applySharedFirstCredential(id, "RESET");
  await writeAudit(req.user!.id, "SUPERVISOR_CREDENTIAL_RESET", "user", id, { deliveryId: delivery.id, alreadyPending, sharedFirstPassword: true });
  res.status(202).json({ reset: true, queued: true, deliveryId: delivery.id, alreadyPending });
});

/**
 * Re-open a supervisor login that the LabourWorks sync switched off, by recording an audited
 * Supervisor OVERRIDE for a named reason.
 *
 * WHY THIS IS AN OVERRIDE AND NOT `PUT /:id { active: true }`
 *   `PUT /:id` refuses a CLMS account with `409 CLMS_SYNC_OWNED`, and that refusal is correct: the
 *   sync owns the LIFECYCLE of an account whose Employee row and `IsTerminated` flag do not belong
 *   to this app, so a bare activation would be re-decided at the next tick. A SupervisorOverride is
 *   the one mechanism in this app that the sync treats as an assertion rather than as derived data
 *   — it survives every run and it is visible on the CLMS Overrides tab. The operator therefore has
 *   to supply a REASON, and the reason is what makes the record accountable.
 *
 * WHAT IT REFUSES, AND WHY THAT IS NOT AN OBSTACLE
 *   Only a genuinely terminated employee is refused (`SOURCE_TERMINATED`): activating a login for
 *   somebody LabourWorks reports as terminated would contradict the source on a fact that matters,
 *   and the fix for that is in LabourWorks, not here. An "absent from the snapshot" employee is
 *   deliberately NOT refused — that is one of the states that needs repairing by hand (the absence
 *   sweep and the pre-fix sync are both capable of leaving an active person disabled), and re-opening
 *   the login and the employee record together is precisely the repair.
 *
 * WHAT IT DOES
 *   - upserts the override (reactivating a revoked one, audited as such);
 *   - reopens the employee record if it was soft-terminated, clearing `terminatedAt`;
 *   - sets the login active and bumps `tokenVersion`, so a stale browser session cannot continue;
 *   - queues a REACTIVATION credential only when the account was actually closed;
 *   - writes a `SUPERVISOR_ACTIVATE` audit row naming the reason, the override and the old state.
 *
 * It deliberately does NOT touch the password hash: the person has been signing in with a password
 * of their own, and re-provisioning the shared first credential here would lock them out of the very
 * account being restored.
 */
supervisorRegistrationRouter.post("/:id/activate", async (req, res) => {
  const id = Number(req.params.id);
  const reason = String(req.body?.reason ?? "").trim();
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "A supervisor id is required.", code: "INVALID_ID" });
  if (reason.length < 3) {
    return res.status(400).json({ error: "A reason (at least 3 characters) is required — it is recorded against the override.", code: "REASON_REQUIRED" });
  }

  const existing = await prisma.user.findUnique({
    where: { id },
    include: { employee: { select: { id: true, ecNo: true, name: true, active: true, terminatedAt: true, source: true, employmentType: true } } },
  });
  if (!existing || existing.role !== "SUPERVISOR") return res.status(404).json({ error: "Supervisor not found", code: "SUPERVISOR_NOT_FOUND" });
  if (!existing.employee) {
    return res.status(409).json({ error: "This supervisor account is not linked to an employee record, so it cannot be verified against LabourWorks.", code: "EMPLOYEE_NOT_LINKED" });
  }

  // Is the source really reporting them as terminated? Read the SAME view with the SAME flag rule
  // the sync uses, rather than trusting the stored `terminatedAt` (which may predate this repair).
  const terminatedInSource = await sourceTerminatedForEcNo(existing.employee.ecNo).catch(() => null);
  if (terminatedInSource === true) {
    return res.status(409).json({
      error: `${existing.name} (${existing.employee.ecNo}) is reported TERMINATED in LabourWorks. Correct the record there, then run the sync — activating the login here would contradict the source.`,
      code: "SOURCE_TERMINATED",
    });
  }

  const alreadyActive = existing.active && existing.employee.active;
  const before = { accountActive: existing.active, employeeActive: existing.employee.active, terminatedAt: existing.employee.terminatedAt };
  // Read the override BEFORE upserting so the audit row can say whether this re-activated a revoked
  // override or created the first one — the two are different decisions by the operator.
  const previousOverride = await prisma.supervisorOverride.findUnique({
    where: { employeeId: existing.employee.id },
    select: { id: true, revokedAt: true, reason: true },
  });

  const result = await prisma.$transaction(async (tx) => {
    const override = await tx.supervisorOverride.upsert({
      where: { employeeId: existing.employee!.id },
      create: { employeeId: existing.employee!.id, createdById: req.user!.id, reason },
      update: { createdById: req.user!.id, reason, revokedAt: null },
    });
    if (!existing.employee!.active) {
      await tx.employee.update({ where: { id: existing.employee!.id }, data: { active: true, terminatedAt: null } });
    }
    let credentialQueued = false;
    if (!existing.active) {
      const updated = await tx.user.update({
        where: { id },
        data: { active: true, tokenVersion: { increment: 1 } },
        select: { id: true, active: true },
      });
      credentialQueued = await queueCredential(tx, updated.id, "REACTIVATION");
      return { override, user: updated, credentialQueued };
    }
    const current = await tx.user.findUniqueOrThrow({ where: { id }, select: { id: true, active: true } });
    return { override, user: current, credentialQueued };
  });

  await writeAudit(req.user!.id, "SUPERVISOR_ACTIVATE", "user", id, {
    reason,
    overrideId: result.override.id,
    overrideCreated: previousOverride === null,
    overrideReactivated: Boolean(previousOverride?.revokedAt),
    previousOverrideReason: previousOverride?.reason ?? null,
    ecNo: existing.employee.ecNo,
    source: existing.employee.source,
    employeeType: existing.employee.employmentType,
    before,
    after: { accountActive: result.user.active, employeeActive: true },
    credentialQueued: result.credentialQueued,
    sourceTerminatedChecked: terminatedInSource !== null,
  });

  res.status(200).json({
    ok: true,
    alreadyActive,
    user: { id: result.user.id, name: existing.name, active: result.user.active },
    employee: { id: existing.employee.id, ecNo: existing.employee.ecNo, active: true },
    override: { id: result.override.id, reason: result.override.reason, revokedAt: result.override.revokedAt },
    credentialQueued: result.credentialQueued,
  });
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
  const credential = needsCredential ? await initialCredentialState() : null;
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
        employeeId: employee.id, email: loginEmail, ...credential!, name: employee.name, role: "SUPERVISOR",
        source: "SYNC", departmentId: employee.departmentId, active: true,
      } });
    } else if (needsCredential) {
      user = await tx.user.update({ where: { id: user.id }, data: {
        name: employee.name, role: "SUPERVISOR", departmentId: employee.departmentId, active: true,
        ...credential!,
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
