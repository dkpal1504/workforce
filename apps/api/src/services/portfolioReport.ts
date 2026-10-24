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
 * dashboard's OWN operations figure — every timesheet entry SUBMITTED for approval or beyond
 * (`SUBMITTED`, `SUP_APPROVED`, `HOD_APPROVED`, `PM_APPROVED`), at `otHours` when the row carries
 * explicit OT, otherwise 2h for a `shiftSlot` row and 1h for a legacy `hourSlot` row, summed per
 * job order. It is computed in `hoursOf()` below. The status set and the printed wording that
 * documents it live together in `portfolioReporting.BOOKED_HOURS_STATUSES` / `BOOKED_HOURS_NOTE`
 * so the number and the note cannot drift apart.
 *
 * IT DELIBERATELY DOES NOT MATCH `GET /api/summary/job-order`. The Summary is an APPROVED-hours
 * screen and counts only `PM_APPROVED`; an operations dashboard must show every hour BOOKED
 * against a job order, including effort stuck in approval, because a COO looking at burn needs to
 * see it. The two figures serve different purposes and are kept distinct ON PURPOSE. The note now
 * says so; an earlier version falsely claimed the two agreed.
 */

import { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "../db";
import {
  BOOKED_HOURS_NOTE,
  BOOKED_HOURS_STATUSES,
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
import {
  intersectDepartmentFilter,
  intersectProjectFilter,
  reportScopeFor,
  type ReportScope,
} from "./roleAccess";
import { assignedProjectIdsFor } from "./projectScope";
import {
  buildProjectStructure,
  type ProjectStructureRow,
  type StructureNetworkRow,
  type StructureWbsRow,
} from "./projectStructure";
import { SCHEDULE_ATTENTION_WEIGHTS, SCHEDULE_BAND_DEFINITIONS, SCHEDULE_RULES, type ScheduleBand } from "./jobOrderSchedule";

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
export type ReportActor = {
  id: number;
  name: string;
  role: string;
  /**
   * The actor's OWN Department, used to derive the report scope. Optional at the type level so
   * the many existing pure-assembly test fixtures and the ADMIN/PM/COO call sites need no change,
   * but the report loader REQUIRES it for a Department-scoped role: it normalises `undefined` to
   * `null`, which `reportScopeFor` turns into the fail-closed NONE scope.
   */
  departmentId?: number | null;
};

/** A `JobOrderFacts` row with its dates already reduced to `YYYY-MM-DD` (or null). */
export type ReportJobRow = Omit<
  JobOrderFacts,
  "lastBooking" | "oldestUnapprovedAt" | "forecastExhaustedOn" | "plannedStartDate" | "plannedEndDate" | "projectedFinish"
> & {
  lastBooking: string | null;
  oldestUnapprovedAt: string | null;
  forecastExhaustedOn: string | null;
  /** The planned window as `YYYY-MM-DD`, or null for continual / standing work. */
  plannedStartDate: string | null;
  plannedEndDate: string | null;
  /** The projected finish as `YYYY-MM-DD`, or null when it cannot honestly be projected. */
  projectedFinish: string | null;
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
  /**
   * The SCHEDULE coverage and bands. `notScheduled` is the honest counterpart of every schedule
   * figure on this report: without it, a portfolio where most Job Orders carry no window would look
   * perfectly on time.
   */
  schedule: {
    scheduled: number;
    notScheduled: number;
    onPlan: number;
    dueSoon: number;
    atRisk: number;
    delayed: number;
  };
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
  /**
   * The SCHEDULE rules, as data, beside the hours bands and the attention weights: the bands, the
   * thresholds that produce them, the weight each one adds, and the COVERAGE — how many Job Orders
   * carry a window at all. The coverage sentence is not decoration: a portfolio whose rows have no
   * dates must never read as a portfolio that is punctual.
   */
  schedule: {
    bands: Record<ScheduleBand, { label: string }>;
    weights: typeof SCHEDULE_ATTENTION_WEIGHTS;
    rules: typeof SCHEDULE_RULES;
    coverageNote: string;
  };
  notes: string[];
};

export type PortfolioReport = {
  generatedAt: string;
  asOf: string;
  provenance: {
    filters: Array<{ label: string; value: string }>;
    filtersHash: string;
    generatedBy: ReportActor;
    /**
     * The scope ACTUALLY APPLIED, as data. A forwarded report must state its own limits: an HOD's
     * export is a whole-Department view and its provenance says so even if the original request
     * asked for another Department (that request was intersected away, never obeyed). Both exports
     * render this block, so the XLSX and the PDF inherit it automatically.
     */
    scope: {
      kind: ReportScope["kind"];
      /** The Department id when `kind === "DEPARTMENT"`, else null. */
      departmentId: number | null;
      /**
       * The Project ids when `kind === "PROJECTS"`, else null. Carried so a forwarded export states
       * the exact assignment it was built from, not merely "assigned projects".
       */
      projectIds: number[] | null;
      /** A sentence a reader can quote, e.g. "Department 4 (whole department)". */
      description: string;
    };
  };
  definitions: PortfolioDefinitions;
  pulse: PortfolioPulse;
  projectRollUps: ProjectRollUp[];
  /**
   * The Project → WBS → Network → Job Order register (see `projectStructure.ts`).
   *
   * It is a SECTION OF ITS OWN because it answers a different question from the rest of the report:
   * the other sections rank work ("what needs a push"), this one describes shape ("what is under
   * this project"). Every node's hours and dates come from the SAME scoped facts as the sections
   * above, so the register can never disagree with them.
   */
  projectStructure: ProjectStructureRow[];
  needsPush: ReportJobRow[];
  /** The full number of ranked job orders, even when `needsPush` is capped. */
  needsPushTotal: number;
  onTrack: ReportJobRow[];
  onTrackNotMeasurable: ReportJobRow[];
  /**
   * The schedule section: every Job Order whose planned window is breached or about to be, worst
   * first. Its own tab, because "on track" is a claim about HOURS and must not be quietly redefined
   * by a date — a row can be on track on hours and delayed on schedule, and that pair is the whole
   * reason this section exists.
   */
  scheduleDelays: ReportJobRow[];
  jobWork: ReportJobRow[];
  departmentLoad: DepartmentRollUp[];
  exceptions: {
    noBudgetHours: ExceptionBucket;
    budgetWithNoBookings: ExceptionBucket;
    noProgress: ExceptionBucket;
    unapproved: ExceptionBucket;
    /**
     * The schedule buckets. The last one is a DATA-QUALITY bucket, not a work signal: half a window
     * cannot be judged, so it is reported for correction instead of being read as a plan.
     */
    endDatePassed: ExceptionBucket;
    scheduledNoProgress: ExceptionBucket;
    scheduleIncomplete: ExceptionBucket;
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
  // Defence in depth: a Date that is not a date must print as "no date" rather than throw and take the whole
  // report down. The fix at the source is in `jobOrderSchedule`, where an invalid projection is now null.
  if (date === null) return null;
  if (Number.isNaN(date.getTime())) return null;
  return dateKey(date);
}

/**
 * The scope as a sentence a reader can quote, used in the provenance block (and therefore in both
 * exports, which render that same block). Kept here rather than in the UI so the JSON is the one
 * place the statement of limits lives.
 */
function describeScope(scope: ReportScope): string {
  if (scope.kind === "ORGANISATION") return "Whole organisation (all departments)";
  if (scope.kind === "DEPARTMENT") return `Department ${scope.departmentId} (whole department)`;
  if (scope.kind === "PROJECTS") return `Assigned projects only (${scope.projectIds.length})`;
  // Reached by an HOD/DEPT_HEAD with no Department mapping, or a PROJECT_MANAGER with no active
  // assignment. The sentence must fit BOTH, so it names neither.
  return "No usable scope for this account — nothing in scope";
}

/**
 * How the provenance renders an EMPTY applied Department set — a request disjoint from the actor's
 * scope, or a head with no Department mapping. The shared `describePortfolioFilters` would render
 * an empty array as the empty STRING, and a blank value in a "filters applied" block reads as a
 * rendering fault: a reader assumes no Department filter was present at all. Saying "None" is the
 * honest statement — a Department filter IS in force and it admits nothing.
 */
const EMPTY_DEPARTMENT_FILTER_LINE = "None (nothing in the applied scope)";
/** The Project dimension's counterpart: an applied-but-empty Project set reads as an explicit
 *  "nothing", never as a blank that looks like "no filter". */
const EMPTY_PROJECT_FILTER_LINE = "None (nothing in the applied scope)";

/**
 * Order-independent equality for two Department sets, either of which may be null. Used only to
 * decide whether the actor's scope NARROWED the requested Department filter (null = "no filter",
 * which is not the same as an empty set).
 */
function sameNumberSet(a: number[] | null, b: number[] | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort((x, y) => x - y);
  const sortedB = [...b].sort((x, y) => x - y);
  return sortedA.every((value, index) => value === sortedB[index]);
}

/** Project a fact onto the JSON row shape: every instant becomes a `YYYY-MM-DD` date. */
function toRow(fact: JobOrderFacts): ReportJobRow {
  return {
    ...fact,
    lastBooking: dateKeyOrNull(fact.lastBooking),
    oldestUnapprovedAt: dateKeyOrNull(fact.oldestUnapprovedAt),
    forecastExhaustedOn: dateKeyOrNull(fact.forecastExhaustedOn),
    plannedStartDate: dateKeyOrNull(fact.plannedStartDate),
    plannedEndDate: dateKeyOrNull(fact.plannedEndDate),
    projectedFinish: dateKeyOrNull(fact.projectedFinish),
  };
}

/**
 * Booked hours for one job order from a grouped timesheet result.
 *
 * THIS IS THE HOURS COLUMN, and it is the DASHBOARD's definition, not the Summary's:
 *   - an OT row contributes its explicit `otHours`;
 *   - a `shiftSlot` row is 2h;
 *   - a legacy `hourSlot` row is 1h.
 * `_count.shiftSlot` and `_count.hourSlot` are the counts of NON-NULL values, so a row
 * that sets neither contributes only through `otHours`.
 *
 * WHERE IT DIFFERS FROM THE SUMMARY, DELIBERATELY:
 *   1. POPULATION — this sums `BOOKED_HOURS_STATUSES` (SUBMITTED, SUP_APPROVED, HOD_APPROVED,
 *      PM_APPROVED), whereas `GET /api/summary/job-order` sums `PM_APPROVED` only. So this figure
 *      INCLUDES hours still awaiting approval and equals or exceeds the Summary's.
 *   2. ARITHMETIC — a row carrying BOTH an `otHours` and a slot is ADDED here (`+`), while the
 *      Summary's `??` counts only the `otHours`. (No such row exists in current dev data; the
 *      difference is documented rather than "fixed" because the operations number wants both.)
 * Both differences are intentional and the printed note states them. See `BOOKED_HOURS_NOTE`.
 */
export function hoursOf(counts: { shiftSlot: number; hourSlot: number }, otHoursSum: number | null): number {
  return (otHoursSum ?? 0) + counts.shiftSlot * 2 + counts.hourSlot * 1;
}

/**
 * Statuses whose booked hours this dashboard counts: `BOOKED_HOURS_STATUSES`, imported from
 * `portfolioReporting.ts` — never re-declared here. The note that documents the figure (also in
 * that module) and these queries must name the SAME set, or the printed note can drift from the
 * number, which is the defect this change removes.
 */

/** Statuses whose hours are punched but NOT yet approved (approval-aging signal). */
export const UNAPPROVED_STATUSES = ["DRAFT", "SUBMITTED", "SUP_APPROVED"] as const;

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
  /**
   * The scope the loader actually applied. Optional so the pure-assembly fixtures keep working;
   * defaults to ORGANISATION, which is what an unspecified caller meant before this concept
   * existed. NEVER omit it for a Department-scoped actor: it is what the provenance block prints
   * so a forwarded report states its own limits.
   */
  scope?: ReportScope;
  /**
   * The EFFECTIVE Department set the loader actually applied to the query — the intersected
   * `actor ∩ requested`, or the actor's Department when the request named none. REQUIRED to make
   * the provenance describe the report that was PRODUCED rather than the request that produced it:
   * an HOD who asked for `departmentIds=[1,2]` reads Department 1's rows, so the printed Department
   * line and the filename hash must say "1", never "1, 2".
   *
   *   - `undefined` -> unknown (pure fixtures only): the filter description and hash fall back to
   *                    the requested `filters.departmentIds`, preserving the pre-scope behaviour.
   *   - `null`      -> no Department predicate was applied (whole organisation).
   *   - `[]`        -> a Department filter WAS applied and admits nothing.
   *   - non-empty   -> exactly those Departments.
   *
   * The loader always passes it, so a real report never falls back to the request.
   */
  effectiveDepartmentIds?: number[] | null;
  /**
   * The EFFECTIVE Project set the loader applied, with the same four states as the Department set
   * above (undefined = unknown/request, null = no predicate, [] = applied and admits nothing,
   * ids = exactly those). The loader always passes it.
   */
  effectiveProjectIds?: number[] | null;
  /**
   * The register the loader assembled from the SAME scoped facts. Optional so the pure-assembly
   * fixtures keep working; a fixture that omits it gets an empty register, which is the honest
   * answer for a caller that supplied no master rows.
   */
  projectStructure?: ProjectStructureRow[];
};

/**
 * Turn already-built facts into the full response. Pure: no I/O, no clock reads.
 */
export function assemblePortfolioReport(input: AssembleInput): PortfolioReport {
  const { facts, filters, actor, asOf, now } = input;
  // Default to the whole organisation: an unspecified caller (the pure-assembly fixtures, and any
  // pre-existing call site) meant "no Department narrowing" before this scope concept existed.
  const scope: ReportScope = input.scope ?? { kind: "ORGANISATION" };

  // ── PROVENANCE DESCRIBES THE REPORT PRODUCED, NOT THE REQUEST ───────────────────────────────
  // The request was CLAMPED to the actor's scope before it was ever run, so the request is NOT the
  // filter that was applied. Building the printed filter line and the filename hash from the raw
  // `filters` is the DISCLOSURE DEFECT this block fixes: an HOD of Department 1 who asked for
  // `departmentIds=[1,2]` read 2 rows — correct — but his export PRINTS "Department: 1, 2" and
  // stamps that same string into the filename hash, affirmatively claiming a Department he was
  // never allowed to read. The fix substitutes the EFFECTIVE Department set everywhere the
  // provenance says "Department". The rows were always contained; this removes the false claim
  // ABOUT the boundary that the rest of the feature exists to enforce.
  //
  // The loader ALWAYS passes `effectiveDepartmentIds`, so a real report cannot fall back to the
  // request. Only a pure fixture that omits it (pre-scope callers) does, and for an ORGANISATION
  // actor the effective set EQUALS the request anyway, so that fallback preserves old behaviour.
  const appliedDepartmentIds =
    input.effectiveDepartmentIds === undefined
      ? filters.departmentIds
      : input.effectiveDepartmentIds;
  // The Project set is treated IDENTICALLY, and for the same reason: a manager who asked for
  // `projectIds=[9]` outside his assignment read 0 rows, so an export that printed "9" would be
  // claiming a scope the report never consulted.
  const appliedProjectIds =
    input.effectiveProjectIds === undefined
      ? filters.projectIds
      : input.effectiveProjectIds;
  // ONE effective filter set drives BOTH the readable line and the hash, so they can never
  // disagree with each other or with the rows the query returned.
  const appliedFilters: PortfolioFilters =
    appliedDepartmentIds === filters.departmentIds && appliedProjectIds === filters.projectIds
      ? filters
      : { ...filters, departmentIds: appliedDepartmentIds, projectIds: appliedProjectIds };

  // The filter list is a COMPLETE statement of scope: every unset filter still prints "All". The
  // Department line is the one entry that must reflect the intersection, and an empty applied set
  // is rendered explicitly (the shared describe would print it as a blank value) so a zero-row
  // report never looks like it simply had no Department filter.
  const filterLines = describePortfolioFilters(appliedFilters);
  const describedFilters = filterLines.map((entry) => {
    if (entry.label === "Department" && appliedDepartmentIds !== null && appliedDepartmentIds.length === 0) {
      return { label: entry.label, value: EMPTY_DEPARTMENT_FILTER_LINE };
    }
    if (entry.label === "Project" && appliedProjectIds !== null && appliedProjectIds.length === 0) {
      return { label: entry.label, value: EMPTY_PROJECT_FILTER_LINE };
    }
    return entry;
  });

  // Record that a NARROWING happened, so a reader can see both truths: what was ASKED for and what
  // was APPLIED. `scope` already states the applied truth; this note removes any ambiguity about
  // whether the applied limit was chosen or imposed.
  const requestedDepartmentFilterNarrowed =
    input.effectiveDepartmentIds !== undefined &&
    !sameNumberSet(filters.departmentIds, input.effectiveDepartmentIds);
  const requestedProjectFilterNarrowed =
    input.effectiveProjectIds !== undefined &&
    !sameNumberSet(filters.projectIds, input.effectiveProjectIds);

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

  // The schedule section: breached windows first (most days late first), then the projections that
  // are running beyond the plan, then the ones closing within the week. A Job Order with no window is
  // NOT in here — it is not late, it is unscheduled, and the coverage line says how many those are.
  const scheduleOrder: Record<string, number> = { DELAYED: 0, AT_RISK: 1, DUE_SOON: 2 };
  const scheduleDelays = facts
    .filter((fact) => fact.scheduleBand === "DELAYED" || fact.scheduleBand === "AT_RISK" || fact.scheduleBand === "DUE_SOON")
    .slice()
    .sort((a, b) => {
      const rank = scheduleOrder[a.scheduleBand] - scheduleOrder[b.scheduleBand];
      if (rank !== 0) return rank;
      // Worst first inside a band: days late (most negative) or the biggest projected slip.
      return (a.daysToEnd ?? 0) - (b.daysToEnd ?? 0) || (b.projectedSlipDays ?? 0) - (a.projectedSlipDays ?? 0);
    })
    .map(toRow);

  const capped = (predicate: (fact: JobOrderFacts) => boolean): ExceptionBucket => {
    const matched = facts.filter(predicate);
    return { count: matched.length, rows: matched.slice(0, EXCEPTION_ROW_CAP).map(toRow) };
  };

  // The schedule pulse, counted from the SAME band each row prints, so the tile and the table can
  // never disagree. `scheduled` is the denominator the coverage sentence needs.
  const schedulePulse = {
    scheduled: facts.filter((fact) => fact.plannedStartDate !== null || fact.plannedEndDate !== null).length,
    notScheduled: facts.filter((fact) => fact.plannedStartDate === null && fact.plannedEndDate === null).length,
    onPlan: facts.filter((fact) => fact.scheduleBand === "ON_PLAN").length,
    dueSoon: facts.filter((fact) => fact.scheduleBand === "DUE_SOON").length,
    atRisk: facts.filter((fact) => fact.scheduleBand === "AT_RISK").length,
    delayed: facts.filter((fact) => fact.scheduleBand === "DELAYED").length,
  };

  const definitions: PortfolioDefinitions = {
    bands: BAND_DEFINITIONS,
    attentionWeights: { ...ATTENTION_WEIGHTS },
    measurable: {
      onHours: "budgeted hours in force are greater than zero",
      onQuantity: "a quantity target exists AND at least one APPROVED progress row exists",
    },
    activityWindowDaysNote: `A job order is "no activity" when it is measurable on hours and its last booking is more than ${filters.activityDays} day(s) old.`,
    schedule: {
      bands: SCHEDULE_BAND_DEFINITIONS,
      weights: SCHEDULE_ATTENTION_WEIGHTS,
      rules: SCHEDULE_RULES,
      // Printed on every report, in the DATA block, so a forwarded copy cannot imply that a portfolio
      // is on time when most of its rows carry no dates at all.
      coverageNote: `${schedulePulse.scheduled} of ${facts.length} job order(s) in scope carry a planned window; `
        + `the remaining ${schedulePulse.notScheduled} are NOT SCHEDULED (continual / standing work) and are never counted as on-time. `
        + `A window closing with quantity outstanding is DELAYED; a projection more than ${SCHEDULE_RULES.atRiskProjectedSlipDays} days `
        + `beyond the planned end is AT RISK; a window closing within ${SCHEDULE_RULES.dueSoonDays} days with quantity outstanding is DUE SOON. `
        + "The schedule is a separate axis: it never moves the hours band.",
    },
    notes: [
      // FIRST, because a forwarded report must lead with its own limits: the scope actually
      // applied, not the scope that was requested. This travels into the XLSX and the PDF through
      // the same definitions data block, so a downloaded HOD report states that it is a whole-
      // Department view even if the original query asked for another Department.
      `Scope applied: ${describeScope(scope)}.`,
      // Present ONLY when the scope actually clamped the request, so a reader sees both truths: the
      // Department line above says what was APPLIED, and this says what was ASKED for and that it
      // was narrowed. Omitted when they agree, so there is no redundant line on an ordinary report.
      ...(requestedDepartmentFilterNarrowed
        ? [
            `Requested Department filter: ${filters.departmentIds?.join(", ") ?? "All"} — intersected with the acting scope and narrowed to the applied scope above; the request never widened it.`,
          ]
        : []),
      // The same disclosure for the Project dimension: a manager's request can only narrow his
      // assignment, and an export must say so rather than print the ids he asked for.
      ...(requestedProjectFilterNarrowed
        ? [
            `Requested Project filter: ${filters.projectIds?.join(", ") ?? "All"} — intersected with the acting scope and narrowed to the applied scope above; the request never widened it.`,
          ]
        : []),
      "Quantity achievement is NOT_MEASURABLE until HODs punch and PMs approve progress; it is never assumed.",
      BOOKED_HOURS_NOTE,
      "The budget used is the revision in force on the as-of date, exactly as budgetInForce() defines it.",
      // Stated once, in the DATA block, so the screen, the XLSX and the PDF all inherit it and a
      // reader who sees a GREEN row on both On track and Needs push knows it is not a contradiction.
      // The schedule note sits beside the burn/activity one for the same reason: a reader who sees a
      // GREEN row under Needs push must not think the schedule was consulted to put it there.
      "Schedule is judged separately from hours: a job order can be GREEN on hours and DELAYED on its planned window, and the Schedule & delays section lists exactly those rows.",
      "Burn and activity are separate measures: a GREEN (well-burnt) job order may still appear under Needs push when it has stalled — no booking inside the activity window — because that is an independent fact about the work.",
    ],
  };

  return {
    generatedAt: now.toISOString(),
    asOf: dateKey(asOf),
    provenance: {
      // Built from `appliedFilters`, the EFFECTIVE set, never the raw `filters`: the report must
      // state the scope it actually produced, and `appliedFilters` is also the object the hash is
      // taken from, so the printed line and the filename key cannot diverge.
      filters: describedFilters,
      filtersHash: portfolioFiltersHash(appliedFilters),
      generatedBy: actor,
      scope: {
        kind: scope.kind,
        departmentId: scope.kind === "DEPARTMENT" ? scope.departmentId : null,
        projectIds: scope.kind === "PROJECTS" ? [...scope.projectIds] : null,
        description: describeScope(scope),
      },
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
      schedule: schedulePulse,
      noActivity,
      hoursAwaitingApproval,
      oldestUnapprovedAt: dateKeyOrNull(oldestUnapprovedAt),
    },
    projectRollUps: rollUpProjects(facts),
    projectStructure: input.projectStructure ?? [],
    needsPush,
    needsPushTotal: facts.length,
    onTrack,
    onTrackNotMeasurable,
    scheduleDelays,
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
      // ── The schedule buckets ─────────────────────────────────────────────────────────────────────
      // A window that has closed with quantity outstanding: the delay list, and the one flag on this
      // report that a client is likely to see quoted. It is a fact, not a projection.
      endDatePassed: capped((fact) => fact.scheduleBand === "DELAYED"),
      // A window was set but no APPROVED progress exists, so nobody can say whether it is on plan:
      // either the work has not started or the HOD is not punching. Both need a person, not a number.
      scheduledNoProgress: capped((fact) =>
        (fact.plannedStartDate !== null || fact.plannedEndDate !== null) && !fact.measurableOnQuantity),
      // Half a window cannot be judged. Reported for correction, never read as a plan.
      scheduleIncomplete: capped((fact) =>
        (fact.plannedStartDate === null) !== (fact.plannedEndDate === null)),
    },
  };
}

/**
 * The distinct projects represented in the fetched job orders, in code order.
 *
 * Used for every scope that is NOT project-scoped: the register then describes exactly the projects
 * the reader can already see rows for, which is what keeps a Department head's structure honest. A
 * project-scoped actor uses its assignment instead (so an assigned project with no work still shows).
 */
function projectsFromJobOrders(
  jobOrders: ReadonlyArray<{ project: { id: number; code: string; name: string; active: boolean } }>
): Array<{ id: number; code: string; name: string; active: boolean }> {
  const seen = new Map<number, { id: number; code: string; name: string; active: boolean }>();
  for (const jobOrder of jobOrders) {
    if (!seen.has(jobOrder.project.id)) seen.set(jobOrder.project.id, jobOrder.project);
  }
  return [...seen.values()].sort((a, b) => a.code.localeCompare(b.code));
}

/* --------------------------------------------------------------------------- *
 * The bounded loader
 * ------------------------------------------------------------------------- */

/** The `where` clause for the Job Order selection, derived from the parsed filters. */
function jobOrderWhere(
  filters: PortfolioFilters,
  /**
   * The EFFECTIVE, already-intersected Department set — see `intersectDepartmentFilter`. NOT
   * `filters.departmentIds`:
   *   - `null`            -> no Department predicate (whole organisation),
   *   - a non-empty array -> those Departments,
   *   - an EMPTY array    -> match NOTHING (`{ in: [] }`; Prisma treats an empty `in` as no match).
   * Derived once in `buildPortfolioReport` so the request can never widen the actor's scope. An HOD
   * asking for another Department lands on the empty array and therefore reads zero rows.
   */
  departmentFilter: number[] | null,
  /**
   * The EFFECTIVE, already-intersected Project set — see `intersectProjectFilter`. NOT
   * `filters.projectIds`: an EMPTY array must survive as `{ in: [] }` (zero rows), while `null`
   * means "no Project predicate at all". Collapsing the two would turn a disjoint request into the
   * whole assignment.
   */
  projectFilter: number[] | null,
): Prisma.JobOrderWhereInput {
  const where: Prisma.JobOrderWhereInput = {};
  if (filters.status !== "all") where.status = filters.status;
  if (projectFilter !== null) where.projectId = { in: projectFilter };
  if (filters.wbsIds) where.projectWbsId = { in: filters.wbsIds };
  if (departmentFilter !== null) where.departmentId = { in: departmentFilter };
  // A `sectionIds` filter needs no separate cross-department guard: Section ids are globally
  // unique, so intersecting `sectionId in [...]` with the scope's `departmentId in [...]` already
  // yields zero rows for a Section that lives in another Department — the same honest empty result
  // as a foreign Department id. The Department predicate above is what enforces that.
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
 * BOOKED_HOURS_STATUSES row — the same population the hours figure sums — so the budget is read as
 * of the last day work was actually recorded, mirroring the Summary route's convention.
 */
export async function buildPortfolioReport(
  filters: PortfolioFilters,
  actor: ReportActor,
  now: Date = new Date()
): Promise<PortfolioReport> {
  // ── SCOPE, decided SERVER-SIDE and applied as ONE intersected predicate ────────────────────
  // The request's `departmentIds` may only NARROW the actor's own scope, never widen it, so the
  // effective Department filter is the INTERSECTION `actor ∩ requested`. An HOD in Department 4
  // who passes `departmentIds=9` therefore gets Department 4, never Department 9 — the request is
  // data to be clamped, not an instruction to be trusted.
  //
  // FAIL CLOSED: an HOD/DEPT_HEAD with NO Department mapping resolves to the NONE scope and the
  // filter becomes the impossible `{ in: [] }` (the `{ id: -1 }` idiom, expressed as an empty set).
  // This is the whole point: Prisma treats an EMPTY `where` object as EVERY row, so a missing
  // Department must produce a filter that matches nothing rather than no filter at all.
  //
  // AN EMPTY INTERSECTION RETURNS ZERO ROWS, BY DESIGN. When the actor asks only for a Department
  // that is not theirs the intersection is empty and the loader keeps it empty. It deliberately
  // does NOT fall back to the actor's own Department: a report that quietly ignores the filter it
  // was handed is worse than an empty one, because the reader believes a filter was applied. The
  // provenance block records the scope actually applied either way.
  // The Project assignment is read HERE, server-side, and only for the role that is scoped by it
  // (`assignedProjectIdsFor` returns null with no query for every other role). It is deliberately
  // not passed in by the route: a request must never be able to name its own project scope.
  const assignedProjectIds = await assignedProjectIdsFor(actor);
  const scope = reportScopeFor(actor.role, actor.departmentId ?? null, assignedProjectIds);
  const effectiveDepartmentIds = intersectDepartmentFilter(scope, filters.departmentIds);
  // The Project dimension is intersected with the assignment exactly as the Department one is with
  // the Department: the request narrows, never widens, and a disjoint request stays EMPTY.
  const effectiveProjectIds = intersectProjectFilter(scope, filters.projectIds);

  // 1. The job orders and every relation the report names. ONE query, scoped by the intersected
  //    Department set above — so the pulse, needs-push, on-track, job work, department load, the
  //    exception buckets AND both exports (which reuse this assembly) all derive from the SAME
  //    scoped fetch. There is no second scoping path.
  const jobOrders = await db.jobOrder.findMany({
    where: jobOrderWhere(filters, effectiveDepartmentIds, effectiveProjectIds),
    include: {
      // `active` is carried so the register can state a project's stored state without a second
      // read for the ordinary (non-project-scoped) caller.
      project: { select: { id: true, code: true, name: true, active: true } },
      projectWbs: { select: { id: true, wbsCode: true, name: true } },
      network: { select: { id: true, code: true, name: true } },
      uom: { select: { code: true } },
      department: { select: { id: true, name: true } },
      section: { select: { id: true, name: true } },
    },
    orderBy: [{ projectId: "asc" }, { code: "asc" }],
  });

  const jobOrderIds = jobOrders.map((jobOrder) => jobOrder.id);

  // ── The structure register's master rows ───────────────────────────────────────────────────────
  // TWO bounded queries (+ one for a Project Manager, whose projects include ones with NO job orders
  // and therefore cannot be derived from the facts). The `_count` rides on the same query, so
  // telling an EMPTY node from an out-of-scope node costs nothing extra.
  //
  // WHICH PROJECTS: for a PROJECT_MANAGER the ASSIGNMENT — an assigned project with no job orders is
  // the row that matters most, and deriving from the facts would hide it. For everyone else the
  // projects whose job orders are in scope, which is what keeps a Department head's register
  // describing his own department.
  //
  // It follows the EFFECTIVE PROJECT FILTER, not the bare scope, so it can never contradict the rows
  // above it: a disjoint request (which matches nothing) leaves an EMPTY register rather than a
  // register of projects whose counts would then read zero against facts that were filtered out.
  // With no project request, the effective set IS the assignment (or null for a role that is not
  // project-scoped), which is exactly the case that must keep an assigned-but-idle project visible.
  const structureProjectIds = effectiveProjectIds !== null
    ? [...effectiveProjectIds]
    : [...new Set(jobOrders.map((jobOrder) => jobOrder.projectId))].sort((a, b) => a - b);

  const [structureProjects, structureWbs, structureNetworks] = await Promise.all([
    effectiveProjectIds !== null
      ? db.project.findMany({
          where: { id: { in: structureProjectIds } },
          select: { id: true, code: true, name: true, active: true },
          orderBy: { code: "asc" },
        })
      : Promise.resolve(projectsFromJobOrders(jobOrders)),
    structureProjectIds.length === 0
      ? Promise.resolve([] as StructureWbsRow[])
      : db.projectWbs.findMany({
          where: { projectId: { in: structureProjectIds } },
          select: {
            id: true,
            projectId: true,
            wbsCode: true,
            name: true,
            sortOrder: true,
            active: true,
            _count: { select: { jobOrders: true } },
          },
          orderBy: [{ sortOrder: "asc" }, { wbsCode: "asc" }],
        }).then((rows) => rows.map((row) => ({ ...row, jobOrderCount: row._count.jobOrders }))),
    structureProjectIds.length === 0
      ? Promise.resolve([] as StructureNetworkRow[])
      : db.network.findMany({
          where: { projectId: { in: structureProjectIds } },
          select: {
            id: true,
            projectId: true,
            wbsId: true,
            code: true,
            name: true,
            active: true,
            _count: { select: { jobOrders: true } },
          },
          orderBy: { code: "asc" },
        }).then((rows) => rows.map((row) => ({ ...row, jobOrderCount: row._count.jobOrders }))),
  ]);

  const structureFor = (facts: readonly JobOrderFacts[]) =>
    buildProjectStructure({
      facts,
      projects: structureProjects,
      wbsRows: structureWbs,
      networkRows: structureNetworks,
      activityDays: filters.activityDays,
    });

  if (jobOrderIds.length === 0) {
    // Nothing in scope: no further queries, and the as-of date falls back to today. The scope is
    // still stamped so an empty report says WHY it is empty.
    return assemblePortfolioReport({
      facts: [],
      filters,
      actor,
      asOf: filters.asOf ?? now,
      now,
      scope,
      // The intersected sets actually applied. On this branch they are the EMPTY sets for a
      // disjoint request (or an unmapped head / unassigned manager), which is exactly what lets the
      // provenance say "None (nothing in the applied scope)" instead of echoing the foreign
      // Department or Project that was asked for. The rows are zero; the disclosure now matches.
      effectiveDepartmentIds,
      effectiveProjectIds,
      // An assigned project with no work still appears, with a zeroed register: that is the row a
      // Project Manager needs to see, and deriving the register from the facts alone would hide it.
      projectStructure: structureFor([]),
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
    where: { ...idFilter, status: { in: [...BOOKED_HOURS_STATUSES] } },
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
    where: { ...idFilter, status: { in: [...BOOKED_HOURS_STATUSES] } },
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
        // ProjectWbs.name is nullable and so is Network.name; the facts shape wants a string, so an
        // unnamed network renders as an empty name rather than leaking a null into the register.
        network: jobOrder.network
          ? { id: jobOrder.network.id, code: jobOrder.network.code, name: jobOrder.network.name ?? "" }
          : null,
        department: jobOrder.department,
        section: jobOrder.section,
        plannedStartDate: jobOrder.plannedStartDate,
        plannedEndDate: jobOrder.plannedEndDate,
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

  return assemblePortfolioReport({
    facts,
    filters,
    actor,
    asOf,
    now,
    scope,
    effectiveDepartmentIds,
    effectiveProjectIds,
    projectStructure: structureFor(facts),
  });
}
