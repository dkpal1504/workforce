import { Router } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { requireAuth, requireRoles } from "../middleware/auth";
import { endOfFrequency, formatDateOnly, parseDateOnly, startOfFrequency } from "../utils/date";
import { getMaxDailyHours } from "../config";
import { contractOverheadHours } from "../services/contractWorkHours";
import { isDepartmentViewRole } from "../services/roleAccess";
import {
  balanceOf,
  latestApprovedProgress,
  percentOf,
  resolveBudgetInForce,
  type BudgetRevisionLike,
} from "../services/budgetLookup";

export const summaryRouter = Router();

summaryRouter.use(requireAuth, requireRoles("EMPLOYEE", "SUPERVISOR", "HOD", "DEPT_HEAD", "PM", "HR", "FINANCE", "ADMIN"));

type JoStatus = "all" | "active" | "inactive";

/**
 * Job Order Summary: Project -> WBS -> Job Order.
 *
 * The WBS level is required here. A Job Order number repeats across projects
 * (`@@unique([projectId, code])` only stops a repeat inside one project), so the
 * WBS row is what keeps the screen unambiguous.
 *
 * Hours and quantity are INDEPENDENT measures and are never blended: the four
 * hour columns come from approved timesheet/allocation hours, the four quantity
 * columns come from the effective-dated budget revision and the approved
 * quantity progress.
 */
summaryRouter.get("/job-order", async (req, res) => {
  const role = req.user!.role;
  if (role === "EMPLOYEE") return res.status(403).json({ error: "Employee Summary is limited to own approved My Hours.", code: "FORBIDDEN" });
  const userId = req.user!.id;

  // Optional filters
  const status = (String(req.query.status || "all") as JoStatus);
  if (!["all", "active", "inactive"].includes(status)) {
    return res.status(400).json({ error: "status must be one of all|active|inactive" });
  }
  const requestedDeptId =
    typeof req.query.departmentId === "string" && req.query.departmentId.length
      ? Number(req.query.departmentId)
      : undefined;
  // HOD is always scoped to the server-side Department. A missing Department
  // fails closed. Other reporting roles may use the explicit report filter.
  // A Section HOD is pinned to its Department; a Department HOD / Department Head is
  // pinned to its Department too, but covers every Section in it.
  const filterDeptId = isDepartmentViewRole(role) ? (req.user!.departmentId ?? -1) : requestedDeptId;

  let projectIds: number[] | undefined;
  if (typeof req.query.projectIds === "string" && req.query.projectIds.length) {
    projectIds = req.query.projectIds.split(",").map(Number).filter(Boolean);
  }

  // A row carries one budget, and budgets are effective-dated. The reference date
  // is the Job Order's own last booked work date - the date its consumption figure
  // is true at - falling back to its last approved progress date. An explicit
  // `asOf` overrides it for a back-dated report.
  let asOf: Date | null = null;
  if (typeof req.query.asOf === "string" && req.query.asOf.length) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(req.query.asOf)) {
      return res.status(400).json({ error: "asOf must be a YYYY-MM-DD date" });
    }
    asOf = parseDateOnly(req.query.asOf);
  }

  const scope = role === "SUPERVISOR" ? "own" : "organization";

  // All Job Orders matching the filters. `departmentId` is required on a Job Order
  // now, so the Department filter is a straight equality (there is no longer a
  // "any department" standing row to OR in).
  const jobOrders = await prisma.jobOrder.findMany({
    where: {
      status: status === "all" ? { in: ["active", "inactive"] } : status,
      projectId: projectIds?.length ? { in: projectIds } : undefined,
      ...(filterDeptId != null ? { departmentId: filterDeptId } : {}),
    },
    // `project` and `projectWbs` are the grouping keys; `uom` labels the quantity
    // columns so a quantity is never read as hours.
    include: { project: true, projectWbs: true, uom: true },
    orderBy: [{ code: "asc" }],
  });

  if (jobOrders.length === 0) {
    return res.json({ groups: [], role, scope, asOf: asOf ? formatDateOnly(asOf) : null });
  }

  const jobOrderIds = jobOrders.map((j) => j.id);

  // Pull final-approved consumption entries for those JOs. Supervisors see
  // their own tagging; reporting roles see organization-wide data unless filtered.
  const entries = await prisma.timesheetEntry.findMany({
    where: {
      jobOrderId: { in: jobOrderIds },
      // Consumption is recognized only after the final Project Manager approval.
      status: "PM_APPROVED",
      ...(role === "SUPERVISOR" ? { taggedById: userId } : {}),
      ...(role === "EMPLOYEE" ? { employeeId: req.user!.employeeId ?? -1 } : {}),
      ...(isDepartmentViewRole(role) && req.user!.sectionId == null ? {
        // Approved by a Section HOD of this Department (the Department HOD may not
        // have approved it personally), which is the department-level roll-up.
        timesheetDay: {
          approvals: { some: { approverId: { not: req.user!.id }, approver: { role: "HOD" }, action: "APPROVE" } },
          employee: { departmentId: req.user!.departmentId ?? -1 },
        },
      } : role === "HOD" ? {
        timesheetDay: { approvals: { some: { approverId: userId, action: "APPROVE" } } },
      } : {}),
      ...(role === "PM" ? { timesheetDay: { approvals: { some: { approverId: userId, action: "APPROVE" } } } } : {}),
    },
    select: { jobOrderId: true, shiftSlot: true, hourSlot: true, otHours: true, workDate: true },
  });

  // Payroll/My Hours allocations use a separate parent-day model. Include
  // their slots only after the same final PM approval stage.
  const linkedEmployeeId = req.user!.employeeId;
  const allocations = await prisma.employeeAllocation.findMany({
    where: {
      jobOrderId: { in: jobOrderIds },
      allocationDay: {
        status: "PM_APPROVED",
        ...(isDepartmentViewRole(role) && req.user!.sectionId == null
          ? {
              approvals: { some: { approverId: { not: req.user!.id }, approver: { role: "HOD" }, action: "APPROVE" } },
              employee: { departmentId: req.user!.departmentId ?? -1 },
            }
          : role === "HOD" ? { approvals: { some: { approverId: userId, action: "APPROVE" } } } : {}),
        ...(role === "PM" ? { approvals: { some: { approverId: userId, action: "APPROVE" } } } : {}),
      },
      ...(["EMPLOYEE", "SUPERVISOR"].includes(role) ? { employeeId: linkedEmployeeId ?? -1 } : {}),
    },
    select: { jobOrderId: true, workDate: true },
  });

  // Budget revisions are effective-dated, so the screen reads them and picks the
  // one in force per Job Order instead of trusting the Job Order's current columns.
  const revisionRows = await prisma.jobOrderBudgetRevision.findMany({
    where: { jobOrderId: { in: jobOrderIds } },
    select: {
      jobOrderId: true,
      revisionNo: true,
      budgetedHours: true,
      budgetedQuantity: true,
      uomId: true,
      effectiveFrom: true,
    },
  });
  const revisionsByJo = new Map<number, BudgetRevisionLike[]>();
  for (const revision of revisionRows) {
    const list = revisionsByJo.get(revision.jobOrderId);
    if (list) list.push(revision);
    else revisionsByJo.set(revision.jobOrderId, [revision]);
  }

  // Quantity progress: only APPROVED rows count, and the latest one carries the
  // cumulative achieved quantity.
  const progressRows = await prisma.jobOrderProgress.findMany({
    where: { jobOrderId: { in: jobOrderIds }, status: "APPROVED" },
    select: { id: true, jobOrderId: true, status: true, progressDate: true, cumulativeQuantity: true, revisionNo: true },
  });
  const progressByJo = new Map<number, typeof progressRows>();
  for (const row of progressRows) {
    const list = progressByJo.get(row.jobOrderId);
    if (list) list.push(row);
    else progressByJo.set(row.jobOrderId, [row]);
  }

  // Group true approved hours by JobOrder: shift slots are 2h, legacy slots
  // are 1h, an OT row contributes its explicit hours, and each payroll slot is 2h.
  // The same pass records each Job Order's last booked work date for the budget pick.
  const consumptionByJo = new Map<number, number>();
  const lastBookedDateByJo = new Map<number, number>();
  const noteDate = (map: Map<number, number>, jobOrderId: number, date: Date) => {
    const at = date.getTime();
    if (!Number.isFinite(at)) return;
    const current = map.get(jobOrderId);
    if (current == null || at > current) map.set(jobOrderId, at);
  };
  for (const e of entries) {
    if (e.jobOrderId == null) continue;
    const hours = e.otHours ?? (e.shiftSlot != null ? 2 : e.hourSlot != null ? 1 : 0);
    consumptionByJo.set(e.jobOrderId, (consumptionByJo.get(e.jobOrderId) ?? 0) + hours);
    noteDate(lastBookedDateByJo, e.jobOrderId, e.workDate);
  }
  for (const allocation of allocations) {
    if (allocation.jobOrderId == null) continue;
    consumptionByJo.set(
      allocation.jobOrderId,
      (consumptionByJo.get(allocation.jobOrderId) ?? 0) + 2
    );
    noteDate(lastBookedDateByJo, allocation.jobOrderId, allocation.workDate);
  }
  const lastProgressDateByJo = new Map<number, number>();
  for (const row of progressRows) noteDate(lastProgressDateByJo, row.jobOrderId, row.progressDate);

  const buildRow = (jo: (typeof jobOrders)[number], srNo: number) => {
    const consumption = consumptionByJo.get(jo.id) ?? 0;
    const workDate =
      asOf ?? new Date(lastBookedDateByJo.get(jo.id) ?? lastProgressDateByJo.get(jo.id) ?? Date.now());
    const budget = resolveBudgetInForce(revisionsByJo.get(jo.id) ?? [], workDate, {
      budgetedHours: jo.budgetedHours,
      budgetedQuantity: jo.budgetedQuantity,
      uomId: jo.uomId,
    });
    const progress = latestApprovedProgress(progressByJo.get(jo.id) ?? []);
    const achievedQuantity = progress?.cumulativeQuantity ?? 0;
    return {
      id: jo.id,
      srNo,
      code: jo.code,
      name: jo.name,
      status: jo.status,
      wbsId: jo.projectWbs.id,
      wbsCode: jo.projectWbs.wbsCode,
      wbsName: jo.projectWbs.name,
      uom: jo.uom.code,
      // --- hours (budget vs approved hours booked) ---
      budgetedHours: budget.budgetedHours,
      consumption,
      consumptionPct: percentOf(consumption, budget.budgetedHours),
      balance: balanceOf(budget.budgetedHours, consumption),
      // --- quantity (effective-dated budget vs approved cumulative progress) ---
      budgetedQuantity: budget.budgetedQuantity,
      achievedQuantity,
      progressReported: progress != null,
      balanceQuantity: balanceOf(budget.budgetedQuantity, achievedQuantity),
      quantityPct: percentOf(achievedQuantity, budget.budgetedQuantity),
      // Which revision supplied the budget, so the screen is auditable.
      budgetSource: budget.source,
      budgetRevisionNo: budget.revisionNo,
      budgetEffectiveFrom: budget.effectiveFrom ? formatDateOnly(budget.effectiveFrom) : null,
      budgetWorkDate: formatDateOnly(workDate),
    };
  };

  // Group Job Orders by Project, then by WBS row (both ordered by their master
  // sort order). Sr. No. restarts per Project and runs on across its WBS rows.
  type WbsGroup = {
    wbsId: number;
    wbsCode: string;
    wbsName: string | null;
    sortOrder: number;
    jobOrders: (typeof jobOrders)[number][];
  };
  type ProjectGroup = {
    projectId: number;
    projectName: string;
    projectCode: string;
    projectColorKey: string;
    sortOrder: number;
    wbs: Map<number, WbsGroup>;
  };
  const byProject = new Map<number, ProjectGroup>();
  for (const jo of jobOrders) {
    let project = byProject.get(jo.project.id);
    if (!project) {
      project = {
        projectId: jo.project.id,
        projectName: jo.project.name,
        projectCode: jo.project.code,
        projectColorKey: jo.project.colorKey,
        sortOrder: jo.project.sortOrder,
        wbs: new Map(),
      };
      byProject.set(jo.project.id, project);
    }
    let wbs = project.wbs.get(jo.projectWbs.id);
    if (!wbs) {
      wbs = {
        wbsId: jo.projectWbs.id,
        wbsCode: jo.projectWbs.wbsCode,
        wbsName: jo.projectWbs.name,
        sortOrder: jo.projectWbs.sortOrder,
        jobOrders: [],
      };
      project.wbs.set(jo.projectWbs.id, wbs);
    }
    wbs.jobOrders.push(jo);
  }

  const byNumber = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
  const groups = Array.from(byProject.values())
    .sort((a, b) => a.sortOrder - b.sortOrder || byNumber(a.projectCode, b.projectCode))
    .map((project) => {
      let srNo = 0;
      const wbsGroups = Array.from(project.wbs.values())
        .sort((a, b) => a.sortOrder - b.sortOrder || byNumber(a.wbsCode, b.wbsCode))
        .map((wbs) => ({
          wbsId: wbs.wbsId,
          wbsCode: wbs.wbsCode,
          wbsName: wbs.wbsName,
          rows: wbs.jobOrders
            .slice()
            .sort((a, b) => byNumber(a.code, b.code))
            .map((jo) => {
              srNo += 1;
              return buildRow(jo, srNo);
            }),
        }));
      return {
        projectId: project.projectId,
        projectName: project.projectName,
        projectCode: project.projectCode,
        projectColorKey: project.projectColorKey,
        sortOrder: project.sortOrder,
        wbsGroups,
      };
    });

  res.json({
    groups,
    role,
    scope,
    asOf: asOf ? formatDateOnly(asOf) : null,
  });
});

summaryRouter.get("/decisions", async (req, res) => {
  const dateStr = String(req.query.date || "");
  const frequency = String(req.query.frequency || "daily") as "daily" | "weekly" | "monthly";
  if (!dateStr) return res.status(400).json({ error: "date required" });
  const anchor = parseDateOnly(dateStr);
  const start = startOfFrequency(anchor, frequency);
  const end = endOfFrequency(anchor, frequency);
  const { role, id: userId, employeeId } = req.user!;
  const statuses = ["HOD_APPROVED", "PM_APPROVED", "REJECTED", "FINAL_REJECTED", "PLANNING_RETURNED"];

  let dayScope: Prisma.TimesheetDayWhereInput = { status: { in: statuses } };
  let allocationScope: Prisma.EmployeeAllocationDayWhereInput = { status: { in: statuses } };
  if (role === "EMPLOYEE") {
    dayScope = { employeeId: employeeId ?? -1, status: "PM_APPROVED" };
    allocationScope = { employeeId: employeeId ?? -1, status: "PM_APPROVED" };
  } else if (role === "SUPERVISOR") {
    dayScope = { taggedById: userId, approvals: { some: { approver: { role: "HOD" } } } };
    allocationScope = { employeeId: employeeId ?? -1, approvals: { some: { approver: { role: "HOD" } } } };
  } else if (isDepartmentViewRole(role) && req.user!.sectionId == null) {
    const departmentId = req.user!.departmentId ?? -1;
    dayScope = { employee: { departmentId } };
    allocationScope = { employee: { departmentId } };
  } else if (role === "HOD") {
    dayScope = { approvals: { some: { approverId: userId } } };
    allocationScope = { approvals: { some: { approverId: userId } } };
  } else if (role === "PM") {
    dayScope = { approvals: { some: { approverId: userId } } };
    allocationScope = { approvals: { some: { approverId: userId } } };
  } else if (role === "FINANCE") {
    dayScope = { status: "PM_APPROVED" };
    allocationScope = { status: "PM_APPROVED" };
  }

  const [days, allocationDays] = await Promise.all([
    prisma.timesheetDay.findMany({
      where: { workDate: { gte: start, lte: end }, AND: [dayScope] },
      include: { employee: { include: { department: true } }, entries: true, approvals: { include: { approver: true }, orderBy: { createdAt: "desc" } } },
      orderBy: { workDate: "desc" }, take: 300,
    }),
    prisma.employeeAllocationDay.findMany({
      where: { workDate: { gte: start, lte: end }, AND: [allocationScope] },
      include: { employee: { include: { department: true } }, allocations: true, approvals: { include: { approver: true }, orderBy: { createdAt: "desc" } } },
      orderBy: { workDate: "desc" }, take: 300,
    }),
  ]);

  const relevant = (approval: { approverId: number; approver: { role: string }; action: string }) => {
    if (role === "EMPLOYEE") return approval.approver.role === "PM" && approval.action === "APPROVE";
    if (role === "SUPERVISOR") return approval.approver.role === "HOD";
    if (role === "HOD") return approval.approverId === userId || (approval.approver.role === "PM" && (approval.action.includes("REJECT") || approval.action === "PLANNING_RETURN"));
    if (role === "PM") return approval.approverId === userId;
    return true;
  };
  const items = [
    ...days.map((day) => {
      const decision = day.approvals.find(relevant) ?? day.approvals[0] ?? null;
      const hours = day.entries.reduce((sum, entry) => sum + (entry.otHours ?? (entry.shiftSlot ? 2 : entry.hourSlot != null ? 1 : 0)), 0);
      return { id: `timesheet-${day.id}`, source: "SUPERVISOR_TIMESHEET", employee: day.employee, workDate: day.workDate.toISOString().slice(0, 10), status: day.status, hours, decision: decision ? { action: decision.action, comment: decision.comment, at: decision.createdAt, by: decision.approver.name, role: decision.approver.role } : null };
    }),
    ...allocationDays.map((day) => {
      const decision = day.approvals.find(relevant) ?? day.approvals[0] ?? null;
      return { id: `allocation-${day.id}`, source: "MY_HOURS", employee: day.employee, workDate: day.workDate.toISOString().slice(0, 10), status: day.status, hours: day.allocations.length * 2, decision: decision ? { action: decision.action, comment: decision.comment, at: decision.createdAt, by: decision.approver.name, role: decision.approver.role } : null };
    }),
  ].filter((item) => role === "ADMIN" || role === "FINANCE" || item.decision != null)
    .sort((a, b) => b.workDate.localeCompare(a.workDate));
  res.json({ items });
});

summaryRouter.get("/", async (req, res) => {
  const frequency = (String(req.query.frequency || "daily") as "daily" | "weekly" | "monthly");
  const groupBy = String(req.query.groupBy || "supervisor") as
    | "employee"
    | "supervisor"
    | "department"
    | "totals";
  const view = String(req.query.view || "hours") as "hours" | "cost";
  const dateStr = String(req.query.date || "");
  if (!dateStr) return res.status(400).json({ error: "date required" });

  const anchor = parseDateOnly(dateStr);
  const start = startOfFrequency(anchor, frequency);
  const end = endOfFrequency(anchor, frequency);

  let projectIds: string[] | undefined;
  if (typeof req.query.projectIds === "string" && req.query.projectIds.length) {
    projectIds = req.query.projectIds.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  } else if (Array.isArray(req.query.projectIds)) {
    projectIds = (req.query.projectIds as string[]).map((s) => String(s).trim().toUpperCase()).filter(Boolean);
  }

  const role = req.user!.role;
  const userId = req.user!.id;
  const employeeId = req.user!.employeeId;
  const visibleStatuses = ["HOD_APPROVED", "PM_APPROVED", "REJECTED", "FINAL_REJECTED", "PLANNING_RETURNED"];
  let entryScope: Prisma.TimesheetEntryWhereInput = { status: { in: visibleStatuses } };
  if (role === "EMPLOYEE") entryScope = { employeeId: employeeId ?? -1, status: "PM_APPROVED" };
  else if (role === "SUPERVISOR") entryScope = {
    taggedById: userId,
    status: { in: visibleStatuses },
    timesheetDay: { approvals: { some: { approver: { role: "HOD" }, action: { in: ["APPROVE", "REJECT", "SEND_BACK"] } } } },
  };
  else if (isDepartmentViewRole(role) && req.user!.sectionId == null) {
    // Department HOD / Department Head: every Section of this Department, showing only
    // hours already APPROVED by the Section HODs. Work still sitting with a Section
    // HOD is deliberately excluded (it is not attendance yet) and belongs in the
    // Approvals queue instead.
    //
    // The Department is read from the FROZEN booking snapshot (department_id), so a
    // later transfer does not move approved hours out of this report. Rows written
    // before the snapshot columns existed have department_id IS NULL and fall back to
    // the employee's current Department, which keeps that history visible.
    const departmentId = req.user!.departmentId ?? -1;
    entryScope = {
      status: { in: visibleStatuses },
      OR: [
        { departmentId },
        { departmentId: null, employee: { departmentId } },
      ],
    };
  }
  else if (role === "HOD") entryScope = {
    status: { in: visibleStatuses },
    timesheetDay: { approvals: { some: { approverId: userId } } },
  };
  else if (role === "PM") entryScope = {
    status: { in: visibleStatuses },
    timesheetDay: { approvals: { some: { approverId: userId } } },
  };
  else if (role === "FINANCE") entryScope = { status: "PM_APPROVED" };

  const entries = await prisma.timesheetEntry.findMany({
    where: {
      workDate: { gte: start, lte: end },
      AND: [
        { OR: [{ projectWbsId: { not: null } }, { jobOrderId: { not: null } }] },
        entryScope,
      ],
    },
    include: {
      employee: { include: { department: true } },
      taggedBy: { include: { department: true } },
      // Frozen attribution snapshot on the booking row: `project_id` and
      // `department_id` are the grouping keys for this report. The Job Order join is
      // only the fallback for rows booked before the snapshot columns existed.
      project: true,
      department: true,
      jobOrder: { include: { project: true } },
    },
  });

  let allocationDayScope: Prisma.EmployeeAllocationDayWhereInput = { status: { in: visibleStatuses } };
  // Department roll-up for payroll/My Hours rows: the snapshot lives on the
  // allocation row itself, not on its parent day.
  let allocationDepartmentScope: Prisma.EmployeeAllocationWhereInput | null = null;
  if (role === "EMPLOYEE") allocationDayScope = { employeeId: employeeId ?? -1, status: "PM_APPROVED" };
  else if (role === "SUPERVISOR") allocationDayScope = {
    employeeId: employeeId ?? -1,
    status: { in: visibleStatuses },
    approvals: { some: { approver: { role: "HOD" } } },
  };
  else if (isDepartmentViewRole(role) && req.user!.sectionId == null) {
    const departmentId = req.user!.departmentId ?? -1;
    allocationDayScope = { status: { in: visibleStatuses } };
    // Frozen snapshot first; a NULL snapshot is pre-snapshot history and falls back
    // to the employee's current Department.
    allocationDepartmentScope = {
      OR: [
        { departmentId },
        { departmentId: null, employee: { departmentId } },
      ],
    };
  }
  else if (role === "HOD") allocationDayScope = {
    status: { in: visibleStatuses },
    approvals: { some: { approverId: userId } },
  };
  else if (role === "PM") allocationDayScope = {
    status: { in: visibleStatuses }, approvals: { some: { approverId: userId } },
  };
  else if (role === "FINANCE") allocationDayScope = { status: "PM_APPROVED" };

  const allocations = await prisma.employeeAllocation.findMany({
    where: {
      workDate: { gte: start, lte: end },
      allocationDay: allocationDayScope,
      ...(allocationDepartmentScope ?? {}),
    },
    include: {
      employee: { include: { department: true } },
      allocatedBy: { include: { department: true } },
      // `project` is the booking-time snapshot column on this table, and
      // `department` the frozen Department for the roll-up.
      project: true,
      department: true,
      jobOrder: true,
      allocationDay: true,
    },
  });

  const rates = await prisma.costRate.findMany({
    where: {
      effectiveFrom: { lte: end },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: start } }],
    },
    orderBy: { effectiveFrom: "desc" },
  });

  function rateFor(category: string): number {
    const r = rates.find((x) => x.category === category);
    return r ? Number(r.ratePerHour) : 0;
  }

  // Build the dynamic project-column set from the rows actually present. The
  // project of a row is the FROZEN attribution snapshot captured when the hours
  // were booked (`project_id`), never a live join through its Job Order, so a later
  // master-data change cannot move approved history. Rows booked before the snapshot
  // columns existed fall back to the Job Order's Project.
  //
  // Columns are keyed and labelled by the Project's `color_key` (unique across
  // projects) and ordered by the Project's sort order.
  type ProjectRef = { id: number; code: string; name: string; colorKey: string; sortOrder: number };
  const snapshotProject = (row: {
    project: ProjectRef | null;
    jobOrder: { project: ProjectRef } | null;
  }): ProjectRef | null => row.project ?? row.jobOrder?.project ?? null;
  const projectMeta = new Map<string, ProjectRef>();
  const rememberProject = (project: ProjectRef | null | undefined) => {
    if (!project) return;
    const colorKey = String(project.colorKey || "").toUpperCase();
    if (!colorKey) return;
    projectMeta.set(colorKey, {
      id: project.id,
      code: project.code,
      name: project.name,
      colorKey,
      sortOrder: project.sortOrder,
    });
  };
  for (const e of entries) rememberProject(snapshotProject(e));
  for (const allocation of allocations) rememberProject(allocation.project);
  // Only the projects explicitly selected when a filter is provided, matched on the
  // same `color_key` token the UI filter uses.
  if (projectIds?.length) {
    const codes = new Set(projectIds);
    for (const k of [...projectMeta.keys()]) {
      if (!codes.has(k)) projectMeta.delete(k);
    }
  }
  const projects = [...projectMeta.values()].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.colorKey.localeCompare(b.colorKey, undefined, { numeric: true })
  );

  type AggKey = string;
  type Bucket = {
    label: string;
    secondary: string;
    projectHours: Record<string, number>;
    projectCost: Record<string, number>;
    projectOtHours: Record<string, number>;
    projectOtCost: Record<string, number>;
    overheadHours: number;
    overheadCost: number;
  };
  const buckets = new Map<AggKey, Bucket>();

  type GroupSource = {
    employeeId: number;
    employee: { name: string; departmentId: number; department: { name: string } };
    taggedById: number;
    taggedBy: { name: string; department: { name: string } | null };
    /** Frozen Department snapshot on the booking row; null before it existed. */
    departmentId: number | null;
    department: { name: string } | null;
  };
  // Group by the Department frozen on the booking row, so a later transfer does not
  // move approved hours between Departments. Legacy rows fall back to the employee's
  // current Department.
  const departmentOf = (e: GroupSource) => ({
    id: e.departmentId ?? e.employee.departmentId,
    name: e.department?.name ?? e.employee.department.name,
  });
  const groupIdentity = (e: GroupSource) => {
    if (groupBy === "employee") {
      return { key: `emp-${e.employeeId}`, label: e.employee.name, secondary: departmentOf(e).name };
    }
    if (groupBy === "department") {
      const department = departmentOf(e);
      return { key: `dept-${department.id}`, label: department.name, secondary: "" };
    }
    if (groupBy === "totals") {
      return { key: "totals", label: "All", secondary: "" };
    }
    return {
      key: `sup-${e.taggedById}`,
      label: e.taggedBy.name,
      secondary: e.taggedBy.department?.name ?? "",
    };
  };

  const getBucket = (e: (typeof entries)[number]) => {
    const identity = groupIdentity(e);
    let bucket = buckets.get(identity.key);
    if (!bucket) {
      bucket = {
        label: identity.label,
        secondary: identity.secondary,
        projectHours: {},
        projectCost: {},
        projectOtHours: {},
        projectOtCost: {},
        overheadHours: 0,
        overheadCost: 0,
      };
      buckets.set(identity.key, bucket);
    }
    return bucket;
  };

  // Regular and OT hours both remain associated with their booked project.
  // Summary OT is approved-only, matching the approval/reporting contract.
  for (const e of entries) {
    const project = snapshotProject(e);
    const colorKey = project ? String(project.colorKey || "").toUpperCase() : "";
    if (!colorKey || !projectMeta.has(colorKey)) continue;

    const bucket = getBucket(e);
    if (e.otHours != null) {
      if (e.status !== "HOD_APPROVED" && e.status !== "PM_APPROVED") continue;
      bucket.projectOtHours[colorKey] = (bucket.projectOtHours[colorKey] || 0) + e.otHours;
      bucket.projectOtCost[colorKey] =
        (bucket.projectOtCost[colorKey] || 0) + e.otHours * rateFor(e.employee.category);
      continue;
    }

    const regularHours = e.shiftSlot != null ? 2 : e.hourSlot != null ? 1 : 0;
    bucket.projectHours[colorKey] = (bucket.projectHours[colorKey] || 0) + regularHours;
    bucket.projectCost[colorKey] =
      (bucket.projectCost[colorKey] || 0) + regularHours * rateFor(e.employee.category);
  }

  for (const allocation of allocations) {
    const colorKey = String(allocation.project.colorKey || "").toUpperCase();
    if (!colorKey || !projectMeta.has(colorKey)) continue;
    const source: GroupSource = {
      employeeId: allocation.employeeId,
      employee: allocation.employee,
      taggedById: allocation.allocatedById,
      taggedBy: allocation.allocatedBy,
      departmentId: allocation.departmentId,
      department: allocation.department,
    };
    const bucket = (() => {
      const identity = groupIdentity(source);
      let value = buckets.get(identity.key);
      if (!value) {
        value = { label: identity.label, secondary: identity.secondary, projectHours: {}, projectCost: {}, projectOtHours: {}, projectOtCost: {}, overheadHours: 0, overheadCost: 0 };
        buckets.set(identity.key, value);
      }
      return value;
    })();
    bucket.projectHours[colorKey] = (bucket.projectHours[colorKey] || 0) + 2;
    bucket.projectCost[colorKey] = (bucket.projectCost[colorKey] || 0) + 2 * rateFor(allocation.employee.category);
  }

  // Overhead is unused regular capacity for a timesheet day. It is deliberately
  // kept outside every project and shown only in the final Overhead Total column.
  const dayRegular = new Map<number, { sample: (typeof entries)[number]; hours: number; overtimeHours: number }>();
  for (const e of entries) {
    let day = dayRegular.get(e.timesheetDayId);
    if (!day) {
      day = { sample: e, hours: 0, overtimeHours: 0 };
      dayRegular.set(e.timesheetDayId, day);
    }
    if (e.otHours == null) {
      day.hours += e.shiftSlot != null ? 2 : e.hourSlot != null ? 1 : 0;
    } else {
      day.overtimeHours += e.otHours;
    }
  }
  const maxDailyHours = getMaxDailyHours();
  for (const day of dayRegular.values()) {
    const identity = groupIdentity(day.sample);
    const bucket = buckets.get(identity.key);
    if (!bucket) continue;
    const overhead = contractOverheadHours(maxDailyHours, day.hours, day.overtimeHours);
    bucket.overheadHours += overhead;
    bucket.overheadCost += overhead * rateFor(day.sample.employee.category);
  }

  const rows = Array.from(buckets.values()).map((b, i) => {
    const values: Record<string, number> = {};
    const projectOtValues: Record<string, number> = {};
    let total = 0;
    for (const p of projects) {
      const regular = view === "cost" ? b.projectCost[p.colorKey] || 0 : b.projectHours[p.colorKey] || 0;
      const ot = view === "cost" ? b.projectOtCost[p.colorKey] || 0 : b.projectOtHours[p.colorKey] || 0;
      values[p.colorKey] = regular;
      projectOtValues[p.colorKey] = ot;
      total += regular + ot;
    }
    return {
      srNo: i + 1,
      name: b.label,
      department: b.secondary,
      values,
      projectOtValues,
      total,
      overheadHours: b.overheadHours,
      overheadCost: b.overheadCost,
    };
  });

  const totals: Record<string, number> = {};
  const projectOtTotals: Record<string, number> = {};
  let grand = 0;
  for (const p of projects) {
    totals[p.colorKey] = rows.reduce((acc, r) => acc + (r.values[p.colorKey] || 0), 0);
    projectOtTotals[p.colorKey] = rows.reduce((acc, r) => acc + (r.projectOtValues[p.colorKey] || 0), 0);
    grand += totals[p.colorKey] + projectOtTotals[p.colorKey];
  }
  const overheadTotalHours = rows.reduce((acc, r) => acc + r.overheadHours, 0);
  const overheadTotalCost = rows.reduce((acc, r) => acc + r.overheadCost, 0);

  res.json({
    // Columns are labelled by `color_key` and ordered by the Project's sort order.
    projects: projects.map((p) => ({
      id: p.id,
      code: p.code,
      name: p.name,
      colorKey: p.colorKey,
      sortOrder: p.sortOrder,
    })),
    rows,
    totals,
    projectOtTotals,
    grandTotal: grand,
    overheadTotalHours,
    overheadTotalCost,
    groupBy,
    view,
    frequency,
    scope: role === "SUPERVISOR" ? "own" : isDepartmentViewRole(role) ? "department" : "organization",
    dateFrom: start.toISOString().slice(0, 10),
    dateTo: end.toISOString().slice(0, 10),
  });
});
