import { Router } from "express";
import bcrypt from "bcryptjs";
import { changePasswordSchema, loginSchema } from "@workforce/shared";
import { prisma } from "../db";
import { requireAuth, requireRoles, signToken } from "../middleware/auth";
import { writeAudit } from "../audit";
import { findEmployeeByCanonicalEcNo } from "../services/employeeIdentity";
import { usesEcNoLogin } from "../services/defaultLoginCredentials";

export const authRouter = Router();

type CapabilityMap = {
  selectTeam: boolean;
  editTimesheet: boolean;
  viewSummary: boolean;
  approveTimesheets: boolean;
  manageSupervisors: boolean;
  manageMasterData: boolean;
  manageEmployees: boolean;
  allocateHours: boolean;
};

function capabilitiesFor(role: string): CapabilityMap {
  return {
    selectTeam: role === "SUPERVISOR",
    editTimesheet: role === "SUPERVISOR",
    viewSummary: ["SUPERVISOR", "HOD", "PM", "HR", "FINANCE", "ADMIN"].includes(role),
    approveTimesheets: ["HOD", "PM", "ADMIN"].includes(role),
    manageSupervisors: ["ADMIN", "HR"].includes(role),
    manageMasterData: role === "ADMIN",
    manageEmployees: ["ADMIN", "HR"].includes(role),
    allocateHours: ["SUPERVISOR", "EMPLOYEE", "HOD", "PM", "HR", "ADMIN"].includes(role),
  };
}

function landingPath(role: string): string {
  if (["HOD", "PM", "ADMIN"].includes(role)) return "/approvals";
  if (role === "HR") return "/supervisors";
  if (role === "FINANCE") return "/summary";
  if (role === "EMPLOYEE") return "/allocations";
  return "/select-team";
}

const lifecycleUserSelect = {
  id: true,
  email: true,
  name: true,
  role: true,
  departmentId: true,
  employeeId: true,
  active: true,
  mustChangePassword: true,
  tokenVersion: true,
  passwordExpiresAt: true,
  credentialProvisionedAt: true,
  credentialSentAt: true,
  department: { select: { id: true, name: true, code: true } },
  employee: {
    select: {
      id: true,
      ecNo: true,
      active: true,
      terminatedAt: true,
      departmentId: true,
      sectionAssignment: {
        select: {
          section: {
            select: {
              id: true,
              code: true,
              name: true,
              departmentId: true,
              costCenter: { select: { id: true, code: true, name: true, active: true } },
            },
          },
        },
      },
    },
  },
} as const;

function presentUser(user: any) {
  const assignedSection = user.employee?.sectionAssignment?.section ?? null;
  const requiresSectionSelection =
    user.role === "SUPERVISOR" && user.employeeId != null && assignedSection == null;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    departmentId: user.departmentId,
    employeeId: user.employeeId,
    active: user.active,
    employeeActive: user.employee?.active ?? null,
    mustChangePassword: user.mustChangePassword,
    passwordExpiresAt: user.passwordExpiresAt,
    credentialProvisionedAt: user.credentialProvisionedAt,
    credentialSentAt: user.credentialSentAt,
    department: user.department,
    employee: user.employee
      ? {
          id: user.employee.id,
          ecNo: user.employee.ecNo,
          active: user.employee.active,
          terminatedAt: user.employee.terminatedAt,
        }
      : null,
    section: assignedSection,
    requiresSectionSelection,
    capabilities: capabilitiesFor(user.role),
    landingPath: landingPath(user.role),
  };
}

authRouter.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const { password } = parsed.data;
  const identifier = (parsed.data.identifier ?? parsed.data.email ?? "").trim();

  // Payroll Employees and Supervisors authenticate with canonical ecNo. The
  // comparison key is trimmed and case-insensitive; the stored ecNo is unchanged.
  const employee = await findEmployeeByCanonicalEcNo(identifier);
  const linkedUser = employee
    ? await prisma.user.findUnique({
        where: { employeeId: employee.id },
        select: { ...lifecycleUserSelect, passwordHash: true },
      })
    : null;
  const ecNoUser = linkedUser && usesEcNoLogin(linkedUser.role, linkedUser.employeeId) ? linkedUser : null;

  // Keep email login for administrative roles and older API clients. Stored
  // login emails are normalized to lowercase at creation time.
  const emailCandidate = ecNoUser ? null : await prisma.user.findUnique({
    where: { email: identifier.toLowerCase() },
    select: { ...lifecycleUserSelect, passwordHash: true },
  });
  const emailUser = emailCandidate
    && emailCandidate.employeeId == null
    && ["ADMIN", "HR", "HOD", "PM", "FINANCE"].includes(emailCandidate.role)
      ? emailCandidate
      : null;
  const user = ecNoUser ?? emailUser;
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ error: "Invalid EC No/email or password", code: "INVALID_CREDENTIALS" });
  }
  if (!user.active || (user.employeeId != null && !user.employee?.active)) {
    return res.status(401).json({ error: "This account is inactive. Contact support.", code: "ACCOUNT_INACTIVE" });
  }
  if (user.passwordExpiresAt && user.passwordExpiresAt.getTime() <= Date.now()) {
    return res.status(401).json({ error: "Your temporary credential has expired. Contact support.", code: "CREDENTIAL_EXPIRED" });
  }

  const token = signToken({ id: user.id, tokenVersion: user.tokenVersion });
  await writeAudit(user.id, "LOGIN", "user", user.id);
  res.json({ token, user: presentUser(user) });
});

authRouter.post("/logout", requireAuth, async (req, res) => {
  await prisma.user.update({
    where: { id: req.user!.id },
    data: { tokenVersion: { increment: 1 } },
  });
  await writeAudit(req.user!.id, "LOGOUT", "user", req.user!.id);
  res.json({ ok: true });
});

authRouter.get("/me", requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user!.id }, select: lifecycleUserSelect });
  if (!user) return res.status(401).json({ error: "Session revoked", code: "SESSION_REVOKED" });
  res.json({ user: presentUser(user) });
});

authRouter.put("/section", requireAuth, requireRoles("SUPERVISOR", "EMPLOYEE"), async (req, res) => {
  if (!req.user!.employeeId) return res.status(409).json({ error: "No linked Employee record.", code: "NO_LINKED_EMPLOYEE" });
  const sectionId = Number(req.body?.sectionId);
  if (!Number.isInteger(sectionId) || sectionId <= 0) return res.status(400).json({ error: "sectionId is required" });
  const [employee, section] = await Promise.all([
    prisma.employee.findUnique({ where: { id: req.user!.employeeId }, select: { id: true, departmentId: true, active: true } }),
    prisma.section.findUnique({ where: { id: sectionId } }),
  ]);
  if (!employee?.active) return res.status(409).json({ error: "Employee is inactive.", code: "EMPLOYEE_INACTIVE" });
  if (!section?.active || section.departmentId !== employee.departmentId) {
    return res.status(400).json({ error: "Select an active Section under your Department.", code: "INVALID_SECTION" });
  }
  await prisma.employeeSectionAssignment.upsert({
    where: { employeeId: employee.id },
    create: { employeeId: employee.id, sectionId, source: "SELF_SERVICE" },
    update: { sectionId, source: "SELF_SERVICE" },
  });
  await writeAudit(req.user!.id, "EMPLOYEE_SECTION_SELECT", "employee", employee.id, { sectionId });
  const user = await prisma.user.findUnique({ where: { id: req.user!.id }, select: lifecycleUserSelect });
  res.json({ user: presentUser(user) });
});

authRouter.post("/change-password", requireAuth, async (req, res) => {
  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten(), code: "INVALID_PASSWORD" });
  }

  const user = await prisma.user.findUnique({
    where: { id: req.user!.id },
    select: { id: true, passwordHash: true },
  });
  if (!user || !(await bcrypt.compare(parsed.data.currentPassword, user.passwordHash))) {
    return res.status(400).json({ error: "Current password is incorrect", code: "CURRENT_PASSWORD_INCORRECT" });
  }

  const passwordHash = await bcrypt.hash(parsed.data.newPassword, 12);
  const updated = await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash,
      mustChangePassword: false,
      passwordExpiresAt: null,
      tokenVersion: { increment: 1 },
    },
    select: lifecycleUserSelect,
  });
  await writeAudit(user.id, "PASSWORD_CHANGE", "user", user.id, { forced: req.user!.mustChangePassword });

  const token = signToken({ id: updated.id, tokenVersion: updated.tokenVersion });
  res.json({ token, user: presentUser(updated) });
});
