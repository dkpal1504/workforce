/**
 * The operational snapshot a message carries, and the owner a Job Order addresses.
 *
 * The snapshot reuses the report's OWN rules — `buildJobOrderFacts`, `hoursOf`,
 * `BOOKED_HOURS_STATUSES`, `UNAPPROVED_STATUSES` — rather than re-deriving burn, bands or schedule.
 * A conversation that quoted a different number from the dashboard would destroy trust in both.
 */

import { prisma } from "../db";
import { buildJobOrderFacts, BOOKED_HOURS_STATUSES } from "./portfolioReporting";
import { hoursOf, UNAPPROVED_STATUSES } from "./portfolioReport";
import type { BriefFacts } from "./assistantPrompts";

export type JobOrderContext = {
  /** The line printed under a message: "Burn 82% AMBER · Schedule DELAYED 6d · Qty 64% · Budget rev 3". */
  line: string;
  /** Stored on the message as JSON (the frozen snapshot). */
  data: {
    asOf: string;
    budgetHours: number;
    actualHours: number;
    burnPct: number | null;
    hoursBand: string;
    scheduleBand: string;
    daysToEnd: number | null;
    qtyCompletePct: number | null;
    daysSinceActivity: number | null;
    unapprovedHours: number;
    revisionNo: number | null;
  };
};

/** The Job Order facts a message freezes, in one bounded set of queries. */
export async function jobOrderContextFor(jobOrderId: number, now: Date = new Date()): Promise<JobOrderContext | null> {
  const jobOrder = await prisma.jobOrder.findUnique({
    where: { id: jobOrderId },
    select: {
      id: true,
      code: true,
      name: true,
      status: true,
      budgetedHours: true,
      budgetedQuantity: true,
      plannedStartDate: true,
      plannedEndDate: true,
      project: { select: { id: true, code: true, name: true } },
      projectWbs: { select: { id: true, wbsCode: true, name: true } },
      network: { select: { id: true, code: true, name: true } },
      department: { select: { id: true, name: true } },
      section: { select: { id: true, name: true } },
      uom: { select: { code: true } },
    },
  });
  if (!jobOrder) return null;

  const [revisions, progressRows, booked, unapproved, span] = await Promise.all([
    prisma.jobOrderBudgetRevision.findMany({
      where: { jobOrderId },
      select: { revisionNo: true, budgetedHours: true, budgetedQuantity: true, effectiveFrom: true },
    }),
    prisma.jobOrderProgress.findMany({
      where: { jobOrderId },
      select: { status: true, cumulativeQuantity: true, progressDate: true, revisionNo: true },
    }),
    prisma.timesheetEntry.groupBy({
      by: ["jobOrderId"],
      where: { jobOrderId, status: { in: [...BOOKED_HOURS_STATUSES] } },
      _sum: { otHours: true },
      _count: { shiftSlot: true, hourSlot: true },
    }),
    prisma.timesheetEntry.groupBy({
      by: ["jobOrderId"],
      where: { jobOrderId, status: { in: [...UNAPPROVED_STATUSES] } },
      _sum: { otHours: true },
      _count: { shiftSlot: true, hourSlot: true },
    }),
    prisma.timesheetEntry.groupBy({
      by: ["jobOrderId"],
      where: { jobOrderId, status: { in: [...BOOKED_HOURS_STATUSES] } },
      _min: { workDate: true },
      _max: { workDate: true },
    }),
  ]);

  const bookedRow = booked[0];
  const unapprovedRow = unapproved[0];
  const spanRow = span[0];
  const asOf = spanRow?._max.workDate ?? now;

  const facts = buildJobOrderFacts({
    jobOrder: {
      id: jobOrder.id,
      code: jobOrder.code,
      name: jobOrder.name,
      status: jobOrder.status,
      budgetedHours: jobOrder.budgetedHours,
      budgetedQuantity: jobOrder.budgetedQuantity,
      uom: jobOrder.uom.code,
      project: jobOrder.project,
      wbs: { id: jobOrder.projectWbs.id, wbsCode: jobOrder.projectWbs.wbsCode, name: jobOrder.projectWbs.name ?? "" },
      network: jobOrder.network ? { id: jobOrder.network.id, code: jobOrder.network.code, name: jobOrder.network.name ?? "" } : null,
      department: jobOrder.department,
      section: jobOrder.section,
      plannedStartDate: jobOrder.plannedStartDate,
      plannedEndDate: jobOrder.plannedEndDate,
    },
    budgetRevisions: revisions,
    actualHours: bookedRow ? hoursOf(bookedRow._count, bookedRow._sum.otHours) : 0,
    unapprovedHours: unapprovedRow ? hoursOf(unapprovedRow._count, unapprovedRow._sum.otHours) : 0,
    oldestUnapprovedAt: null,
    firstBooking: spanRow?._min.workDate ?? null,
    lastBooking: spanRow?._max.workDate ?? null,
    progressRows,
    asOf,
    now,
  });

  const revisionNo = revisions.length
    ? revisions.reduce((latest, row) => (row.revisionNo > latest.revisionNo ? row : latest)).revisionNo
    : null;

  const pct = (value: number | null): string => (value === null ? "—" : `${Math.round(value * 100)}%`);
  const schedule = facts.scheduleBand === "DELAYED" && facts.daysToEnd !== null
    ? `DELAYED ${Math.abs(facts.daysToEnd)}d`
    : facts.scheduleBand.replace(/_/g, " ");

  const line = [
    `Burn ${pct(facts.burnPct)} ${facts.hoursBand}`,
    `Schedule ${schedule}`,
    `Qty ${pct(facts.qtyCompletePct)}`,
    revisionNo === null ? "no budget revision" : `Budget rev ${revisionNo}`,
  ].join(" · ");

  return {
    line,
    data: {
      asOf: asOf.toISOString().slice(0, 10),
      budgetHours: facts.budgetHours,
      actualHours: facts.actualHours,
      burnPct: facts.burnPct,
      hoursBand: facts.hoursBand,
      scheduleBand: facts.scheduleBand,
      daysToEnd: facts.daysToEnd,
      qtyCompletePct: facts.qtyCompletePct,
      daysSinceActivity: facts.daysSinceActivity,
      unapprovedHours: facts.unapprovedHours,
      revisionNo,
    },
  };
}

/** The same facts in the shape the assistant prompt takes. */
export async function briefFactsFor(jobOrderId: number): Promise<BriefFacts | null> {
  const row = await prisma.jobOrder.findUnique({
    where: { id: jobOrderId },
    select: {
      code: true,
      name: true,
      status: true,
      project: { select: { code: true, name: true } },
      projectWbs: { select: { wbsCode: true } },
      network: { select: { code: true } },
      department: { select: { name: true } },
      section: { select: { name: true } },
      thread: {
        select: {
          messages: { orderBy: { seq: "desc" }, take: 5, select: { seq: true, kind: true, authorRole: true, body: true } },
          commitments: { where: { state: "OPEN" }, select: { dueOn: true } },
        },
      },
    },
  });
  if (!row) return null;
  const context = await jobOrderContextFor(jobOrderId);
  if (!context) return null;
  const messages = (row.thread?.messages ?? []).slice().reverse();
  const openEscalations = messages.filter((m) => m.kind === "ESCALATION").length;
  const now = new Date();
  const promisesOverdue = (row.thread?.commitments ?? []).filter((c) => c.dueOn.getTime() <= now.getTime()).length;

  return {
    code: row.code,
    name: row.name,
    project: `${row.project.code} · ${row.project.name}`,
    wbs: row.projectWbs.wbsCode,
    network: row.network?.code ?? null,
    department: row.department.name,
    section: row.section?.name ?? null,
    status: row.status,
    budgetHours: context.data.budgetHours,
    actualHours: context.data.actualHours,
    burnPct: context.data.burnPct,
    hoursBand: context.data.hoursBand,
    plannedStart: null,
    plannedEnd: null,
    scheduleBand: context.data.scheduleBand,
    daysToEnd: context.data.daysToEnd,
    targetQty: 0,
    achievedQty: 0,
    qtyCompletePct: context.data.qtyCompletePct,
    daysSinceActivity: context.data.daysSinceActivity,
    unapprovedHours: context.data.unapprovedHours,
    openEscalations,
    promisesOverdue,
    lastMessages: messages.map((m) => ({ seq: m.seq, kind: m.kind, role: m.authorRole, body: m.body })),
  };
}

export type ResolvedOwner = {
  userId: number | null;
  /** A routable address, or null when the person only has an `@employee.local` login handle. */
  email: string | null;
  /** The account's login identifier, always present when `userId` is: the participant key. */
  loginEmail: string | null;
  name: string;
  /** How the owner was decided, shown in the UI so nobody wonders why this person was addressed. */
  basis: "EXPLICIT" | "SECTION_HOD" | "DEPARTMENT_HOD" | "NONE";
};

/**
 * Who holds this Job Order.
 *
 * Explicit assignment wins. Otherwise the HOD(s) of the Job Order's own section — a Section that
 * carries several HODs resolves to the first active one — then the department-wide HOD. Nothing is
 * invented: no mapping means NO owner, and the UI says so.
 */
export async function resolveOwner(jobOrderId: number): Promise<ResolvedOwner> {
  const jobOrder = await prisma.jobOrder.findUnique({
    where: { id: jobOrderId },
    select: {
      sectionId: true,
      departmentId: true,
      owner: { select: { id: true, name: true, email: true, notificationEmail: true, active: true } },
    },
  });
  if (!jobOrder) return { userId: null, email: null, loginEmail: null, name: "No owner", basis: "NONE" };

  if (jobOrder.owner && jobOrder.owner.active) {
    return {
      userId: jobOrder.owner.id,
      email: jobOrder.owner.notificationEmail ?? realEmail(jobOrder.owner.email),
      loginEmail: jobOrder.owner.email,
      name: jobOrder.owner.name,
      basis: "EXPLICIT",
    };
  }

  const hos = await prisma.user.findMany({
    where: { role: "HOD", active: true, departmentId: jobOrder.departmentId },
    select: { id: true, name: true, email: true, notificationEmail: true, sectionId: true, scopeSections: { select: { sectionId: true } } },
    orderBy: { id: "asc" },
  });
  const sectionHod = jobOrder.sectionId == null
    ? null
    : hos.find((user) => {
        const sections = user.scopeSections.length ? user.scopeSections.map((s) => s.sectionId) : user.sectionId == null ? [] : [user.sectionId];
        return sections.includes(jobOrder.sectionId as number);
      });
  const departmentHod = hos.find((user) => user.scopeSections.length === 0 && user.sectionId == null);

  const chosen = sectionHod ?? departmentHod;
  if (chosen) {
    return {
      userId: chosen.id,
      email: chosen.notificationEmail ?? realEmail(chosen.email),
      loginEmail: chosen.email,
      name: chosen.name,
      basis: sectionHod ? "SECTION_HOD" : "DEPARTMENT_HOD",
    };
  }
  return { userId: null, email: null, loginEmail: null, name: "No owner", basis: "NONE" };
}

/** A login e-mail that is a real address; `@employee.local` handles are not routable. */
function realEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  return email.endsWith("@employee.local") ? null : email;
}
