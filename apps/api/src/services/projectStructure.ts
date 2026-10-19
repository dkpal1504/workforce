/**
 * Project structure — the Project → WBS → Network → Job Order register.
 *
 * PURE. Takes the job-order facts the report has ALREADY built (and already scoped) plus the
 * master rows, and arranges them into a tree. No I/O, no clock: the caller owns both.
 *
 * WHY IT EXISTS: the portfolio sections answer "which job orders need a push". A Project Manager
 * also has to answer "what is under MY project" — which WBS elements exist, which networks hang off
 * them, and how the work beneath each node stands. That is a different question (structure, not
 * ranking), and answering it by filtering the job-work table by eye is what this section replaces.
 *
 * TWO HONESTY RULES, both tested:
 *
 *  1. A node's bands are the WORST of its children, never an average. One RED job order makes the
 *     WBS red whatever the others say — a fire is not diluted by the green jobs beside it. The
 *     precedence constants below are the single place that judgement is made.
 *  2. A NETWORK HAS NO STATUS OF ITS OWN. The schema stores only `active`; every band printed
 *     against a network is derived from its Job Orders, and the section labels it as such. Reporting
 *     a derived figure as a stored SAP status would be the kind of confident-looking lie the
 *     report's provenance block exists to prevent.
 */

import {
  burnPct,
  hoursBand,
  quantityBand,
  type Band,
  type JobOrderFacts,
} from "./portfolioReporting";
import type { ScheduleBand } from "./jobOrderSchedule";

/** The WBS master rows the loader fetched, in its own sort order. */
export type StructureWbsRow = {
  id: number;
  projectId: number;
  wbsCode: string;
  name: string | null;
  sortOrder: number;
  active: boolean;
  /**
   * TOTAL Job Orders pointing at this WBS element, in or out of the reader's scope. It comes from
   * the `_count` on the same query that fetched the row, so it costs no round-trip. It is what lets
   * an empty node be told apart from a node whose work is entirely outside the reader's scope.
   */
  jobOrderCount: number;
};

/** The Network master rows the loader fetched. A Network belongs to ONE WBS element. */
export type StructureNetworkRow = {
  id: number;
  projectId: number;
  wbsId: number;
  code: string;
  name: string | null;
  active: boolean;
  /** As `StructureWbsRow.jobOrderCount`: the TOTAL across every scope. */
  jobOrderCount: number;
};

/** One row of the register. The same shape is used at every level, so the screen prints one table. */
export type StructureNode = {
  id: number;
  code: string;
  name: string | null;
  /** The STORED active flag. For a Network this is the only real status there is. */
  active: boolean;
  /** Job Orders under this node THAT THE READER CAN SEE. */
  jobOrderCount: number;
  /** Job Orders under this node in total, whatever the reader's scope (master `_count`). */
  jobOrderCountAll: number;
  budgetHours: number;
  actualHours: number;
  burnPct: number | null;
  /** Worst child band (see the file header). RED beats AMBER beats GREEN beats NOT_MEASURABLE. */
  hoursBand: Band;
  /** Worst child schedule band: DELAYED > AT_RISK > DUE_SOON > ON_PLAN > NOT_SCHEDULED. */
  scheduleBand: ScheduleBand;
  /** Achieved / target over the node's children. Null when nothing under it has a quantity target. */
  qtyCompletePct: number | null;
  qtyBand: Band;
  /** Children measurable on hours with no booking inside the operator's activity window. */
  noActivity: number;
  unapprovedHours: number;
  jobOrderIds: number[];
};

export type StructureWbsNode = StructureNode & { networks: StructureNode[] };

export type ProjectStructureRow = {
  project: { id: number; code: string; name: string; active: boolean };
  totals: StructureNode;
  wbs: StructureWbsNode[];
};

/**
 * Worst-wins precedence. DECLARED, not implied by an enum order: the numbers are the contract the
 * tests pin, and a future band must be slotted in deliberately rather than defaulting to harmless.
 */
export const SCHEDULE_PRECEDENCE: Record<ScheduleBand, number> = {
  NOT_SCHEDULED: 0,
  ON_PLAN: 1,
  DUE_SOON: 2,
  AT_RISK: 3,
  DELAYED: 4,
};

/** The same precedence for the hours bands, in one place for the same reason. */
export const HOURS_PRECEDENCE: Record<Band, number> = {
  NOT_MEASURABLE: 0,
  GREEN: 1,
  AMBER: 2,
  RED: 3,
};

export function worstScheduleBand(bands: readonly ScheduleBand[]): ScheduleBand {
  let worst: ScheduleBand = "NOT_SCHEDULED";
  for (const band of bands) {
    if (SCHEDULE_PRECEDENCE[band] > SCHEDULE_PRECEDENCE[worst]) worst = band;
  }
  return worst;
}

/** Worst child wins — the headline band the screen colours. */
export function worstHoursBand(bands: readonly Band[]): Band {
  let worst: Band = "NOT_MEASURABLE";
  for (const band of bands) {
    if (HOURS_PRECEDENCE[band] > HOURS_PRECEDENCE[worst]) worst = band;
  }
  return worst;
}

/**
 * Aggregate one node from the facts beneath it.
 *
 * `hoursBand` is the WORST child (what the screen colours), while `burnPct` is recomputed from the
 * node's SUMMED hours. The two answer different questions on purpose — "is any job order in
 * trouble?" versus "how burnt is this node overall?" — exactly as `ProjectRollUp.hoursBand` and
 * `burnBand` already do for the portfolio roll-ups.
 */
function aggregate(
  identity: { id: number; code: string; name: string | null; active: boolean },
  jobOrderCountAll: number,
  facts: readonly JobOrderFacts[],
  activityDays: number
): StructureNode {
  const budgetHours = facts.reduce((sum, fact) => sum + fact.budgetHours, 0);
  const actualHours = facts.reduce((sum, fact) => sum + fact.actualHours, 0);
  const targetQty = facts.reduce((sum, fact) => sum + fact.targetQty, 0);
  const achievedQty = facts.reduce((sum, fact) => sum + fact.achievedQty, 0);

  return {
    id: identity.id,
    code: identity.code,
    name: identity.name,
    active: identity.active,
    jobOrderCount: facts.length,
    jobOrderCountAll,
    budgetHours,
    actualHours,
    burnPct: burnPct(budgetHours, actualHours),
    hoursBand: worstHoursBand(facts.map((fact) => fact.hoursBand)),
    scheduleBand: worstScheduleBand(facts.map((fact) => fact.scheduleBand)),
    // Null, not 0, when nothing under the node has a quantity target: "not measurable" and
    // "nothing achieved" are different facts and the screen must not print 0% for the first.
    qtyCompletePct: targetQty > 0 ? achievedQty / targetQty : null,
    qtyBand: quantityBand(targetQty, achievedQty),
    noActivity: facts.filter(
      (fact) =>
        fact.measurableOnHours
        && fact.daysSinceActivity !== null
        && fact.daysSinceActivity > activityDays
    ).length,
    unapprovedHours: facts.reduce((sum, fact) => sum + fact.unapprovedHours, 0),
    jobOrderIds: facts.map((fact) => fact.id),
  };
}

/**
 * Build the register.
 *
 * WHICH NODES APPEAR — the rule that keeps a Department-scoped reader honest:
 *   - a WBS/Network with ≥1 Job Order IN SCOPE appears, carrying those rows;
 *   - a WBS/Network with ZERO Job Orders at all also appears, because an empty WBS element is a
 *     real gap in the plan and is exactly what a Project Manager is looking for;
 *   - a node whose Job Orders are ALL outside the scope is omitted. Otherwise a Department Head
 *     would read nodes he cannot attribute, and a project manager would read his colleague's WBS
 *     element under his own project. `jobOrderCountAll` (the master `_count`) is what makes this
 *     decidable without a second query.
 *
 * A PROJECT always appears when its id is in `projects` — an assigned project with no Job Orders is
 * the most important row on the screen, not a missing one.
 */
export function buildProjectStructure(input: {
  facts: readonly JobOrderFacts[];
  /** The projects in scope: the assignment for a PROJECT_MANAGER, else those seen in the facts. */
  projects: ReadonlyArray<{ id: number; code: string; name: string; active: boolean }>;
  wbsRows: readonly StructureWbsRow[];
  networkRows: readonly StructureNetworkRow[];
  /** The operator's activity window, so the "no activity" count matches the pulse's window. */
  activityDays: number;
}): ProjectStructureRow[] {
  const factsByWbs = new Map<number, JobOrderFacts[]>();
  const factsByNetwork = new Map<number, JobOrderFacts[]>();

  for (const fact of input.facts) {
    const wbsList = factsByWbs.get(fact.wbs.id);
    if (wbsList) wbsList.push(fact);
    else factsByWbs.set(fact.wbs.id, [fact]);

    // A Job Order with no network is grouped under its WBS and simply not attached to a network
    // node. The column is required in the schema, so this only guards a hand-edited database.
    if (!fact.network) continue;
    const networkList = factsByNetwork.get(fact.network.id);
    if (networkList) networkList.push(fact);
    else factsByNetwork.set(fact.network.id, [fact]);
  }

  return input.projects.map((project) => {
    const projectFacts = input.facts.filter((fact) => fact.project.id === project.id);
    const projectWbs = input.wbsRows.filter((row) => row.projectId === project.id);
    const projectAll = projectWbs.reduce((sum, row) => sum + row.jobOrderCount, 0);

    const totals = aggregate(
      { id: project.id, code: project.code, name: project.name, active: project.active },
      projectAll,
      projectFacts,
      input.activityDays
    );

    const wbs: StructureWbsNode[] = [];
    for (const row of projectWbs.slice().sort((a, b) => a.sortOrder - b.sortOrder || a.wbsCode.localeCompare(b.wbsCode))) {
      const nodeFacts = factsByWbs.get(row.id) ?? [];
      // Omit a node whose work is entirely out of scope; keep an empty one (an empty WBS element is
      // a plan gap, not noise).
      if (nodeFacts.length === 0 && row.jobOrderCount > 0) continue;

      const networks: StructureNode[] = [];
      for (const network of input.networkRows
        .filter((candidate) => candidate.wbsId === row.id)
        .sort((a, b) => a.code.localeCompare(b.code))) {
        const networkFacts = factsByNetwork.get(network.id) ?? [];
        if (networkFacts.length === 0 && network.jobOrderCount > 0) continue;
        networks.push(
          aggregate(
            { id: network.id, code: network.code, name: network.name, active: network.active },
            network.jobOrderCount,
            networkFacts,
            input.activityDays
          )
        );
      }

      wbs.push({
        ...aggregate(
          { id: row.id, code: row.wbsCode, name: row.name, active: row.active },
          row.jobOrderCount,
          nodeFacts,
          input.activityDays
        ),
        networks,
      });
    }

    return { project, totals, wbs };
  });
}
