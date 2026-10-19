import test from "node:test";
import assert from "node:assert/strict";
import { buildProjectStructure, worstHoursBand, worstScheduleBand } from "./projectStructure";
import type { JobOrderFacts } from "./portfolioReporting";

/**
 * The register's contract: worst-child banding, the empty-node rule, and the totals.
 *
 * `fact()` fills the fields this module reads and casts the rest, so a fixture stays about the
 * structure under test instead of 40 lines of unrelated defaults.
 */
function fact(overrides: {
  id: number;
  projectId?: number;
  wbsId?: number;
  networkId?: number | null;
  budgetHours?: number;
  actualHours?: number;
  hoursBand?: JobOrderFacts["hoursBand"];
  scheduleBand?: JobOrderFacts["scheduleBand"];
  targetQty?: number;
  achievedQty?: number;
  unapprovedHours?: number;
  daysSinceActivity?: number | null;
  measurableOnHours?: boolean;
}): JobOrderFacts {
  const projectId = overrides.projectId ?? 1;
  const wbsId = overrides.wbsId ?? 10;
  const networkId = overrides.networkId === undefined ? 100 : overrides.networkId;
  return {
    id: overrides.id,
    code: `JO-${overrides.id}`,
    name: `Job ${overrides.id}`,
    displayName: `JO-${overrides.id} Job ${overrides.id}`,
    project: { id: projectId, code: `P${projectId}`, name: `Project ${projectId}` },
    wbs: { id: wbsId, wbsCode: `WBS-${wbsId}`, name: `WBS ${wbsId}` },
    network: networkId === null ? null : { id: networkId, code: `NW-${networkId}`, name: `Network ${networkId}` },
    department: { id: 1, name: "Hull" },
    section: null,
    status: "active",
    uom: "MT",
    budgetHours: overrides.budgetHours ?? 100,
    actualHours: overrides.actualHours ?? 0,
    burnPct: null,
    hoursBand: overrides.hoursBand ?? "GREEN",
    hoursPerDay: null,
    forecastExhaustedOn: null,
    targetQty: overrides.targetQty ?? 0,
    achievedQty: overrides.achievedQty ?? 0,
    qtyPct: null,
    qtyCompletePct: 0,
    qtyBand: "NOT_MEASURABLE",
    balanceQty: 0,
    lastBooking: null,
    daysSinceActivity: overrides.daysSinceActivity ?? null,
    unapprovedHours: overrides.unapprovedHours ?? 0,
    oldestUnapprovedAt: null,
    measurableOnHours: overrides.measurableOnHours ?? true,
    measurableOnQuantity: false,
    plannedStartDate: null,
    plannedEndDate: null,
    scheduleBand: overrides.scheduleBand ?? "NOT_SCHEDULED",
    daysToEnd: null,
    planElapsedPct: null,
    scheduleGapPct: null,
    requiredRate: null,
    actualRate: null,
    projectedFinish: null,
    projectedSlipDays: null,
    attentionScore: 0,
    reasons: [],
  } as JobOrderFacts;
}

const project = { id: 1, code: "CSR.013", name: "MV AINA", active: true };

test("a project nests its WBS elements and their networks, and totals the whole tree", () => {
  const rows = buildProjectStructure({
    projects: [project],
    activityDays: 7,
    wbsRows: [
      { id: 10, projectId: 1, wbsCode: "W1", name: "Hull", sortOrder: 1, active: true, jobOrderCount: 2 },
      { id: 11, projectId: 1, wbsCode: "W2", name: "Deck", sortOrder: 2, active: true, jobOrderCount: 1 },
    ],
    networkRows: [
      { id: 100, projectId: 1, wbsId: 10, code: "N1", name: null, active: true, jobOrderCount: 1 },
      { id: 101, projectId: 1, wbsId: 10, code: "N2", name: null, active: true, jobOrderCount: 1 },
      { id: 102, projectId: 1, wbsId: 11, code: "N3", name: null, active: true, jobOrderCount: 1 },
    ],
    facts: [
      fact({ id: 1, wbsId: 10, networkId: 100, budgetHours: 100, actualHours: 50 }),
      fact({ id: 2, wbsId: 10, networkId: 101, budgetHours: 100, actualHours: 100 }),
      fact({ id: 3, wbsId: 11, networkId: 102, budgetHours: 50, actualHours: 10 }),
    ],
  });

  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.project.code, "CSR.013");
  assert.equal(row.totals.jobOrderCount, 3);
  assert.equal(row.totals.budgetHours, 250);
  assert.equal(row.totals.actualHours, 160);
  assert.equal(row.wbs.length, 2);
  assert.deepEqual(row.wbs.map((wbs) => wbs.code), ["W1", "W2"], "WBS order follows sortOrder");
  assert.deepEqual(row.wbs[0].networks.map((net) => net.code), ["N1", "N2"], "networks sort by code");
  assert.equal(row.wbs[0].jobOrderCount, 2);
  assert.equal(row.wbs[0].networks[0].jobOrderCount, 1);
  assert.deepEqual(row.wbs[0].networks[0].jobOrderIds, [1]);
});

test("the WORST child band wins — a fire is not diluted by the green jobs beside it", () => {
  const rows = buildProjectStructure({
    projects: [project],
    activityDays: 7,
    wbsRows: [{ id: 10, projectId: 1, wbsCode: "W1", name: null, sortOrder: 1, active: true, jobOrderCount: 2 }],
    networkRows: [],
    facts: [
      fact({ id: 1, wbsId: 10, budgetHours: 100, actualHours: 1, hoursBand: "GREEN" }),
      fact({ id: 2, wbsId: 10, budgetHours: 100, actualHours: 100, hoursBand: "RED" }),
    ],
  });
  assert.equal(rows[0].wbs[0].hoursBand, "RED", "one RED job order makes the WBS red");
  assert.equal(rows[0].totals.hoursBand, "RED", "and the project with it");
  // The aggregate burn is still its own honest figure (101/200), not the worst child's.
  assert.equal(rows[0].totals.burnPct, 101 / 200);
});

test("the schedule precedence is DELAYED > AT_RISK > DUE_SOON > ON_PLAN > NOT_SCHEDULED", () => {
  assert.equal(worstScheduleBand(["NOT_SCHEDULED", "ON_PLAN"]), "ON_PLAN");
  assert.equal(worstScheduleBand(["ON_PLAN", "DUE_SOON"]), "DUE_SOON");
  assert.equal(worstScheduleBand(["DUE_SOON", "AT_RISK"]), "AT_RISK");
  assert.equal(worstScheduleBand(["AT_RISK", "DELAYED"]), "DELAYED");
  assert.equal(worstScheduleBand([]), "NOT_SCHEDULED", "nothing to judge is never 'on plan'");
  assert.equal(worstHoursBand([]), "NOT_MEASURABLE", "no budget anywhere is not a green");
  assert.equal(worstHoursBand(["GREEN", "AMBER"]), "AMBER");
  assert.equal(worstHoursBand(["AMBER", "RED"]), "RED");
});

test("quantity is aggregated across children, and is NULL when nobody set a target", () => {
  const rows = buildProjectStructure({
    projects: [project],
    activityDays: 7,
    wbsRows: [{ id: 10, projectId: 1, wbsCode: "W1", name: null, sortOrder: 1, active: true, jobOrderCount: 2 }],
    networkRows: [],
    facts: [
      fact({ id: 1, wbsId: 10, targetQty: 100, achievedQty: 25 }),
      fact({ id: 2, wbsId: 10, targetQty: 300, achievedQty: 75 }),
    ],
  });
  assert.equal(rows[0].wbs[0].qtyCompletePct, 100 / 400, "summed achieved over summed target");
  assert.equal(rows[0].wbs[0].qtyBand !== "NOT_MEASURABLE", true);

  const noTarget = buildProjectStructure({
    projects: [project],
    activityDays: 7,
    wbsRows: [{ id: 10, projectId: 1, wbsCode: "W1", name: null, sortOrder: 1, active: true, jobOrderCount: 1 }],
    networkRows: [],
    facts: [fact({ id: 1, wbsId: 10, budgetHours: 10 })],
  });
  assert.equal(noTarget[0].wbs[0].qtyCompletePct, null, "nothing achieved and no target is not 0%");
  assert.equal(noTarget[0].wbs[0].qtyBand, "NOT_MEASURABLE");
});

test("an EMPTY WBS element is kept, and a node whose work is all out of scope is dropped", () => {
  const rows = buildProjectStructure({
    projects: [project],
    activityDays: 7,
    wbsRows: [
      // No job orders anywhere: a plan gap the manager needs to see.
      { id: 10, projectId: 1, wbsCode: "EMPTY", name: null, sortOrder: 1, active: true, jobOrderCount: 0 },
      // Job orders exist, but none of them are in this reader's scope (a Department head).
      { id: 11, projectId: 1, wbsCode: "ELSEWHERE", name: null, sortOrder: 2, active: true, jobOrderCount: 5 },
      // One in scope.
      { id: 12, projectId: 1, wbsCode: "MINE", name: null, sortOrder: 3, active: true, jobOrderCount: 5 },
    ],
    networkRows: [
      { id: 100, projectId: 1, wbsId: 10, code: "EMPTY-NW", name: null, active: true, jobOrderCount: 0 },
      { id: 101, projectId: 1, wbsId: 12, code: "OUT-NW", name: null, active: true, jobOrderCount: 4 },
      { id: 102, projectId: 1, wbsId: 12, code: "IN-NW", name: null, active: true, jobOrderCount: 1 },
    ],
    facts: [fact({ id: 1, wbsId: 12, networkId: 102 })],
  });

  const codes = rows[0].wbs.map((wbs) => wbs.code);
  assert.deepEqual(codes, ["EMPTY", "MINE"], "an empty node is kept; an out-of-scope-only node is omitted");
  assert.deepEqual(
    rows[0].wbs[0].networks.map((net) => net.code),
    ["EMPTY-NW"],
    "an empty network is kept so the gap is visible"
  );
  assert.deepEqual(rows[0].wbs[1].networks.map((net) => net.code), ["IN-NW"], "the out-of-scope network is omitted");
  // The master count still states the whole truth about the node that IS shown.
  assert.equal(rows[0].wbs[1].jobOrderCountAll, 5);
  assert.equal(rows[0].wbs[1].jobOrderCount, 1);
});

test("a project with no job orders in scope still appears — it is the row that needs attention", () => {
  const rows = buildProjectStructure({
    projects: [project, { id: 2, code: "CSR.012", name: "SHIVANSH SUPPORTER", active: true }],
    activityDays: 7,
    wbsRows: [{ id: 20, projectId: 2, wbsCode: "W", name: null, sortOrder: 1, active: true, jobOrderCount: 0 }],
    networkRows: [],
    facts: [],
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[1].project.code, "CSR.012");
  assert.equal(rows[1].totals.jobOrderCount, 0);
  assert.equal(rows[1].totals.hoursBand, "NOT_MEASURABLE");
  assert.equal(rows[1].totals.scheduleBand, "NOT_SCHEDULED");
  assert.equal(rows[1].wbs.length, 1, "its empty WBS is still listed");
});

test("no-activity counts only measurable rows older than the operator's window", () => {
  const rows = buildProjectStructure({
    projects: [project],
    activityDays: 7,
    wbsRows: [{ id: 10, projectId: 1, wbsCode: "W", name: null, sortOrder: 1, active: true, jobOrderCount: 3 }],
    networkRows: [],
    facts: [
      fact({ id: 1, wbsId: 10, daysSinceActivity: 30 }),
      fact({ id: 2, wbsId: 10, daysSinceActivity: 3 }),
      // Measurable on hours is what makes a stall a stall; without a budget there is nothing to
      // have stalled against.
      fact({ id: 3, wbsId: 10, daysSinceActivity: 30, measurableOnHours: false }),
    ],
  });
  assert.equal(rows[0].wbs[0].noActivity, 1);
});

test("the activity window is the caller's, not a hardcoded seven days", () => {
  const facts = [fact({ id: 1, wbsId: 10, daysSinceActivity: 20 })];
  const wbsRows = [{ id: 10, projectId: 1, wbsCode: "W", name: null, sortOrder: 1, active: true, jobOrderCount: 1 }];
  const wide = buildProjectStructure({ projects: [project], activityDays: 30, wbsRows, networkRows: [], facts });
  const narrow = buildProjectStructure({ projects: [project], activityDays: 7, wbsRows, networkRows: [], facts });
  assert.equal(wide[0].totals.noActivity, 0);
  assert.equal(narrow[0].totals.noActivity, 1);
});

test("a job order with no network sits under its WBS and is not lost", () => {
  const rows = buildProjectStructure({
    projects: [project],
    activityDays: 7,
    wbsRows: [{ id: 10, projectId: 1, wbsCode: "W", name: null, sortOrder: 1, active: true, jobOrderCount: 1 }],
    networkRows: [],
    facts: [fact({ id: 1, wbsId: 10, networkId: null })],
  });
  assert.equal(rows[0].wbs[0].jobOrderCount, 1);
  assert.deepEqual(rows[0].wbs[0].jobOrderIds, [1]);
  assert.equal(rows[0].wbs[0].networks.length, 0);
});
