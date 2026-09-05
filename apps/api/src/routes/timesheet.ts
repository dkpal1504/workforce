import { Router } from "express";
import { SHIFT_SLOTS, bulkAssignSchema, setSlotJobOrderSchema, timesheetDaySchema } from "@workforce/shared";
import type { ShiftSlot } from "@workforce/shared";
import { prisma } from "../db";
import { requireAuth } from "../middleware/auth";
import { writeAudit } from "../audit";
import { parseDateOnly } from "../utils/date";
import { getMaxDailyHours } from "../config";
import { getEmployeeDayHourTotals } from "../services/hours";
import { isApprovedStatus, isProtectedEntryStatus, resolveEditLock } from "../services/timesheetEditLock";

export const timesheetRouter = Router();

timesheetRouter.use(requireAuth);

const RETURN_ACTIONS = ["REJECT", "SEND_BACK", "PLANNING_RETURN"];

type ShiftSlotRow = {
  shiftSlot: ShiftSlot;
  jobOrderId: number | null;
  /** Convenience fields flattened from the jobOrder relation. */
  projectId: number | null;
  projectColorKey: string | null;
  projectName: string | null;
  jobOrderCode: string | null;
  jobOrderName: string | null;
  projectWbsCode: string | null;
  /** Entry row id (for per-slot edit) — null if no row yet. */
  entryId: number | null;
  status: string | null;
  locked: boolean;
};

function buildShiftRows(
  entries: {
    id: number;
    shiftSlot: string | null;
    jobOrderId: number | null;
    projectWbsId: number | null;
    status: string;
    jobOrder: {
      id: number;
      code: string;
      name: string;
      project: { id: number; name: string; colorKey: string };
      projectWbs: { id: number; wbsCode: string } | null;
    } | null;
    projectWbs: { id: number; wbsCode: string; name: string; colorKey: string } | null;
  }[]
): ShiftSlotRow[] {
  const byShift = new Map<string, (typeof entries)[number]>();
  for (const e of entries) {
    if (!e.shiftSlot) continue;
    byShift.set(e.shiftSlot, e);
  }
  return SHIFT_SLOTS.map((shiftSlot) => {
    const e = byShift.get(shiftSlot);
    if (!e) {
      return {
        shiftSlot,
        jobOrderId: null,
        projectId: null,
        projectColorKey: null,
        projectName: null,
        jobOrderCode: null,
        jobOrderName: null,
        projectWbsCode: null,
        entryId: null,
        status: null,
        locked: false,
      };
    }
    // Prefer the JobOrder relation (new model); fall back to legacy ProjectWbs.
    const jo = e.jobOrder;
    const pw = e.projectWbs;
    return {
      shiftSlot,
      jobOrderId: e.jobOrderId,
      projectId: jo?.project.id ?? null,
      projectColorKey: jo?.project.colorKey ?? pw?.colorKey ?? null,
      projectName: jo?.project.name ?? pw?.name ?? null,
      jobOrderCode: jo?.code ?? null,
      jobOrderName: jo?.name ?? null,
      projectWbsCode: jo?.projectWbs?.wbsCode ?? pw?.wbsCode ?? null,
      entryId: e.id,
      status: e.status,
      locked: e.projectWbsId != null && e.jobOrderId != null && isProtectedEntryStatus(e.status),
    };
  });
}

timesheetRouter.get("/", async (req, res) => {
  const supervisorId = Number(req.query.supervisor_id);
  const dateStr = String(req.query.date || "");
  if (!supervisorId || !dateStr) {
    return res.status(400).json({ error: "supervisor_id and date required" });
  }
  const workDate = parseDateOnly(dateStr);
  const maxDailyHours = getMaxDailyHours();

  const team = await prisma.dailyTeamSelection.findMany({
    where: { supervisorId, workDate, removedAt: null },
    include: { employee: { include: { department: true } } },
    orderBy: { createdAt: "asc" },
  });

  const days = await prisma.timesheetDay.findMany({
    where: { taggedById: supervisorId, workDate },
    include: {
      entries: {
        include: {
          projectWbs: true,
          jobOrder: { include: { project: true, projectWbs: true } },
        },
      },
      employee: true,
      approvals: {
        include: { approver: { select: { id: true, name: true, role: true } } },
        orderBy: { createdAt: "desc" },
        take: 20,
      },
    },
  });
  const dayByEmployee = new Map(days.map((d) => [d.employeeId, d]));

  const employeeIds = team.map((t) => t.employeeId);
  const dayTotals = await getEmployeeDayHourTotals(employeeIds, workDate, supervisorId);

  // Active projects + their job orders, for the Bulk Assignment block + per-row Allocation.
  const projects = await prisma.project.findMany({
    where: { active: true },
    orderBy: { sortOrder: "asc" },
    include: {
      jobOrders: {
        where: { status: { in: ["active"] } },
        orderBy: { code: "asc" },
      },
    },
  });

  // Build per-employee rows: 4 shift slots + derived totals + edit-lock info.
  const rows = team.map((t) => {
    const day = dayByEmployee.get(t.employeeId);
    const slots = buildShiftRows(day?.entries ?? []);
    const filledSlots = slots.filter((s) => s.jobOrderId != null).length;
    const otherSlots = dayTotals.get(t.employeeId)?.otherSlots ?? [];
    const otherHours = dayTotals.get(t.employeeId)?.otherHours ?? 0;
    // Day total = filled shift slots (this supervisor) + distinct hour slots tagged by other supervisors.
    const dayTotalHours = filledSlots + otherHours;
    const exceedsLimit = dayTotalHours > maxDailyHours;
    const latestReturn = day?.approvals?.find((a) => RETURN_ACTIONS.includes(a.action)) ?? null;
    const latestApprove = day?.approvals?.find((a) => a.action === "APPROVE") ?? null;
    const status = day?.status ?? "DRAFT";
    const hasProtectedEntries = Boolean(
      day?.entries?.some(
        (e) => (e.projectWbsId != null || e.jobOrderId != null) && isProtectedEntryStatus(e.status)
      )
    );
    const lock = resolveEditLock(status, latestApprove?.createdAt ?? day?.updatedAt ?? null, {
      hasProtectedEntries,
    });

    return {
      employeeId: t.employeeId,
      employee: t.employee,
      remarks: day?.remarks ?? "",
      status,
      slots,
      filledSlots,
      filled: filledSlots > 0,
      fullShiftDone: filledSlots === SHIFT_SLOTS.length,
      otherHours,
      otherSlots,
      dayTotalHours,
      exceedsLimit,
      remarksRequired: exceedsLimit && filledSlots > 0,
      editMode: lock.editMode,
      approvedAt: lock.approvedAt,
      lockExpiresAt: lock.lockExpiresAt,
      returnFeedback: latestReturn
        ? {
            action: latestReturn.action,
            comment: latestReturn.comment,
            at: latestReturn.createdAt.toISOString(),
            by: latestReturn.approver.name,
            role: latestReturn.approver.role,
          }
        : null,
    };
  });

  const filledCount = rows.filter((r) => r.filledSlots > 0).length;
  const rejectedCount = rows.filter((r) => r.status === "REJECTED").length;

  const openReturns = await prisma.timesheetDay.findMany({
    where: { taggedById: supervisorId, status: "REJECTED" },
    include: {
      employee: { select: { id: true, name: true, ecNo: true } },
      approvals: {
        where: { action: { in: ["REJECT", "SEND_BACK"] } },
        include: { approver: { select: { name: true, role: true } } },
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
    orderBy: { updatedAt: "desc" },
    take: 50,
  });

  res.json({
    rows,
    filled: filledCount,
    total: rows.length,
    rejectedCount,
    projects: projects.map((p) => ({
      id: p.id,
      code: p.code,
      name: p.name,
      colorKey: p.colorKey,
      jobOrders: p.jobOrders.map((j) => ({
        id: j.id,
        code: j.code,
        name: j.name,
        status: j.status,
        budgetedHours: j.budgetedHours,
      })),
    })),
    maxDailyHours,
    openReturns: openReturns.map((d) => {
      const feedback = d.approvals[0];
      return {
        id: d.id,
        workDate: d.workDate.toISOString().slice(0, 10),
        employee: d.employee,
        remarks: d.remarks,
        feedback: feedback
          ? {
              action: feedback.action,
              comment: feedback.comment,
              at: feedback.createdAt.toISOString(),
              by: feedback.approver.name,
              role: feedback.approver.role,
            }
          : null,
      };
    }),
  });
});

timesheetRouter.put("/day", async (req, res) => {
  const parsed = timesheetDaySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const { supervisorId, workDate: dateStr, rows } = parsed.data;
  // Owner enforcement: only the timesheet's owner supervisor may edit it.
  if (supervisorId !== req.user!.id) {
    return res.status(403).json({ error: "You can only edit your own timesheet.", code: "NOT_OWNER" });
  }
  const workDate = parseDateOnly(dateStr);

  const lockViolations: { employeeId: number; error: string }[] = [];

  for (const row of rows) {
    const existing = await prisma.timesheetDay.findUnique({
      where: {
        employeeId_workDate_taggedById: {
          employeeId: row.employeeId,
          workDate,
          taggedById: supervisorId,
        },
      },
      include: {
        entries: true,
        approvals: {
          where: { action: "APPROVE" },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
    });

    const status = existing?.status ?? "DRAFT";
    const hasProtectedEntries = Boolean(
      existing?.entries?.some(
        (e) =>
          (e.projectWbsId != null || e.jobOrderId != null) && isProtectedEntryStatus(e.status)
      )
    );
    const lock = resolveEditLock(status, existing?.approvals[0]?.createdAt ?? existing?.updatedAt ?? null, {
      hasProtectedEntries,
    });

    if (lock.editMode === "locked") {
      lockViolations.push({
        employeeId: row.employeeId,
        error: "Timesheet is HOD/Project Head approved and the 24-hour add window has expired. Only HOD reject unlocks it.",
      });
      continue;
    }

    if (lock.editMode === "addOnly" && existing) {
      const existingBySlot = new Map(
        existing.entries.filter((e) => e.shiftSlot != null).map((e) => [e.shiftSlot as string, e])
      );
      for (const s of row.slots) {
        const prev = existingBySlot.get(s.shiftSlot);
        const isProtected = prev && (prev.projectWbsId != null || prev.jobOrderId != null) && isProtectedEntryStatus(prev.status);
        if (isProtected) {
          if (s.jobOrderId == null || s.jobOrderId !== prev.jobOrderId) {
            lockViolations.push({
              employeeId: row.employeeId,
              error:
                "Cannot clear or change shift slots already approved by HOD/Project Head. You may only fill empty slots (or fix rejected new slots).",
            });
            break;
          }
        } else if (isApprovedStatus(status) && prev && (prev.projectWbsId != null || prev.jobOrderId != null)) {
          if (s.jobOrderId == null || s.jobOrderId !== prev.jobOrderId) {
            lockViolations.push({
              employeeId: row.employeeId,
              error:
                "Cannot clear or change shift slots already saved after HOD/Project Head approval. You may only fill empty slots within 24 hours.",
            });
            break;
          }
        }
      }
      if (lockViolations.some((v) => v.employeeId === row.employeeId)) continue;

      await prisma.timesheetDay.update({
        where: { id: existing.id },
        data: { remarks: row.remarks ?? null },
      });

      for (const s of row.slots) {
        const prev = existingBySlot.get(s.shiftSlot);
        if (prev && (prev.projectWbsId != null || prev.jobOrderId != null) && isProtectedEntryStatus(prev.status)) continue;

        if (isApprovedStatus(status)) {
          // Only add into empty slots
          if (prev && (prev.projectWbsId != null || prev.jobOrderId != null)) continue;
          if (s.jobOrderId == null) continue;
          await prisma.timesheetEntry.upsert({
            where: {
              timesheet_entry_shiftSlot_unique: {
                employeeId: row.employeeId,
                workDate,
                shiftSlot: s.shiftSlot,
                taggedById: supervisorId,
              },
            },
            create: {
              timesheetDayId: existing.id,
              employeeId: row.employeeId,
              workDate,
              shiftSlot: s.shiftSlot,
              hourSlot: null,
              jobOrderId: s.jobOrderId,
              taggedById: supervisorId,
              status: "DRAFT",
            },
            update: {
              jobOrderId: s.jobOrderId,
              timesheetDayId: existing.id,
              status: "DRAFT",
            },
          });
          continue;
        }

        // REJECTED with protected slots: edit/clear non-protected freely
        if (s.jobOrderId == null) {
          if (prev) {
            await prisma.timesheetEntry.deleteMany({ where: { id: prev.id } });
          }
        } else {
          await prisma.timesheetEntry.upsert({
            where: {
              timesheet_entry_shiftSlot_unique: {
                employeeId: row.employeeId,
                workDate,
                shiftSlot: s.shiftSlot,
                taggedById: supervisorId,
              },
            },
            create: {
              timesheetDayId: existing.id,
              employeeId: row.employeeId,
              workDate,
              shiftSlot: s.shiftSlot,
              hourSlot: null,
              jobOrderId: s.jobOrderId,
              taggedById: supervisorId,
              status: "DRAFT",
            },
            update: {
              jobOrderId: s.jobOrderId,
              timesheetDayId: existing.id,
              status: "DRAFT",
            },
          });
        }
      }
      continue;
    }

    // Full edit (DRAFT / REJECTED / SUBMITTED / new)
    const day = await prisma.timesheetDay.upsert({
      where: {
        employeeId_workDate_taggedById: {
          employeeId: row.employeeId,
          workDate,
          taggedById: supervisorId,
        },
      },
      create: {
        employeeId: row.employeeId,
        workDate,
        taggedById: supervisorId,
        status: "DRAFT",
        remarks: row.remarks ?? null,
      },
      update: {
        remarks: row.remarks ?? null,
        status: isApprovedStatus(status) ? status : "DRAFT",
      },
    });

    if (!isApprovedStatus(status) && day.status !== "DRAFT") {
      await prisma.timesheetDay.update({ where: { id: day.id }, data: { status: "DRAFT" } });
    }

    for (const s of row.slots) {
      if (s.jobOrderId == null) {
        await prisma.timesheetEntry.deleteMany({
          where: { timesheetDayId: day.id, shiftSlot: s.shiftSlot },
        });
      } else {
        await prisma.timesheetEntry.upsert({
          where: {
            timesheet_entry_shiftSlot_unique: {
              employeeId: row.employeeId,
              workDate,
              shiftSlot: s.shiftSlot,
              taggedById: supervisorId,
            },
          },
          create: {
            timesheetDayId: day.id,
            employeeId: row.employeeId,
            workDate,
            shiftSlot: s.shiftSlot,
            hourSlot: null,
            jobOrderId: s.jobOrderId,
            taggedById: supervisorId,
            status: "DRAFT",
          },
          update: {
            jobOrderId: s.jobOrderId,
            timesheetDayId: day.id,
            status: "DRAFT",
          },
        });
      }
    }
  }

  if (lockViolations.length) {
    return res.status(400).json({
      error: lockViolations.map((v) => v.error).join(" "),
      code: "TIMESHEET_EDIT_LOCKED",
      violations: lockViolations,
    });
  }

  await writeAudit(req.user!.id, "TIMESHEET_SAVE_DRAFT", "timesheet_day", dateStr, {
    supervisorId,
    rowCount: rows.length,
  });

  const employeeIds = rows.map((r) => r.employeeId);
  const dayTotals = await getEmployeeDayHourTotals(employeeIds, workDate, supervisorId);
  const maxDailyHours = getMaxDailyHours();
  const warnings = rows
    .map((r) => {
      const localFilled = r.slots.filter((s) => s.jobOrderId != null).length;
      if (!localFilled) return null;
      const otherHours = dayTotals.get(r.employeeId)?.otherHours ?? 0;
      const total = localFilled + otherHours;
      if (total <= maxDailyHours) return null;
      return {
        employeeId: r.employeeId,
        dayTotalHours: total,
        maxDailyHours,
        remarksPresent: Boolean(r.remarks?.trim()),
      };
    })
    .filter(Boolean);

  res.json({ ok: true, maxDailyHours, warnings });
});

/**
 * Bulk-assign a single (projectId, jobOrderId) to a set of (employeeId, shiftSlot)
 * pairs in one supervisor-day. Used by the Daily Timesheet Entry "Bulk Assignment"
 * block. Honours the same edit-lock rules as PUT /day.
 */
timesheetRouter.post("/bulk-assign", async (req, res) => {
  const parsed = bulkAssignSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const { supervisorId, workDate: dateStr, projectId, jobOrderId, slots } = parsed.data;
  // Owner enforcement: only the timesheet's owner supervisor may edit it.
  if (supervisorId !== req.user!.id) {
    return res.status(403).json({ error: "You can only edit your own timesheet.", code: "NOT_OWNER" });
  }
  const workDate = parseDateOnly(dateStr);

  // Validate the JobOrder belongs to the Project.
  const jo = await prisma.jobOrder.findUnique({
    where: { id: jobOrderId },
    include: { project: true },
  });
  if (!jo || jo.projectId !== projectId) {
    return res.status(400).json({ error: "JobOrder does not belong to the selected project" });
  }

  // Group slots by employee for edit-lock check + day upsert.
  const byEmployee = new Map<number, ShiftSlot[]>();
  for (const s of slots) {
    const list = byEmployee.get(s.employeeId) ?? [];
    list.push(s.shiftSlot);
    byEmployee.set(s.employeeId, list);
  }

  const lockViolations: { employeeId: number; error: string }[] = [];
  let taggedSlots = 0;
  let taggedEmployees = 0;

  for (const [employeeId, shiftSlots] of byEmployee) {
    const existing = await prisma.timesheetDay.findUnique({
      where: {
        employeeId_workDate_taggedById: {
          employeeId,
          workDate,
          taggedById: supervisorId,
        },
      },
      include: { entries: true, approvals: { where: { action: "APPROVE" }, take: 1, orderBy: { createdAt: "desc" } } },
    });
    const status = existing?.status ?? "DRAFT";
    const hasProtected = Boolean(
      existing?.entries?.some(
        (e) => (e.projectWbsId != null || e.jobOrderId != null) && isProtectedEntryStatus(e.status)
      )
    );
    const lock = resolveEditLock(status, existing?.approvals[0]?.createdAt ?? existing?.updatedAt ?? null, { hasProtectedEntries: hasProtected });
    if (lock.editMode === "locked") {
      lockViolations.push({
        employeeId,
        error: "Timesheet is HOD/Project Head approved and the 24-hour add window has expired.",
      });
      continue;
    }

    const day = await prisma.timesheetDay.upsert({
      where: {
        employeeId_workDate_taggedById: { employeeId, workDate, taggedById: supervisorId },
      },
      create: { employeeId, workDate, taggedById: supervisorId, status: "DRAFT", remarks: null },
      update: { status: isApprovedStatus(status) ? status : "DRAFT" },
    });

    for (const shiftSlot of shiftSlots) {
      await prisma.timesheetEntry.upsert({
        where: {
          timesheet_entry_shiftSlot_unique: {
            employeeId,
            workDate,
            shiftSlot,
            taggedById: supervisorId,
          },
        },
        create: {
          timesheetDayId: day.id,
          employeeId,
          workDate,
          shiftSlot,
          hourSlot: null,
          jobOrderId,
          taggedById: supervisorId,
          status: "DRAFT",
        },
        update: {
          jobOrderId,
          timesheetDayId: day.id,
          status: "DRAFT",
        },
      });
      taggedSlots += 1;
    }
    taggedEmployees += 1;
  }

  if (lockViolations.length) {
    return res.status(400).json({ error: lockViolations.map((v) => v.error).join(" "), violations: lockViolations });
  }

  await writeAudit(req.user!.id, "TIMESHEET_BULK_ASSIGN", "timesheet_day", dateStr, {
    supervisorId,
    projectId,
    jobOrderId,
    taggedSlots,
    taggedEmployees,
  });

  res.json({ ok: true, taggedSlots, taggedEmployees, projectName: jo.project.name, jobOrderCode: jo.code });
});

/** Per-slot edit used by the per-row "Assign" button. Clears if jobOrderId is null. */
timesheetRouter.put("/entry", async (req, res) => {
  const parsed = setSlotJobOrderSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const { supervisorId, workDate: dateStr, employeeId, shiftSlot, jobOrderId } = parsed.data;
  // Owner enforcement: only the timesheet's owner supervisor may edit it.
  if (supervisorId !== req.user!.id) {
    return res.status(403).json({ error: "You can only edit your own timesheet.", code: "NOT_OWNER" });
  }
  const workDate = parseDateOnly(dateStr);

  const existing = await prisma.timesheetDay.findUnique({
    where: { employeeId_workDate_taggedById: { employeeId, workDate, taggedById: supervisorId } },
    include: { entries: true, approvals: { where: { action: "APPROVE" }, take: 1, orderBy: { createdAt: "desc" } } },
  });
  const status = existing?.status ?? "DRAFT";
  const hasProtected = Boolean(
    existing?.entries?.some((e) => (e.projectWbsId != null || e.jobOrderId != null) && isProtectedEntryStatus(e.status))
  );
  const lock = resolveEditLock(status, existing?.approvals[0]?.createdAt ?? existing?.updatedAt ?? null, { hasProtectedEntries: hasProtected });
  if (lock.editMode === "locked") {
    return res.status(400).json({ error: "Timesheet is locked. Only HOD/Project Head reject unlocks it." });
  }

  const day = await prisma.timesheetDay.upsert({
    where: { employeeId_workDate_taggedById: { employeeId, workDate, taggedById: supervisorId } },
    create: { employeeId, workDate, taggedById: supervisorId, status: "DRAFT", remarks: null },
    update: { status: isApprovedStatus(status) ? status : "DRAFT" },
  });

  if (jobOrderId == null) {
    await prisma.timesheetEntry.deleteMany({ where: { timesheetDayId: day.id, shiftSlot } });
    return res.json({ ok: true, cleared: true });
  }

  await prisma.timesheetEntry.upsert({
    where: {
      timesheet_entry_shiftSlot_unique: { employeeId, workDate, shiftSlot, taggedById: supervisorId },
    },
    create: {
      timesheetDayId: day.id,
      employeeId,
      workDate,
      shiftSlot,
      hourSlot: null,
      jobOrderId,
      taggedById: supervisorId,
      status: "DRAFT",
    },
    update: { jobOrderId, timesheetDayId: day.id, status: "DRAFT" },
  });

  res.json({ ok: true });
});

/**
 * Add/update/clear overtime (OT) hours for an employee on a day.
 * OT is additive and separate from the 8h allocation — it never counts toward
 * totalAlloc/overhead. One OT row per (employee, workDate, taggedById) is
 * enforced here (SQLite treats NULL as distinct in unique constraints, so the
 * schema can't). Owner-checked + status-locked + audited, same as assign/unassign.
 */
timesheetRouter.put("/ot", async (req, res) => {
  const supervisorId = Number(req.body.supervisorId);
  const dateStr = String(req.body.workDate || "");
  const employeeId = Number(req.body.employeeId);
  const jobOrderId = req.body.jobOrderId == null ? null : Number(req.body.jobOrderId);
  const otHours = req.body.otHours == null ? null : Number(req.body.otHours);

  if (!supervisorId || !dateStr || !employeeId) {
    return res.status(400).json({ error: "supervisorId, workDate and employeeId required" });
  }
  // Owner enforcement: only the timesheet's owner supervisor may add OT.
  if (supervisorId !== req.user!.id) {
    return res.status(403).json({ error: "You can only edit your own timesheet.", code: "NOT_OWNER" });
  }
  const workDate = parseDateOnly(dateStr);

  // Validate OT hours: integer 1-12 (configurable cap), or null to clear.
  const maxOt = Number(process.env.MAX_OT_HOURS || 12);
  if (otHours != null) {
    if (!Number.isInteger(otHours) || otHours < 1 || otHours > maxOt) {
      return res.status(400).json({
        error: `OT hours must be a whole number between 1 and ${maxOt}.`,
        code: "INVALID_OT_HOURS",
      });
    }
    if (jobOrderId == null) {
      return res.status(400).json({ error: "A project / work order is required when adding OT hours.", code: "OT_REQUIRES_JOBORDER" });
    }
    // Validate the job order exists.
    const jo = await prisma.jobOrder.findUnique({ where: { id: jobOrderId } });
    if (!jo) return res.status(400).json({ error: "Invalid work order.", code: "INVALID_JOBORDER" });
  }

  // Status lock: OT can only be added while the day is editable (DRAFT/REJECTED).
  const existing = await prisma.timesheetDay.findUnique({
    where: { employeeId_workDate_taggedById: { employeeId, workDate, taggedById: supervisorId } },
    include: { entries: true, approvals: { where: { action: "APPROVE" }, take: 1, orderBy: { createdAt: "desc" } } },
  });
  const status = existing?.status ?? "DRAFT";
  const hasProtected = Boolean(
    existing?.entries?.some((e) => (e.projectWbsId != null || e.jobOrderId != null) && isProtectedEntryStatus(e.status))
  );
  const lock = resolveEditLock(status, existing?.approvals[0]?.createdAt ?? existing?.updatedAt ?? null, { hasProtectedEntries: hasProtected });
  if (lock.editMode === "locked") {
    return res.status(400).json({ error: "Timesheet is locked. Only HOD/Project Head reject unlocks it.", code: "TIMESHEET_EDIT_LOCKED" });
  }

  // Ensure the day exists.
  const day = await prisma.timesheetDay.upsert({
    where: { employeeId_workDate_taggedById: { employeeId, workDate, taggedById: supervisorId } },
    create: { employeeId, workDate, taggedById: supervisorId, status: "DRAFT", remarks: null },
    update: { status: isApprovedStatus(status) ? status : "DRAFT" },
  });

  // One OT row per (employee, workDate, taggedById) — find the existing OT row.
  const existingOt = await prisma.timesheetEntry.findFirst({
    where: { timesheetDayId: day.id, otHours: { not: null } },
  });

  if (otHours == null) {
    // Clear OT.
    if (existingOt) await prisma.timesheetEntry.delete({ where: { id: existingOt.id } });
  } else if (existingOt) {
    // Update existing OT row.
    await prisma.timesheetEntry.update({
      where: { id: existingOt.id },
      data: { jobOrderId, otHours, status: "DRAFT" },
    });
  } else {
    // Create OT row (shiftSlot=null, hourSlot=null, otHours=N).
    await prisma.timesheetEntry.create({
      data: {
        timesheetDayId: day.id,
        employeeId,
        workDate,
        shiftSlot: null,
        hourSlot: null,
        jobOrderId,
        otHours,
        taggedById: supervisorId,
        status: "DRAFT",
      },
    });
  }

  await writeAudit(req.user!.id, "TIMESHEET_OT", "timesheet_day", day.id, {
    employeeId,
    workDate: dateStr,
    jobOrderId,
    otHours,
  });

  res.json({ ok: true, otHours, jobOrderId });
});

timesheetRouter.post("/submit", async (req, res) => {
  const supervisorId = Number(req.body.supervisorId);
  const dateStr = String(req.body.workDate || "");
  if (!supervisorId || !dateStr) {
    return res.status(400).json({ error: "supervisorId and workDate required" });
  }
  // Owner enforcement: only the timesheet's owner supervisor may submit it.
  if (supervisorId !== req.user!.id) {
    return res.status(403).json({ error: "You can only submit your own timesheet.", code: "NOT_OWNER" });
  }
  const workDate = parseDateOnly(dateStr);
  const maxDailyHours = getMaxDailyHours();

  const days = await prisma.timesheetDay.findMany({
    where: { taggedById: supervisorId, workDate },
    include: {
      employee: true,
      // A tagged hour counts whether it was tagged via the legacy ProjectWbs path or the
      // new JobOrder-only path that the supervisor's Daily Timesheet Entry writes today.
      // Without this OR, timesheets tagged through the JobOrder flow have an empty
      // `entries` array here and fail with "No project hours to submit".
      entries: {
        where: {
          OR: [{ projectWbsId: { not: null } }, { jobOrderId: { not: null } }],
        },
      },
      approvals: {
        where: { action: "APPROVE" },
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
  });

  const employeeIds = days.map((d) => d.employeeId);
  const dayTotals = await getEmployeeDayHourTotals(employeeIds, workDate, supervisorId);

  const violations: {
    employeeId: number;
    employeeName: string;
    dayTotalHours: number;
    maxDailyHours: number;
    remarks: string | null;
  }[] = [];
  const warnings: typeof violations = [];
  const lockedIds: number[] = [];

  for (const day of days) {
    const hasProtectedEntries = day.entries.some(
      (e) => e.projectWbsId != null && isProtectedEntryStatus(e.status)
    );
    const lock = resolveEditLock(day.status, day.approvals[0]?.createdAt ?? day.updatedAt, {
      hasProtectedEntries,
    });
    if (lock.editMode === "locked") {
      lockedIds.push(day.id);
      continue;
    }
    if (!day.entries.length) continue;
    // Union of legacy hour slots (numeric) with shift-slot entries (strings). Tag shift slots
    // with `s:` so they don't collide with the numeric hour-slot space; Set dedupes each kind.
    const localSlots: string[] = day.entries.map((e) =>
      e.hourSlot != null ? `h:${e.hourSlot}` : e.shiftSlot != null ? `s:${e.shiftSlot}` : ""
    ).filter(Boolean);
    const otherSlots = dayTotals.get(day.employeeId)?.otherSlots ?? [];
    const total = new Set([...otherSlots.map((s) => `h:${s}`), ...localSlots]).size;
    if (total <= maxDailyHours) continue;
    const item = {
      employeeId: day.employeeId,
      employeeName: day.employee.name,
      dayTotalHours: total,
      maxDailyHours,
      remarks: day.remarks,
    };
    if (!day.remarks?.trim()) {
      violations.push(item);
    } else {
      warnings.push(item);
    }
  }

  if (violations.length) {
    return res.status(400).json({
      error: `Daily hours exceed ${maxDailyHours}h for one or more employees. Enter a mandatory reason in Remarks before submitting for approval.`,
      code: "MAX_DAILY_HOURS_REMARKS_REQUIRED",
      maxDailyHours,
      violations,
      warnings,
    });
  }

  const submittable = days.filter((d) => {
    if (!d.entries.length) return false;
    if (lockedIds.includes(d.id)) return false;
    const hasProtectedEntries = d.entries.some(
      (e) => e.projectWbsId != null && isProtectedEntryStatus(e.status)
    );
    const lock = resolveEditLock(d.status, d.approvals[0]?.createdAt ?? d.updatedAt, {
      hasProtectedEntries,
    });
    if (lock.editMode === "locked") return false;
    if (lock.editMode === "addOnly") {
      return d.entries.some((e) => e.status === "DRAFT" || e.status === "REJECTED");
    }
    return ["DRAFT", "REJECTED"].includes(d.status);
  });
  const dayIds = submittable.map((d) => d.id);

  if (!dayIds.length) {
    return res.status(400).json({
      error: lockedIds.length
        ? "No editable timesheets to submit. Approved sheets outside the 24-hour window cannot be modified."
        : "No project hours to submit. Tag at least one hour before submitting for approval.",
    });
  }

  let submittedCount = 0;
  for (const dayId of dayIds) {
    const day = days.find((d) => d.id === dayId)!;
    const hasProtectedEntries = day.entries.some(
      (e) => e.projectWbsId != null && isProtectedEntryStatus(e.status)
    );

    await prisma.timesheetDay.update({
      where: { id: dayId },
      data: { status: "SUBMITTED" },
    });

    if (hasProtectedEntries) {
      // Amendment: only newly added / rejected-for-fix slots go pending — keep prior approvals
      await prisma.timesheetEntry.updateMany({
        where: {
          timesheetDayId: dayId,
          taggedById: supervisorId,
          OR: [{ projectWbsId: { not: null } }, { jobOrderId: { not: null } }],
          status: { in: ["DRAFT", "REJECTED"] },
        },
        data: { status: "SUBMITTED" },
      });
    } else {
      await prisma.timesheetEntry.updateMany({
        where: {
          timesheetDayId: dayId,
          taggedById: supervisorId,
          OR: [{ projectWbsId: { not: null } }, { jobOrderId: { not: null } }],
        },
        data: { status: "SUBMITTED" },
      });
    }
    submittedCount += 1;
  }

  await writeAudit(req.user!.id, "TIMESHEET_SUBMIT", "timesheet_day", dateStr, {
    supervisorId,
    updated: submittedCount,
    overtimeWarnings: warnings.length,
  });

  res.json({
    ok: true,
    submitted: submittedCount,
    maxDailyHours,
    warnings: warnings.map((w) => ({
      ...w,
      message: `${w.employeeName} has ${w.dayTotalHours}h (limit ${w.maxDailyHours}h). Overtime reason recorded for HOD: "${w.remarks}"`,
    })),
  });
});
