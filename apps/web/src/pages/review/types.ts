/** The shapes `GET /api/review/...` returns. Kept next to the screens that read them. */

export type ReviewScope =
  | { ok: true; scope: { kind: "ORGANISATION" } | { kind: "DEPARTMENT"; departmentId: number } | { kind: "PROJECTS"; projectIds: number[] }; description: string }
  | { ok: false; description: string };

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

export type ReviewProjectsResponse = { scope: ReviewScope; projects: ReviewProjectRow[] };

export type CurvePoint = {
  key: string;
  start: string;
  end: string;
  plannedHours: number;
  actualHours: number;
  plannedCum: number;
  actualCum: number;
};

export type SCurve = {
  basis: string;
  points: CurvePoint[];
  coverage: {
    budgetHours: number;
    plannedInCurveHours: number;
    unscheduledHours: number;
    wbsTotal: number;
    wbsScheduled: number;
    wbsUnscheduled: number;
    weightsConfigured: number;
    weightsEqualShare: number;
    jobOrdersTotal: number;
    jobOrdersScheduled: number;
    scheduledBudgetShare: number;
  };
  assumptions: string[];
  empty: boolean;
};

export type SlowRow = {
  jobOrderId: number;
  code: string;
  displayName: string;
  wbsCode: string;
  departmentName: string;
  sectionName: string | null;
  plannedEndDate: string | null;
  projectedFinish: string | null;
  scheduleBand: string;
  hoursBand: string;
  burnPct: number | null;
  qtyPct: number | null;
  score: number;
  measurable: boolean;
  reasons: string[];
  components: Record<string, number>;
};

export type SlowRanking = { rows: SlowRow[]; ranked: number; notMeasurable: number };

export type ManpowerHistogram = {
  buckets: Array<{
    key: string;
    start: string;
    end: string;
    contractPeople: number;
    payrollPeople: number;
    people: number;
    contractHours: number;
    payrollHours: number;
    hasData: boolean;
  }>;
  peakPeople: number;
  peakKey: string | null;
  averagePeople: number;
  contractHours: number;
  payrollHours: number;
  headcount: number;
  definition: string;
};

export type EscalationAgeSummary = {
  buckets: Array<{ key: string; label: string; count: number }>;
  total: number;
  overdue: number;
  acknowledgedUnanswered: number;
  oldest: Array<{
    id: number;
    jobOrderCode: string | null;
    createdAt: string;
    ageDays: number;
    bucket: string;
    overdue: boolean;
    acknowledgedUnanswered: boolean;
  }>;
  examined: number;
};

export type ReviewPayload = {
  schemaVersion: number;
  frozen: boolean;
  project: { id: number; code: string; name: string; departmentName: string | null; projectManager: string | null };
  period: { kind: "WEEKLY" | "MONTHLY"; start: string; end: string; label: string; provisional: boolean };
  generatedAt: string;
  snapshot: { id: number; revision: number; capturedAt: string; provisional: boolean; captureTrigger: string } | null;
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
    budgetRevision: string | null;
  };
  sCurve: SCurve;
  slowest: SlowRanking;
  manpower: ManpowerHistogram;
  escalations: EscalationAgeSummary;
  actions: { open: number; overdue: number; done: number; cancelled: number; carriedTwiceOrMore: number; unowned: number };
  attendance: { grounding: null | { presentManDays: number; bookedManDays: number; unbookedManDays: number; basis: string }; gap: string | null; note: string };
  readiness: {
    jobOrders: number;
    withoutPlan: number;
    withoutBudget: number;
    withoutBookings: number;
    withQuantityProgress: number;
    quantityProgressAvailable: boolean;
    planCoverage: number;
    sentences: string[];
  };
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
  scope: ReviewScope;
  window: { start: string; end: string; days: string[] };
};
