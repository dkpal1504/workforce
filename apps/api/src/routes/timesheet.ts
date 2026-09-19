import { Router, type NextFunction, type Request, type Response } from "express";
import { SHIFT_SLOTS, bulkAssignSchema, setSlotJobOrderSchema, timesheetDaySchema } from "@workforce/shared";
import type { ShiftSlot } from "@workforce/shared";
import { prisma } from "../db";
import { requireAuth, requireRoles } from "../middleware/auth";
import { writeAudit } from "../audit";
import { formatDateOnly, parseDateOnly, previousWorkDate } from "../utils/date";
import { getMaxDailyHours } from "../config";
import { getEmployeeDayHourTotals } from "../services/hours";
import { isApprovedStatus, isProtectedEntryStatus, resolveEditLock } from "../services/timesheetEditLock";
import { canSubmitRetainedDraft, inactiveEmployeePayload } from "../services/employeeEligibility";
import {
  assignableJobOrders,
  invalidJobOrderPayload,
  isAssignableJobOrder,
  jobOrderOptionLabel,
  loadDepartmentSections,
  loadSlotJobOrders,
} from "../services/jobOrderEligibility";
import {
  loadAttributionSnapshots,
  resolveAttributionSnapshot,
  snapshotForBooking,
  snapshotsFromJobOrders,
} from "../services/attributionSnapshot";

export const timesheetRouter = Router();

async function supervisorDepartmentForActor(actorRole: string, actorId: number, supervisorId: number): Promise<number | null> {
  if (actorRole !== "ADMIN" && actorId !== supervisorId) return null;
  const supervisor = await prisma.user.findFirst({ where: { id: supervisorId, role: "SUPERVISOR", active: true }, select: { departmentId: true } });
  return supervisor?.departmentId ?? null;
}

async function hasTeamAccess(
  supervisorId: number,
  departmentId: number | null,
  workDate: Date,
  employeeIds: number[]
): Promise<boolean> {
  const ids = [...new Set(employeeIds)];
  if (departmentId == null || ids.length === 0) return false;
  const count = await prisma.dailyTeamSelection.count({
    where: {
      supervisorId,
      workDate,
      removedAt: null,
      employeeId: { in: ids },
      employee: { departmentId, employmentType: "CLMS" },
    },
  });
  return count === ids.length;
}

function teamAccessDenied(res: import("express").Response) {
  return res.status(403).json({
    error: "Labour must be assigned to your team from a Section in your Department.",
    code: "LABOUR_NOT_ASSIGNED",
  });
}

timesheetRouter.use(requireAuth, requireRoles("SUPERVISOR", "ADMIN"));

// Serialize allocation writes in this API process. This makes submission a
// first-writer-wins operation instead of allowing two overlapping submits to
// pass the conflict check at the same time.
let mutationTail: Promise<void> = Promise.resolve();
function serializeTimesheetMutation(req: Request, res: Response, next: NextFunction) {
  let release!: () => void;
  const turn = new Promise<void>((resolve) => { release = resolve; });
  const previous = mutationTail;
  mutationTail = previous.then(() => turn);
  previous.then(() => {
    let released = false;
    const unlock = () => {
      if (released) return;
      released = true;
      release();
    };
    res.once("finish", unlock);
    res.once("close", unlock);
    next();
  }).catch(next);
}

const RETURN_ACTIONS = ["REJECT", "SEND_BACK", "PLANNING_RETURN"];

const SHIFT_TO_HOUR_SLOTS: Record<ShiftSlot, readonly number[]> = {
  am1: [1, 2],
  am2: [3, 4],
  pm1: [6, 7],
  pm2: [8, 9],
};

const BOOKED_ENTRY_STATUSES = ["SUBMITTED", "SUP_APPROVED", "HOD_APPROVED", "PM_APPROVED"];

function entryOverlapsShift(entry: { shiftSlot: string | null; hourSlot: number | null }, shiftSlot: ShiftSlot) {
  if (entry.shiftSlot != null) return entry.shiftSlot === shiftSlot;
  return entry.hourSlot != null && SHIFT_TO_HOUR_SLOTS[shiftSlot].includes(entry.hourSlot);
}

function entriesOverlap(
  left: { shiftSlot: string | null; hourSlot: number | null },
  right: { shiftSlot: string | null; hourSlot: number | null }
) {
  if (left.shiftSlot != null) return entryOverlapsShift(right, left.shiftSlot as ShiftSlot);
  if (right.shiftSlot != null) return entryOverlapsShift(left, right.shiftSlot as ShiftSlot);
  return left.hourSlot != null && left.hourSlot === right.hourSlot;
}

type SlotClaim = {
  employeeId: number;
  shiftSlot: string | null;
  hourSlot: number | null;
};

type ExternalSlotConflict = SlotClaim & {
  employeeName: string;
  supervisorId: number;
  supervisorName: string;
};

async function findExternalBookedConflicts(
  supervisorId: number,
  workDate: Date,
  claims: SlotClaim[]
): Promise<ExternalSlotConflict[]> {
  const employeeIds = [...new Set(claims.map((claim) => claim.employeeId))];
  if (!employeeIds.length) return [];
  const booked = await prisma.timesheetEntry.findMany({
    where: {
      employeeId: { in: employeeIds },
      workDate,
      taggedById: { not: supervisorId },
      status: { in: BOOKED_ENTRY_STATUSES },
      otHours: null,
      OR: [{ projectWbsId: { not: null } }, { jobOrderId: { not: null } }],
    },
    include: {
      employee: { select: { name: true } },
      taggedBy: { select: { id: true, name: true } },
    },
  });
  const conflicts: ExternalSlotConflict[] = [];
  for (const claim of claims) {
    for (const other of booked) {
      if (other.employeeId !== claim.employeeId || !entriesOverlap(claim, other)) continue;
      conflicts.push({
        ...claim,
        employeeName: other.employee.name,
        supervisorId: other.taggedById,
        supervisorName: other.taggedBy.name,
      });
    }
  }
  return conflicts.filter(
    (conflict, index, all) =>
      all.findIndex(
        (item) =>
          item.employeeId === conflict.employeeId &&
          item.shiftSlot === conflict.shiftSlot &&
          item.hourSlot === conflict.hourSlot &&
          item.supervisorId === conflict.supervisorId
      ) === index
  );
}

function bookedConflictPayload(conflicts: ExternalSlotConflict[]) {
  const messages = [...new Map(
    conflicts.map((item) => [
      `${item.employeeId}|${item.supervisorId}`,
      `Slot of Mr ${item.employeeName} is already booked by Supervisor ${item.supervisorName}`,
    ])
  ).values()];
  return {
    error: messages.join(". "),
    code: "SLOT_ALREADY_BOOKED",
    conflicts,
  };
}

async function discardLosingDraftSlots(
  supervisorId: number,
  workDate: Date,
  conflicts: SlotClaim[]
) {
  if (!conflicts.length) return;
  await prisma.timesheetEntry.deleteMany({
    where: {
      taggedById: supervisorId,
      workDate,
      status: { in: ["DRAFT", "REJECTED"] },
      OR: conflicts.map((item) => ({
        employeeId: item.employeeId,
        shiftSlot: item.shiftSlot,
        hourSlot: item.hourSlot,
      })),
    },
  });
}

async function discardCompetingExternalDrafts(
  supervisorId: number,
  workDate: Date,
  winningClaims: SlotClaim[]
) {
  const employeeIds = [...new Set(winningClaims.map((claim) => claim.employeeId))];
  if (!employeeIds.length) return 0;
  const drafts = await prisma.timesheetEntry.findMany({
    where: {
      employeeId: { in: employeeIds },
      workDate,
      taggedById: { not: supervisorId },
      status: { in: ["DRAFT", "REJECTED"] },
      otHours: null,
      OR: [{ projectWbsId: { not: null } }, { jobOrderId: { not: null } }],
    },
    select: { id: true, employeeId: true, shiftSlot: true, hourSlot: true },
  });
  const losingIds = drafts
    .filter((draft) =>
      winningClaims.some(
        (claim) => claim.employeeId === draft.employeeId && entriesOverlap(claim, draft)
      )
    )
    .map((draft) => draft.id);
  if (!losingIds.length) return 0;
  const result = await prisma.timesheetEntry.deleteMany({ where: { id: { in: losingIds } } });
  return result.count;
}

type ShiftSlotRow = {
  shiftSlot: ShiftSlot;
  jobOrderId: number | null;
  /** Attribution snapshot of the booking, so the picker can preselect Section. */
  projectId: number | null;
  departmentId: number | null;
  sectionId: number | null;
  /** Convenience fields flattened from the jobOrder relation. */
  projectColorKey: string | null;
  projectName: string | null;
  jobOrderCode: string | null;
  jobOrderName: string | null;
  /** Display form of the booking: `Job_Order-Job_Description`. */
  jobOrderLabel: string | null;
  projectWbsCode: string | null;
  /** WBS number of the booked Job Order (returned, not shown by default). */
  wbsNo: string | null;
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
    projectId: number | null;
    departmentId: number | null;
    sectionId: number | null;
    status: string;
    jobOrder: {
      id: number;
      code: string;
      name: string;
      project: { id: number; name: string; colorKey: string };
      projectWbs: { id: number; wbsCode: string } | null;
    } | null;
    projectWbs: {
      id: number;
      wbsCode: string;
      name: string | null;
      projectId: number;
      project: { name: string; colorKey: string } | null;
    } | null;
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
        departmentId: null,
        sectionId: null,
        projectColorKey: null,
        projectName: null,
        jobOrderCode: null,
        jobOrderName: null,
        jobOrderLabel: null,
        projectWbsCode: null,
        wbsNo: null,
        entryId: null,
        status: null,
        locked: false,
      };
    }
    // Prefer the JobOrder relation (new model); fall back to legacy ProjectWbs.
    // Labels stay live on the Project; ProjectWbs itself carries no colour.
    const jo = e.jobOrder;
    const pw = e.projectWbs;
    return {
      shiftSlot,
      jobOrderId: e.jobOrderId,
      projectId: e.projectId ?? jo?.project.id ?? pw?.projectId ?? null,
      departmentId: e.departmentId,
      sectionId: e.sectionId,
      projectColorKey: jo?.project.colorKey ?? pw?.project?.colorKey ?? null,
      projectName: jo?.project.name ?? pw?.project?.name ?? pw?.name ?? null,
      jobOrderCode: jo?.code ?? null,
      jobOrderName: jo?.name ?? null,
      jobOrderLabel: jo ? jobOrderOptionLabel(jo) : null,
      projectWbsCode: jo?.projectWbs?.wbsCode ?? pw?.wbsCode ?? null,
      wbsNo: jo?.projectWbs?.wbsCode ?? pw?.wbsCode ?? null,
      entryId: e.id,
      status: e.status,
      locked: (e.projectWbsId != null || e.jobOrderId != null) && isProtectedEntryStatus(e.status),
    };
  });
}

/**
 * A booking is copyable only when its Job Order, Project and Department are all
 * active, the same rule the write paths enforce.
 */
function isAssignableBooking(
  jobOrder: { status: string; project: { active: boolean } | null; department: { active: boolean } | null } | null
): boolean {
  return jobOrder != null && isAssignableJobOrder(jobOrder);
}

/**
 * Copy the previous calendar day's roster and assignments into an editable draft.
 * Source approval status is intentionally ignored. The source day is never changed.
 */
timesheetRouter.post("/carry-forward", serializeTimesheetMutation, async (req, res) => {
  const supervisorId = Number(req.body.supervisorId);
  const dateStr = String(req.body.workDate || "");
  if (!supervisorId || !dateStr) {
    return res.status(400).json({ error: "supervisorId and workDate required" });
  }
  if (req.user!.role !== "ADMIN" && supervisorId !== req.user!.id) {
    return res.status(403).json({ error: "You can only carry forward your own timesheet.", code: "NOT_OWNER" });
  }

  const workDate = parseDateOnly(dateStr);
  const supervisorDepartmentId = await supervisorDepartmentForActor(req.user!.role, req.user!.id, supervisorId);
  if (supervisorDepartmentId == null) return teamAccessDenied(res);
  const sourceDate = previousWorkDate(workDate);
  const sourceDays = await prisma.timesheetDay.findMany({
    where: { taggedById: supervisorId, workDate: sourceDate },
    include: {
      employee: { select: { id: true, active: true } },
      entries: { include: { jobOrder: { select: { id: true, status: true, projectId: true, projectWbsId: true, departmentId: true, sectionId: true, project: { select: { active: true } }, department: { select: { active: true } } } } } },
    },
  });
  const sourceTeam = await prisma.dailyTeamSelection.findMany({
    where: {
      supervisorId, workDate: sourceDate, removedAt: null,
      employee: {
        departmentId: supervisorDepartmentId, employmentType: "CLMS",
        sectionAssignment: { section: { departmentId: supervisorDepartmentId, active: true } },
      },
    },
    select: { employeeId: true },
  });

  if (!sourceDays.length && !sourceTeam.length) {
    return res.status(404).json({
      error: `No roster or assignments found on ${formatDateOnly(sourceDate)}.`,
      code: "NO_PREVIOUS_DAY_DATA",
    });
  }

  // Only the prior contract-labour roster is eligible; personal hours stay in My Hours.
  const visibleEmployeeIds = new Set(sourceTeam.map((row) => row.employeeId));
  const activeSourceDays = sourceDays.filter(
    (day) => day.employee.active && visibleEmployeeIds.has(day.employeeId)
  );
  // The copy is a NEW booking on the target day, so the attribution snapshot is
  // resolved from the live Job Order at copy time, not inherited from the source row.
  const sourceSnapshots = await loadAttributionSnapshots(
    activeSourceDays.flatMap((day) => day.entries.map((entry) => entry.jobOrderId))
  );
  const regularClaims: SlotClaim[] = activeSourceDays.flatMap((day) =>
    day.entries
      .filter(
        (entry) => entry.otHours == null && entry.shiftSlot != null && isAssignableBooking(entry.jobOrder)
      )
      .map((entry) => ({
        employeeId: day.employeeId,
        shiftSlot: entry.shiftSlot,
        hourSlot: entry.hourSlot,
      }))
  );
  const conflicts = await findExternalBookedConflicts(supervisorId, workDate, regularClaims);
  const conflictKeys = new Set(
    conflicts.map((item) => `${item.employeeId}|${item.shiftSlot ?? ""}|${item.hourSlot ?? ""}`)
  );

  const result = await prisma.$transaction(async (tx) => {
    let rosterCopied = 0;
    let daysCopied = 0;
    let regularSlotsCopied = 0;
    let otRowsSkipped = 0;
    let closedJobOrderSlots = 0;
    let unsupportedLegacyEntries = 0;
    let conflictedSlots = 0;
    const lockedEmployeeIds: number[] = [];

    for (const employeeId of new Set(sourceTeam.map((row) => row.employeeId))) {
      const employee = await tx.employee.findFirst({
        where: {
          id: employeeId, active: true, departmentId: supervisorDepartmentId, employmentType: "CLMS",
          sectionAssignment: { section: { departmentId: supervisorDepartmentId, active: true } },
        }, select: { active: true },
      });
      if (!employee) continue;
      const existing = await tx.dailyTeamSelection.findFirst({
        where: { supervisorId, employeeId, workDate },
        orderBy: { createdAt: "desc" },
      });
      if (existing) {
        await tx.dailyTeamSelection.update({
          where: { id: existing.id },
          data: { removedAt: null, source: "CARRIED_OVER" },
        });
      } else {
        await tx.dailyTeamSelection.create({
          data: { supervisorId, employeeId, workDate, source: "CARRIED_OVER" },
        });
      }
      rosterCopied += 1;
    }

    for (const sourceDay of activeSourceDays) {
      const target = await tx.timesheetDay.findUnique({
        where: {
          employeeId_workDate_taggedById: {
            employeeId: sourceDay.employeeId,
            workDate,
            taggedById: supervisorId,
          },
        },
        include: { entries: true },
      });
      const targetIsLocked =
        target != null &&
        (["SUBMITTED", "HOD_APPROVED", "PM_APPROVED"].includes(target.status) ||
          target.entries.some((entry) => isProtectedEntryStatus(entry.status)));
      if (targetIsLocked) {
        lockedEmployeeIds.push(sourceDay.employeeId);
        continue;
      }

      const targetDay = await tx.timesheetDay.upsert({
        where: {
          employeeId_workDate_taggedById: {
            employeeId: sourceDay.employeeId,
            workDate,
            taggedById: supervisorId,
          },
        },
        create: {
          employeeId: sourceDay.employeeId,
          workDate,
          taggedById: supervisorId,
          status: "DRAFT",
          remarks: sourceDay.remarks,
        },
        update: { status: "DRAFT", remarks: sourceDay.remarks },
      });
      daysCopied += 1;

      for (const entry of sourceDay.entries) {
        // OT is intentionally never carried forward. It must be entered manually
        // for the current day so overtime remains controlled and deliberate.
        if (entry.otHours != null) {
          otRowsSkipped += 1;
          continue;
        }
        if (entry.jobOrderId != null && !isAssignableBooking(entry.jobOrder)) {
          closedJobOrderSlots += 1;
          continue;
        }
        // The current screen uses four 2-hour shift slots. Old hourly/WBS-only
        // rows cannot be converted without changing their meaning, so report them.
        if (entry.hourSlot != null || entry.jobOrderId == null) {
          unsupportedLegacyEntries += 1;
          continue;
        }

        const conflictKey = `${sourceDay.employeeId}|${entry.shiftSlot ?? ""}|${entry.hourSlot ?? ""}`;
        if (entry.otHours == null && conflictKeys.has(conflictKey)) {
          conflictedSlots += 1;
          continue;
        }

        if (entry.shiftSlot != null) {
          const snapshot = snapshotForBooking(sourceSnapshots, entry.jobOrderId);
          await tx.timesheetEntry.upsert({
            where: {
              timesheet_entry_shiftSlot_unique: {
                employeeId: sourceDay.employeeId,
                workDate,
                shiftSlot: entry.shiftSlot,
                taggedById: supervisorId,
              },
            },
            create: {
              timesheetDayId: targetDay.id,
              employeeId: sourceDay.employeeId,
              workDate,
              shiftSlot: entry.shiftSlot,
              hourSlot: null,
              jobOrderId: entry.jobOrderId,
              ...snapshot,
              taggedById: supervisorId,
              status: "DRAFT",
            },
            update: {
              timesheetDayId: targetDay.id,
              jobOrderId: entry.jobOrderId,
              ...snapshot,
              status: "DRAFT",
            },
          });
          regularSlotsCopied += 1;
        }
      }
    }

    return {
      rosterCopied,
      daysCopied,
      regularSlotsCopied,
      otRowsSkipped,
      closedJobOrderSlots,
      unsupportedLegacyEntries,
      conflictedSlots,
      lockedEmployeeIds,
    };
  });

  await writeAudit(req.user!.id, "TIMESHEET_CARRY_FORWARD", "timesheet_day", dateStr, {
    supervisorId,
    sourceDate: formatDateOnly(sourceDate),
    targetDate: dateStr,
    ...result,
  });

  res.json({ ok: true, sourceDate: formatDateOnly(sourceDate), ...result });
});

/**
 * Job Order picker rows for ONE Department + Section + Project selection.
 *
 * The Department is the supervisor's own and is never taken from the client.
 * Section is freely chosen among that Department's active sections and Project
 * is freely chosen; together they narrow the Job Order list. Every row is
 * returned as `Job_Order-Job_Description`, plus `wbsNo` and the Project
 * `colorKey`, so the client can disambiguate without showing the WBS.
 */
timesheetRouter.get("/job-orders", async (req, res) => {
  const supervisorId = Number(req.query.supervisor_id);
  if (!supervisorId) return res.status(400).json({ error: "supervisor_id required" });
  if (req.user!.role !== "ADMIN" && supervisorId !== req.user!.id) {
    return res.status(403).json({ error: "You can only list your own Job Orders.", code: "NOT_OWNER" });
  }
  const departmentId = await supervisorDepartmentForActor(req.user!.role, req.user!.id, supervisorId);
  if (departmentId == null) return teamAccessDenied(res);

  const department = await prisma.department.findUnique({
    where: { id: departmentId },
    select: { id: true, name: true },
  });
  const sections = await loadDepartmentSections(departmentId);
  const projectId = Number(req.query.project_id);
  const sectionId = Number(req.query.section_id);
  // The Project is required; the Section is optional. A supervisor is mapped to ONE
  // department, so "this project, in my department" is the whole filter, and the section a
  // booked hour belongs to comes from the Job Order that is chosen.
  const jobOrders =
    Number.isInteger(projectId) && projectId > 0
      ? await loadSlotJobOrders({
          departmentId,
          projectId,
          ...(Number.isInteger(sectionId) && sectionId > 0 ? { sectionId } : {}),
        })
      : [];

  res.json({ department, sections, jobOrders });
});

timesheetRouter.get("/", async (req, res) => {
  const supervisorId = Number(req.query.supervisor_id);
  const dateStr = String(req.query.date || "");
  if (!supervisorId || !dateStr) {
    return res.status(400).json({ error: "supervisor_id and date required" });
  }
  if (req.user!.role !== "ADMIN" && supervisorId !== req.user!.id) {
    return res.status(403).json({ error: "You can only view your own timesheet.", code: "NOT_OWNER" });
  }
  const workDate = parseDateOnly(dateStr);
  const supervisorDepartmentId = await supervisorDepartmentForActor(req.user!.role, req.user!.id, supervisorId);
  if (supervisorDepartmentId == null) return teamAccessDenied(res);
  const maxDailyHours = getMaxDailyHours();

  // The supervisor's Department is FIXED to his own; Section and Project are
  // freely chosen from that Department's active sections and the active projects.
  const department = await prisma.department.findUnique({
    where: { id: supervisorDepartmentId },
    select: { id: true, name: true },
  });
  const sections = await loadDepartmentSections(supervisorDepartmentId);

  const team = await prisma.dailyTeamSelection.findMany({
    where: {
      supervisorId, workDate, removedAt: null,
      employee: {
        departmentId: supervisorDepartmentId, employmentType: "CLMS",
        sectionAssignment: { section: { departmentId: supervisorDepartmentId, active: true } },
      },
    },
    include: { employee: { include: { department: true } } },
    orderBy: { createdAt: "asc" },
  });

  const days = await prisma.timesheetDay.findMany({
    where: { taggedById: supervisorId, workDate },
    include: {
      entries: {
        include: {
          projectWbs: { include: { project: { select: { name: true, colorKey: true } } } },
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

  // Supervisor personal hours are recorded only through My Hours. This grid is
  // restricted to contract labour explicitly assigned to the daily team.
  const teamWithSelf: { employeeId: number; employee: (typeof team)[number]["employee"]; isSelf: boolean }[] =
    team.map((item) => ({ employeeId: item.employeeId, employee: item.employee, isSelf: false }));

  const employeeIds = teamWithSelf.map((t) => t.employeeId);
  const dayTotals = await getEmployeeDayHourTotals(employeeIds, workDate, supervisorId);
  // Only submitted/approved allocations from other supervisors are globally
  // visible. Their drafts remain private until they win the submission claim.
  const otherEntries = employeeIds.length
    ? await prisma.timesheetEntry.findMany({
        where: {
          employeeId: { in: employeeIds },
          workDate,
          taggedById: { not: supervisorId },
          status: { in: BOOKED_ENTRY_STATUSES },
          OR: [{ projectWbsId: { not: null } }, { jobOrderId: { not: null } }],
        },
        include: {
          taggedBy: { select: { id: true, name: true } },
          projectWbs: { include: { project: { select: { name: true, colorKey: true } } } },
          jobOrder: { include: { project: true, projectWbs: true } },
        },
      })
    : [];
  const otherEntriesByEmployee = new Map<number, typeof otherEntries>();
  for (const entry of otherEntries) {
    const list = otherEntriesByEmployee.get(entry.employeeId) ?? [];
    list.push(entry);
    otherEntriesByEmployee.set(entry.employeeId, list);
  }

  // Active projects + their job orders, for the Bulk Assignment block + per-row Allocation.
  const projects = await prisma.project.findMany({
    where: { active: true },
    orderBy: { sortOrder: "asc" },
    select: {
      id: true,
      code: true,
      name: true,
      colorKey: true,
      isNonProject: true,
      // Job Orders of the supervisor's own Department; the Section filter is
      // applied when the supervisor picks a section (see GET /job-orders).
      jobOrders: {
        where: { status: "active", departmentId: supervisorDepartmentId, department: { active: true } },
        orderBy: { code: "asc" },
        select: {
          id: true,
          code: true,
          name: true,
          status: true,
          budgetedHours: true,
          sectionId: true,
          projectWbs: { select: { wbsCode: true } },
        },
      },
    },
  });

  // Build per-employee rows: 4 shift slots + derived totals + edit-lock info.
  const rows = teamWithSelf.map((t) => {
    const day = dayByEmployee.get(t.employeeId);
    const ownSlots = buildShiftRows(day?.entries ?? []);
    const external = otherEntriesByEmployee.get(t.employeeId) ?? [];
    const slots = ownSlots.map((slot) => {
      const bookings = external.filter(
        (entry) => entry.otHours == null && entryOverlapsShift(entry, slot.shiftSlot)
      );
      const displayBooking =
        bookings.find((entry) => BOOKED_ENTRY_STATUSES.includes(entry.status)) ?? bookings[0] ?? null;
      return {
        ...slot,
        bookedByOther: bookings.length > 0,
        bookedBySupervisorNames: [...new Set(bookings.map((entry) => entry.taggedBy.name))],
        otherBookingSubmitted: bookings.some((entry) => BOOKED_ENTRY_STATUSES.includes(entry.status)),
        otherBookingStatus: displayBooking?.status ?? null,
        otherProjectColorKey:
          displayBooking?.jobOrder?.project.colorKey ?? displayBooking?.projectWbs?.project?.colorKey ?? null,
      };
    });
    const ownOtEntry = day?.entries.find((e) => e.otHours != null) ?? null;
    const externalOtEntries = external.filter((e) => e.otHours != null);
    const externalOtEntry = externalOtEntries[0] ?? null;
    // A submitted/approved OT booking from another supervisor wins the display
    // and is read-only, matching cross-supervisor regular-slot behavior.
    const otEntry = externalOtEntry ?? ownOtEntry;
    const filledSlots = slots.filter((s) => s.jobOrderId != null).length;
    const employeeDayTotals = dayTotals.get(t.employeeId);
    const otherSlots = employeeDayTotals?.otherSlots ?? [];
    const otherHours = employeeDayTotals?.otherHours ?? 0;
    // Service totals are true hours across this supervisor plus eligible bookings
    // from other supervisors (shift slot = 2h; legacy hour slot = 1h).
    const dayTotalHours = employeeDayTotals?.totalHours ?? filledSlots * 2;
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
      isSelf: t.isSelf,
      remarks: day?.remarks ?? "",
      status,
      slots,
      otHours: otEntry?.otHours ?? null,
      otJobOrderId: otEntry?.jobOrderId ?? null,
      otProjectId: otEntry?.projectId ?? otEntry?.jobOrder?.project.id ?? null,
      otSectionId: otEntry?.sectionId ?? null,
      otDepartmentId: otEntry?.departmentId ?? null,
      otProjectColorKey: otEntry?.jobOrder?.project.colorKey ?? null,
      otLocked:
        externalOtEntry != null || (ownOtEntry != null && isProtectedEntryStatus(ownOtEntry.status)),
      otBookedByOther: externalOtEntry != null,
      otBookedBySupervisorNames: [
        ...new Set(externalOtEntries.map((entry) => entry.taggedBy.name)),
      ],
      otOtherBookingStatus: externalOtEntry?.status ?? null,
      filledSlots,
      filled: filledSlots > 0 || (otEntry?.otHours ?? 0) > 0,
      fullShiftDone: filledSlots === SHIFT_SLOTS.length,
      otherHours,
      otherSlots,
      dayTotalHours,
      exceedsLimit,
      remarksRequired: (exceedsLimit && filledSlots > 0) || (ownOtEntry?.otHours ?? 0) > 0,
      active: t.employee.active,
      terminatedAt: t.employee.terminatedAt,
      canSubmitRetainedDraft: canSubmitRetainedDraft(t.employee, day),
      editMode: t.employee.active ? lock.editMode : "locked",
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

  const filledCount = rows.filter((r) => r.filledSlots > 0 || (r.otHours ?? 0) > 0).length;
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
    department,
    sections,
    projects: projects.map((p) => ({
      id: p.id,
      code: p.code,
      name: p.name,
      colorKey: p.colorKey,
      isNonProject: p.isNonProject,
      jobOrders: p.jobOrders.map((j) => ({
        id: j.id,
        code: j.code,
        name: j.name,
        label: jobOrderOptionLabel(j),
        wbsNo: j.projectWbs?.wbsCode ?? null,
        colorKey: p.colorKey,
        projectId: p.id,
        projectName: p.name,
        sectionId: j.sectionId,
        standing: j.sectionId == null,
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

timesheetRouter.put("/day", serializeTimesheetMutation, async (req, res) => {
  const parsed = timesheetDaySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const { supervisorId, workDate: dateStr, rows } = parsed.data;
  // Owner enforcement: only the timesheet's owner supervisor may edit it.
  if (req.user!.role !== "ADMIN" && supervisorId !== req.user!.id) {
    return res.status(403).json({ error: "You can only edit your own timesheet.", code: "NOT_OWNER" });
  }
  const workDate = parseDateOnly(dateStr);
  if (!(await hasTeamAccess(supervisorId, await supervisorDepartmentForActor(req.user!.role, req.user!.id, supervisorId), workDate, rows.map((row) => row.employeeId)))) {
    return teamAccessDenied(res);
  }
  const inactiveEmployees = await prisma.employee.findMany({
    where: { id: { in: rows.map((row) => row.employeeId) }, active: false }, select: { id: true },
  });
  const inactiveIds = new Set(inactiveEmployees.map((employee) => employee.id));
  for (const row of rows.filter((item) => inactiveIds.has(item.employeeId))) {
    const existing = await prisma.timesheetDay.findUnique({
      where: { employeeId_workDate_taggedById: { employeeId: row.employeeId, workDate, taggedById: supervisorId } },
      include: { entries: true },
    });
    const existingByShift = new Map((existing?.entries ?? []).filter((entry) => entry.shiftSlot != null).map((entry) => [entry.shiftSlot as string, entry]));
    const changed = (row.remarks ?? "") !== (existing?.remarks ?? "") || row.slots.some(
      (slot) => (existingByShift.get(slot.shiftSlot)?.jobOrderId ?? null) !== slot.jobOrderId
    );
    if (changed) return res.status(409).json(inactiveEmployeePayload());
  }
  const requestedJobOrderIds = rows.flatMap((row) => row.slots.map((slot) => slot.jobOrderId).filter((id): id is number => id != null));
  const assignable = await assignableJobOrders(requestedJobOrderIds);
  if ([...new Set(requestedJobOrderIds)].some((id) => !assignable.has(id))) {
    return res.status(400).json(invalidJobOrderPayload());
  }
  // Attribution snapshot per requested Job Order, written on every create AND update.
  const snapshots = snapshotsFromJobOrders([...assignable.values()]);
  const requestedClaims: SlotClaim[] = rows.filter((row) => !inactiveIds.has(row.employeeId)).flatMap((row) =>
    row.slots
      .filter((slot) => slot.jobOrderId != null)
      .map((slot) => ({ employeeId: row.employeeId, shiftSlot: slot.shiftSlot, hourSlot: null }))
  );
  const externalConflicts = await findExternalBookedConflicts(supervisorId, workDate, requestedClaims);
  if (externalConflicts.length) {
    await discardLosingDraftSlots(supervisorId, workDate, externalConflicts);
    return res.status(409).json(bookedConflictPayload(externalConflicts));
  }

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
        employee: { select: { active: true, terminatedAt: true } },
        approvals: {
          where: { action: "APPROVE" },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
    });

    const employeeLifecycle = existing?.employee ?? await prisma.employee.findUnique({
      where: { id: row.employeeId }, select: { active: true, terminatedAt: true },
    });
    if (!employeeLifecycle) {
      lockViolations.push({ employeeId: row.employeeId, error: "Employee not found." });
      continue;
    }
    if (!employeeLifecycle.active) {
      const existingByShift = new Map(
        (existing?.entries ?? []).filter((entry) => entry.shiftSlot != null).map((entry) => [entry.shiftSlot as string, entry])
      );
      const remarksChanged = (row.remarks ?? "") !== (existing?.remarks ?? "");
      const slotsChanged = row.slots.some(
        (slot) => (existingByShift.get(slot.shiftSlot)?.jobOrderId ?? null) !== slot.jobOrderId
      );
      if (remarksChanged || slotsChanged) {
        lockViolations.push({ employeeId: row.employeeId, error: inactiveEmployeePayload().error });
      }
      continue;
    }

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
      // The daily grid submits all visible employees together. Ignore a locked
      // row when the client merely echoes its current values; only reject an
      // actual attempt to change protected data.
      const existingByShift = new Map(
        existing!.entries.filter((e) => e.shiftSlot != null).map((e) => [e.shiftSlot as string, e])
      );
      const remarksChanged = (row.remarks ?? "") !== (existing!.remarks ?? "");
      const slotsChanged = row.slots.some(
        (slot) => (existingByShift.get(slot.shiftSlot)?.jobOrderId ?? null) !== slot.jobOrderId
      );
      if (!remarksChanged && !slotsChanged) continue;

      lockViolations.push({
        employeeId: row.employeeId,
        error: "Timesheet has been submitted and cannot be edited. Only HOD/Project Head rejection unlocks it.",
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
                "Cannot clear or change slots that were already submitted or approved.",
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
              ...snapshotForBooking(snapshots, s.jobOrderId),
              taggedById: supervisorId,
              status: "DRAFT",
            },
            update: {
              jobOrderId: s.jobOrderId,
              ...snapshotForBooking(snapshots, s.jobOrderId),
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
              ...snapshotForBooking(snapshots, s.jobOrderId),
              taggedById: supervisorId,
              status: "DRAFT",
            },
            update: {
              jobOrderId: s.jobOrderId,
              ...snapshotForBooking(snapshots, s.jobOrderId),
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
            ...snapshotForBooking(snapshots, s.jobOrderId),
            taggedById: supervisorId,
            status: "DRAFT",
          },
          update: {
            jobOrderId: s.jobOrderId,
            ...snapshotForBooking(snapshots, s.jobOrderId),
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
timesheetRouter.post("/bulk-assign", serializeTimesheetMutation, async (req, res) => {
  const parsed = bulkAssignSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const { supervisorId, workDate: dateStr, projectId, jobOrderId, slots } = parsed.data;
  // Owner enforcement: only the timesheet's owner supervisor may edit it.
  if (req.user!.role !== "ADMIN" && supervisorId !== req.user!.id) {
    return res.status(403).json({ error: "You can only edit your own timesheet.", code: "NOT_OWNER" });
  }
  const workDate = parseDateOnly(dateStr);
  if (!(await hasTeamAccess(supervisorId, await supervisorDepartmentForActor(req.user!.role, req.user!.id, supervisorId), workDate, slots.map((slot) => slot.employeeId)))) {
    return teamAccessDenied(res);
  }
  const requestedClaims: SlotClaim[] = slots.map((slot) => ({
    employeeId: slot.employeeId,
    shiftSlot: slot.shiftSlot,
    hourSlot: null,
  }));
  const externalConflicts = await findExternalBookedConflicts(supervisorId, workDate, requestedClaims);
  if (externalConflicts.length) {
    await discardLosingDraftSlots(supervisorId, workDate, externalConflicts);
    return res.status(409).json(bookedConflictPayload(externalConflicts));
  }

  // Validate the JobOrder belongs to the Project.
  const jo = (await assignableJobOrders([jobOrderId])).get(jobOrderId);
  if (!jo) return res.status(400).json(invalidJobOrderPayload());
  if (jo.projectId !== projectId) {
    return res.status(400).json({ error: "JobOrder does not belong to the selected project" });
  }
  const snapshot = resolveAttributionSnapshot(jo);

  // Group slots by employee for edit-lock check + day upsert.
  const byEmployee = new Map<number, ShiftSlot[]>();
  for (const s of slots) {
    const list = byEmployee.get(s.employeeId) ?? [];
    list.push(s.shiftSlot);
    byEmployee.set(s.employeeId, list);
  }

  const activeEmployees = await prisma.employee.count({ where: { id: { in: [...byEmployee.keys()] }, active: true } });
  if (activeEmployees !== byEmployee.size) return res.status(409).json(inactiveEmployeePayload());

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
        error: "Timesheet has been submitted and cannot be edited.",
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
          ...snapshot,
          taggedById: supervisorId,
          status: "DRAFT",
        },
        update: {
          jobOrderId,
          ...snapshot,
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
timesheetRouter.put("/entry", serializeTimesheetMutation, async (req, res) => {
  const parsed = setSlotJobOrderSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const { supervisorId, workDate: dateStr, employeeId, shiftSlot, jobOrderId } = parsed.data;
  // Owner enforcement: only the timesheet's owner supervisor may edit it.
  if (req.user!.role !== "ADMIN" && supervisorId !== req.user!.id) {
    return res.status(403).json({ error: "You can only edit your own timesheet.", code: "NOT_OWNER" });
  }
  const workDate = parseDateOnly(dateStr);
  if (!(await hasTeamAccess(supervisorId, await supervisorDepartmentForActor(req.user!.role, req.user!.id, supervisorId), workDate, [employeeId]))) {
    return teamAccessDenied(res);
  }
  const employee = await prisma.employee.findUnique({ where: { id: employeeId }, select: { active: true } });
  if (!employee?.active) return res.status(409).json(inactiveEmployeePayload());

  let snapshot = resolveAttributionSnapshot(null);
  if (jobOrderId != null) {
    const jo = (await assignableJobOrders([jobOrderId])).get(jobOrderId);
    if (!jo) return res.status(400).json(invalidJobOrderPayload());
    snapshot = resolveAttributionSnapshot(jo);
    const externalConflicts = await findExternalBookedConflicts(supervisorId, workDate, [
      { employeeId, shiftSlot, hourSlot: null },
    ]);
    if (externalConflicts.length) {
      await discardLosingDraftSlots(supervisorId, workDate, externalConflicts);
      return res.status(409).json(bookedConflictPayload(externalConflicts));
    }
  }

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
      ...snapshot,
      taggedById: supervisorId,
      status: "DRAFT",
    },
    update: { jobOrderId, ...snapshot, timesheetDayId: day.id, status: "DRAFT" },
  });

  res.json({ ok: true });
});

/**
 * Add/update/clear overtime (OT) hours for an employee on a day.
 * OT is additive and separate from regular slots. An OT-only holiday day has
 * zero overhead; mixed regular + OT days retain unused regular capacity as
 * overhead. One OT row per (employee, workDate, taggedById) is
 * enforced here (SQLite treats NULL as distinct in unique constraints, so the
 * schema can't). Owner-checked + status-locked + audited, same as assign/unassign.
 */
timesheetRouter.put("/ot", serializeTimesheetMutation, async (req, res) => {
  const supervisorId = Number(req.body.supervisorId);
  const dateStr = String(req.body.workDate || "");
  const employeeId = Number(req.body.employeeId);
  const jobOrderId = req.body.jobOrderId == null ? null : Number(req.body.jobOrderId);
  const otHours = req.body.otHours == null ? null : Number(req.body.otHours);
  const remarksProvided = typeof req.body.remarks === "string";
  const remarks = remarksProvided ? String(req.body.remarks).trim() : null;

  if (!supervisorId || !dateStr || !employeeId) {
    return res.status(400).json({ error: "supervisorId, workDate and employeeId required" });
  }
  // Owner enforcement: only the timesheet's owner supervisor may add OT.
  if (req.user!.role !== "ADMIN" && supervisorId !== req.user!.id) {
    return res.status(403).json({ error: "You can only edit your own timesheet.", code: "NOT_OWNER" });
  }
  const workDate = parseDateOnly(dateStr);
  if (!(await hasTeamAccess(supervisorId, await supervisorDepartmentForActor(req.user!.role, req.user!.id, supervisorId), workDate, [employeeId]))) {
    return teamAccessDenied(res);
  }
  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { active: true, employmentType: true },
  });
  if (!employee?.active) return res.status(409).json(inactiveEmployeePayload());
  if (otHours != null && employee.employmentType !== "CLMS") {
    return res.status(400).json({
      error: "Overtime entry is available only for contract workmen.",
      code: "OT_NOT_ALLOWED_FOR_PAYROLL",
    });
  }

  // Validate OT hours: integer 1-12 (configurable cap), or null to clear.
  const maxOt = Number(process.env.MAX_OT_HOURS || 12);
  // OT is booked to a Job Order, so it carries the same attribution snapshot.
  let otSnapshot = resolveAttributionSnapshot(null);
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
    const otJobOrder = (await assignableJobOrders([jobOrderId])).get(jobOrderId);
    if (!otJobOrder) {
      return res.status(400).json(invalidJobOrderPayload());
    }
    otSnapshot = resolveAttributionSnapshot(otJobOrder);

    const externalOt = await prisma.timesheetEntry.findFirst({
      where: {
        employeeId,
        workDate,
        taggedById: { not: supervisorId },
        status: { in: BOOKED_ENTRY_STATUSES },
        otHours: { not: null },
      },
      include: { taggedBy: { select: { id: true, name: true } } },
    });
    if (externalOt) {
      return res.status(409).json({
        error: `OT of this employee is already booked by Supervisor ${externalOt.taggedBy.name}.`,
        code: "OT_ALREADY_BOOKED",
        employeeId,
        supervisorId: externalOt.taggedById,
        supervisorName: externalOt.taggedBy.name,
        status: externalOt.status,
      });
    }
  }

  // Status lock: OT can only be added while the day is editable (DRAFT/REJECTED).
  const existing = await prisma.timesheetDay.findUnique({
    where: { employeeId_workDate_taggedById: { employeeId, workDate, taggedById: supervisorId } },
    include: { entries: true, approvals: { where: { action: "APPROVE" }, take: 1, orderBy: { createdAt: "desc" } } },
  });
  const effectiveRemarks = remarksProvided ? remarks : existing?.remarks?.trim() || null;
  if (otHours != null && !effectiveRemarks) {
    return res.status(400).json({
      error: "Remarks are mandatory when assigning OT hours.",
      code: "OT_REMARKS_REQUIRED",
    });
  }
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
    create: {
      employeeId,
      workDate,
      taggedById: supervisorId,
      status: "DRAFT",
      remarks: effectiveRemarks,
    },
    update: {
      status: isApprovedStatus(status) ? status : "DRAFT",
      ...(remarksProvided ? { remarks: effectiveRemarks } : {}),
    },
  });

  // One OT row per (employee, workDate, taggedById) — find the existing OT row.
  const existingOt = await prisma.timesheetEntry.findFirst({
    where: { timesheetDayId: day.id, otHours: { not: null } },
  });

  if (existingOt && existingOt.otHours === otHours && existingOt.jobOrderId === jobOrderId) {
    return res.json({ ok: true, otHours, jobOrderId });
  }
  if (existingOt && isProtectedEntryStatus(existingOt.status)) {
    return res.status(400).json({
      error: "Approved OT cannot be changed. HOD/Project Head must reject it first.",
      code: "TIMESHEET_ENTRY_LOCKED",
    });
  }

  if (otHours == null) {
    // Clear OT.
    if (existingOt) await prisma.timesheetEntry.delete({ where: { id: existingOt.id } });
  } else if (existingOt) {
    // Update existing OT row.
    await prisma.timesheetEntry.update({
      where: { id: existingOt.id },
      data: { jobOrderId, otHours, ...otSnapshot, status: "DRAFT" },
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
        ...otSnapshot,
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

timesheetRouter.post("/submit", serializeTimesheetMutation, async (req, res) => {
  const supervisorId = Number(req.body.supervisorId);
  const dateStr = String(req.body.workDate || "");
  if (!supervisorId || !dateStr) {
    return res.status(400).json({ error: "supervisorId and workDate required" });
  }
  // Owner enforcement: only the timesheet's owner supervisor may submit it.
  if (req.user!.role !== "ADMIN" && supervisorId !== req.user!.id) {
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
  if (employeeIds.length && !(await hasTeamAccess(supervisorId, await supervisorDepartmentForActor(req.user!.role, req.user!.id, supervisorId), workDate, employeeIds))) {
    return teamAccessDenied(res);
  }
  const dayTotals = await getEmployeeDayHourTotals(employeeIds, workDate, supervisorId);
  const bookedByOther = employeeIds.length
    ? await prisma.timesheetEntry.findMany({
        where: {
          employeeId: { in: employeeIds },
          workDate,
          taggedById: { not: supervisorId },
          status: { in: BOOKED_ENTRY_STATUSES },
          OR: [{ projectWbsId: { not: null } }, { jobOrderId: { not: null } }],
        },
        include: { taggedBy: { select: { id: true, name: true } } },
      })
    : [];

  const slotConflicts: {
    employeeId: number;
    employeeName: string;
    supervisorId: number;
    supervisorName: string;
    shiftSlot: string | null;
    hourSlot: number | null;
  }[] = [];
  for (const day of days) {
    const hasProtectedEntries = day.entries.some(
      (entry) => (entry.projectWbsId != null || entry.jobOrderId != null) && isProtectedEntryStatus(entry.status)
    );
    const lock = resolveEditLock(day.status, day.approvals[0]?.createdAt ?? day.updatedAt, {
      hasProtectedEntries,
    });
    if (lock.editMode === "locked") continue;

    const pendingEntries = day.entries.filter(
      (entry) =>
        entry.otHours == null &&
        (entry.shiftSlot != null || entry.hourSlot != null) &&
        ["DRAFT", "REJECTED"].includes(entry.status)
    );
    for (const entry of pendingEntries) {
      for (const other of bookedByOther) {
        if (other.otHours != null) continue;
        if (other.employeeId !== day.employeeId || !entriesOverlap(entry, other)) continue;
        if (
          slotConflicts.some(
            (item) =>
              item.employeeId === day.employeeId &&
              item.supervisorId === other.taggedById &&
              item.shiftSlot === entry.shiftSlot &&
              item.hourSlot === entry.hourSlot
          )
        ) continue;
        slotConflicts.push({
          employeeId: day.employeeId,
          employeeName: day.employee.name,
          supervisorId: other.taggedById,
          supervisorName: other.taggedBy.name,
          shiftSlot: entry.shiftSlot,
          hourSlot: entry.hourSlot,
        });
      }
    }
  }
  if (slotConflicts.length) {
    await discardLosingDraftSlots(supervisorId, workDate, slotConflicts);
    return res.status(409).json(bookedConflictPayload(slotConflicts));
  }

  const otConflict = days
    .flatMap((day) =>
      day.entries
        .filter((entry) => (entry.otHours ?? 0) > 0 && ["DRAFT", "REJECTED"].includes(entry.status))
        .map(() => bookedByOther.find((other) => other.employeeId === day.employeeId && other.otHours != null))
    )
    .find((entry) => entry != null);
  if (otConflict) {
    await prisma.timesheetEntry.deleteMany({
      where: {
        taggedById: supervisorId,
        workDate,
        employeeId: otConflict.employeeId,
        status: { in: ["DRAFT", "REJECTED"] },
        otHours: { not: null },
      },
    });
    return res.status(409).json({
      error: `OT of this employee is already booked by Supervisor ${otConflict.taggedBy.name}.`,
      code: "OT_ALREADY_BOOKED",
      employeeId: otConflict.employeeId,
      supervisorId: otConflict.taggedById,
      supervisorName: otConflict.taggedBy.name,
      status: otConflict.status,
    });
  }

  const missingOtRemarks = days
    .filter((day) => day.entries.some((entry) => (entry.otHours ?? 0) > 0) && !day.remarks?.trim())
    .map((day) => ({ employeeId: day.employeeId, employeeName: day.employee.name }));
  if (missingOtRemarks.length) {
    return res.status(400).json({
      error: `Remarks are mandatory when overtime is entered for: ${missingOtRemarks
        .map((item) => item.employeeName)
        .join(", ")}.`,
      code: "OT_REMARKS_REQUIRED",
      employees: missingOtRemarks,
    });
  }

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
      (e) => (e.projectWbsId != null || e.jobOrderId != null) && isProtectedEntryStatus(e.status)
    );
    const lock = resolveEditLock(day.status, day.approvals[0]?.createdAt ?? day.updatedAt, {
      hasProtectedEntries,
    });
    if (lock.editMode === "locked") {
      lockedIds.push(day.id);
      continue;
    }
    if (!day.entries.length) continue;
    // Use the shared true-hour total so four 2-hour shift slots equal 8h and
    // eligible bookings from other supervisors are included consistently.
    const total = dayTotals.get(day.employeeId)?.totalHours ?? 0;
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
    if (!d.employee.active && !canSubmitRetainedDraft(d.employee, d)) return false;
    if (!d.entries.length) return false;
    if (lockedIds.includes(d.id)) return false;
    const hasProtectedEntries = d.entries.some(
      (e) => (e.projectWbsId != null || e.jobOrderId != null) && isProtectedEntryStatus(e.status)
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
    // A winning concurrent submit may already have removed this supervisor's
    // overlapping draft rows. Return the winning booking, not a misleading
    // "no project hours" response, so the client reloads the replacement.
    const replacementConflicts: ExternalSlotConflict[] = bookedByOther.map((other) => ({
      employeeId: other.employeeId,
      employeeName: days.find((day) => day.employeeId === other.employeeId)?.employee.name ?? `#${other.employeeId}`,
      supervisorId: other.taggedById,
      supervisorName: other.taggedBy.name,
      shiftSlot: other.shiftSlot,
      hourSlot: other.hourSlot,
    }));
    if (!lockedIds.length && replacementConflicts.length) {
      return res.status(409).json(bookedConflictPayload(replacementConflicts));
    }
    return res.status(400).json({
      error: lockedIds.length
        ? "No editable timesheets to submit. Submitted and approved timesheets cannot be modified."
        : "No project hours to submit. Tag at least one hour before submitting for approval.",
    });
  }

  const winningClaims: SlotClaim[] = submittable.flatMap((day) =>
    day.entries
      .filter(
        (entry) =>
          entry.otHours == null &&
          (entry.shiftSlot != null || entry.hourSlot != null) &&
          ["DRAFT", "REJECTED"].includes(entry.status)
      )
      .map((entry) => ({
        employeeId: day.employeeId,
        shiftSlot: entry.shiftSlot,
        hourSlot: entry.hourSlot,
      }))
  );
  const replacedDraftSlots = await discardCompetingExternalDrafts(
    supervisorId,
    workDate,
    winningClaims
  );
  const winningOtEmployeeIds = submittable
    .filter((day) =>
      day.entries.some(
        (entry) => (entry.otHours ?? 0) > 0 && ["DRAFT", "REJECTED"].includes(entry.status)
      )
    )
    .map((day) => day.employeeId);
  const replacedDraftOt = winningOtEmployeeIds.length
    ? await prisma.timesheetEntry.deleteMany({
        where: {
          employeeId: { in: winningOtEmployeeIds },
          workDate,
          taggedById: { not: supervisorId },
          status: { in: ["DRAFT", "REJECTED"] },
          otHours: { not: null },
        },
      })
    : { count: 0 };

  let submittedCount = 0;
  for (const dayId of dayIds) {
    const day = days.find((d) => d.id === dayId)!;
    const hasProtectedEntries = day.entries.some(
      (e) => (e.projectWbsId != null || e.jobOrderId != null) && isProtectedEntryStatus(e.status)
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
    replacedDraftSlots,
    replacedDraftOt: replacedDraftOt.count,
  });

  res.json({
    ok: true,
    submitted: submittedCount,
    maxDailyHours,
    replacedDraftSlots,
    replacedDraftOt: replacedDraftOt.count,
    warnings: warnings.map((w) => ({
      ...w,
      message: `${w.employeeName} has ${w.dayTotalHours}h (limit ${w.maxDailyHours}h). Overtime reason recorded for HOD: "${w.remarks}"`,
    })),
  });
});
