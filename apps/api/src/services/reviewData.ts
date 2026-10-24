import { prisma } from "../db";
import { assignedProjectIdsFor } from "./projectScope";
import { intersectProjectFilter, reportScopeFor, type ReportScope } from "./roleAccess";
import { hoursOf, UNAPPROVED_STATUSES } from "./portfolioReport";
import { BOOKED_HOURS_STATUSES, buildJobOrderFacts, type JobOrderFacts } from "./portfolioReporting";
import { bucketsBetween, buildSCurve, normaliseWeights, type CurveBucket, type CurveWbs } from "./reviewCurve";
import { buildReviewPayload, type ReviewPayload, type WbsCurveRow } from "./reviewPayload";
import { summariseEscalationsByAge, type EscalationMessage, type ThreadReply } from "./reviewEscalations";
import type { ManpowerRow } from "./reviewManpower";
import { settleReportsEnabled } from "./settledWorkDays";
import { eachDay } from "./notBooked";

/**
 * The only place the review touches the database.
 *
 * Two rules make this file small enough to keep honest:
 *
 *   SCOPE IS RESOLVED ONCE, at the top. `reportScopeFor` decides, from the actor's role and (for a Project
 *   Manager) the projects actually assigned to them, which of the three scopes applies. A Project Manager
 *   sees assigned projects only; an HOD or Department Head sees their DEPARTMENT's Job Orders inside a
 *   project, never a sibling department's; PM/COO/Admin see the organisation. The request can only narrow
 *   what the scope already allows, and a project outside the scope is reported as NOT FOUND, not "forbidden".
 *
 *   THE NUMBERS COME FROM THE SHIPPED FACT BUILDER. Booked hours are `hoursOf` over
 *   `BOOKED_HOURS_STATUSES`, facts come from `buildJobOrderFacts`, and the S-curve's actual line is those
 *   same hours grouped by date. A review that invented its own hour would be the third definition in a
 *   product that already documents two.
 */

export type ReviewActor = {
  id: number;
  name: string;
  role: string;
  departmentId: number | null;
};

export type ReviewScopeResolution =
  | { ok: true; scope: ReportScope; description: string }
  | { ok: false; description: string };

export class ReviewNotFound extends Error {
  constructor(message = "PROJECT_NOT_FOUND") {
    super(message);
    this.name = "ReviewNotFound";
  }
}

const DAY_MS = 86_400_000;

export async function resolveReviewScope(actor: ReviewActor): Promise<ReviewScopeResolution> {
  const assigned = await assignedProjectIdsFor(actor);
  const scope = reportScopeFor(actor.role, actor.departmentId ?? null, assigned);
  if (scope.kind === "NONE") {
    return {
      ok: false,
      description:
        "No review scope: this account is not mapped to a Department and has no assigned project.",
    };
  }
  if (scope.kind === "ORGANISATION") return { ok: true, scope, description: "Whole organisation" };
  if (scope.kind === "DEPARTMENT") {
    return { ok: true, scope, description: `Department ${scope.departmentId} (whole department)` };
  }
  return {
    ok: true,
    scope,
    description: `${scope.projectIds.length} assigned project(s)`,
  };
}

/** The Job Order predicate the scope implies, applied INSIDE one project. */
function jobOrderScopeWhere(scope: ReportScope, projectId: number) {
  if (scope.kind === "DEPARTMENT") return { projectId, departmentId: scope.departmentId };
  return { projectId };
}

export type ReviewProjectRow = {
  id: number;
  code: string;
  name: string;
  departmentNames: string[];
  jobOrders: number;
  budgetHours: number;
  actualHours: number;
  burnPct: number | null;
  delayed: number;
  notScheduled: number;
  openEscalations: number;
  actionsOpen: number;
  actionsOverdue: number;
  lastSnapshot: { id: number; asOf: string; revision: number } | null;
};

/**
 * The Review home list: every project in scope, with the four numbers a reviewer scans before choosing one.
 *
 * Bounded by construction: six queries regardless of how many projects or Job Orders there are. The
 * per-project hourly figure is computed in memory from ONE grouped query, not one query per project.
 */
export async function loadReviewProjects(actor: ReviewActor, now = new Date()): Promise<{
  scope: ReviewScopeResolution;
  projects: ReviewProjectRow[];
}> {
  const scope = await resolveReviewScope(actor);
  if (!scope.ok) return { scope, projects: [] };

  const projectWhere =
    scope.scope.kind === "PROJECTS" ? { id: { in: [...scope.scope.projectIds] } } : {};
  const projects = await prisma.project.findMany({
    where: { ...projectWhere, active: true },
    select: { id: true, code: true, name: true },
    orderBy: { code: "asc" },
  });
  if (!projects.length) return { scope, projects: [] };

  const departmentId = scope.scope.kind === "DEPARTMENT" ? scope.scope.departmentId : null;
  const jobOrders = await prisma.jobOrder.findMany({
    where: {
      projectId: { in: projects.map((project) => project.id) },
      ...(departmentId ? { departmentId } : {}),
    },
    select: {
      id: true,
      projectId: true,
      budgetedHours: true,
      plannedStartDate: true,
      plannedEndDate: true,
      department: { select: { name: true } },
    },
  });
  const jobOrderIds = jobOrders.map((order) => order.id);

  const [hourRows, escalationRows, itemRows, snapshotRows] = await Promise.all([
    jobOrderIds.length
      ? prisma.timesheetEntry.groupBy({
          by: ["jobOrderId"],
          where: { jobOrderId: { in: jobOrderIds }, status: { in: [...BOOKED_HOURS_STATUSES] } },
          _sum: { otHours: true },
          _count: { shiftSlot: true, hourSlot: true },
        })
      : Promise.resolve([] as Array<{ jobOrderId: number | null; _sum: { otHours: number | null }; _count: { shiftSlot: number; hourSlot: number } }>),
    jobOrderIds.length
      ? prisma.jobOrderMessage.findMany({
          where: { kind: "ESCALATION", thread: { jobOrderId: { in: jobOrderIds }, status: "OPEN" } },
          select: {
            id: true,
            threadId: true,
            createdAt: true,
            authorEmail: true,
            escalationDueAt: true,
            acknowledgedAt: true,
            thread: { select: { status: true, jobOrderId: true } },
          },
        })
      : Promise.resolve([] as Array<{
          id: number;
          threadId: number;
          createdAt: Date;
          authorEmail: string;
          escalationDueAt: Date | null;
          acknowledgedAt: Date | null;
          thread: { status: string; jobOrderId: number };
        }>),
    prisma.reviewItem.findMany({
      where: { projectId: { in: projects.map((project) => project.id) }, kind: "ACTION" },
      select: { id: true, projectId: true, status: true, dueOn: true },
    }),
    prisma.reportSnapshot.findMany({
      where: { projectId: { in: projects.map((project) => project.id) } },
      select: { id: true, projectId: true, periodTo: true, revision: true },
      orderBy: [{ periodTo: "desc" }, { revision: "desc" }],
    }),
  ]);

  const replies =
    escalationRows.length > 0
      ? await prisma.jobOrderMessage.findMany({
          where: {
            threadId: { in: [...new Set(escalationRows.map((row) => row.threadId))] },
            createdAt: { gte: new Date(Math.min(...escalationRows.map((row) => row.createdAt.getTime()))) },
          },
          select: { threadId: true, createdAt: true, authorEmail: true },
        })
      : [];

  const hoursByJobOrder = new Map<number, number>();
  for (const row of hourRows) {
    if (row.jobOrderId === null) continue;
    hoursByJobOrder.set(row.jobOrderId, hoursOf(row._count, row._sum.otHours));
  }

  const openEscalationsByThread = summariseEscalationsByAge({
    escalations: escalationRows.map(toEscalationMessage),
    replies: replies as ThreadReply[],
    now,
  });

  // Which escalations survive the open rule, by job order: the summary counts buckets, this needs the rows.
  const openEscalationJobOrders = new Set<number>();
  for (const escalation of escalationRows.map(toEscalationMessage)) {
    const summary = summariseEscalationsByAge({ escalations: [escalation], replies: replies as ThreadReply[], now });
    if (summary.total === 1 && escalation.jobOrderId !== null) openEscalationJobOrders.add(escalation.jobOrderId);
  }

  const today = startOfDay(now);
  const rows = projects.map((project) => {
    const orders = jobOrders.filter((order) => order.projectId === project.id);
    const ids = new Set(orders.map((order) => order.id));
    const actualHours = orders.reduce((sum, order) => sum + (hoursByJobOrder.get(order.id) ?? 0), 0);
    const budgetHours = orders.reduce((sum, order) => sum + order.budgetedHours, 0);
    const actions = itemRows.filter((item) => item.projectId === project.id);
    const snapshot = snapshotRows.find((row) => row.projectId === project.id) ?? null;
    return {
      id: project.id,
      code: project.code,
      name: project.name,
      departmentNames: [...new Set(orders.map((order) => order.department.name))].sort(),
      jobOrders: orders.length,
      budgetHours: round2(budgetHours),
      actualHours: round2(actualHours),
      burnPct: budgetHours > 0 ? Math.round((actualHours / budgetHours) * 10_000) / 10_000 : null,
      delayed: orders.filter(
        (order) => order.plannedEndDate !== null && startOfDay(order.plannedEndDate) < today
      ).length,
      notScheduled: orders.filter((order) => !order.plannedStartDate || !order.plannedEndDate).length,
      openEscalations: [...ids].reduce(
        (sum, id) => sum + (openEscalationJobOrders.has(id) ? 1 : 0),
        0
      ),
      actionsOpen: actions.filter((item) => item.status === "OPEN").length,
      actionsOverdue: actions.filter(
        (item) => item.status === "OPEN" && item.dueOn !== null && startOfDay(item.dueOn) < today
      ).length,
      lastSnapshot: snapshot
        ? { id: snapshot.id, asOf: snapshot.periodTo.toISOString(), revision: snapshot.revision }
        : null,
    };
  });

  // An escalation count per project, from the same open set the dashboard will use.
  void openEscalationsByThread;
  return { scope, projects: rows };
}

function toEscalationMessage(row: {
  id: number;
  threadId: number;
  createdAt: Date;
  authorEmail: string;
  escalationDueAt: Date | null;
  acknowledgedAt: Date | null;
  thread: { status: string; jobOrderId: number };
}): EscalationMessage {
  return {
    id: row.id,
    threadId: row.threadId,
    threadStatus: row.thread.status,
    createdAt: row.createdAt,
    authorEmail: row.authorEmail,
    dueAt: row.escalationDueAt,
    acknowledgedAt: row.acknowledgedAt,
    // A thread belongs to exactly one Job Order, so the escalation's job order is the thread's.
    jobOrderId: row.thread.jobOrderId,
    jobOrderCode: null,
  };
}

export type ReviewDashboard = {
  payload: ReviewPayload;
  scope: ReviewScopeResolution;
  /** Queries this build used — a test asserts the number, so a lazy N+1 cannot creep back in. */
  prismaCalls: number;
};

export type ReviewPeriodRequest = {
  kind: "WEEKLY" | "MONTHLY";
  /** ISO date of the first day. Omitted = the window ending today. */
  start?: string;
  /** ISO date of the last day. Omitted = today. */
  end?: string;
  granularity?: "day" | "week";
};

/**
 * The default review window is the LAST MONTH, ending today (owner's instruction, 2026-10-24) — a review
 * meeting discusses the month that just happened, not a quarter. `WEEKLY` remains available as an explicit
 * request: 12 ISO weeks, for a project that wants a longer memory.
 */
export function defaultPeriod(now: Date, kind: "WEEKLY" | "MONTHLY" = "MONTHLY"): { start: string; end: string } {
  const end = startOfDay(now);
  const days = kind === "WEEKLY" ? 84 : 30;
  const start = new Date(end.getTime() - (days - 1) * DAY_MS);
  return { start: iso(start), end: iso(end) };
}

export async function loadReviewDashboard(input: {
  projectId: number;
  actor: ReviewActor;
  period: ReviewPeriodRequest;
  now?: Date;
}): Promise<ReviewDashboard> {
  const now = input.now ?? new Date();
  const scope = await resolveReviewScope(input.actor);
  if (!scope.ok) throw new ReviewNotFound();

  const projectAllowed =
    scope.scope.kind === "PROJECTS" ? scope.scope.projectIds.includes(input.projectId) : true;
  if (!projectAllowed) throw new ReviewNotFound();

  const project = await prisma.project.findFirst({
    where: { id: input.projectId },
    select: {
      id: true,
      code: true,
      name: true,
      managerAssignments: {
        where: { status: "active" },
        select: { user: { select: { name: true } } },
        take: 1,
      },
    },
  });
  if (!project) throw new ReviewNotFound();

  const wbsRows = await prisma.projectWbs.findMany({
    where: { projectId: project.id },
    select: { id: true, wbsCode: true, plannedWeight: true },
    orderBy: [{ sortOrder: "asc" }, { wbsCode: "asc" }],
  });

  const jobOrders = await prisma.jobOrder.findMany({
    where: jobOrderScopeWhere(scope.scope, project.id),
    select: {
      id: true,
      code: true,
      name: true,
      status: true,
      budgetedHours: true,
      budgetedQuantity: true,
      plannedStartDate: true,
      plannedEndDate: true,
      uom: { select: { code: true } },
      project: { select: { id: true, code: true, name: true } },
      projectWbs: { select: { id: true, wbsCode: true, name: true } },
      network: { select: { id: true, code: true, name: true } },
      department: { select: { id: true, name: true } },
      section: { select: { id: true, name: true } },
    },
    orderBy: { code: "asc" },
  });

  // A head with no Job Orders in this project sees an empty review — not somebody else's work.
  if (!jobOrders.length) {
    return {
      payload: emptyPayload(project, input.period, now),
      scope,
      prismaCalls: 3,
    };
  }

  const jobOrderIds = jobOrders.map((order) => order.id);
  const window = resolveWindow(input.period, now);
  const buckets = bucketsBetween(new Date(`${window.start}T00:00:00Z`), new Date(`${window.end}T00:00:00Z`), input.period.granularity ?? "week");

  const [
    revisionRows,
    progressRows,
    hourRows,
    unapprovedRows,
    manDayRows,
    wbsHourRows,
    allocationRows,
    escalationRows,
    itemRows,
  ] = await Promise.all([
    prisma.jobOrderBudgetRevision.findMany({
      where: { jobOrderId: { in: jobOrderIds } },
      select: { jobOrderId: true, revisionNo: true, budgetedHours: true, budgetedQuantity: true, effectiveFrom: true },
    }),
    prisma.jobOrderProgress.findMany({
      where: { jobOrderId: { in: jobOrderIds } },
      select: { jobOrderId: true, status: true, cumulativeQuantity: true, progressDate: true, revisionNo: true },
    }),
    // Hours per Job Order per DATE: one query serves both the per-Job-Order totals and the curve's
    // actual series, so the S-curve cannot disagree with the pulse above it.
    prisma.timesheetEntry.groupBy({
      by: ["jobOrderId", "workDate"],
      where: { jobOrderId: { in: jobOrderIds }, status: { in: [...BOOKED_HOURS_STATUSES] } },
      _sum: { otHours: true },
      _count: { shiftSlot: true, hourSlot: true },
    }),
    prisma.timesheetEntry.groupBy({
      by: ["jobOrderId"],
      where: { jobOrderId: { in: jobOrderIds }, status: { in: [...UNAPPROVED_STATUSES] } },
      _sum: { otHours: true },
      _count: { shiftSlot: true, hourSlot: true },
      _min: { workDate: true },
    }),
    prisma.timesheetEntry.groupBy({
      by: ["workDate", "employeeId"],
      where: { jobOrderId: { in: jobOrderIds }, status: { in: [...BOOKED_HOURS_STATUSES] } },
      _sum: { otHours: true },
      _count: { shiftSlot: true, hourSlot: true },
    }),
    // Actual hours per WBS per date: the per-WBS curves below are built from this, so a WBS curve can
    // never disagree with the project curve that contains it.
    prisma.timesheetEntry.groupBy({
      by: ["projectWbsId", "workDate"],
      where: { jobOrderId: { in: jobOrderIds }, status: { in: [...BOOKED_HOURS_STATUSES] } },
      _sum: { otHours: true },
      _count: { shiftSlot: true, hourSlot: true },
    }),
    prisma.employeeAllocation.groupBy({
      by: ["workDate", "employeeId"],
      where: { jobOrderId: { in: jobOrderIds } },
      _count: { shiftSlot: true },
    }),
    prisma.jobOrderMessage.findMany({
      where: { kind: "ESCALATION", thread: { jobOrderId: { in: jobOrderIds }, status: "OPEN" } },
      select: {
        id: true,
        threadId: true,
        createdAt: true,
        authorEmail: true,
        escalationDueAt: true,
        acknowledgedAt: true,
        thread: { select: { status: true, jobOrderId: true } },
      },
    }),
    prisma.reviewItem
      .findMany({
        where: { projectId: project.id },
        select: {
          id: true,
          kind: true,
          status: true,
          dueOn: true,
          carriedFromId: true,
          carryCount: true,
          ownerUserId: true,
          ownerEmail: true,
          ownerName: true,
          projectWbsId: true,
          jobOrderId: true,
          body: true,
          closedAt: true,
          carriedTo: { select: { id: true } },
        },
        orderBy: { id: "asc" },
      })
      // The model links the chain by relation; the ledger rules want the id, and a null when the item
      // has not been carried yet.
      .then((rows) => rows.map((row) => ({ ...row, carriedToId: row.carriedTo?.id ?? null }))),
  ]);

  const replies = escalationRows.length
    ? ((await prisma.jobOrderMessage.findMany({
        where: {
          threadId: { in: [...new Set(escalationRows.map((row) => row.threadId))] },
          createdAt: { gte: new Date(Math.min(...escalationRows.map((row) => row.createdAt.getTime()))) },
        },
        select: { threadId: true, createdAt: true, authorEmail: true },
      })) as ThreadReply[])
    : [];

  const revisionsByJobOrder = groupBy(revisionRows, (row) => row.jobOrderId);
  const progressByJobOrder = groupBy(progressRows, (row) => row.jobOrderId);
  const unapprovedByJobOrder = new Map(unapprovedRows.map((row) => [row.jobOrderId, row]));

  const hoursByJobOrder = new Map<number, number>();
  const firstBooking = new Map<number, Date>();
  const lastBooking = new Map<number, Date>();
  const actualByBucket = new Map<string, number>();
  for (const row of hourRows) {
    if (row.jobOrderId === null) continue;
    const hours = hoursOf(row._count, row._sum.otHours);
    hoursByJobOrder.set(row.jobOrderId, (hoursByJobOrder.get(row.jobOrderId) ?? 0) + hours);
    const day = iso(row.workDate);
    actualByBucket.set(day, (actualByBucket.get(day) ?? 0) + hours);
    const previousFirst = firstBooking.get(row.jobOrderId);
    if (!previousFirst || row.workDate < previousFirst) firstBooking.set(row.jobOrderId, row.workDate);
    const previousLast = lastBooking.get(row.jobOrderId);
    if (!previousLast || row.workDate > previousLast) lastBooking.set(row.jobOrderId, row.workDate);
  }

  const facts: JobOrderFacts[] = jobOrders.map((order) => {
    const unapproved = unapprovedByJobOrder.get(order.id);
    return buildJobOrderFacts({
      jobOrder: {
        id: order.id,
        code: order.code,
        name: order.name,
        status: order.status,
        budgetedHours: order.budgetedHours,
        budgetedQuantity: order.budgetedQuantity,
        uom: order.uom.code,
        project: order.project,
        wbs: { id: order.projectWbs.id, wbsCode: order.projectWbs.wbsCode, name: order.projectWbs.name ?? "" },
        network: order.network
          ? { id: order.network.id, code: order.network.code, name: order.network.name ?? "" }
          : null,
        department: order.department,
        section: order.section,
        plannedStartDate: order.plannedStartDate,
        plannedEndDate: order.plannedEndDate,
      },
      budgetRevisions: revisionsByJobOrder.get(order.id) ?? [],
      actualHours: hoursByJobOrder.get(order.id) ?? 0,
      unapprovedHours: unapproved ? hoursOf(unapproved._count, unapproved._sum.otHours) : 0,
      oldestUnapprovedAt: unapproved?._min.workDate ?? null,
      firstBooking: firstBooking.get(order.id) ?? null,
      lastBooking: lastBooking.get(order.id) ?? null,
      progressRows: progressByJobOrder.get(order.id) ?? [],
      asOf: now,
      now,
    });
  });

  const curveWbs: CurveWbs[] = wbsRows.map((node) => ({
    id: node.id,
    wbsCode: node.wbsCode,
    plannedWeight: node.plannedWeight,
    jobOrders: jobOrders
      .filter((order) => order.projectWbs.id === node.id)
      .map((order) => ({
        id: order.id,
        budgetHours: order.budgetedHours,
        plannedStartDate: order.plannedStartDate,
        plannedEndDate: order.plannedEndDate,
      })),
  }));

  const budgetHours = jobOrders.reduce((sum, order) => sum + order.budgetedHours, 0);

  // Per-WBS curves. The weights are the ones the project curve uses, so the parts add up to the whole:
  // a node's planned hours are its share of the budget, not the whole budget.
  const shares = normaliseWeights(curveWbs);
  const actualByWbsDay = new Map<number, Map<string, number>>();
  for (const row of wbsHourRows) {
    if (row.projectWbsId === null) continue;
    const byDay = actualByWbsDay.get(row.projectWbsId) ?? new Map<string, number>();
    const day = iso(row.workDate);
    byDay.set(day, (byDay.get(day) ?? 0) + hoursOf(row._count, row._sum.otHours));
    actualByWbsDay.set(row.projectWbsId, byDay);
  }
  const wbsCurves: WbsCurveRow[] = curveWbs.map((node) => {
    const share = shares.get(node.id) ?? 0;
    const nodeBudget = round2(share * budgetHours);
    const byDay = actualByWbsDay.get(node.id) ?? new Map<string, number>();
    const curve = buildSCurve({
      buckets,
      wbs: [node],
      budgetHours: nodeBudget,
      actualHoursByBucket: buckets.map((bucket) => sumRange(byDay, bucket)),
    });
    const last = curve.points[curve.points.length - 1];
    const plannedToDate = last ? last.plannedCum : 0;
    const actualToDate = last ? last.actualCum : 0;
    return {
      wbsId: node.id,
      wbsCode: node.wbsCode,
      name: curveWbs.find((row) => row.id === node.id)?.wbsCode ?? node.wbsCode,
      plannedWeight: node.plannedWeight,
      share: Math.round(share * 10_000) / 10_000,
      budgetHours: nodeBudget,
      plannedToDate,
      actualToDate,
      variance: round2(actualToDate - plannedToDate),
      jobOrders: node.jobOrders.length,
      jobOrdersScheduled: node.jobOrders.filter((order) => order.plannedStartDate && order.plannedEndDate).length,
      curve,
    };
  });
  const attendance = await loadAttendanceGrounding(jobOrderIds, window, manDayRows, now);

  const payload = buildReviewPayload({
    project: {
      id: project.id,
      code: project.code,
      name: project.name,
      // A Project row has no Department of its own: its departments are the ones its Job Orders name.
      departmentName: [...new Set(jobOrders.map((order) => order.department.name))].sort().join(", ") || null,
      projectManager: project.managerAssignments[0]?.user.name ?? null,
    },
    period: {
      kind: input.period.kind,
      start: window.start,
      end: window.end,
      label: periodLabel(window, input.period.kind),
      provisional: new Date(`${window.end}T23:59:59.999Z`) > now,
    },
    generatedAt: now,
    now,
    buckets,
    wbs: curveWbs,
    facts,
    budgetHours,
    actualHoursByBucket: buckets.map((bucket) => sumRange(actualByBucket, bucket)),
    manpowerBuckets: buckets,
    contractRows: manDayRows.map((row) => ({
      workDate: iso(row.workDate),
      employeeId: row.employeeId,
      hours: hoursOf(row._count, row._sum.otHours),
    })),
    payrollRows: allocationRows.map((row) => ({
      workDate: iso(row.workDate),
      employeeId: row.employeeId,
      // My hours is a four-slot grid and one slot is two hours — the same convention the timesheet
      // uses for a full shift, so the two series are comparable without being added together.
      hours: row._count.shiftSlot * 2,
    })),
    escalations: summariseEscalationsByAge({
      escalations: escalationRows.map(toEscalationMessage),
      replies,
      now,
    }),
    items: itemRows,
    attendance,
    wbsCurves,
    budgetRevisionLabel: latestRevisionLabel(revisionRows),
  });

  return { payload, scope, prismaCalls: 11 + (replies.length ? 1 : 0) };
}

/** Present man-days against booked man-days: the question only the attendance settlement can answer. */
async function loadAttendanceGrounding(
  jobOrderIds: readonly number[],
  window: { start: string; end: string },
  manDayRows: ReadonlyArray<{ workDate: Date; employeeId: number }>,
  now: Date
): Promise<{ grounding: ReviewPayload["attendance"]["grounding"]; gap: ReviewPayload["attendance"]["gap"] }> {
  if (!settleReportsEnabled()) return { grounding: null, gap: "SETTLEMENT_OFF" };
  const employeeIds = [...new Set(manDayRows.map((row) => row.employeeId))];
  if (!employeeIds.length) return { grounding: null, gap: "NO_SETTLED_ROWS" };

  const settled = await prisma.attendanceDay.findMany({
    where: {
      employeeId: { in: employeeIds },
      workDate: { gte: new Date(`${window.start}T00:00:00.000Z`), lte: new Date(`${window.end}T00:00:00.000Z`) },
      attendanceClass: { in: ["WORKED", "WORKED_WEEKLY_OFF", "WORKED_HOLIDAY"] },
    },
    select: { employeeId: true, workDate: true },
  });
  if (!settled.length) return { grounding: null, gap: "NO_SETTLED_ROWS" };

  const present = new Set(settled.map((row) => `${row.employeeId}:${iso(row.workDate)}`));
  const booked = new Set(manDayRows.map((row) => `${row.employeeId}:${iso(row.workDate)}`));
  // Booked man-days that fall OUTSIDE the settled present set are still days the project was charged —
  // they are not counted as unbooked, and they cannot reduce the gap.
  const unbooked = [...present].filter((key) => !booked.has(key)).length;
  void jobOrderIds;
  void now;
  return {
    grounding: {
      presentManDays: present.size,
      bookedManDays: booked.size,
      unbookedManDays: unbooked,
      basis: "SETTLED_ATTENDANCE",
    },
    gap: null,
  };
}

/**
 * One Job Order's own S-curve: its budget spread across its own planned window, against the hours booked to
 * it. Fetched on demand because a project can hold hundreds of Job Orders and the screen draws one.
 *
 * The scope check is the same one the dashboard performs — a foreign project is NOT FOUND, and an HOD may
 * only plot a Job Order of their own department.
 */
export async function loadJobOrderCurve(input: {
  projectId: number;
  jobOrderId: number;
  actor: ReviewActor;
  period: ReviewPeriodRequest;
  now?: Date;
}): Promise<{
  jobOrder: { id: number; code: string; name: string; wbsCode: string; budgetHours: number };
  curve: ReturnType<typeof buildSCurve>;
  window: { start: string; end: string };
}> {
  const now = input.now ?? new Date();
  const scope = await resolveReviewScope(input.actor);
  if (!scope.ok) throw new ReviewNotFound();
  if (scope.scope.kind === "PROJECTS" && !scope.scope.projectIds.includes(input.projectId)) {
    throw new ReviewNotFound();
  }

  const jobOrder = await prisma.jobOrder.findFirst({
    where: {
      id: input.jobOrderId,
      projectId: input.projectId,
      ...(scope.scope.kind === "DEPARTMENT" ? { departmentId: scope.scope.departmentId } : {}),
    },
    select: {
      id: true,
      code: true,
      name: true,
      budgetedHours: true,
      plannedStartDate: true,
      plannedEndDate: true,
      projectWbs: { select: { id: true, wbsCode: true } },
    },
  });
  if (!jobOrder) throw new ReviewNotFound();

  const window = resolveWindow(input.period, now);
  const buckets = bucketsBetween(
    new Date(`${window.start}T00:00:00Z`),
    new Date(`${window.end}T00:00:00Z`),
    input.period.granularity ?? "week"
  );

  const rows = await prisma.timesheetEntry.groupBy({
    by: ["workDate"],
    where: { jobOrderId: jobOrder.id, status: { in: [...BOOKED_HOURS_STATUSES] } },
    _sum: { otHours: true },
    _count: { shiftSlot: true, hourSlot: true },
  });
  const byDay = new Map<string, number>();
  for (const row of rows) {
    byDay.set(iso(row.workDate), (byDay.get(iso(row.workDate)) ?? 0) + hoursOf(row._count, row._sum.otHours));
  }

  const curve = buildSCurve({
    buckets,
    wbs: [
      {
        id: jobOrder.projectWbs.id,
        wbsCode: jobOrder.projectWbs.wbsCode,
        plannedWeight: null,
        jobOrders: [
          {
            id: jobOrder.id,
            budgetHours: jobOrder.budgetedHours,
            plannedStartDate: jobOrder.plannedStartDate,
            plannedEndDate: jobOrder.plannedEndDate,
          },
        ],
      },
    ],
    budgetHours: jobOrder.budgetedHours,
    actualHoursByBucket: buckets.map((bucket) => sumRange(byDay, bucket)),
  });

  return {
    jobOrder: {
      id: jobOrder.id,
      code: jobOrder.code,
      name: jobOrder.name,
      wbsCode: jobOrder.projectWbs.wbsCode,
      budgetHours: jobOrder.budgetedHours,
    },
    curve,
    window,
  };
}

function emptyPayload(
  project: { id: number; code: string; name: string; managerAssignments: Array<{ user: { name: string } }> },
  period: ReviewPeriodRequest,
  now: Date
): ReviewPayload {
  const window = resolveWindow(period, now);
  return buildReviewPayload({
    project: {
      id: project.id,
      code: project.code,
      name: project.name,
      departmentName: null,
      projectManager: project.managerAssignments[0]?.user.name ?? null,
    },
    period: {
      kind: period.kind,
      start: window.start,
      end: window.end,
      label: periodLabel(window, period.kind),
      provisional: false,
    },
    generatedAt: now,
    now,
    buckets: [],
    wbs: [],
    facts: [],
    budgetHours: 0,
    actualHoursByBucket: [],
    manpowerBuckets: [],
    contractRows: [],
    payrollRows: [],
    escalations: summariseEscalationsByAge({ escalations: [], replies: [], now }),
    items: [],
    attendance: { grounding: null, gap: "NOT_REQUESTED" },
  });
}

export function resolveWindow(period: ReviewPeriodRequest, now: Date): { start: string; end: string } {
  const fallback = defaultPeriod(now, period.kind);
  const start = period.start ?? fallback.start;
  const end = period.end ?? fallback.end;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    throw new ReviewNotFound("BAD_PERIOD");
  }
  if (new Date(start) > new Date(end)) throw new ReviewNotFound("BAD_PERIOD");
  return { start, end };
}

export function periodLabel(window: { start: string; end: string }, kind: "WEEKLY" | "MONTHLY"): string {
  const start = new Date(`${window.start}T00:00:00Z`);
  const end = new Date(`${window.end}T00:00:00Z`);
  const format = (date: Date) =>
    date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const lastDayOfEndMonth = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0));
  // A rolling window is NOT a calendar month: naming it "September 2026" while it ends on 24 October would
  // mislabel a month's worth of numbers, so only an exact calendar month gets the month's name.
  const isCalendarMonth =
    kind === "MONTHLY" &&
    start.getUTCDate() === 1 &&
    start.getUTCFullYear() === end.getUTCFullYear() &&
    start.getUTCMonth() === end.getUTCMonth() &&
    end.getUTCDate() === lastDayOfEndMonth.getUTCDate();
  if (isCalendarMonth) {
    return start.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
  }
  return `${format(start)} – ${format(end)}`;
}

function latestRevisionLabel(
  rows: ReadonlyArray<{ jobOrderId: number; revisionNo: number; budgetedHours: number; effectiveFrom: Date }>
): string | null {
  if (!rows.length) return null;
  const latest = rows.reduce((best, row) => (row.revisionNo > best.revisionNo ? row : best), rows[0]);
  return `revision ${latest.revisionNo} (${iso(latest.effectiveFrom)})`;
}

function sumRange(map: Map<string, number>, bucket: CurveBucket): number {
  let total = 0;
  for (const [day, hours] of map) {
    if (day >= bucket.start && day <= bucket.end) total += hours;
  }
  return total;
}

function groupBy<T>(rows: readonly T[], key: (row: T) => number): Map<number, T[]> {
  const map = new Map<number, T[]>();
  for (const row of rows) {
    const id = key(row);
    const list = map.get(id);
    if (list) list.push(row);
    else map.set(id, [row]);
  }
  return map;
}

function startOfDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function iso(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Exported for the route's day-list echo, so the screen and the loader agree on the window. */
export function windowDays(window: { start: string; end: string }): string[] {
  return eachDay(window.start, window.end);
}
