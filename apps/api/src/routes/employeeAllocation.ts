import { Router } from "express";
import { prisma } from "../db";
import { requireAuth, requireRoles } from "../middleware/auth";
import { writeAudit } from "../audit";
import { parseDateOnly } from "../utils/date";

/**
 * Payroll employee manhour allocation (CR#2).
 *
 * Project is MANDATORY; Work Order is OPTIONAL (unlike contract-worker timesheets
 * where WO is required). OT is NOT applicable to payroll employees — this model has
 * no OT field, so OT is structurally impossible here.
 *
 * Owner + role enforcement:
 *   - An employee allocates only to SELF (403 NOT_OWNER if employeeId !== req.user's
 *     linked employee).
 *   - HOD / Project Planning allocate for others via requireRoles("HOD","PM","ADMIN").
 *
 * The `employeeId` is server-derived from the authenticated user (via the User<->Employee
 * link) for the self-service path — never trusted from the client without the role check.
 */

export const employeeAllocationRouter = Router();

employeeAllocationRouter.use(requireAuth);

/** Derive the Employee id linked to an authenticated User, if any. */
async function employeeIdForUser(userId: number): Promise<number | null> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { employeeId: true } });
  return u?.employeeId ?? null;
}

/** List allocations — owner sees their own; HOD/PM/ADMIN see department-scoped or all. */
employeeAllocationRouter.get("/", async (req, res) => {
  const role = req.user!.role;
  const userId = req.user!.id;
  const departmentId = req.user!.departmentId;

  const where: Record<string, unknown> = {};
  // Non-approver accounts (supervisors, and any payroll employee with a login) see
  // only their own allocations; approvers see department-scoped or org-wide.
  if (!["HOD", "PM", "ADMIN", "HR"].includes(role)) {
    const empId = await employeeIdForUser(userId);
    if (empId == null) {
      return res.json({ allocations: [], error: null, note: "No linked employee record for this account." });
    }
    where.employeeId = empId;
  } else if (role === "HOD" && departmentId != null) {
    // HOD sees allocations for their department's employees.
    where.employee = { departmentId };
  }
  // ADMIN / PM without the role filter see all (organization scope).

  const allocations = await prisma.employeeAllocation.findMany({
    where,
    include: {
      employee: { select: { id: true, name: true, ecNo: true, grade: true, department: true } },
      project: { select: { id: true, name: true, colorKey: true } },
      jobOrder: { select: { id: true, code: true, name: true } },
      allocatedBy: { select: { id: true, name: true } },
    },
    orderBy: [{ workDate: "desc" }, { id: "desc" }],
    take: 200,
  });

  res.json({ allocations });
});

/**
 * Create/update an employee's manhour allocation for a date.
 * Employee self-service: employeeId must equal the caller's linked Employee (NOT_OWNER).
 * HOD/PM/ADMIN may allocate for any employee (role-gated).
 */
employeeAllocationRouter.put("/", async (req, res) => {
  const role = req.user!.role;
  const userId = req.user!.id;
  const { employeeId, workDate, projectId, jobOrderId } = req.body ?? {};

  const parsedEmpId = Number(employeeId);
  const parsedDate = typeof workDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(workDate) ? workDate : null;
  const parsedProjectId = Number(projectId);
  const parsedJobOrderId = jobOrderId == null ? null : Number(jobOrderId);

  if (!parsedEmpId || !parsedDate || !parsedProjectId) {
    return res.status(400).json({ error: "employeeId, workDate and projectId are required" });
  }

  // Owner / role enforcement:
  const canAllocateOthers = ["HOD", "PM", "ADMIN", "HR"].includes(role);
  if (!canAllocateOthers) {
    // Employee self-service: only allocate to self via linked Employee.
    const ownEmpId = await employeeIdForUser(userId);
    if (ownEmpId == null || ownEmpId !== parsedEmpId) {
      return res.status(403).json({ error: "You can only allocate hours to yourself.", code: "NOT_OWNER" });
    }
  }

  // Validate the employee exists and is active.
  const employee = await prisma.employee.findUnique({ where: { id: parsedEmpId } });
  if (!employee) return res.status(400).json({ error: "Employee not found." });
  if (!employee.active) return res.status(400).json({ error: "Employee is not active.", code: "EMPLOYEE_INACTIVE" });

  // Project is mandatory and must exist.
  const project = await prisma.project.findUnique({ where: { id: parsedProjectId } });
  if (!project) return res.status(400).json({ error: "Project not found." });

  // Work Order is OPTIONAL; if provided, must exist and belong to the project.
  if (parsedJobOrderId != null) {
    const jo = await prisma.jobOrder.findUnique({ where: { id: parsedJobOrderId } });
    if (!jo) return res.status(400).json({ error: "Work order not found." });
    if (jo.projectId !== parsedProjectId) {
      return res.status(400).json({ error: "Work order does not belong to the selected project." });
    }
  }

  const wd = parseDateOnly(parsedDate);

  // Find-or-update on the allocation's natural key (employee, date, project, allocator).
  // Project is the mandatory unit; jobOrderId is an optional attribute that updates on
  // collision. The unique constraint covers these four, NOT jobOrderId.
  const existing = await prisma.employeeAllocation.findFirst({
    where: {
      employeeId: parsedEmpId,
      workDate: wd,
      projectId: parsedProjectId,
      allocatedById: userId,
    },
  });

  let allocation;
  if (existing) {
    allocation = await prisma.employeeAllocation.update({
      where: { id: existing.id },
      data: { status: "DRAFT", jobOrderId: parsedJobOrderId },
    });
  } else {
    allocation = await prisma.employeeAllocation.create({
      data: {
        employeeId: parsedEmpId,
        workDate: wd,
        projectId: parsedProjectId,
        jobOrderId: parsedJobOrderId,
        allocatedById: userId,
        status: "DRAFT",
      },
    });
  }

  await writeAudit(userId, "EMPLOYEE_ALLOCATION", "employee_allocation", allocation.id, {
    employeeId: parsedEmpId,
    workDate: parsedDate,
    projectId: parsedProjectId,
    jobOrderId: parsedJobOrderId,
  });

  res.status(201).json({ allocation });
});

/** Delete an allocation — owner deletes own; HOD/PM/ADMIN/HR delete scoped. */
employeeAllocationRouter.delete("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const role = req.user!.role;
  const userId = req.user!.id;

  const allocation = await prisma.employeeAllocation.findUnique({ where: { id } });
  if (!allocation) return res.status(404).json({ error: "Allocation not found" });

  const canDeleteOthers = ["HOD", "PM", "ADMIN", "HR"].includes(role);
  if (!canDeleteOthers) {
    const ownEmpId = await employeeIdForUser(userId);
    if (ownEmpId == null || ownEmpId !== allocation.employeeId) {
      return res.status(403).json({ error: "You can only delete your own allocations.", code: "NOT_OWNER" });
    }
  }

  await prisma.employeeAllocation.delete({ where: { id } });
  await writeAudit(userId, "EMPLOYEE_ALLOCATION_DELETE", "employee_allocation", id, {
    employeeId: allocation.employeeId,
  });
  res.json({ ok: true });
});
