import { Router } from "express";
import { prisma } from "../db";
import { requireAuth, requireRoles } from "../middleware/auth";
import { writeAudit } from "../audit";
import { parseDateOnly } from "../utils/date";
import { getMaxDailyHours } from "../config";
import { canSubmitRetainedDraft, inactiveEmployeePayload, rejectionStatusForEmployee } from "../services/employeeEligibility";
import { assignableJobOrders, invalidJobOrderPayload } from "../services/jobOrderEligibility";

/**
 * Payroll employee manhour allocation (CR#2) — slot-based, parent day + slot rows.
 *
 * 4 shift slots per day (am1/am2/pm1/pm2, each 2h). Project is MANDATORY,
 * Work Order is OPTIONAL. OT is NOT applicable to payroll employees — no OT field,
 * and the daily cap (env-configured via MAX_DAILY_HOURS, default 8h) is strict
 * (no OT excess for payroll).
 *
 * Lifecycle: DRAFT (assigning slots) -> SUBMITTED (after "Submit for HOD approval")
 * -> HOD_APPROVED -> PM_APPROVED. Reject at any stage transitions to REJECTED.
 * Status-locked: when the parent day is SUBMITTED/APPROVED, slot edits are rejected
 * at the API. Staged approval: HOD approves SUBMITTED -> HOD_APPROVED; PM
 * (Project Planning) approves HOD_APPROVED -> PM_APPROVED.
 *
 * Owner + role: an employee allocates only to SELF via the linked Employee
 * (NOT_OWNER guard); only ADMIN may allocate for another employee.
 * `employeeId` is server-derived for self-service (never trusted from the body).
 */

export const employeeAllocationRouter = Router();

employeeAllocationRouter.use(requireAuth);

const VALID_SLOTS = new Set(["am1", "am2", "pm1", "pm2"]);
const SHIFT_HOURS: Record<string, number> = { am1: 2, am2: 2, pm1: 2, pm2: 2 };

async function employeeIdForUser(userId: number): Promise<number | null> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { employeeId: true } });
  return u?.employeeId ?? null;
}

/** GET /api/allocations?employeeId&date — list days + slots for the scope. */
employeeAllocationRouter.get("/", async (req, res) => {
  const role = req.user!.role;
  const userId = req.user!.id;
  const queryEmpId = req.query.employeeId ? Number(req.query.employeeId) : null;
  const queryDate = typeof req.query.date === "string" ? req.query.date : null;

  const where: Record<string, unknown> = {};
  if (queryEmpId) where.employeeId = queryEmpId;
  if (queryDate && /^\d{4}-\d{2}-\d{2}$/.test(queryDate)) {
    where.workDate = parseDateOnly(queryDate);
  }
  if (role !== "ADMIN") {
    const ownEmpId = await employeeIdForUser(userId);
    if (ownEmpId == null) {
      return res.json({ days: [], note: "No linked employee record for this account." });
    }
    where.employeeId = ownEmpId;
  }

  const days = await prisma.employeeAllocationDay.findMany({
    where,
    include: {
      allocations: {
        include: {
          project: { select: { id: true, name: true, colorKey: true } },
          jobOrder: { select: { id: true, code: true, name: true } },
          allocatedBy: { select: { id: true, name: true } },
        },
        orderBy: [{ shiftSlot: "asc" }],
      },
      employee: { select: { id: true, name: true, ecNo: true, grade: true, active: true, terminatedAt: true, department: true } },
    },
    orderBy: [{ workDate: "desc" }, { id: "desc" }],
    take: 200,
  });

  res.json({ days });
});

/** POST /api/allocations/slot — atomic upsert of one slot on the parent day. */
employeeAllocationRouter.post("/slot", async (req, res) => {
  const role = req.user!.role;
  const userId = req.user!.id;

  const { employeeId: bodyEmpId, workDate: bodyDate, shiftSlot, projectId: bodyProjectId, jobOrderId: bodyJobOrderId, remarks } = req.body ?? {};

  if (!bodyDate || !/^\d{4}-\d{2}-\d{2}$/.test(bodyDate)) {
    return res.status(400).json({ error: "workDate required (YYYY-MM-DD)" });
  }
  if (!shiftSlot || !VALID_SLOTS.has(shiftSlot)) {
    return res.status(400).json({ error: "shiftSlot must be one of am1, am2, pm1, pm2" });
  }
  if (!bodyProjectId) {
    return res.status(400).json({ error: "projectId is required" });
  }

  // Resolve employee server-side for every non-Admin caller. Approval roles
  // must use the approval endpoints and cannot edit another employee's draft.
  const canAllocateOthers = role === "ADMIN";
  let employeeId = bodyEmpId;
  if (!canAllocateOthers) {
    const ownEmpId = await employeeIdForUser(userId);
    if (ownEmpId == null) return res.status(403).json({ error: "No linked employee record for this account.", code: "NO_LINKED_EMPLOYEE" });
    if (employeeId != null && employeeId !== ownEmpId) {
      return res.status(403).json({ error: "You can only allocate hours to yourself.", code: "NOT_OWNER" });
    }
    employeeId = ownEmpId;
  }
  if (!employeeId) return res.status(400).json({ error: "employeeId is required" });

  const employee = await prisma.employee.findUnique({ where: { id: employeeId } });
  if (!employee) return res.status(400).json({ error: "Employee not found" });
  if (!employee.active) return res.status(409).json(inactiveEmployeePayload());

  const project = await prisma.project.findUnique({ where: { id: Number(bodyProjectId) } });
  if (!project) return res.status(400).json({ error: "Project not found" });
  if (bodyJobOrderId != null) {
    const jo = (await assignableJobOrders([Number(bodyJobOrderId)])).get(Number(bodyJobOrderId));
    if (!jo) return res.status(400).json(invalidJobOrderPayload());
    if (jo.projectId !== project.id) {
      return res.status(400).json({ error: "Work order does not belong to the selected project." });
    }
  }

  const wd = parseDateOnly(bodyDate);

  const result = await prisma.$transaction(async (tx) => {
    const day = await tx.employeeAllocationDay.upsert({
      where: { employeeId_workDate: { employeeId, workDate: wd } },
      create: {
        employeeId,
        workDate: wd,
        status: "DRAFT",
        remarks: remarks ?? null,
      },
      update: remarks != null ? { remarks } : {},
    });
    if (day.status !== "DRAFT" && day.status !== "REJECTED") {
      throw Object.assign(new Error("Day is locked (submitted/approved); slot edits rejected."), { code: "DAY_LOCKED" });
    }
    // Upsert the slot on this day.
    const slot = await tx.employeeAllocation.upsert({
      where: { allocationDayId_shiftSlot: { allocationDayId: day.id, shiftSlot } },
      create: {
        allocationDayId: day.id,
        employeeId,
        workDate: wd,
        shiftSlot,
        projectId: project.id,
        jobOrderId: bodyJobOrderId != null ? Number(bodyJobOrderId) : null,
        allocatedById: userId,
      },
      update: {
        projectId: project.id,
        jobOrderId: bodyJobOrderId != null ? Number(bodyJobOrderId) : null,
        allocatedById: userId,
      },
    });
    return { day, slot };
  }).catch((e) => {
    if (e.code === "DAY_LOCKED") return { __error: e };
    throw e;
  });

  if ("__error" in result) {
    return res.status(400).json({ error: result.__error.message, code: result.__error.code });
  }

  await writeAudit(userId, "EMPLOYEE_ALLOCATION_SLOT", "employee_allocation", result.slot.id, {
    employeeId, workDate: bodyDate, shiftSlot, projectId: project.id, jobOrderId: bodyJobOrderId ?? null,
  });
  res.status(201).json({ day: result.day, slot: result.slot });
});

/** DELETE /api/allocations/slot/:id — clear a single slot (only on DRAFT/REJECTED). */
employeeAllocationRouter.delete("/slot/:id", async (req, res) => {
  const id = Number(req.params.id);
  const role = req.user!.role;
  const userId = req.user!.id;

  const slot = await prisma.employeeAllocation.findUnique({ where: { id }, include: { allocationDay: true, employee: { select: { active: true } } } });
  if (!slot) return res.status(404).json({ error: "Slot not found" });
  if (!slot.employee.active) return res.status(409).json(inactiveEmployeePayload());

  const canDeleteOthers = role === "ADMIN";
  if (!canDeleteOthers) {
    const ownEmpId = await employeeIdForUser(userId);
    if (ownEmpId == null || ownEmpId !== slot.employeeId) {
      return res.status(403).json({ error: "You can only delete your own slots.", code: "NOT_OWNER" });
    }
  }
  if (slot.allocationDay.status !== "DRAFT" && slot.allocationDay.status !== "REJECTED") {
    return res.status(400).json({ error: "Day is locked (submitted/approved); slots cannot be removed.", code: "DAY_LOCKED" });
  }
  await prisma.employeeAllocation.delete({ where: { id } });
  await writeAudit(userId, "EMPLOYEE_ALLOCATION_SLOT_DELETE", "employee_allocation", id, {
    employeeId: slot.employeeId, workDate: slot.workDate.toISOString().slice(0, 10), shiftSlot: slot.shiftSlot,
  });
  res.json({ ok: true });
});

/** POST /api/allocations/submit — submit a day for HOD approval. */
employeeAllocationRouter.post("/submit", async (req, res) => {
  const role = req.user!.role;
  const userId = req.user!.id;

  const { employeeId: bodyEmpId, workDate: bodyDate, remarks } = req.body ?? {};
  if (!bodyDate || !/^\d{4}-\d{2}-\d{2}$/.test(bodyDate)) {
    return res.status(400).json({ error: "workDate required" });
  }

  const canSubmitOthers = role === "ADMIN";
  let employeeId = bodyEmpId;
  if (!canSubmitOthers) {
    const ownEmpId = await employeeIdForUser(userId);
    if (ownEmpId == null) return res.status(403).json({ error: "No linked employee record for this account.", code: "NO_LINKED_EMPLOYEE" });
    if (employeeId != null && employeeId !== ownEmpId) {
      return res.status(403).json({ error: "You can only submit your own allocations.", code: "NOT_OWNER" });
    }
    employeeId = ownEmpId;
  }
  if (!employeeId) return res.status(400).json({ error: "employeeId is required" });

  const wd = parseDateOnly(bodyDate);

  const day = await prisma.employeeAllocationDay.findUnique({
    where: { employeeId_workDate: { employeeId, workDate: wd } },
    include: { allocations: true, employee: { select: { active: true, terminatedAt: true } } },
  });
  if (!day || day.allocations.length === 0) {
    return res.status(400).json({ error: "No slots assigned for this day." });
  }
  if (!day.employee.active && !canSubmitRetainedDraft(day.employee, day)) {
    return res.status(409).json(inactiveEmployeePayload());
  }
  if (day.status !== "DRAFT" && day.status !== "REJECTED") {
    return res.status(400).json({ error: `Day is already ${day.status}; cannot submit.` });
  }

  // Compute total hours (slot count * 2h) — must be ≤ MAX_DAILY_HOURS (default 8).
  // Payroll: no OT, so strictly ≤ cap; over-allocation is rejected.
  const maxDailyHours = getMaxDailyHours();
  const totalHours = day.allocations.length * 2;
  if (totalHours > maxDailyHours) {
    return res.status(400).json({
      error: `Daily total ${totalHours}h exceeds the ${maxDailyHours}h cap for payroll (no OT allowed).`,
      code: "OVERALLOCATION",
    });
  }

  const updated = await prisma.employeeAllocationDay.update({
    where: { id: day.id },
    data: { status: "SUBMITTED", submittedAt: new Date(), remarks: remarks ?? day.remarks },
  });
  await writeAudit(userId, "EMPLOYEE_ALLOCATION_SUBMIT", "employee_allocation_day", day.id, {
    employeeId, workDate: bodyDate, slotCount: day.allocations.length,
  });
  res.json({ day: updated });
});

/** GET /api/allocations/pending — role-aware, department-scoped approval queue.
 *   HOD: SUBMITTED days in their own department.
 *   PM: HOD_APPROVED days across all departments (PM is a single central authority).
 *   ADMIN: both stages, all departments.
 *   HR: read-only on their own department (no approve/reject unless explicitly intended).
 * Null department fails closed: HOD/HR with departmentId=null see an empty queue.
 */
employeeAllocationRouter.get("/pending", requireRoles("HOD", "PM", "ADMIN", "HR"), async (req, res) => {
  const role = req.user!.role;
  const departmentId = req.user!.departmentId;

  // Role-aware status filter (strict per-stage):
  //   HOD: SUBMITTED only (their queue; HOD_APPROVED has already moved to PM).
  //   PM: HOD_APPROVED only (waiting for PM final approval).
  //   ADMIN/HR: both stages for visibility (HR is read-only — approve/reject is
  //   stage-scoped on the mutation endpoints).
  const statuses =
    role === "HOD" ? ["SUBMITTED"] :
    role === "PM" ? ["HOD_APPROVED"] :
    ["SUBMITTED", "HOD_APPROVED"];
  const where: Record<string, unknown> = { status: { in: statuses } };

  // Department scope for HOD and HR; PM/ADMIN are global.
  if (role === "HOD" || role === "HR") {
    if (departmentId == null) {
      // Fail closed: a department-less HOD/HR sees nothing rather than all records.
      return res.json({ days: [] });
    }
    where.employee = { departmentId };
  }
  // PM, ADMIN: no department filter.

  const days = await prisma.employeeAllocationDay.findMany({
    where,
    include: {
      employee: { include: { department: true } },
      allocations: {
        include: {
          project: { select: { id: true, name: true, colorKey: true } },
          jobOrder: { select: { id: true, code: true, name: true } },
        },
      },
    },
    orderBy: [{ submittedAt: "asc" }],
  });
  res.json({ days });
});

/** Immutable payroll/My Hours decisions made by the logged-in approver. */
employeeAllocationRouter.get("/history", requireRoles("HOD", "PM", "ADMIN"), async (req, res) => {
  const approvals = await prisma.employeeAllocationApproval.findMany({
    where: { approverId: req.user!.id },
    include: {
      allocationDay: {
        include: {
          employee: { include: { department: true } },
          allocations: { include: { project: true, jobOrder: true } },
        },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  res.json({ approvals });
});

/**
 * POST /api/allocations/:dayId/approve — staged approval, role + department guarded.
 *   HOD/ADMIN approves SUBMITTED -> HOD_APPROVED (within own department for HOD).
 *   PM/ADMIN approves HOD_APPROVED -> PM_APPROVED (PM is global).
 *   Wrong-stage role or cross-department HOD attempts return 403 (FORBIDDEN/WRONG_STAGE).
 *   Null department fails closed.
 */
employeeAllocationRouter.post("/:dayId/approve", requireRoles("HOD", "PM", "ADMIN", "HR"), async (req, res) => {
  const dayId = Number(req.params.dayId);
  const userId = req.user!.id;
  const role = req.user!.role;
  const departmentId = req.user!.departmentId;
  const day = await prisma.employeeAllocationDay.findUnique({
    where: { id: dayId },
    include: { employee: { select: { departmentId: true, active: true } } },
  });
  if (!day) return res.status(404).json({ error: "Day not found" });

  // Department isolation for HOD: must match the day's employee department.
  if (role === "HOD") {
    if (departmentId == null) {
      return res.status(403).json({ error: "HOD has no department assigned.", code: "FORBIDDEN" });
    }
    if (day.employee.departmentId !== departmentId) {
      return res.status(403).json({ error: "Day belongs to another department.", code: "FORBIDDEN" });
    }
  }

  // Staged transitions: HOD -> SUBMITTED->HOD_APPROVED, PM -> HOD_APPROVED->PM_APPROVED.
  let nextStatus: string | null = null;
  if (day.status === "SUBMITTED") {
    if (role !== "HOD" && role !== "ADMIN") {
      return res.status(403).json({ error: "Only HOD/ADMIN can approve a SUBMITTED day.", code: "WRONG_STAGE" });
    }
    nextStatus = "HOD_APPROVED";
  } else if (day.status === "HOD_APPROVED") {
    if (role !== "PM" && role !== "ADMIN") {
      return res.status(403).json({ error: "Only PM/ADMIN can advance HOD_APPROVED to PM_APPROVED.", code: "WRONG_STAGE" });
    }
    nextStatus = "PM_APPROVED";
  } else {
    return res.status(400).json({ error: `Day status is ${day.status}; cannot approve.` });
  }

  const comment = typeof req.body?.comment === "string" ? req.body.comment.trim() || null : null;
  const updated = await prisma.$transaction(async (tx) => {
    const saved = await tx.employeeAllocationDay.update({
      where: { id: dayId },
      data: { status: nextStatus!, approvedAt: new Date(), approverId: userId },
    });
    await tx.employeeAllocationApproval.create({
      data: { allocationDayId: dayId, approverId: userId, action: "APPROVE", comment, resultingStatus: nextStatus! },
    });
    return saved;
  });
  await writeAudit(userId, "EMPLOYEE_ALLOCATION_APPROVE", "employee_allocation_day", dayId, {
    employeeId: day.employeeId, workDate: day.workDate.toISOString().slice(0, 10), from: day.status, to: nextStatus,
  });
  res.json({ day: updated });
});

/**
 * POST /api/allocations/:dayId/reject — stage-scoped, role + department guarded.
 *   HOD rejects SUBMITTED only (within own department).
 *   PM rejects HOD_APPROVED only (global).
 *   ADMIN may reject either stage.
 *   HR is not allowed to reject (it's listed in requireRoles above for read-only
 *   consistency, but the per-stage check below rejects HR attempts on either stage).
 *   Null department fails closed.
 */
employeeAllocationRouter.post("/:dayId/reject", requireRoles("HOD", "PM", "ADMIN", "HR"), async (req, res) => {
  const dayId = Number(req.params.dayId);
  const userId = req.user!.id;
  const role = req.user!.role;
  const departmentId = req.user!.departmentId;
  const comment = typeof req.body?.comment === "string" ? req.body.comment : null;

  const day = await prisma.employeeAllocationDay.findUnique({
    where: { id: dayId },
    include: { employee: { select: { departmentId: true, active: true } } },
  });
  if (!day) return res.status(404).json({ error: "Day not found" });
  if (day.status !== "SUBMITTED" && day.status !== "HOD_APPROVED") {
    return res.status(400).json({ error: `Day status is ${day.status}; cannot reject.` });
  }

  // Department isolation for HOD.
  if (role === "HOD") {
    if (departmentId == null) {
      return res.status(403).json({ error: "HOD has no department assigned.", code: "FORBIDDEN" });
    }
    if (day.employee.departmentId !== departmentId) {
      return res.status(403).json({ error: "Day belongs to another department.", code: "FORBIDDEN" });
    }
  }

  // Stage-scoped reject: HOD can only reject SUBMITTED, PM can only reject HOD_APPROVED.
  // HR cannot reject at any stage (read-only on this lifecycle).
  if (day.status === "SUBMITTED") {
    if (role !== "HOD" && role !== "ADMIN") {
      return res.status(403).json({ error: "Only HOD/ADMIN can reject a SUBMITTED day.", code: "WRONG_STAGE" });
    }
  } else if (day.status === "HOD_APPROVED") {
    if (role !== "PM" && role !== "ADMIN") {
      return res.status(403).json({ error: "Only PM/ADMIN can reject a HOD_APPROVED day.", code: "WRONG_STAGE" });
    }
  }

  const resultingStatus = rejectionStatusForEmployee(day.employee.active);
  const updated = await prisma.$transaction(async (tx) => {
    const saved = await tx.employeeAllocationDay.update({
      where: { id: dayId },
      data: { status: resultingStatus, approverId: userId, remarks: comment ?? day.remarks },
    });
    await tx.employeeAllocationApproval.create({
      data: { allocationDayId: dayId, approverId: userId, action: "REJECT", comment, resultingStatus },
    });
    return saved;
  });
  await writeAudit(userId, "EMPLOYEE_ALLOCATION_REJECT", "employee_allocation_day", dayId, {
    employeeId: day.employeeId, workDate: day.workDate.toISOString().slice(0, 10), from: day.status, comment,
  });
  res.json({ day: updated });
});
