import { Router } from "express";
import { prisma } from "../db";
import { requireAuth, requireRoles } from "../middleware/auth";
import { writeAudit } from "../audit";
import { getMaxDailyHours } from "../config";
import { getEmployeeDayHourTotals } from "../services/hours";
import { isProtectedEntryStatus } from "../services/timesheetEditLock";

export const approvalsRouter = Router();

approvalsRouter.use(requireAuth);

const APPROVER_ROLES = ["HOD", "PM", "ADMIN"] as const;

type ProjectWbsRef = { colorKey: string; name: string } | null;
type JobOrderRef = {
  project: { colorKey: string; name: string };
} | null;

type EntryLike = {
  projectWbsId: number | null;
  jobOrderId: number | null;
  status: string;
  projectWbs: ProjectWbsRef;
  jobOrder: JobOrderRef;
};

type DayRow = {
  id: number;
  employeeId: number;
  workDate: Date;
  status: string;
  remarks: string | null;
  updatedAt: Date;
  employee: {
    id: number;
    name: string;
    ecNo: string;
    department: { name: string };
  };
  taggedBy: { id: number; name: string; email: string };
  entries: EntryLike[];
  approvals: {
    action: string;
    comment: string | null;
    createdAt: Date;
    approver: { id: number; name: string; role: string };
  }[];
};

function pendingStatusesForRole(role: string): string[] {
  if (role === "HOD") return ["SUBMITTED"];
  if (role === "PM") return ["HOD_APPROVED"];
  return ["SUBMITTED", "HOD_APPROVED"];
}

function nextStatusOnApprove(role: string, current: string): string | null {
  if ((role === "HOD" || role === "ADMIN") && current === "SUBMITTED") return "HOD_APPROVED";
  if ((role === "PM" || role === "ADMIN") && current === "HOD_APPROVED") return "PM_APPROVED";
  return null;
}

function roleLabel(role: string): string {
  if (role === "PM") return "Project Head";
  if (role === "HOD") return "HOD";
  if (role === "ADMIN") return "Admin";
  return role;
}

function daysPending(updatedAt: Date): number {
  const ms = Date.now() - updatedAt.getTime();
  return Math.max(0, Math.floor(ms / (24 * 60 * 60 * 1000)));
}

function projectHoursFromEntries(entries: EntryLike[]) {
  const byKey: Record<string, number> = { A: 0, B: 0, C: 0 };
  let overhead = 0;
  for (const e of entries) {
    // A tagged entry is one with projectWbsId OR jobOrderId. The project color
    // can come from the legacy projectWbs relation OR the new
    // jobOrder.project relation. Without the jobOrder fallback, days tagged
    // exclusively via the supervisor's Daily Timesheet Entry (jobOrder-only)
    // appear as 0 project hours to HOD/PM.
    const colorKey = e.projectWbs?.colorKey ?? e.jobOrder?.project.colorKey ?? null;
    if (e.projectWbsId == null && e.jobOrderId == null) continue;
    if (!colorKey) continue;
    const key = String(colorKey).toUpperCase();
    if (key === "A" || key === "B" || key === "C") {
      byKey[key] += 1;
    } else {
      overhead += 1;
    }
  }
  const totalAlloc = byKey.A + byKey.B + byKey.C + overhead;
  return { projectHours: byKey, overhead, totalAlloc };
}

/** Entries pending this approver's action (amendments keep prior approvals on other entries). */
function pendingEntriesForRole(d: DayRow, role: string) {
  // A "tagged" entry is one tagged to a project (via legacy projectWbs OR via
  // the new jobOrder path). Filter must OR both, otherwise days tagged solely
  // through the supervisor's Daily Timesheet Entry never appear here.
  const tagged = d.entries.filter((e) => e.projectWbsId != null || e.jobOrderId != null);
  const hasProtected = tagged.some((e) => isProtectedEntryStatus(e.status));
  const hasPriorApprove = d.approvals.some((a) => a.action === "APPROVE");

  if (role === "HOD" || (role === "ADMIN" && d.status === "SUBMITTED")) {
    if (hasProtected || hasPriorApprove) {
      const pending = tagged.filter((e) => e.status === "SUBMITTED");
      return { entries: pending, isAmendment: pending.length > 0 && pending.length < tagged.length };
    }
    return { entries: tagged, isAmendment: false };
  }

  if (role === "PM" || (role === "ADMIN" && d.status === "HOD_APPROVED")) {
    // PM reviews HOD-approved sheets; for amendments after PM approve, only SUBMITTED slots
    if (tagged.some((e) => e.status === "PM_APPROVED") && tagged.some((e) => e.status === "SUBMITTED")) {
      const pending = tagged.filter((e) => e.status === "SUBMITTED");
      return { entries: pending, isAmendment: true };
    }
    return { entries: tagged.filter((e) => e.status === "HOD_APPROVED" || e.status === "SUBMITTED"), isAmendment: false };
  }

  return { entries: tagged, isAmendment: false };
}

async function conflictEmployeeIds(employeeIds: number[], workDates: Date[]): Promise<Set<string>> {
  const flagged = new Set<string>();
  if (!employeeIds.length || !workDates.length) return flagged;

  const entries = await prisma.timesheetEntry.findMany({
    where: {
      employeeId: { in: employeeIds },
      workDate: { in: workDates },
      // Conflict = two supervisors tagging the same slot (any flow). Include
      // both projectWbsId (legacy) and jobOrderId (new) so we don't miss
      // jobOrder-only conflicts.
      OR: [{ projectWbsId: { not: null } }, { jobOrderId: { not: null } }],
    },
    select: { employeeId: true, workDate: true, taggedById: true },
  });

  const bag = new Map<string, Set<number>>();
  for (const e of entries) {
    const key = `${e.employeeId}|${e.workDate.toISOString().slice(0, 10)}`;
    let set = bag.get(key);
    if (!set) {
      set = new Set();
      bag.set(key, set);
    }
    set.add(e.taggedById);
  }
  for (const [key, supervisors] of bag) {
    if (supervisors.size > 1) flagged.add(key);
  }
  return flagged;
}

function mapEmployeeRow(
  d: DayRow,
  dayTotalHours: number,
  maxDailyHours: number,
  conflictKeys: Set<string>,
  role: string
) {
  const workDate = d.workDate.toISOString().slice(0, 10);
  const { entries: pendingEntries, isAmendment } = pendingEntriesForRole(d, role);
  const { projectHours, overhead, totalAlloc } = projectHoursFromEntries(pendingEntries);
  // "All tagged" (across the whole day, not just pending) must include both flows too.
  const allTagged = projectHoursFromEntries(d.entries);
  const unallocatedHours = Math.max(0, maxDailyHours - dayTotalHours);
  const conflictKey = `${d.employeeId}|${workDate}`;
  return {
    id: d.id,
    workDate,
    status: d.status,
    remarks: d.remarks,
    pendingDays: daysPending(d.updatedAt),
    projectHours,
    overhead,
    totalAlloc,
    /** Remaining capacity vs daily max (empty / untagged hours). */
    unallocatedHours,
    /** Full day total across all supervisors/slots — used for OT alerts. */
    dayTotalHours,
    allTotalAlloc: allTagged.totalAlloc,
    maxDailyHours,
    exceedsLimit: dayTotalHours > maxDailyHours,
    isAmendment,
    hasConflict: conflictKeys.has(conflictKey),
    employee: {
      id: d.employee.id,
      name: d.employee.name,
      ecNo: d.employee.ecNo,
      department: d.employee.department.name,
    },
    supervisor: d.taggedBy,
  };
}

type EmployeeMapped = ReturnType<typeof mapEmployeeRow>;

function groupBySupervisor(rows: EmployeeMapped[]) {
  const groups = new Map<
    string,
    {
      supervisorId: number;
      supervisorName: string;
      workDate: string;
      pendingDays: number;
      hasConflict: boolean;
      isAmendment: boolean;
      projectHours: Record<string, number>;
      overhead: number;
      totalAlloc: number;
      unallocatedHours: number;
      exceedsLimit: boolean;
      employees: EmployeeMapped[];
    }
  >();

  for (const row of rows) {
    const key = `${row.supervisor.id}|${row.workDate}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        supervisorId: row.supervisor.id,
        supervisorName: row.supervisor.name,
        workDate: row.workDate,
        pendingDays: row.pendingDays,
        hasConflict: false,
        isAmendment: false,
        projectHours: { A: 0, B: 0, C: 0 },
        overhead: 0,
        totalAlloc: 0,
        unallocatedHours: 0,
        exceedsLimit: false,
        employees: [],
      };
      groups.set(key, g);
    }
    g.employees.push(row);
    g.pendingDays = Math.max(g.pendingDays, row.pendingDays);
    g.hasConflict = g.hasConflict || row.hasConflict;
    g.isAmendment = g.isAmendment || row.isAmendment;
    g.exceedsLimit = g.exceedsLimit || row.exceedsLimit;
    g.projectHours.A += row.projectHours.A;
    g.projectHours.B += row.projectHours.B;
    g.projectHours.C += row.projectHours.C;
    g.overhead += row.overhead;
    g.totalAlloc += row.totalAlloc;
    g.unallocatedHours += row.unallocatedHours;
  }

  return Array.from(groups.values()).sort((a, b) => {
    if (a.workDate !== b.workDate) return b.workDate.localeCompare(a.workDate);
    return a.supervisorName.localeCompare(b.supervisorName);
  });
}

const dayInclude = {
  employee: { include: { department: true } },
  taggedBy: { select: { id: true, name: true, email: true } },
  entries: {
    // Load all entries that reference a project (legacy ProjectWbs OR new JobOrder).
    // Without the OR, jobOrder-only days render as empty rows to HOD.
    where: {
      OR: [{ projectWbsId: { not: null } }, { jobOrderId: { not: null } }],
    },
    include: { projectWbs: true, jobOrder: { include: { project: true } } },
  },
  approvals: {
    include: { approver: { select: { id: true, name: true, role: true } } },
    orderBy: { createdAt: "desc" as const },
  },
};

async function buildRows(days: DayRow[], maxDailyHours: number, role: string) {
  const employeeIds = [...new Set(days.map((d) => d.employeeId))];
  const workDates = [...new Set(days.map((d) => d.workDate.toISOString()))].map((s) => new Date(s));
  const conflictKeys = await conflictEmployeeIds(employeeIds, workDates);

  const rows: EmployeeMapped[] = [];
  for (const d of days) {
    const { entries: pendingEntries } = pendingEntriesForRole(d, role);
    if (pendingEntries.length === 0) continue;
    const totals = await getEmployeeDayHourTotals([d.employeeId], d.workDate);
    const dayTotalHours = totals.get(d.employeeId)?.totalHours ?? 0;
    rows.push(mapEmployeeRow(d, dayTotalHours, maxDailyHours, conflictKeys, role));
  }
  return rows;
}

approvalsRouter.get("/pending", requireRoles(...APPROVER_ROLES), async (req, res) => {
  const role = req.user!.role;
  const statusFilter = pendingStatusesForRole(role);
  const maxDailyHours = getMaxDailyHours();

  const days = (await prisma.timesheetDay.findMany({
    where: {
      status: { in: statusFilter },
      // Only days that have at least one project-tagged hour (legacy WBS OR new JobOrder).
      entries: {
        some: { OR: [{ projectWbsId: { not: null } }, { jobOrderId: { not: null } }] },
      },
    },
    include: dayInclude,
    orderBy: [{ workDate: "desc" }, { updatedAt: "desc" }],
  })) as unknown as DayRow[];

  const rows = await buildRows(days, maxDailyHours, role);
  const received = groupBySupervisor(rows).filter((g) => g.employees.length > 0 && g.totalAlloc > 0);

  let returnedByPlanning: {
    id: number;
    workDate: string;
    supervisor: { id: number; name: string; email: string };
    employee: { id: number; name: string; ecNo: string; department: string };
    projectHours: Record<string, number>;
    overhead: number;
    totalAlloc: number;
    planningComment: string | null;
    planningReturnedAt: string | null;
    planningApprover: string | null;
  }[] = [];

  if (role === "HOD" || role === "ADMIN") {
    const returned = (await prisma.timesheetDay.findMany({
      where: {
        status: "PLANNING_RETURNED",
        entries: {
          some: { OR: [{ projectWbsId: { not: null } }, { jobOrderId: { not: null } }] },
        },
      },
      include: dayInclude,
      orderBy: [{ updatedAt: "desc" }],
    })) as unknown as DayRow[];

    returnedByPlanning = returned
      .map((d) => {
        const { projectHours, overhead, totalAlloc } = projectHoursFromEntries(d.entries);
        if (totalAlloc === 0) return null;
        const planning = d.approvals.find(
          (a) => a.action === "PLANNING_RETURN" || (a.action === "REJECT" && a.approver.role === "PM")
        );
        return {
          id: d.id,
          workDate: d.workDate.toISOString().slice(0, 10),
          supervisor: d.taggedBy,
          employee: {
            id: d.employee.id,
            name: d.employee.name,
            ecNo: d.employee.ecNo,
            department: d.employee.department.name,
          },
          projectHours,
          overhead,
          totalAlloc,
          planningComment: planning?.comment ?? d.remarks,
          planningReturnedAt: planning?.createdAt?.toISOString() ?? d.updatedAt.toISOString(),
          planningApprover: planning?.approver.name ?? null,
        };
      })
      .filter((row): row is NonNullable<typeof row> => row != null);
  }

  const projects = await prisma.projectWbs.findMany({
    where: { active: true },
    orderBy: { colorKey: "asc" },
    select: { id: true, code: true, name: true, colorKey: true, wbsCode: true },
  });

  res.json({
    role,
    roleLabel: roleLabel(role),
    maxDailyHours,
    projects,
    received,
    returnedByPlanning,
  });
});

approvalsRouter.get("/history", requireRoles(...APPROVER_ROLES), async (req, res) => {
  const approvals = await prisma.approval.findMany({
    where: {
      approverId: req.user!.id,
      action: { in: ["APPROVE", "REJECT", "PLANNING_RETURN", "SEND_BACK"] },
    },
    include: {
      timesheetDay: {
        include: {
          employee: { include: { department: true } },
          taggedBy: { select: { id: true, name: true, email: true } },
          entries: {
            where: { OR: [{ projectWbsId: { not: null } }, { jobOrderId: { not: null } }] },
            include: { projectWbs: true, jobOrder: { include: { project: true } } },
          },
        },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  const items = approvals.map((a) => {
    const d = a.timesheetDay;
    const { projectHours, overhead, totalAlloc } = projectHoursFromEntries(d.entries);
    return {
      approvalId: a.id,
      action: a.action,
      comment: a.comment,
      approvedAt: a.createdAt.toISOString(),
      resultingStatus: d.status,
      id: d.id,
      workDate: d.workDate.toISOString().slice(0, 10),
      projectHours,
      overhead,
      totalAlloc,
      employee: {
        id: d.employee.id,
        name: d.employee.name,
        ecNo: d.employee.ecNo,
        department: d.employee.department.name,
      },
      supervisor: d.taggedBy,
    };
  });

  res.json({ items, roleLabel: roleLabel(req.user!.role) });
});

/**
 * "Group by Job Order" lens for the Approvals page.
 * Sums consumption across the HOD's department for the period, split by
 * approved vs unapproved entry status, per Job Order.
 *
 * Note: this is scoped to the HOD's department (via supervisor + employee
 * department), matching the doc footnote "Figures reflect this department's
 * submissions only". Cross-department totals live on the Job Order Summary screen.
 */
approvalsRouter.get("/job-order-consumption", requireRoles(...APPROVER_ROLES), async (req, res) => {
  const role = req.user!.role;
  const departmentId = req.user!.departmentId;

  // Scope: only entries in this approver's department (via supervisor OR employee),
  // matching the pending view. If the approver has no department (e.g. PM), no
  // department filter is applied — consistent with the existing pending view.
  const deptWhere =
    departmentId != null
      ? {
          OR: [{ taggedBy: { departmentId } }, { employee: { departmentId } }],
        }
      : {};

  const entries = await prisma.timesheetEntry.findMany({
    where: {
      jobOrderId: { not: null },
      ...deptWhere,
    },
    include: {
      jobOrder: { include: { project: true } },
    },
  });

  // Group by (job order × workDate) so each row carries a DATE and the per-project
  // A/B/C hour breakdown for that submission, plus the approved/unapproved split.
  type Row = {
    jobOrderId: number;
    code: string;
    name: string;
    workDate: string;
    projectColorKey: string;
    projectName: string;
    budgetedHours: number | null;
    projectA: number;
    projectB: number;
    projectC: number;
    overhead: number;
    consumptionApproved: number;
    consumptionUnapproved: number;
    consumptionPct: number | null;
  };

  const byKey = new Map<string, Row>();

  for (const e of entries) {
    if (!e.jobOrder || !e.jobOrderId) continue;
    const jo = e.jobOrder;
    const dateKey = e.workDate.toISOString().slice(0, 10);
    const key = `${jo.id}|${dateKey}`;
    let row = byKey.get(key);
    if (!row) {
      row = {
        jobOrderId: jo.id,
        code: jo.code,
        name: jo.name,
        workDate: dateKey,
        projectColorKey: jo.project.colorKey,
        projectName: jo.project.name,
        budgetedHours: jo.budgetedHours,
        projectA: 0,
        projectB: 0,
        projectC: 0,
        overhead: 0,
        consumptionApproved: 0,
        consumptionUnapproved: 0,
        consumptionPct: null,
      };
      byKey.set(key, row);
    }

    // Approved vs unapproved classification derived server-side from entry status.
    const isApproved = e.status === "HOD_APPROVED" || e.status === "PM_APPROVED";
    if (isApproved) {
      row.consumptionApproved += 1;
    } else {
      row.consumptionUnapproved += 1;
    }

    // Per-project hour breakdown (legacy ProjectWbs fallback kept for consistency).
    const colorKey = String(jo.project.colorKey || "").toUpperCase();
    if (colorKey === "A") row.projectA += 1;
    else if (colorKey === "B") row.projectB += 1;
    else if (colorKey === "C") row.projectC += 1;
    else row.overhead += 1;
  }

  const rows = Array.from(byKey.values())
    .map((r) => {
      const total = r.consumptionApproved + r.consumptionUnapproved;
      r.consumptionPct =
        r.budgetedHours && r.budgetedHours > 0 ? Math.round((total / r.budgetedHours) * 100) : null;
      return r;
    })
    .sort((a, b) => {
      if (a.workDate !== b.workDate) return b.workDate.localeCompare(a.workDate);
      return a.code.localeCompare(b.code);
    });

  res.json({ rows, role });
});

async function applyApprove(ids: number[], userId: number, role: string, comment: string | null) {
  const results: { id: number; status: string }[] = [];
  const errors: { id: number; error: string }[] = [];

  for (const id of ids) {
    const day = await prisma.timesheetDay.findUnique({
      where: { id },
      include: {
        entries: {
          where: { OR: [{ projectWbsId: { not: null } }, { jobOrderId: { not: null } }] },
        },
      },
    });
    if (!day) {
      errors.push({ id, error: "Not found" });
      continue;
    }
    const next = nextStatusOnApprove(role, day.status);
    if (!next) {
      errors.push({ id, error: `Cannot approve from status ${day.status} as ${role}` });
      continue;
    }

    const hasProtected = day.entries.some((e) => isProtectedEntryStatus(e.status));
    // Amendment: only the newly submitted slots go pending — keep prior approvals intact.
    const entryWhere =
      hasProtected && day.status === "SUBMITTED"
        ? {
            timesheetDayId: id,
            status: "SUBMITTED" as const,
            OR: [{ projectWbsId: { not: null } }, { jobOrderId: { not: null } }],
          }
        : { timesheetDayId: id };

    await prisma.$transaction([
      prisma.timesheetDay.update({ where: { id }, data: { status: next } }),
      prisma.timesheetEntry.updateMany({
        where: entryWhere,
        data: { status: next },
      }),
      prisma.approval.create({
        data: {
          timesheetDayId: id,
          approverId: userId,
          action: "APPROVE",
          comment,
        },
      }),
    ]);
    await writeAudit(userId, "APPROVE", "timesheet_day", id, { nextStatus: next, partial: hasProtected });
    results.push({ id, status: next });
  }

  return { results, errors };
}

async function applyReject(ids: number[], userId: number, role: string, comment: string | null) {
  const results: { id: number; status: string }[] = [];
  const errors: { id: number; error: string }[] = [];

  for (const id of ids) {
    const day = await prisma.timesheetDay.findUnique({
      where: { id },
      include: {
        entries: {
          where: { OR: [{ projectWbsId: { not: null } }, { jobOrderId: { not: null } }] },
        },
      },
    });
    if (!day) {
      errors.push({ id, error: "Not found" });
      continue;
    }

    const isPlanningReturn = (role === "PM" || role === "ADMIN") && day.status === "HOD_APPROVED";
    const nextStatus = isPlanningReturn ? "PLANNING_RETURNED" : "REJECTED";
    const action = isPlanningReturn ? "PLANNING_RETURN" : "REJECT";

    if (role === "HOD" && day.status !== "SUBMITTED") {
      errors.push({ id, error: `Cannot reject from status ${day.status} as HOD` });
      continue;
    }
    if (role === "PM" && day.status !== "HOD_APPROVED") {
      errors.push({ id, error: `Cannot reject from status ${day.status} as Project Head` });
      continue;
    }

    const hasProtected = day.entries.some((e) => isProtectedEntryStatus(e.status));
    // Amendment reject: bounce only the newly submitted slots; keep prior approvals intact.
    const entryWhere =
      hasProtected && day.status === "SUBMITTED" && !isPlanningReturn
        ? {
            timesheetDayId: id,
            status: "SUBMITTED" as const,
            OR: [{ projectWbsId: { not: null } }, { jobOrderId: { not: null } }],
          }
        : { timesheetDayId: id };

    await prisma.$transaction([
      prisma.timesheetDay.update({ where: { id }, data: { status: nextStatus } }),
      prisma.timesheetEntry.updateMany({
        where: entryWhere,
        data: { status: nextStatus },
      }),
      prisma.approval.create({
        data: {
          timesheetDayId: id,
          approverId: userId,
          action,
          comment,
        },
      }),
    ]);
    await writeAudit(userId, action, "timesheet_day", id, { nextStatus, partial: hasProtected });
    results.push({ id, status: nextStatus });
  }

  return { results, errors };
}

approvalsRouter.post("/batch", requireRoles(...APPROVER_ROLES), async (req, res) => {
  const ids = Array.isArray(req.body?.ids)
    ? req.body.ids.map((n: unknown) => Number(n)).filter((n: number) => Number.isFinite(n) && n > 0)
    : [];
  const action = req.body?.action === "reject" ? "reject" : "approve";
  const comment = typeof req.body?.comment === "string" ? req.body.comment : null;

  if (!ids.length) return res.status(400).json({ error: "No timesheet ids provided" });

  const outcome =
    action === "approve"
      ? await applyApprove(ids, req.user!.id, req.user!.role, comment)
      : await applyReject(ids, req.user!.id, req.user!.role, comment);

  res.json({ ok: outcome.errors.length === 0, ...outcome });
});

approvalsRouter.post("/:id/approve", requireRoles(...APPROVER_ROLES), async (req, res) => {
  const id = Number(req.params.id);
  const comment = typeof req.body?.comment === "string" ? req.body.comment : null;
  const { results, errors } = await applyApprove([id], req.user!.id, req.user!.role, comment);
  if (errors.length) return res.status(400).json({ error: errors[0].error });
  res.json({ ok: true, status: results[0].status });
});

approvalsRouter.post("/:id/reject", requireRoles(...APPROVER_ROLES), async (req, res) => {
  const id = Number(req.params.id);
  const comment = typeof req.body?.comment === "string" ? req.body.comment : null;
  const { results, errors } = await applyReject([id], req.user!.id, req.user!.role, comment);
  if (errors.length) return res.status(400).json({ error: errors[0].error });
  res.json({ ok: true, status: results[0].status });
});

approvalsRouter.post("/:id/send-back", requireRoles("HOD", "ADMIN"), async (req, res) => {
  const id = Number(req.params.id);
  const day = await prisma.timesheetDay.findUnique({ where: { id } });
  if (!day) return res.status(404).json({ error: "Not found" });
  if (day.status !== "PLANNING_RETURNED") {
    return res.status(400).json({ error: "Only Planning-returned sheets can be sent back to supervisor" });
  }
  const comment = typeof req.body?.comment === "string" ? req.body.comment : null;

  await prisma.$transaction([
    prisma.timesheetDay.update({
      where: { id },
      data: { status: "REJECTED", remarks: comment || day.remarks },
    }),
    prisma.timesheetEntry.updateMany({
      where: { timesheetDayId: id },
      data: { status: "REJECTED" },
    }),
    prisma.approval.create({
      data: {
        timesheetDayId: id,
        approverId: req.user!.id,
        action: "SEND_BACK",
        comment,
      },
    }),
  ]);

  await writeAudit(req.user!.id, "SEND_BACK", "timesheet_day", id);
  res.json({ ok: true, status: "REJECTED" });
});
