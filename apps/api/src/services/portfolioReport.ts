/**
 * Portfolio report — the BOUNDED query layer and the response assembly.
 *
 * Two responsibilities, deliberately separated so the second can be unit-tested with no
 * database at all:
 *
 *   `buildPortfolioReport(filters, actor)`  — fetches every row the report needs in a FIXED
 *       number of Prisma round-trips (never one query per job order), turns them into
 *       `JobOrderFacts` via the pure `buildJobOrderFacts`, and hands the facts to the
 *       assembler. This is the only function in the module that touches the database.
 *
 *   `assemblePortfolioReport(input)`        — pure: takes already-built facts plus the
 *       resolved as-of date and produces the six sections the Operations Dashboard and both
 *       exports render (pulse, needs-push, on-track, job-work, department load, exceptions)
 *       together with the provenance and the definitions DATA.
 *
 * WHERE THE RULES LIVE: none of the banding, scoring, revision or filter logic is
 * re-implemented here. Bands, burn, attention and the roll-ups come from
 * `portfolioReporting.ts`; filter parsing and the filter hash come from
 * `portfolioFilters.ts`. This module only fetches and arranges.
 *
 * THE HOURS COLUMN (the one judgement a reader must be able to check): booked hours are the
 * same figure `GET /api/summary/job-order` reports — `otHours` when the row is an OT row,
 * otherwise 2h for a `shiftSlot` row and 1h for a legacy `hourSlot` row, summed per
 * job order. It is computed in `hoursOf()` below. That choice is what makes this screen
 * agree with the Summary screen for the same job order, which the plan (§2.4) requires.
 */

import { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "../db";
import {
  burnPct,
  buildJobOrderFacts,
  rollUpDepartments,
  rollUpProjects,
  sortByAttention,
  type Band,
  type DepartmentRollUp,
  type JobOrderFacts,
  type ProjectRollUp,
} from "./portfolioReporting";
import {
  describePortfolioFilters,
  portfolioFiltersHash,
  type PortfolioFilters,
} from "./portfolioFilters";

/* --------------------------------------------------------------------------- *
 * Prisma call counting — the no-N+1 guard
 * ------------------------------------------------------------------------- */

/**
 * Every database call the loader makes, appended in order. Exported so a test can reset it
 * and count round-trips: the loader must make the SAME number of calls whether the scope
 * holds 4 job orders or 4,000, which is the whole substance of the "no N+1" rule.
 *
 * The counter lives on this module's own client rather than on the shared `prisma` import,
 * so it can never disturb any other caller's connection.
 */
export const prismaCalls: string[] = [];

/**
 * A thin proxy over the shared Prisma client that records each method call. Top-level
 * functions ($queryRaw, $disconnect, …) are recorded and forwarded; model delegates are
 * wrapped one level deeper so `db.timesheetEntry.groupBy(...)` records as one call.
 */
function countingClient(): PrismaClient {
  const handler: ProxyHandler<PrismaClient> = {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") {
        // A model delegate (jobOrder, timesheetEntry, …): wrap its methods too.
        const model = value as Record<string, unknown>;
        return new Proxy(model, {
          get(modelTarget, modelProp, modelReceiver) {
            const method = Reflect.get(modelTarget, modelProp, modelReceiver);
            if (typeof method !== "function") return method;
            return (...args: unknown[]) => {
              prismaCalls.push(`${String(prop)}.${String(modelProp)}`);
              return (method as (...a: unknown[]) => unknown).apply(modelTarget, args);
            };
          },
        });
      }
      return (...args: unknown[]) => {
        prismaCalls.push(String(prop));
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  };
  return new Proxy(prisma, handler);
}

/** The counting client. Kept private: callers use `buildPortfolioReport`. */
const db = countingClient();

/* --------------------------------------------------------------------------- *
 * Shapes
 * ------------------------------------------------------------------------- */

/** Who asked for the report. Carried into the provenance so an export is attributable. */
export type ReportActor = { id: number; name: string; role: string };

/** A `JobOrderFacts` row with its dates already reduced to `YYYY-MM-DD` (or null). */
export type ReportJobRow = Omit<
  JobOrderFacts,
  "lastBooking" | "oldestUnapprovedAt" | "forecastExhaustedOn"
> & {
  lastBooking: string | null;
  oldestUnapprovedAt: string | null;
  forecastExhaustedOn: string | null;
};

/** One capped exception group: the whole truth in `count`, a bounded sample in `rows`. */
export type ExceptionBucket = { count: number; rows: ReportJobRow[] };

export type PortfolioPulse = {
  /** Distinct projects represented among the job orders in scope. */
  projects: number;
  jobOrders: number;
  budgetHours: number;
  actualHours: number;
  /** `actualHours / budgetHours`, or null when the total budget is zero (never a fake 0). */
  portfolioBurnPct: number | null;
  bands: Record<Band, number>;
  /** Measurable-on-hours job orders with no booking inside the activity window. */
  noActivity: number;
  hoursAwaitingApproval: number;
  /** The oldest unapproved booking date in scope, `YYYY-MM-DD`, or null. */
  oldestUnapprovedAt: string | null;
};

/**
 * The band thresholds and attention weights AS DATA.
 *
 * These are read straight from the same constants the pure rules use, so the UI and the
 * exports can PRINT the rules they applied instead of hardcoding a sentence that can drift
 * from the code. Each weight carries the reason string it produces, so a reader can trace a
 * score back to its cause.
 */
export type PortfolioDefinitions = {
  bands: Record<Band, { min: number | null; max: number | null; label: string }>;
  attentionWeights: {
    hoursRed: number;
    hoursAmber: number;
    noActivity7d: number;
    unapprovedAging3d: number;
    quantityBehind: number;
    noBudget: number;
  };
  measurable: { onHours: string; onQuantity: string };
  activityWindowDaysNote: string;
  notes: string[];
};

export type PortfolioReport = {
  generatedAt: string;
  asOf: string;
  provenance: {
    filters: Array<{ label: string; value: string }>;
    filtersHash: string;
    generatedBy: ReportActor;
  };
  definitions: PortfolioDefinitions;
  pulse: PortfolioPulse;
  projectRollUps: ProjectRollUp[];
  needsPush: ReportJobRow[];
  /** The full number of ranked job orders, even when `needsPush` is capped. */
  needsPushTotal: number;
  onTrack: ReportJobRow[];
  onTrackNotMeasurable: ReportJobRow[];
  jobWork: ReportJobRow[];
  departmentLoad: DepartmentRollUp[];
  exceptions: {
    noBudgetHours: ExceptionBucket;
    budgetWithNoBookings: ExceptionBucket;
    noProgress: ExceptionBucket;
    unapproved: ExceptionBucket;
  };
};

/* --------------------------------------------------------------------------- *
 * The attention weights, named once
 * ------------------------------------------------------------------------- */

/**
 * Mirrors the additive weights documented on `attentionFor` in portfolioReporting.ts. They
 * are repeated here as NAMED CONSTANTS so the definitions block can expose them as data.
 * If the pure function's weights ever change, this block must change with it — the
 * portfolioReporting test and this module's definitions test would both fail, which is the
 * intended tripwire.
 */
const ATTENTION_WEIGHTS = {
  hoursRed: 40,
  hoursAmber: 25,
  noActivity7d: 30,
  unapprovedAging3d: 20,
  quantityBehind: 15,
  noBudget: 10,
} as const;

/** The band rule as printable data. Boundaries are inclusive on the min side. */
const BAND_DEFINITIONS: PortfolioDefinitions["bands"] = {
  RED: { min: 1, max: null, label: ">= 100% of budgeted hours (budget exhausted)" },
  AMBER: { min: 0.75, max: 1, label: ">= 75% and < 100% of budgeted hours" },
  GREEN: { min: 0, max: 0.75, label: "< 75% of budgeted hours" },
  NOT_MEASURABLE: { min: null, max: null, label: "no budgeted hours to measure against" },
};

/** How many rows an exception bucket carries before it is trimmed (the count stays whole). */
export const EXCEPTION_ROW_CAP = 100;

/** How many job orders the ranked push list carries before it is trimmed. */
export const NEEDS_PUSH_CAP = 50;

/* --------------------------------------------------------------------------- *
 * Small helpers
 * ------------------------------------------------------------------------- */

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function dateKeyOrNull(date: Date | null): string | null {
  return date === null ? null : dateKey(date);
}

/** Project a fact onto the JSON row shape: every instant becomes a `YYYY-MM-DD` date. */
function toRow(fact: JobOrderFacts): ReportJobRow {
  return {
    ...fact,
    lastBooking: dateKeyOrNull(fact.lastBooking),
    oldestUnapprovedAt: dateKeyOrNull(fact.oldestUnapprovedAt),
    forecastExhaustedOn: dateKeyOrNull(fact.forecastExhaustedOn),
  };
}

/**
 * Booked hours for one job order from a grouped timesheet result.
 *
 * THIS IS THE HOURS COLUMN. It mirrors `GET /api/summary/job-order` exactly:
 *   - an OT row contributes its explicit `otHours`;
 *   - a `shiftSlot` row is 2h;
 *   - a legacy `hourSlot` row is 1h.
 * `_count.shiftSlot` and `_count.hourSlot` are the counts of NON-NULL values, so a row
 * that sets neither contributes only through `otHours`, which is what we want.
 */
function hoursOf(counts: { shiftSlot: number; hourSlot: number }, otHoursSum: number | null): number {
  return (otHoursSum ?? 0) + counts.shiftSlot * 2 + counts.hourSlot * 1;
}

/** Statuses whose booked hours COUNT towards consumption (mirrors summary.ts' notion of booked). */
const BOOKED_STATUSES = ["SUBMITTED", "SUP_APPROVED", "HOD_APPROVED", "PM_APPROVED"] as const;

/** Statuses whose hours are punched but NOT yet approved (approval-aging signal). */
const UNAPPROVED_STATUSES = ["DRAFT", "SUBMITTED", "SUP_APPROVED"] as const;

/* --------------------------------------------------------------------------- *
 * The pure assembler
 * ------------------------------------------------------------------------- */

export type AssembleInput = {
  facts: readonly JobOrderFacts[];
  filters: PortfolioFilters;
  actor: ReportActor;
  /** The resolved as-of date (never null here: the loader resolves it). */
  asOf: Date;
  /** The wall-clock instant the report was generated. */
  now: Date;
};

/**
 * Turn already-built facts into the full response. Pure: no I/O, no clock reads.
 */
export function assemblePortfolioReport(input: AssembleInput): PortfolioReport {
  const { facts, filters, actor, asOf, now } = input;

  const projectIds = new Set<number>();
  let budgetHours = 0;
  let actualHours = 0;
  let redCount = 0;
  let amberCount = 0;
  let greenCount = 0;
  let notMeasurableCount = 0;
  let noActivity = 0;
  let hoursAwaitingApproval = 0;
  let oldestUnapprovedAt: Date | null = null;

  // The activity window is INCLUSIVE of the boundary day, consistent with the attention
  // score's window rule: a booking exactly `activityDays` old is still "recent". This is the
  // SAME `filters.activityDays` the facts builder used to word the reason strings and the
  // definitions note prints, so all three agree by construction.
  const activityWindowMs = filters.activityDays * 86_400_000;

  for (const fact of facts) {
    projectIds.add(fact.project.id);
    budgetHours += fact.budgetHours;
    actualHours += fact.actualHours;

    if (fact.hoursBand === "RED") redCount += 1;
    else if (fact.hoursBand === "AMBER") amberCount += 1;
    else if (fact.hoursBand === "GREEN") greenCount += 1;
    else notMeasurableCount += 1;

    hoursAwaitingApproval += fact.unapprovedHours;
    if (
      fact.unapprovedHours > 0 &&
      fact.oldestUnapprovedAt !== null &&
      (oldestUnapprovedAt === null || fact.oldestUnapprovedAt < oldestUnapprovedAt)
    ) {
      oldestUnapprovedAt = fact.oldestUnapprovedAt;
    }

    // "No activity" only makes sense for work we CAN measure on hours: an unmeasurable job
    // order is not stalled, it is simply unknown, and counting it here would inflate the
    // flag with rows the operator cannot act on.
    if (
      fact.measurableOnHours &&
      (fact.lastBooking === null || now.getTime() - fact.lastBooking.getTime() > activityWindowMs)
    ) {
      noActivity += 1;
    }
  }

  // The full ranked list, then a capped view of it. The total is exposed separately so the
  // screen can say "showing 50 of 63" without the caller having to recompute.
  const ranked = sortByAttention(facts);
  const needsPush = ranked.slice(0, NEEDS_PUSH_CAP).map(toRow);

  // On track is a claim about MEASURABLE work only. Unmeasurable job orders go in their own
  // bucket so a green tile is never borrowed from missing data.
  const onTrack = facts
    .filter((fact) => fact.hoursBand === "GREEN" && fact.measurableOnHours)
    .slice()
    .sort((a, b) => b.budgetHours - a.budgetHours)
    .map(toRow);
  const onTrackNotMeasurable = facts
    .filter((fact) => !fact.measurableOnHours)
    .slice()
    .sort((a, b) => b.budgetHours - a.budgetHours)
    .map(toRow);

  // Every job order, sorted by project then code so the table reads as a stable register.
  const jobWork = facts
    .slice()
    .sort(
      (a, b) =>
        a.project.id - b.project.id ||
        a.code.localeCompare(b.code, undefined, { numeric: true })
    )
    .map(toRow);

  const capped = (predicate: (fact: JobOrderFacts) => boolean): ExceptionBucket => {
    const matched = facts.filter(predicate);
    return { count: matched.length, rows: matched.slice(0, EXCEPTION_ROW_CAP).map(toRow) };
  };

  const definitions: PortfolioDefinitions = {
    bands: BAND_DEFINITIONS,
    attentionWeights: { ...ATTENTION_WEIGHTS },
    measurable: {
      onHours: "budgeted hours in force are greater than zero",
      onQuantity: "a quantity target exists AND at least one APPROVED progress row exists",
    },
    activityWindowDaysNote: `A job order is "no activity" when it is measurable on hours and its last booking is more than ${filters.activityDays} day(s) old.`,
    notes: [
      "Quantity achievement is NOT_MEASURABLE until HODs punch and PMs approve progress; it is never assumed.",
      "Booked hours match GET /api/summary/job-order: OT rows by otHours, shift rows 2h, legacy hour rows 1h.",
      "The budget used is the revision in force on the as-of date, exactly as budgetInForce() defines it.",
      // Stated once, in the DATA block, so the screen, the XLSX and the PDF all inherit it and a
      // reader who sees a GREEN row on both On track and Needs push knows it is not a contradiction.
      "Burn and activity are separate measures: a GREEN (well-burnt) job order may still appear under Needs push when it has stalled — no booking inside the activity window — because that is an independent fact about the work.",
    ],
  };

  return {
    generatedAt: now.toISOString(),
    asOf: dateKey(asOf),
    provenance: {
      filters: describePortfolioFilters(filters),
      filtersHash: portfolioFiltersHash(filters),
      generatedBy: actor,
    },
    definitions,
    pulse: {
      projects: projectIds.size,
      jobOrders: facts.length,
      budgetHours,
      actualHours,
      portfolioBurnPct: burnPct(budgetHours, actualHours),
      bands: {
        RED: redCount,
        AMBER: amberCount,
        GREEN: greenCount,
        NOT_MEASURABLE: notMeasurableCount,
      },
      noActivity,
      hoursAwaitingApproval,
      oldestUnapprovedAt: dateKeyOrNull(oldestUnapprovedAt),
    },
    projectRollUps: rollUpProjects(facts),
    needsPush,
    needsPushTotal: facts.length,
    onTrack,
    onTrackNotMeasurable,
    jobWork,
    departmentLoad: rollUpDepartments(facts),
    exceptions: {
      // A job order with no positive budget cannot be managed on hours at all.
      noBudgetHours: capped((fact) => !(fact.budgetHours > 0)),
      // A budget exists but nothing has been booked against it — either planning-only work or
      // work that has not started.
      budgetWithNoBookings: capped((fact) => fact.budgetHours > 0 && fact.actualHours === 0),
      // No approved quantity progress exists, so achievement cannot be judged.
      noProgress: capped((fact) => !fact.measurableOnQuantity),
      // Punched but unapproved hours, which every approved-hours report is blind to.
      unapproved: capped((fact) => fact.unapprovedHours > 0),
    },
  };
}

/* --------------------------------------------------------------------------- *
 * The bounded loader
 * ------------------------------------------------------------------------- */

/** The `where` clause for the Job Order selection, derived from the parsed filters. */
function jobOrderWhere(filters: PortfolioFilters): Prisma.JobOrderWhereInput {
  const where: Prisma.JobOrderWhereInput = {};
  if (filters.status !== "all") where.status = filters.status;
  if (filters.projectIds) where.projectId = { in: filters.projectIds };
  if (filters.wbsIds) where.projectWbsId = { in: filters.wbsIds };
  if (filters.departmentIds) where.departmentId = { in: filters.departmentIds };
  if (filters.sectionIds) where.sectionId = { in: filters.sectionIds };
  if (filters.budget === "with") where.budgetedHours = { gt: 0 };
  else if (filters.budget === "without") where.budgetedHours = { lte: 0 };
  return where;
}

/**
 * Fetch everything the report needs and assemble it — in a BOUNDED number of queries.
 *
 * Exactly SEVEN Prisma calls, whatever the scope's size:
 *   1. the job orders with project / WBS / UoM / department / section in one `include`;
 *   2. ALL their budget revisions in one `findMany` (`jobOrderId in [...]`);
 *   3. ALL their progress rows in one `findMany`;
 *   4. per-job-order booked hours in one `groupBy`;
 *   5. per-job-order UNAPPROVED hours in one `groupBy`;
 *   6. the oldest unapproved date per job order in one `groupBy` (`_min.workDate`);
 *   7. the first/last booking per job order in one `groupBy` (`_min`/`_max` of `workDate`).
 *
 * No per-job-order loop issues a query. `portfolioReport.test.ts` doubles the scope and
 * asserts the count is unchanged.
 *
 * AS-OF RESOLUTION: an explicit `filters.asOf` wins. Otherwise the date is the LATEST booked
 * work date in the filtered data, falling back to `now`. "Booked" here means a
 * BOOKED_STATUSES row — the same population the hours figure sums — so the budget is read as
 * of the last day work was actually recorded, mirroring the Summary route's convention.
 */
export async function buildPortfolioReport(
  filters: PortfolioFilters,
  actor: ReportActor,
  now: Date = new Date()
): Promise<PortfolioReport> {
  // 1. The job orders and every relation the report names.
  const jobOrders = await db.jobOrder.findMany({
    where: jobOrderWhere(filters),
    include: {
      project: { select: { id: true, code: true, name: true } },
      projectWbs: { select: { id: true, wbsCode: true, name: true } },
      uom: { select: { code: true } },
      department: { select: { id: true, name: true } },
      section: { select: { id: true, name: true } },
    },
    orderBy: [{ projectId: "asc" }, { code: "asc" }],
  });

  const jobOrderIds = jobOrders.map((jobOrder) => jobOrder.id);

  if (jobOrderIds.length === 0) {
    // Nothing in scope: no further queries, and the as-of date falls back to today.
    return assemblePortfolioReport({
      facts: [],
      filters,
      actor,
      asOf: filters.asOf ?? now,
      now,
    });
  }

  const idFilter = { jobOrderId: { in: jobOrderIds } } as const;

  // 2. Budget revisions for every job order, in ONE query.
  const revisionRows = await db.jobOrderBudgetRevision.findMany({
    where: idFilter,
    select: {
      jobOrderId: true,
      revisionNo: true,
      budgetedHours: true,
      budgetedQuantity: true,
      effectiveFrom: true,
    },
  });

  // 3. Progress rows for every job order, in ONE query. All statuses are fetched, not just
  //    APPROVED: `buildJobOrderFacts` needs to SEE the non-approved rows to decide whether
  //    quantity is measurable at all (a target nobody has punched against is a plan).
  const progressRows = await db.jobOrderProgress.findMany({
    where: idFilter,
    select: {
      jobOrderId: true,
      status: true,
      cumulativeQuantity: true,
      progressDate: true,
      revisionNo: true,
    },
  });

  // 4. Booked hours per job order, in ONE grouped query.
  const bookedRows = await db.timesheetEntry.groupBy({
    by: ["jobOrderId"],
    where: { ...idFilter, status: { in: [...BOOKED_STATUSES] } },
    _sum: { otHours: true },
    _count: { shiftSlot: true, hourSlot: true },
  });

  // 5. Unapproved hours per job order, in ONE grouped query.
  const unapprovedRows = await db.timesheetEntry.groupBy({
    by: ["jobOrderId"],
    where: { ...idFilter, status: { in: [...UNAPPROVED_STATUSES] } },
    _sum: { otHours: true },
    _count: { shiftSlot: true, hourSlot: true },
  });

  // 6. The oldest unapproved date per job order, in ONE grouped query.
  const oldestUnapprovedRows = await db.timesheetEntry.groupBy({
    by: ["jobOrderId"],
    where: { ...idFilter, status: { in: [...UNAPPROVED_STATUSES] } },
    _min: { workDate: true },
  });

  // 7. The first and last booking per job order, in ONE grouped query. The last date also
  //    resolves the as-of date and drives the forecast rate.
  const spanRows = await db.timesheetEntry.groupBy({
    by: ["jobOrderId"],
    where: { ...idFilter, status: { in: [...BOOKED_STATUSES] } },
    _min: { workDate: true },
    _max: { workDate: true },
  });

  const revisionsByJobOrder = new Map<number, Array<{
    revisionNo: number;
    budgetedHours: number;
    budgetedQuantity: number;
    effectiveFrom: Date;
  }>>();
  for (const revision of revisionRows) {
    const list = revisionsByJobOrder.get(revision.jobOrderId);
    if (list) list.push(revision);
    else revisionsByJobOrder.set(revision.jobOrderId, [revision]);
  }

  const progressByJobOrder = new Map<number, Array<{
    status: string;
    cumulativeQuantity: number;
    progressDate: Date;
    revisionNo: number;
  }>>();
  for (const row of progressRows) {
    const list = progressByJobOrder.get(row.jobOrderId);
    if (list) list.push(row);
    else progressByJobOrder.set(row.jobOrderId, [row]);
  }

  const bookedByJobOrder = new Map<number, number>();
  for (const row of bookedRows) {
    if (row.jobOrderId === null) continue;
    bookedByJobOrder.set(row.jobOrderId, hoursOf(row._count, row._sum.otHours));
  }

  const unapprovedByJobOrder = new Map<number, number>();
  for (const row of unapprovedRows) {
    if (row.jobOrderId === null) continue;
    unapprovedByJobOrder.set(row.jobOrderId, hoursOf(row._count, row._sum.otHours));
  }

  const oldestUnapprovedByJobOrder = new Map<number, Date>();
  for (const row of oldestUnapprovedRows) {
    if (row.jobOrderId === null || row._min.workDate === null) continue;
    oldestUnapprovedByJobOrder.set(row.jobOrderId, row._min.workDate);
  }

  const firstBookingByJobOrder = new Map<number, Date>();
  const lastBookingByJobOrder = new Map<number, Date>();
  for (const row of spanRows) {
    if (row.jobOrderId === null) continue;
    if (row._min.workDate !== null) firstBookingByJobOrder.set(row.jobOrderId, row._min.workDate);
    if (row._max.workDate !== null) lastBookingByJobOrder.set(row.jobOrderId, row._max.workDate);
  }

  // Resolve the as-of date: explicit wins, else the latest booked work date, else today.
  let latestBooked: Date | null = null;
  for (const date of lastBookingByJobOrder.values()) {
    if (latestBooked === null || date > latestBooked) latestBooked = date;
  }
  const asOf = filters.asOf ?? latestBooked ?? now;

  const facts = jobOrders.map((jobOrder) =>
    buildJobOrderFacts({
      jobOrder: {
        id: jobOrder.id,
        code: jobOrder.code,
        name: jobOrder.name,
        status: jobOrder.status,
        budgetedHours: jobOrder.budgetedHours,
        budgetedQuantity: jobOrder.budgetedQuantity,
        uom: jobOrder.uom.code,
        project: jobOrder.project,
        // ProjectWbs.name is nullable in the schema; JobOrderIdentity wants a string. An empty
        // name is the honest rendering of "unnamed WBS" and keeps the row shape stable.
        wbs: {
          id: jobOrder.projectWbs.id,
          wbsCode: jobOrder.projectWbs.wbsCode,
          name: jobOrder.projectWbs.name ?? "",
        },
        department: jobOrder.department,
        section: jobOrder.section,
      },
      budgetRevisions: revisionsByJobOrder.get(jobOrder.id) ?? [],
      actualHours: bookedByJobOrder.get(jobOrder.id) ?? 0,
      unapprovedHours: unapprovedByJobOrder.get(jobOrder.id) ?? 0,
      oldestUnapprovedAt: oldestUnapprovedByJobOrder.get(jobOrder.id) ?? null,
      firstBooking: firstBookingByJobOrder.get(jobOrder.id) ?? null,
      lastBooking: lastBookingByJobOrder.get(jobOrder.id) ?? null,
      progressRows: progressByJobOrder.get(jobOrder.id) ?? [],
      asOf,
      now,
      // The operator's window, so each row's attention reason names the SAME window the pulse
      // count and the printed definitions note use. Omitting this was the defect: the facts
      // builder would fall back to the default 7 while the report used filters.activityDays.
      activityDays: filters.activityDays,
    })
  );

  return assemblePortfolioReport({ facts, filters, actor, asOf, now });
}
