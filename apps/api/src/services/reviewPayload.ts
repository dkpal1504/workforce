import type { JobOrderFacts } from "./portfolioReporting";
import { actionCounts, type ActionCounts, type ReviewItemLike } from "./reviewActions";
import { buildSCurve, type CurveBucket, type CurveWbs, type SCurve } from "./reviewCurve";
import type { EscalationAgeSummary } from "./reviewEscalations";
import { buildHistogram, type ManpowerBucket, type ManpowerHistogram, type ManpowerRow } from "./reviewManpower";
import { SLOW_WEIGHTS, rankSlowest, slowRowFor, type SlowRanking } from "./reviewRanking";
import { AGE_BUCKETS } from "./reviewEscalations";
import { BOOKED_HOURS_NOTE } from "./portfolioReporting";
import { dataReadiness, type Readiness } from "./reviewReadiness";

/**
 * THE ONE ASSEMBLY.
 *
 * The live dashboard, the frozen snapshot and both exports (PDF, PPTX) call this function and render its
 * output. Nothing recomputes a number for a download: a pack that disagrees with the screen it was
 * discussed over is worse than no pack, because both are believed.
 *
 * The input is already-loaded data (no database here) so the same payload can be built for a period that
 * ended three months ago from frozen rows, and so every rule above can be tested without a fixture server.
 */

export const REVIEW_SCHEMA_VERSION = 1;

export type ReviewPeriod = {
  kind: "WEEKLY" | "MONTHLY";
  /** First day, ISO date. */
  start: string;
  /** Last day, ISO date. */
  end: string;
  /** As printed: "Week of 12 Oct 2026". */
  label: string;
  /** True when the period has not finished at build time — a mid-week pack must never read as final. */
  provisional: boolean;
};

export type ReviewProjectHeader = {
  id: number;
  code: string;
  name: string;
  departmentName: string | null;
  projectManager: string | null;
};

export type ReviewSnapshotRef = {
  id: number;
  revision: number;
  capturedAt: string;
  provisional: boolean;
  captureTrigger: string;
};

/**
 * Are the crews there and the hours never booked? This is a question the app could not ask before the
 * attendance settlement existed, and it is `null` (with a reason) whenever that data is not available —
 * never a zero that reads as "nobody worked".
 */
export type AttendanceGrounding = {
  presentManDays: number;
  bookedManDays: number;
  /** present minus booked: man-days the yard paid for that no project was charged. */
  unbookedManDays: number;
  basis: "SETTLED_ATTENDANCE";
} | null;

export type AttendanceGroundingGap = "SETTLEMENT_OFF" | "NO_SETTLED_ROWS" | "NOT_REQUESTED";

export type ReviewPayload = {
  schemaVersion: number;
  frozen: boolean;
  project: ReviewProjectHeader;
  period: ReviewPeriod;
  generatedAt: string;
  snapshot: ReviewSnapshotRef | null;
  /** Headline numbers a reviewer reads first, all from the sections below. */
  pulse: {
    jobOrders: number;
    budgetHours: number;
    actualHours: number;
    burnPct: number | null;
    delayed: number;
    atRisk: number;
    notScheduled: number;
    openEscalations: number;
    escalationsOver30: number;
    actionsOpen: number;
    actionsOverdue: number;
    headcountPeak: number;
    /** The revision of the Job Order budget the figures were taken at, when the loader knows it. */
    budgetRevision: string | null;
  };
  sCurve: SCurve;
  slowest: SlowRanking;
  manpower: ManpowerHistogram;
  escalations: EscalationAgeSummary;
  actions: ActionCounts & { items: ReviewItemLike[] };
  attendance: { grounding: AttendanceGrounding; gap: AttendanceGroundingGap | null; note: string };
  readiness: Readiness;
  /** Every rule printed as data, derived from the same constants the numbers use. */
  definitions: {
    slowWeights: Record<string, number>;
    ageBuckets: Array<{ key: string; label: string }>;
    hoursNote: string;
    manpowerNote: string;
    curveBasis: string;
    assumptions: string[];
    overdueRule: string;
    carryRule: string;
  };
};

export type ReviewPayloadInput = {
  project: ReviewProjectHeader;
  period: ReviewPeriod;
  generatedAt: Date;
  buckets: readonly CurveBucket[];
  wbs: readonly CurveWbs[];
  facts: readonly JobOrderFacts[];
  budgetHours: number;
  /** Booked hours per bucket, in bucket order — the loader computes it with the shipped definition. */
  actualHoursByBucket: readonly number[];
  manpowerBuckets: readonly ManpowerBucket[];
  contractRows: readonly ManpowerRow[];
  payrollRows: readonly ManpowerRow[];
  escalations: EscalationAgeSummary;
  items: readonly ReviewItemLike[];
  attendance: { grounding: AttendanceGrounding; gap: AttendanceGroundingGap | null };
  budgetRevisionLabel?: string | null;
  frozen?: boolean;
  snapshot?: ReviewSnapshotRef | null;
  slowLimit?: number;
  now?: Date;
};

export function buildReviewPayload(input: ReviewPayloadInput): ReviewPayload {
  const now = input.now ?? input.generatedAt;
  const sCurve = buildSCurve({
    buckets: input.buckets,
    wbs: input.wbs,
    budgetHours: input.budgetHours,
    actualHoursByBucket: input.actualHoursByBucket,
  });

  const slowRows = input.facts.map((facts) =>
    slowRowFor(facts, { openEscalations: 0, now })
  );
  const slowest = rankSlowest(slowRows, input.slowLimit ?? 10);

  const manpower = buildHistogram({
    buckets: input.manpowerBuckets,
    contractRows: input.contractRows,
    payrollRows: input.payrollRows,
  });

  const actions = {
    ...actionCounts(input.items, now),
    items: [...input.items].sort((a, b) => a.id - b.id),
  };
  const readiness = dataReadiness(input.facts);
  const actualHours = sCurve.points.reduce((sum, point) => sum + point.actualHours, 0);

  return {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    frozen: input.frozen ?? false,
    project: input.project,
    period: input.period,
    generatedAt: input.generatedAt.toISOString(),
    snapshot: input.snapshot ?? null,
    pulse: {
      jobOrders: input.facts.length,
      budgetHours: round2(input.budgetHours),
      actualHours: round2(actualHours),
      burnPct:
        input.budgetHours > 0 ? Math.round((actualHours / input.budgetHours) * 10_000) / 10_000 : null,
      delayed: input.facts.filter((facts) => facts.scheduleBand === "DELAYED").length,
      atRisk: input.facts.filter((facts) => facts.scheduleBand === "AT_RISK").length,
      notScheduled: input.facts.filter((facts) => facts.scheduleBand === "NOT_SCHEDULED").length,
      openEscalations: input.escalations.total,
      escalationsOver30: input.escalations.buckets.find((bucket) => bucket.key === ">30")?.count ?? 0,
      actionsOpen: actions.open,
      actionsOverdue: actions.overdue,
      headcountPeak: manpower.peakPeople,
      budgetRevision: input.budgetRevisionLabel ?? null,
    },
    sCurve,
    slowest,
    manpower,
    escalations: input.escalations,
    actions,
    attendance: {
      grounding: input.attendance.grounding,
      gap: input.attendance.gap,
      note: attendanceNote(input.attendance.grounding, input.attendance.gap),
    },
    readiness,
    definitions: {
      slowWeights: { ...SLOW_WEIGHTS },
      ageBuckets: AGE_BUCKETS.map((bucket) => ({ key: bucket.key, label: bucket.label })),
      hoursNote: BOOKED_HOURS_NOTE,
      manpowerNote: manpower.definition,
      curveBasis: sCurve.basis,
      assumptions: sCurve.assumptions,
      overdueRule: "An action is OVERDUE when its due date is before today and it is still OPEN. Due today is not late.",
      carryRule:
        "Open actions and notes carry to the next review as a COPY, linked both ways; decisions stay in the " +
        "review that took them. An item already carried is never carried twice.",
    },
  };
}

function attendanceNote(grounding: AttendanceGrounding, gap: AttendanceGroundingGap | null): string {
  if (!grounding) {
    if (gap === "SETTLEMENT_OFF") {
      return "Attendance grounding is off: set SETTLE_REPORTS to compare present man-days with booked man-days.";
    }
    if (gap === "NO_SETTLED_ROWS") {
      return "No settled attendance for this period yet, so present-vs-booked man-days cannot be shown.";
    }
    return "Attendance grounding was not requested for this payload.";
  }
  return (
    `${grounding.presentManDays.toLocaleString("en-IN")} present man-day(s) against ` +
    `${grounding.bookedManDays.toLocaleString("en-IN")} booked: ${grounding.unbookedManDays.toLocaleString("en-IN")} ` +
    `day(s) the yard paid for that no project was charged.`
  );
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
