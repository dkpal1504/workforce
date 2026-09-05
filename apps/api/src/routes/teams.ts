import { Router } from "express";
import { teamTodaySchema } from "@workforce/shared";
import { prisma } from "../db";
import { requireAuth } from "../middleware/auth";
import { writeAudit } from "../audit";
import { parseDateOnly, previousWorkDate } from "../utils/date";
import { isApprovedStatus, isProtectedEntryStatus, resolveEditLock } from "../services/timesheetEditLock";

export const teamsRouter = Router();

teamsRouter.use(requireAuth);

teamsRouter.get("/pool", async (req, res) => {
  const departmentId = Number(req.query.department_id);
  const dateStr = String(req.query.date || "");
  const supervisorId = Number(req.query.supervisor_id);
  if (!departmentId || !dateStr || !supervisorId) {
    return res.status(400).json({ error: "department_id, date, supervisor_id required" });
  }
  const workDate = parseDateOnly(dateStr);

  const teamIds = (
    await prisma.dailyTeamSelection.findMany({
      where: { supervisorId, workDate, removedAt: null },
      select: { employeeId: true },
    })
  ).map((r) => r.employeeId);

  const employees = await prisma.employee.findMany({
    where: {
      departmentId,
      active: true,
      id: { notIn: teamIds.length ? teamIds : [-1] },
    },
    orderBy: { name: "asc" },
  });

  res.json({ employees, available: employees.length });
});

teamsRouter.get("/today", async (req, res) => {
  const supervisorId = Number(req.query.supervisor_id);
  const dateStr = String(req.query.date || "");
  if (!supervisorId || !dateStr) {
    return res.status(400).json({ error: "supervisor_id and date required" });
  }
  const workDate = parseDateOnly(dateStr);

  let rows = await prisma.dailyTeamSelection.findMany({
    where: { supervisorId, workDate, removedAt: null },
    include: {
      employee: { include: { department: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  let carriedOver = false;

  if (rows.length === 0) {
    const prev = previousWorkDate(workDate);
    const prior = await prisma.dailyTeamSelection.findMany({
      where: { supervisorId, workDate: prev, removedAt: null },
    });
    if (prior.length > 0) {
      await prisma.$transaction(
        prior.map((p) =>
          prisma.dailyTeamSelection.create({
            data: {
              supervisorId,
              employeeId: p.employeeId,
              workDate,
              source: "CARRIED_OVER",
            },
          })
        )
      );
      carriedOver = true;
      rows = await prisma.dailyTeamSelection.findMany({
        where: { supervisorId, workDate, removedAt: null },
        include: {
          employee: { include: { department: true } },
        },
        orderBy: { createdAt: "asc" },
      });
      await writeAudit(req.user!.id, "TEAM_CARRY_OVER", "daily_team_selection", dateStr, {
        supervisorId,
        count: rows.length,
      });
    }
  } else {
    carriedOver = rows.every((r) => r.source === "CARRIED_OVER");
  }

  // Warn if employees also on other supervisors' teams
  const employeeIds = rows.map((r) => r.employeeId);
  const conflicts = employeeIds.length
    ? await prisma.dailyTeamSelection.findMany({
        where: {
          workDate,
          removedAt: null,
          employeeId: { in: employeeIds },
          supervisorId: { not: supervisorId },
        },
        include: { supervisor: { select: { id: true, name: true } }, employee: { select: { id: true, name: true } } },
      })
    : [];

  res.json({
    team: rows.map((r) => ({
      id: r.id,
      employeeId: r.employeeId,
      employee: r.employee,
      source: r.source,
    })),
    selected: rows.length,
    carriedOver,
    warnings: conflicts.map((c) => ({
      employeeId: c.employeeId,
      employeeName: c.employee.name,
      otherSupervisor: c.supervisor.name,
    })),
  });
});

teamsRouter.post("/today", async (req, res) => {
  const parsed = teamTodaySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const { supervisorId, workDate: dateStr, employeeIds } = parsed.data;
  const workDate = parseDateOnly(dateStr);

  const existing = await prisma.dailyTeamSelection.findMany({
    where: { supervisorId, workDate, removedAt: null },
  });
  const existingIds = new Set(existing.map((e) => e.employeeId));
  const nextIds = new Set(employeeIds);

  const toRemove = existing.filter((e) => !nextIds.has(e.employeeId));
  const toAdd = employeeIds.filter((id) => !existingIds.has(id));

  await prisma.$transaction([
    ...toRemove.map((r) =>
      prisma.dailyTeamSelection.update({
        where: { id: r.id },
        data: { removedAt: new Date(), source: "REMOVED" },
      })
    ),
    ...toAdd.map((employeeId) =>
      prisma.dailyTeamSelection.create({
        data: {
          supervisorId,
          employeeId,
          workDate,
          source: "ADDED",
        },
      })
    ),
  ]);

  await writeAudit(req.user!.id, "TEAM_UPDATE", "daily_team_selection", dateStr, {
    supervisorId,
    employeeIds,
  });

  const team = await prisma.dailyTeamSelection.findMany({
    where: { supervisorId, workDate, removedAt: null },
    include: { employee: true },
    orderBy: { createdAt: "asc" },
  });

  res.json({ team, selected: team.length });
});

teamsRouter.delete("/today/:employeeId", async (req, res) => {
  const supervisorId = Number(req.query.supervisor_id);
  const dateStr = String(req.query.date || "");
  const employeeId = Number(req.params.employeeId);
  if (!supervisorId || !dateStr || !employeeId) {
    return res.status(400).json({ error: "supervisor_id, date, employeeId required" });
  }
  // Owner enforcement: only the timesheet's owner supervisor may remove an employee.
  if (supervisorId !== req.user!.id) {
    return res.status(403).json({ error: "You can only edit your own timesheet.", code: "NOT_OWNER" });
  }
  const workDate = parseDateOnly(dateStr);
  const row = await prisma.dailyTeamSelection.findFirst({
    where: { supervisorId, workDate, employeeId, removedAt: null },
  });
  if (!row) return res.status(404).json({ error: "Not on team" });

  // Status lock: removing an employee (and clearing their allocations) is only
  // allowed on an editable day — never on a SUBMITTED/approved day, which would
  // silently delete already-submitted hours and corrupt the HOD/PM view.
  const day = await prisma.timesheetDay.findUnique({
    where: { employeeId_workDate_taggedById: { employeeId, workDate, taggedById: supervisorId } },
    include: { entries: true, approvals: { where: { action: "APPROVE" }, take: 1, orderBy: { createdAt: "desc" } } },
  });
  const status = day?.status ?? "DRAFT";
  const hasProtected = Boolean(
    day?.entries?.some((e) => (e.projectWbsId != null || e.jobOrderId != null) && isProtectedEntryStatus(e.status))
  );
  const lock = resolveEditLock(status, day?.approvals[0]?.createdAt ?? day?.updatedAt ?? null, { hasProtectedEntries: hasProtected });
  if (lock.editMode === "locked") {
    return res.status(400).json({ error: "Timesheet is locked. Only HOD/Project Head reject unlocks it.", code: "TIMESHEET_EDIT_LOCKED" });
  }

  // Soft-remove the team row AND hard-delete the employee's timesheet entries for
  // this day, so re-adding the employee starts with fresh allocations.
  const deleted = await prisma.$transaction(async (tx) => {
    await tx.dailyTeamSelection.update({
      where: { id: row.id },
      data: { removedAt: new Date(), source: "REMOVED" },
    });
    const res = await tx.timesheetEntry.deleteMany({
      where: { employeeId, workDate, taggedById: supervisorId },
    });
    // Clean up the orphaned timesheet day if no entries remain.
    if (day) {
      const remaining = await tx.timesheetEntry.count({ where: { timesheetDayId: day.id } });
      if (remaining === 0) {
        await tx.timesheetDay.delete({ where: { id: day.id } });
      }
    }
    return res.count;
  });

  await writeAudit(req.user!.id, "TEAM_REMOVE", "daily_team_selection", row.id, {
    employeeId,
    workDate: dateStr,
    entriesDeleted: deleted,
  });
  res.json({ ok: true, entriesDeleted: deleted });
});
