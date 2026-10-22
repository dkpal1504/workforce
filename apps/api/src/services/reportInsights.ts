/**
 * The two conversation-derived datasets that now travel with the Reports export: the delay causes and the
 * hindrance register.
 *
 * WHY THEY LIVE HERE AND NOT IN THE ROUTE: the workbook, the PDF and the screen must state the same
 * numbers. One loader, called by both the JSON endpoints and the download handler, is the only way to be
 * sure of that; two queries would agree until the first time somebody fixed one of them.
 *
 * The row shaping is PURE and tested, because "41% of 68" in a file somebody forwards is a claim that has
 * to be reproducible.
 */
import { prisma } from "../db";
import { conversationScopeFor, type ConversationActor } from "./conversationScope";
import { threadScopeWhere } from "./conversations";
import { ageingBucket, elapsedHours } from "./sla";
import {
  hindranceAge,
  type HindranceAge,
} from "./recovery";
import {
  insightSentence,
  periodRange,
  summariseReasons,
  type InsightPeriod,
  type ReasonSummary,
} from "./delayReasons";

export type DelayExportRow = {
  cause: string;
  count: number;
  sharePct: number;
  averageOpenDays: number;
};

export type HindranceExportRow = {
  wbsCode: string | null;
  jobOrderCode: string | null;
  jobOrderName: string | null;
  category: string;
  description: string;
  ownerEmail: string;
  raisedByEmail: string;
  raisedOn: string;
  ageDays: number;
  stale: boolean;
  state: string;
  closedByName: string;
  closedOn: string;
  closureNote: string;
};

export type ReportInsights = {
  period: InsightPeriod;
  from: string;
  to: string;
  sentence: string;
  delays: { total: number; uncoded: number; rows: DelayExportRow[] };
  hindrances: { state: "OPEN" | "CLOSED"; total: number; rows: HindranceExportRow[] };
  /** Median hours to first answer over the same period — the third number a reader asks for. */
  response: { answered: number; expected: number; medianHours: number | null; withinTargetPct: number | null; overdue24: number };
};

/** Cause rows in the order the screen lists them: largest first. */
export function delayExportRows(summary: ReasonSummary): DelayExportRow[] {
  return summary.byReason.map((row) => ({
    cause: row.label,
    count: row.count,
    sharePct: row.share,
    averageOpenDays: row.averageOpenDays,
  }));
}

/** Register rows, oldest first: an export read in a meeting should lead with what has been open longest. */
export function hindranceExportRows(
  rows: ReadonlyArray<{
    wbsCode: string | null;
    jobOrderCode: string | null;
    jobOrderName: string | null;
    category: string;
    description: string;
    ownerEmail: string | null;
    raisedByEmail: string;
    raisedAt: Date;
    state: string;
    closedByName: string | null;
    closedAt: Date | null;
    closureNote: string | null;
    age: HindranceAge;
  }>
): HindranceExportRow[] {
  return [...rows]
    .sort((a, b) => b.age.days - a.age.days)
    .map((row) => ({
      wbsCode: row.wbsCode,
      jobOrderCode: row.jobOrderCode,
      jobOrderName: row.jobOrderName,
      category: row.category,
      description: row.description,
      ownerEmail: row.ownerEmail ?? "",
      raisedByEmail: row.raisedByEmail,
      raisedOn: row.raisedAt.toISOString().slice(0, 10),
      ageDays: row.age.days,
      stale: row.age.stale,
      state: row.state,
      closedByName: row.closedByName ?? "",
      closedOn: row.closedAt ? row.closedAt.toISOString().slice(0, 10) : "",
      closureNote: row.closureNote ?? "",
    }));
}

/**
 * Load both datasets for the reader's scope.
 *
 * The scope is the CONVERSATION scope, not the report's: a Project Manager reads his portfolio in both
 * places, and an HOD his department, so the file cannot show work the screen would refuse. `NONE` yields
 * empty datasets rather than an error — a report without conversations is still a report.
 */
export async function loadReportInsights(
  actor: ConversationActor,
  period: InsightPeriod,
  hindranceState: "OPEN" | "CLOSED",
  now: Date = new Date()
): Promise<ReportInsights> {
  const scope = await conversationScopeFor(actor);
  const { from, to } = periodRange(period, now);

  if (scope.kind === "NONE") {
    return {
      period,
      from: from.toISOString(),
      to: to.toISOString(),
      sentence: insightSentence({ total: 0, byReason: [], uncoded: 0 }, period),
      delays: { total: 0, uncoded: 0, rows: [] },
      hindrances: { state: hindranceState, total: 0, rows: [] },
      response: { answered: 0, expected: 0, medianHours: null, withinTargetPct: null, overdue24: 0 },
    } as ReportInsights;
  }

  const messages = await prisma.jobOrderMessage.findMany({
    where: { createdAt: { gte: from, lte: to }, thread: threadScopeWhere(scope) },
    select: {
      reasonCode: true,
      createdAt: true,
      responseDueAt: true,
      answeredBy: { select: { createdAt: true }, take: 1, orderBy: { createdAt: "asc" } },
    },
  });

  const summary = summariseReasons(
    messages
      .filter((row) => row.reasonCode != null)
      .map((row) => ({ reasonCode: row.reasonCode, raisedAt: row.createdAt, closedAt: null })),
    now
  );

  const expected = messages.filter((row) => row.responseDueAt != null);
  const answered = expected.filter((row) => row.answeredBy[0] != null);
  const durations = answered
    .map((row) => elapsedHours(row.createdAt, row.answeredBy[0]!.createdAt))
    .sort((a, b) => a - b);
  const median = durations.length
    ? durations.length % 2 === 1
      ? durations[Math.floor(durations.length / 2)]
      : (durations[durations.length / 2 - 1] + durations[durations.length / 2]) / 2
    : null;
  const within = answered.filter(
    (row) =>
      elapsedHours(row.createdAt, row.answeredBy[0]!.createdAt) <=
      Math.max(1, Math.round((row.responseDueAt!.getTime() - row.createdAt.getTime()) / 3_600_000))
  ).length;

  const hindranceRows = await prisma.wbsHindrance.findMany({
    where: { jobOrderId: { not: null }, state: hindranceState },
    orderBy: [{ raisedAt: "asc" }],
    take: 500,
  });

  const jobOrderIds = [...new Set(hindranceRows.map((row) => row.jobOrderId).filter((id): id is number => id != null))];
  const orders = jobOrderIds.length
    ? await prisma.jobOrder.findMany({
        where: { id: { in: jobOrderIds } },
        select: { id: true, code: true, name: true, departmentId: true, sectionId: true, projectId: true },
      })
    : [];
  const orderById = new Map(orders.map((order) => [order.id, order]));

  const inScope = (departmentId: number | null, sectionId: number | null, projectId: number | null): boolean => {
    switch (scope.kind) {
      case "ORGANISATION":
        return true;
      case "PROJECTS":
        return projectId != null && scope.projectIds.includes(projectId);
      case "DEPARTMENT":
        if (departmentId !== scope.departmentId) return false;
        if (scope.sectionIds.length === 0) return true;
        return sectionId == null || scope.sectionIds.includes(sectionId);
      default:
        return false;
    }
  };

  const wbsIds = [...new Set(hindranceRows.map((row) => row.projectWbsId))];
  const wbs = wbsIds.length
    ? await prisma.projectWbs.findMany({ where: { id: { in: wbsIds } }, select: { id: true, wbsCode: true } })
    : [];
  const wbsCode = new Map(wbs.map((row) => [row.id, row.wbsCode]));

  const hindrances = hindranceExportRows(
    hindranceRows
      .filter((row) => {
        const order = row.jobOrderId ? orderById.get(row.jobOrderId) : undefined;
        return inScope(order?.departmentId ?? null, order?.sectionId ?? null, order?.projectId ?? null);
      })
      .map((row) => {
        const order = row.jobOrderId ? orderById.get(row.jobOrderId) : undefined;
        return {
          wbsCode: wbsCode.get(row.projectWbsId) ?? null,
          jobOrderCode: order?.code ?? null,
          jobOrderName: order?.name ?? null,
          category: row.category,
          description: row.description,
          ownerEmail: row.ownerEmail,
          raisedByEmail: row.raisedByEmail,
          raisedAt: row.raisedAt,
          state: row.state,
          closedByName: row.closedByName,
          closedAt: row.closedAt,
          closureNote: row.closureNote,
          age: hindranceAge(row.raisedAt, row.closedAt, now),
        };
      })
  );

  const openAges = expected.filter((row) => row.answeredBy[0] == null);
  const overdue24 = openAges.filter((row) => ageingBucket(elapsedHours(row.createdAt, now)) === "over24").length;

  return {
    period,
    from: from.toISOString(),
    to: to.toISOString(),
    sentence: insightSentence(summary, period),
    delays: { total: summary.total, uncoded: summary.uncoded, rows: delayExportRows(summary) },
    hindrances: { state: hindranceState, total: hindrances.length, rows: hindrances },
    response: {
      answered: answered.length,
      expected: expected.length,
      medianHours: median == null ? null : Math.round(median * 10) / 10,
      withinTargetPct: answered.length ? Math.round((within / answered.length) * 100) : null,
      overdue24,
    },
  };
}
