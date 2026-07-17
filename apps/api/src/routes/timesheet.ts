import { Router } from "express";
import { timesheetDaySchema } from "@workforce/shared";
import { prisma } from "../db";
import { requireAuth } from "../middleware/auth";
import { writeAudit } from "../audit";
import { parseDateOnly } from "../utils/date";
import { getMaxDailyHours, getShifts } from "../config";
import { getEmployeeDayHourTotals } from "../services/hours";
import { isApprovedStatus, isProtectedEntryStatus, resolveEditLock } from "../services/timesheetEditLock";

export const timesheetRouter = Router();

timesheetRouter.use(requireAuth);

const RETURN_ACTIONS = ["REJECT", "SEND_BACK", "PLANNING_RETURN"];

timesheetRouter.get("/", async (req, res) => {
  const supervisorId = Number(req.query.supervisor_id);
  const dateStr = String(req.query.date || "");
  if (!supervisorId || !dateStr) {
    return res.status(400).json({ error: "supervisor_id and date required" });
  }
  const workDate = parseDateOnly(dateStr);
  const maxDailyHours = getMaxDailyHours();
  const shifts = getShifts();

  const team = await prisma.dailyTeamSelection.findMany({
    where: { supervisorId, workDate, removedAt: null },
    include: { employee: { include: { department: true } } },
    orderBy: { createdAt: "asc" },
  });

  const days = await prisma.timesheetDay.findMany({
    where: { taggedById: supervisorId, workDate },
    include: {
      entries: { include: { projectWbs: true } },
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

  const projects = await prisma.projectWbs.findMany({ where: { active: true }, orderBy: { colorKey: "asc" } });

  const rows = team.map((t) => {
    const day = dayByEmployee.get(t.employeeId);
    const hours = Array.from({ length: 13 }, (_, hourSlot) => {
      const entry = day?.entries.find((e) => e.hourSlot === hourSlot);
      return {
        hourSlot,
        projectWbsId: entry?.projectWbsId ?? null,
        locked: Boolean(
          entry?.projectWbsId != null && entry?.status && isProtectedEntryStatus(entry.status)
        ),
        project: entry?.projectWbs
          ? {
              id: entry.projectWbs.id,
              name: entry.projectWbs.name,
              wbsCode: entry.projectWbs.wbsCode,
              colorKey: entry.projectWbs.colorKey,
            }
          : null,
      };
    });
    const filledHours = hours.filter((h) => h.projectWbsId != null).length;
    const totals = dayTotals.get(t.employeeId);
    const otherSlots = totals?.otherSlots ?? [];
    const otherHours = totals?.otherHours ?? 0;
    const dayTotalHours = new Set([
      ...otherSlots,
      ...hours.filter((h) => h.projectWbsId != null).map((h) => h.hourSlot),
    ]).size;
    const exceedsLimit = dayTotalHours > maxDailyHours;
    const latestReturn = day?.approvals?.find((a) => RETURN_ACTIONS.includes(a.action)) ?? null;
    const latestApprove = day?.approvals?.find((a) => a.action === "APPROVE") ?? null;
    const status = day?.status ?? "DRAFT";
    const hasProtectedEntries = Boolean(
      day?.entries?.some((e) => e.projectWbsId != null && isProtectedEntryStatus(e.status))
    );
    const lock = resolveEditLock(status, latestApprove?.createdAt ?? day?.updatedAt ?? null, {
      hasProtectedEntries,
    });

    return {
      employeeId: t.employeeId,
      employee: t.employee,
      remarks: day?.remarks ?? "",
      status,
      hours,
      filled: filledHours > 0,
      filledHours,
      otherHours,
      otherSlots,
      dayTotalHours,
      exceedsLimit,
      remarksRequired: exceedsLimit && filledHours > 0,
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

  const filledCount = rows.filter((r) => r.filledHours > 0).length;
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
    projects,
    maxDailyHours,
    shifts,
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
      existing?.entries?.some((e) => e.projectWbsId != null && isProtectedEntryStatus(e.status))
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
      const existingBySlot = new Map(existing.entries.map((e) => [e.hourSlot, e]));
      for (const h of row.hours) {
        const prev = existingBySlot.get(h.hourSlot);
        if (prev?.projectWbsId != null && isProtectedEntryStatus(prev.status)) {
          if (h.projectWbsId == null || h.projectWbsId !== prev.projectWbsId) {
            lockViolations.push({
              employeeId: row.employeeId,
              error:
                "Cannot clear or change hour slots already approved by HOD/Project Head. You may only fill empty slots (or fix rejected new hours).",
            });
            break;
          }
        } else if (isApprovedStatus(status) && prev?.projectWbsId != null) {
          // Approved day: non-protected filled slots still cannot change (legacy)
          if (h.projectWbsId == null || h.projectWbsId !== prev.projectWbsId) {
            lockViolations.push({
              employeeId: row.employeeId,
              error:
                "Cannot clear or change hour slots already saved after HOD/Project Head approval. You may only fill empty slots within 24 hours.",
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

      for (const h of row.hours) {
        const prev = existingBySlot.get(h.hourSlot);
        if (prev?.projectWbsId != null && isProtectedEntryStatus(prev.status)) continue;

        if (isApprovedStatus(status)) {
          // Only add into empty slots
          if (prev?.projectWbsId != null) continue;
          if (h.projectWbsId == null) continue;
          await prisma.timesheetEntry.upsert({
            where: {
              employeeId_workDate_hourSlot_taggedById: {
                employeeId: row.employeeId,
                workDate,
                hourSlot: h.hourSlot,
                taggedById: supervisorId,
              },
            },
            create: {
              timesheetDayId: existing.id,
              employeeId: row.employeeId,
              workDate,
              hourSlot: h.hourSlot,
              projectWbsId: h.projectWbsId,
              taggedById: supervisorId,
              status: "DRAFT",
            },
            update: {
              projectWbsId: h.projectWbsId,
              timesheetDayId: existing.id,
              status: "DRAFT",
            },
          });
          continue;
        }

        // REJECTED with protected slots: edit/clear non-protected freely
        if (h.projectWbsId == null) {
          if (prev) {
            await prisma.timesheetEntry.deleteMany({
              where: { id: prev.id },
            });
          }
        } else {
          await prisma.timesheetEntry.upsert({
            where: {
              employeeId_workDate_hourSlot_taggedById: {
                employeeId: row.employeeId,
                workDate,
                hourSlot: h.hourSlot,
                taggedById: supervisorId,
              },
            },
            create: {
              timesheetDayId: existing.id,
              employeeId: row.employeeId,
              workDate,
              hourSlot: h.hourSlot,
              projectWbsId: h.projectWbsId,
              taggedById: supervisorId,
              status: "DRAFT",
            },
            update: {
              projectWbsId: h.projectWbsId,
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

    // Never force approved rows through this path (handled above); reset non-approved to DRAFT
    if (!isApprovedStatus(status) && day.status !== "DRAFT") {
      await prisma.timesheetDay.update({ where: { id: day.id }, data: { status: "DRAFT" } });
    }

    for (const h of row.hours) {
      if (h.projectWbsId == null) {
        await prisma.timesheetEntry.deleteMany({
          where: {
            timesheetDayId: day.id,
            hourSlot: h.hourSlot,
          },
        });
      } else {
        await prisma.timesheetEntry.upsert({
          where: {
            employeeId_workDate_hourSlot_taggedById: {
              employeeId: row.employeeId,
              workDate,
              hourSlot: h.hourSlot,
              taggedById: supervisorId,
            },
          },
          create: {
            timesheetDayId: day.id,
            employeeId: row.employeeId,
            workDate,
            hourSlot: h.hourSlot,
            projectWbsId: h.projectWbsId,
            taggedById: supervisorId,
            status: "DRAFT",
          },
          update: {
            projectWbsId: h.projectWbsId,
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
      const localSlots = r.hours.filter((h) => h.projectWbsId != null).map((h) => h.hourSlot);
      if (!localSlots.length) return null;
      const otherSlots = dayTotals.get(r.employeeId)?.otherSlots ?? [];
      const total = new Set([...otherSlots, ...localSlots]).size;
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

timesheetRouter.post("/submit", async (req, res) => {
  const supervisorId = Number(req.body.supervisorId);
  const dateStr = String(req.body.workDate || "");
  if (!supervisorId || !dateStr) {
    return res.status(400).json({ error: "supervisorId and workDate required" });
  }
  const workDate = parseDateOnly(dateStr);
  const maxDailyHours = getMaxDailyHours();

  const days = await prisma.timesheetDay.findMany({
    where: { taggedById: supervisorId, workDate },
    include: {
      employee: true,
      entries: { where: { projectWbsId: { not: null } } },
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
    const localSlots = day.entries.map((e) => e.hourSlot);
    const otherSlots = dayTotals.get(day.employeeId)?.otherSlots ?? [];
    const total = new Set([...otherSlots, ...localSlots]).size;
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
          projectWbsId: { not: null },
          status: { in: ["DRAFT", "REJECTED"] },
        },
        data: { status: "SUBMITTED" },
      });
    } else {
      await prisma.timesheetEntry.updateMany({
        where: {
          timesheetDayId: dayId,
          taggedById: supervisorId,
          projectWbsId: { not: null },
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
