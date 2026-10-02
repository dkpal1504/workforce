/**
 * The portfolio REPORT assembly and its JSON endpoint.
 *
 * Two halves, both exercised here:
 *
 *   1. ASSEMBLY (pure) — `assemblePortfolioReport` takes already-built JobOrderFacts and
 *      produces the six sections the Operations Dashboard and both exports render. Being
 *      pure, the pulse totals, the "needs a push" ordering and its 50-row cap, the
 *      on-track / on-track-not-measurable split and the exception counts can be proven with
 *      injected fixtures, with no database.
 *
 *   2. LOADER + ENDPOINT — `buildPortfolioReport` fetches everything the facts need in a
 *      BOUNDED number of queries (the no-N+1 rule), and `routes/reports.ts` serves it over
 *      real HTTP, gated on PM / ADMIN / COO.
 *
 * Lives under src/services/ on purpose: `apps/api`'s test script globs `src/services/*.test.ts`,
 * so a test under src/routes/ would never run.
 */
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import ExcelJS from "exceljs";
import { prisma } from "../db";
import { signToken } from "../middleware/auth";
import { reportsRouter } from "../routes/reports";
import { buildJobOrderFacts, type JobOrderFacts } from "./portfolioReporting";
import { buildPortfolioXlsx } from "./portfolioExport";
import type { PortfolioFilters } from "./portfolioFilters";
import {
  assemblePortfolioReport,
  buildPortfolioReport,
  prismaCalls,
  type ReportActor,
} from "./portfolioReport";

const NOW = new Date("2026-10-02T00:00:00.000Z");
const DAY = 86_400_000;

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY);
}

function dayKey(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

const ACTOR: ReportActor = { id: 1, name: "System Admin", role: "ADMIN" };

function filters(overrides: Partial<PortfolioFilters> = {}): PortfolioFilters {
  return {
    projectIds: null,
    wbsIds: null,
    departmentIds: null,
    sectionIds: null,
    status: "all",
    budget: "all",
    bands: null,
    asOf: null,
    activityDays: 7,
    ...overrides,
  };
}

/**
 * A real JobOrderFacts row, built by the SAME builder the loader uses, so the assembly is
 * tested against authentic facts (bands, burn, attention reasons) rather than stubs.
 */
function makeFact(params: {
  id: number;
  projectId?: number;
  budgetHours: number;
  budgetQuantity?: number;
  actualHours: number;
  unapprovedHours?: number;
  oldestUnapprovedAt?: Date | null;
  firstBooking?: Date | null;
  lastBooking?: Date | null;
  departmentId?: number;
  sectionId?: number | null;
  hasApprovedProgress?: boolean;
  /** The operator's activity window; defaults to 7 to match `filters()`'s default. */
  activityDays?: number;
}): JobOrderFacts {
  return buildJobOrderFacts({
    jobOrder: {
      id: params.id,
      code: `JO-${String(params.id).padStart(4, "0")}`,
      name: `Job ${params.id}`,
      status: "active",
      budgetedHours: params.budgetHours,
      budgetedQuantity: params.budgetQuantity ?? 0,
      uom: "TON",
      project: {
        id: params.projectId ?? 1,
        code: `P-${params.projectId ?? 1}`,
        name: `Project ${params.projectId ?? 1}`,
      },
      wbs: { id: (params.projectId ?? 1) * 100, wbsCode: `WBS-${params.projectId ?? 1}`, name: "" },
      department: { id: params.departmentId ?? 1, name: `Dept ${params.departmentId ?? 1}` },
      section:
        params.sectionId == null ? null : { id: params.sectionId, name: `Section ${params.sectionId}` },
    },
    // A revision in force so the budget is effective-dated exactly as production is.
    budgetRevisions:
      params.budgetHours > 0
        ? [
            {
              revisionNo: 1,
              budgetedHours: params.budgetHours,
              budgetedQuantity: params.budgetQuantity ?? 0,
              effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
            },
          ]
        : [],
    actualHours: params.actualHours,
    unapprovedHours: params.unapprovedHours ?? 0,
    oldestUnapprovedAt: params.oldestUnapprovedAt ?? null,
    firstBooking: params.firstBooking ?? null,
    lastBooking: params.lastBooking ?? null,
    progressRows: params.hasApprovedProgress
      ? [{ status: "APPROVED", cumulativeQuantity: 10, progressDate: daysAgo(3), revisionNo: 1 }]
      : [],
    asOf: NOW,
    now: NOW,
    activityDays: params.activityDays ?? 7,
  });
}

/* ------------------------------------------------------------------ *
 * Assembly — pulse
 * ------------------------------------------------------------------ */

test("portfoliosReport pulse: totals, burn %, band counts, activity and approval ageing", () => {
  const facts = [
    // RED, active, 12h unapproved oldest 5 days old
    makeFact({
      id: 1,
      projectId: 1,
      budgetHours: 100,
      actualHours: 120,
      lastBooking: daysAgo(1),
      unapprovedHours: 12,
      oldestUnapprovedAt: daysAgo(5),
    }),
    // GREEN but stale (10 days) -> counts as no activity under the 7-day window
    makeFact({ id: 2, projectId: 1, budgetHours: 100, actualHours: 50, lastBooking: daysAgo(10) }),
    // NOT_MEASURABLE and never booked: it is NOT counted as "no activity", because an
    // unmeasurable job order is unknown rather than stalled (see the assembler's reasoning).
    makeFact({ id: 3, projectId: 2, budgetHours: 0, actualHours: 0 }),
  ];

  const report = assemblePortfolioReport({ facts, filters: filters(), actor: ACTOR, asOf: NOW, now: NOW });

  assert.equal(report.pulse.projects, 2, "distinct projects in scope");
  assert.equal(report.pulse.jobOrders, 3);
  assert.equal(report.pulse.budgetHours, 200);
  assert.equal(report.pulse.actualHours, 170);
  assert.equal(report.pulse.portfolioBurnPct, 0.85);
  assert.deepEqual(report.pulse.bands, { RED: 1, AMBER: 0, GREEN: 1, NOT_MEASURABLE: 1 });
  assert.equal(
    report.pulse.noActivity,
    1,
    "only the measurable GREEN order is stale; the unmeasurable one is excluded by design"
  );
  assert.equal(report.pulse.hoursAwaitingApproval, 12);
  assert.equal(dayKey(new Date(report.pulse.oldestUnapprovedAt as string)), "2026-09-27");

  // Provenance is a complete statement of scope, not a list of only what was set.
  assert.equal(report.provenance.generatedBy, ACTOR);
  assert.ok(report.provenance.filtersHash.length > 0);
  assert.ok(report.provenance.filters.some((f) => f.label === "Project"));

  // Definitions travel as DATA so the UI and exports print the rules, not a hardcoded sentence.
  assert.equal(report.definitions.attentionWeights.hoursRed, 40);
  assert.equal(report.definitions.attentionWeights.hoursAmber, 25);
  assert.equal(report.definitions.attentionWeights.noActivity7d, 30);
  assert.equal(report.definitions.attentionWeights.unapprovedAging3d, 20);
  assert.equal(report.definitions.attentionWeights.quantityBehind, 15);
  assert.equal(report.definitions.attentionWeights.noBudget, 10);
  assert.equal(report.definitions.bands.GREEN.max, 0.75);
});

test("portfoliosReport pulse: portfolioBurnPct is null when the total budget is zero", () => {
  const facts = [
    makeFact({ id: 1, budgetHours: 0, actualHours: 30 }),
    makeFact({ id: 2, budgetHours: 0, actualHours: 0 }),
  ];
  const report = assemblePortfolioReport({ facts, filters: filters(), actor: ACTOR, asOf: NOW, now: NOW });
  assert.equal(report.pulse.budgetHours, 0);
  assert.equal(report.pulse.portfolioBurnPct, null, "no denominator -> no percentage, never a fake 0");
});

/* ------------------------------------------------------------------ *\n * Assembly — the ACTIVITY WINDOW agreement (the bug this change fixes)\n * ------------------------------------------------------------------ */

test("portfoliosReport agreement: pulse count, reason strings and printed note all use the SAME activityDays", () => {
  // THE regression test for the contradiction the PDF shipped: with ?activityDays=14 the rules
  // block said "more than 14 day(s) old" while the reasons said "no hours booked in the last
  // 7 days", and job orders idle 8-13 days were flagged inside the operator's window. One value
  // — filters.activityDays — must drive all three: the pulse count, every stalled reason string,
  // and the printed definitions note. This test fails loudly if any of them hardcodes 7 again.
  const idle = [5, 10, 20];

  for (const windowDays of [7, 14, 30]) {
    const facts = idle.map((days, index) =>
      makeFact({
        id: index + 1,
        projectId: 1,
        budgetHours: 100,
        actualHours: 20, // GREEN and measurable: activity is the only signal in play
        lastBooking: daysAgo(days),
        activityDays: windowDays, // the loader threads this from the filter
      })
    );

    const report = assemblePortfolioReport({
      facts,
      filters: filters({ activityDays: windowDays }),
      actor: ACTOR,
      asOf: NOW,
      now: NOW,
    });

    const expectedStalled = idle.filter((days) => days > windowDays);

    // (a) The pulse count reflects the operator's window.
    assert.equal(
      report.pulse.noActivity,
      expectedStalled.length,
      `pulse.noActivity must count only work older than ${windowDays} days`
    );

    // (b) Every row flagged stalled carries a reason naming THIS window — never a stale 7.
    const stalledReasons = report.needsPush
      .flatMap((row) => row.reasons)
      .filter((reason) => reason.startsWith("no hours booked in the last"));
    assert.equal(
      stalledReasons.length,
      expectedStalled.length,
      `the number of stalled reasons must equal the pulse count at ${windowDays} days`
    );
    for (const reason of stalledReasons) {
      assert.equal(
        reason,
        `no hours booked in the last ${windowDays} days`,
        "the reason must name the window actually used"
      );
    }

    // (c) The printed rules note states the SAME window.
    assert.ok(
      report.definitions.activityWindowDaysNote.includes(`more than ${windowDays} day(s) old`),
      `the printed note must state ${windowDays} days: ${report.definitions.activityWindowDaysNote}`
    );

    // (d) THE INVARIANT: the pulse count and the reasons agree on every window. The old code
    // broke exactly here at 14 days — the pulse said 1 while two rows carried "last 7 days".
    assert.equal(
      report.pulse.noActivity,
      stalledReasons.length,
      `pulse count (${report.pulse.noActivity}) and stalled reasons (${stalledReasons.length}) must agree at ${windowDays} days`
    );
  }
});

test("portfoliosReport agreement: at 14 days a row idle 10 days is NOT stalled, while 15 days IS (the exact PDF bug)", () => {
  // The precise case from the generated PDF: DSN.001's job orders last booked 2026-09-19 were
  // 13 days idle at the report instant and were pushed with "no hours booked in the last 7 days"
  // even though the operator had asked for a 14-day window.
  const facts = [
    makeFact({ id: 1, budgetHours: 100, actualHours: 20, lastBooking: daysAgo(10), activityDays: 14 }),
    makeFact({ id: 2, budgetHours: 100, actualHours: 20, lastBooking: daysAgo(15), activityDays: 14 }),
  ];
  const report = assemblePortfolioReport({
    facts,
    filters: filters({ activityDays: 14 }),
    actor: ACTOR,
    asOf: NOW,
    now: NOW,
  });

  assert.equal(report.pulse.noActivity, 1, "only the 15-day-idle order is outside a 14-day window");
  const rowById = new Map(report.needsPush.map((row) => [row.id, row]));
  assert.equal(
    rowById.get(1)!.reasons.some((r: string) => r.includes("no hours booked")),
    false,
    "a 10-day-idle order must not be pushed inside the operator's 14-day window"
  );
  assert.ok(rowById.get(2)!.reasons.includes("no hours booked in the last 14 days"));
  assert.ok(report.definitions.activityWindowDaysNote.includes("more than 14 day(s) old"));
});

test("portfoliosReport definitions: the notes explain why a GREEN row may also be on Needs push", () => {
  // The On track sheet legitimately lists GREEN job orders that also appear in Needs push when
  // they have stalled. That is not a bug, but a reader has to be told; the explanation lives in
  // the definitions DATA so the screen, the XLSX and the PDF all inherit it.
  const report = assemblePortfolioReport({ facts: [], filters: filters(), actor: ACTOR, asOf: NOW, now: NOW });
  const note = report.definitions.notes.find(
    (n) => n.includes("Burn and activity are separate measures") && n.includes("Needs push")
  );
  assert.ok(note, `expected a burn-vs-activity note, got ${JSON.stringify(report.definitions.notes)}`);

  // And the note is carried into the exports' Filters sheet, not just the JSON.
  assert.ok(report.definitions.notes.length >= 4, "the existing notes are preserved, the new one added");
});

test("portfoliosReport definitions: the booked-hours note tells the truth about the Summary divergence", () => {
  // THE regression test at the level that matters: `definitions.notes` is the data printed on the
  // screen, in the XLSX Filters sheet and on PDF page 1. The shipped note claimed "Booked hours
  // match GET /api/summary/job-order" — a parity claim the code does not honour, because this
  // dashboard counts SUBMITTED/SUP_APPROVED as well as the Summary's PM_APPROVED-only population.
  // Two figures with different purposes are fine; a false note saying they agree is not. This test
  // fails loudly if that claim ever returns.
  const report = assemblePortfolioReport({ facts: [], filters: filters(), actor: ACTOR, asOf: NOW, now: NOW });

  const bookedNotes = report.definitions.notes.filter((n) => /booked hours/i.test(n));
  assert.equal(bookedNotes.length, 1, `exactly one booked-hours note, got ${JSON.stringify(bookedNotes)}`);
  const note = bookedNotes[0];

  // No parity claim in any of the old phrasings.
  assert.ok(!/\bmatch(es)?\b/i.test(note), `the note must not claim parity: ${note}`);
  assert.ok(!/same figure/i.test(note), `the note must not claim the same figure: ${note}`);

  // It must state the real difference and name the Summary's approved-only population.
  assert.ok(/NOT the Summary/i.test(note), `must say it is not the Summary's figure: ${note}`);
  assert.ok(note.includes("PM_APPROVED"), `must name the Summary's approved-only status: ${note}`);
  assert.ok(/awaiting approval/i.test(note), `must point at the not-yet-approved part: ${note}`);
  // Every status the booked figure sums is named, so a reader can check the set.
  for (const status of ["SUBMITTED", "SUP_APPROVED", "HOD_APPROVED", "PM_APPROVED"]) {
    assert.ok(note.includes(status), `must name the summed status ${status}: ${note}`);
  }
});

/* ------------------------------------------------------------------ *
 * Assembly — needs a push (ordering, cap, total)
 * ------------------------------------------------------------------ */

test("portfoliosReport needsPush: descending attention score, 50-row cap, full count exposed", () => {
  // 60 GREEN measurable job orders, all score 0, distinct budgets so the tie-break is budget desc.
  const facts: JobOrderFacts[] = [];
  for (let i = 0; i < 60; i += 1) {
    facts.push(makeFact({ id: i + 1, budgetHours: 1000 - i, actualHours: 0, lastBooking: daysAgo(1) }));
  }

  const report = assemblePortfolioReport({ facts, filters: filters(), actor: ACTOR, asOf: NOW, now: NOW });

  assert.equal(report.needsPushTotal, 60, "the full count is exposed even when the list is capped");
  assert.equal(report.needsPush.length, 50, "the ranked list is capped at 50");
  assert.equal(report.needsPush[0].budgetHours, 1000, "ties are broken by budgeted hours desc");
  assert.equal(report.needsPush[49].budgetHours, 951);

  for (let i = 1; i < report.needsPush.length; i += 1) {
    assert.ok(
      report.needsPush[i - 1].attentionScore >= report.needsPush[i].attentionScore,
      "scores are non-increasing"
    );
  }
});

test("portfoliosReport needsPush: a RED job order outranks a fresh GREEN one", () => {
  const red = makeFact({ id: 1, budgetHours: 100, actualHours: 100, lastBooking: daysAgo(1) });
  const green = makeFact({ id: 2, budgetHours: 100, actualHours: 10, lastBooking: daysAgo(1) });
  const report = assemblePortfolioReport({
    facts: [green, red],
    filters: filters(),
    actor: ACTOR,
    asOf: NOW,
    now: NOW,
  });
  assert.equal(report.needsPush[0].id, 1, "the exhausted-budget job order leads the push list");
  assert.ok(report.needsPush[0].reasons.includes("hours budget exhausted"));
});

/* ------------------------------------------------------------------ *
 * Assembly — on track, split from not-measurable
 * ------------------------------------------------------------------ */

test("portfoliosReport onTrack: GREEN-and-measurable only, budget desc, never borrowing missing data", () => {
  const small = makeFact({ id: 1, budgetHours: 100, actualHours: 10, lastBooking: daysAgo(1) }); // GREEN
  const large = makeFact({ id: 2, budgetHours: 200, actualHours: 20, lastBooking: daysAgo(1) }); // GREEN
  const noBudgetWithHours = makeFact({ id: 3, budgetHours: 0, actualHours: 50 }); // NOT_MEASURABLE
  const noBudgetNoHours = makeFact({ id: 4, budgetHours: 0, actualHours: 0 }); // looks green, is not

  const report = assemblePortfolioReport({
    facts: [small, large, noBudgetWithHours, noBudgetNoHours],
    filters: filters(),
    actor: ACTOR,
    asOf: NOW,
    now: NOW,
  });

  assert.deepEqual(
    report.onTrack.map((f) => f.id),
    [2, 1],
    "on track is GREEN & measurable, sorted by budgeted hours desc"
  );
  assert.deepEqual(
    report.onTrackNotMeasurable.map((f) => f.id).sort((a, b) => a - b),
    [3, 4],
    "unmeasurable job orders are their own bucket"
  );
  assert.ok(!report.onTrack.some((f) => f.id === 3 || f.id === 4), "a green tile is never borrowed from missing data");
});

/* ------------------------------------------------------------------ *
 * Assembly — jobWork, departmentLoad, exceptions
 * ------------------------------------------------------------------ */

test("portfoliosReport jobWork is every job order, sorted by project then code", () => {
  const facts = [
    makeFact({ id: 3, projectId: 2, budgetHours: 100, actualHours: 10 }),
    makeFact({ id: 1, projectId: 1, budgetHours: 100, actualHours: 10 }),
    makeFact({ id: 2, projectId: 1, budgetHours: 100, actualHours: 10 }),
  ];
  const report = assemblePortfolioReport({ facts, filters: filters(), actor: ACTOR, asOf: NOW, now: NOW });
  assert.equal(report.jobWork.length, 3);
  const order = report.jobWork.map((f) => `${f.project.id}:${f.code}`);
  assert.deepEqual([...order].sort(), order, "job work is ordered by project then code");
});

test("portfoliosReport exceptions: counts for no-budget, budget-no-bookings, no-progress, unapproved", () => {
  const facts = [
    makeFact({ id: 1, budgetHours: 0, actualHours: 0 }), // no budget; quantity 0 -> no progress
    makeFact({ id: 2, budgetHours: 100, budgetQuantity: 50, actualHours: 0 }), // budget, no bookings; no approved progress
    makeFact({ id: 3, budgetHours: 100, budgetQuantity: 0, actualHours: 40, unapprovedHours: 12, oldestUnapprovedAt: daysAgo(5) }), // unapproved; no quantity target
    makeFact({
      id: 4,
      budgetHours: 100,
      budgetQuantity: 50,
      actualHours: 10,
      lastBooking: daysAgo(1),
      hasApprovedProgress: true, // measurable on quantity -> NOT a no-progress exception
    }),
  ];

  const report = assemblePortfolioReport({ facts, filters: filters(), actor: ACTOR, asOf: NOW, now: NOW });

  assert.equal(report.exceptions.noBudgetHours.count, 1);
  assert.equal(report.exceptions.noBudgetHours.rows[0].id, 1);
  assert.equal(report.exceptions.budgetWithNoBookings.count, 1);
  assert.equal(report.exceptions.budgetWithNoBookings.rows[0].id, 2);
  assert.equal(report.exceptions.noProgress.count, 3, "ids 1, 2 and 3 have no approved progress");
  assert.ok(!report.exceptions.noProgress.rows.some((r) => r.id === 4));
  assert.equal(report.exceptions.unapproved.count, 1);
  assert.equal(report.exceptions.unapproved.rows[0].id, 3);
});

test("portfoliosReport exceptions: row lists are capped at 100 while the count stays true", () => {
  const facts: JobOrderFacts[] = [];
  for (let i = 0; i < 150; i += 1) facts.push(makeFact({ id: i + 1, budgetHours: 0, actualHours: 0 }));
  const report = assemblePortfolioReport({ facts, filters: filters(), actor: ACTOR, asOf: NOW, now: NOW });
  assert.equal(report.exceptions.noBudgetHours.count, 150);
  assert.equal(report.exceptions.noBudgetHours.rows.length, 100);
});

/* ------------------------------------------------------------------ *
 * Loader — bounded queries (no N+1)
 * ------------------------------------------------------------------ */

/**
 * The whole point of the loader is that the number of Prisma round-trips is fixed: it does
 * not grow with the number of job orders. This test builds its own fixture (projects, WBS,
 * networks, job orders) so it can compare N job orders against 2N and assert the count is
 * identical — the classic N+1 would double the reads.
 */
test("portfoliosReport loader: Prisma call count is constant when the job orders double", async (t) => {
  const suffix = Date.now().toString(36);
  const dept = await prisma.department.findFirst({ orderBy: { id: "asc" }, select: { id: true } });
  const uom = await prisma.uom.findFirst({ orderBy: { id: "asc" }, select: { id: true } });
  assert.ok(dept, "the dev database needs a department");
  assert.ok(uom, "the dev database needs a UoM");

  const projects: number[] = [];
  for (const tag of ["A", "B"]) {
    const project = await prisma.project.create({
      data: {
        code: `ZZQ-${suffix}-${tag}`,
        name: `Query count probe ${tag}`,
        colorKey: `${tag}${suffix.slice(-2).toUpperCase()}`,
        active: true,
      },
      select: { id: true },
    });
    projects.push(project.id);
    const wbs = await prisma.projectWbs.create({
      data: { projectId: project.id, wbsCode: "W1", name: "Probe WBS" },
      select: { id: true },
    });
    const network = await prisma.network.create({
      data: { projectId: project.id, wbsId: wbs.id, code: `NW-${suffix}-${tag}`, name: "Probe network" },
      select: { id: true },
    });
    for (let i = 0; i < 4; i += 1) {
      await prisma.jobOrder.create({
        data: {
          projectId: project.id,
          projectWbsId: wbs.id,
          networkId: network.id,
          code: `J${i + 1}`,
          name: `Probe job ${tag}${i + 1}`,
          uomId: uom.id,
          budgetedQuantity: 10,
          budgetedHours: 100,
          departmentId: dept.id,
          status: "active",
        },
      });
    }
  }

  t.after(async () => {
    await prisma.jobOrder.deleteMany({ where: { projectId: { in: projects } } });
    await prisma.network.deleteMany({ where: { projectId: { in: projects } } });
    await prisma.projectWbs.deleteMany({ where: { projectId: { in: projects } } });
    await prisma.project.deleteMany({ where: { id: { in: projects } } });
  });

  // Small set: 4 job orders.
  prismaCalls.length = 0;
  const small = await buildPortfolioReport(filters({ projectIds: [projects[0]] }), ACTOR, NOW);
  const smallCalls = prismaCalls.length;

  // Doubled set: 8 job orders.
  prismaCalls.length = 0;
  const big = await buildPortfolioReport(filters({ projectIds: projects }), ACTOR, NOW);
  const bigCalls = prismaCalls.length;

  assert.equal(small.pulse.jobOrders, 4, "the small scope really has 4 job orders");
  assert.equal(big.pulse.jobOrders, 8, "the big scope really has twice as many");

  // The observed numbers are printed so a reader can see the real counts, not just the claim.
  console.log(`[no-N+1] small(4 job orders)=${smallCalls} prisma calls, doubled(8 job orders)=${bigCalls} prisma calls`);
  assert.equal(bigCalls, smallCalls, "the query count must not grow with the number of job orders");
  assert.equal(smallCalls, 7, "exactly 7 bounded queries: JOs, revisions, progress, booked, unapproved, oldest-unapproved, span");
});

/* ------------------------------------------------------------------ *
 * Endpoint — real HTTP through the real router
 * ------------------------------------------------------------------ */

type Probe = { status: number; body: Record<string, unknown> };

function listen(app: express.Express): Promise<{ base: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({ base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

async function get(base: string, path: string, token?: string): Promise<Probe> {
  const res = await fetch(base + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body: body as Record<string, unknown> };
}

const COO_EMAIL = "coo.portfolio-endpoint-test@workforce.local";

test("GET /api/reports/portfolio admits PM, ADMIN and COO and refuses everyone else", async (t) => {
  const app = express();
  app.use(express.json());
  app.use("/api/reports", reportsRouter); // same mount shape as src/index.ts
  const server = await listen(app);

  await prisma.user.deleteMany({ where: { email: COO_EMAIL } });
  const coo = await prisma.user.create({
    data: { email: COO_EMAIL, passwordHash: "test-fixture", name: "COO Endpoint Test", role: "COO", active: true },
    select: { id: true, tokenVersion: true },
  });
  t.after(async () => {
    await prisma.user.deleteMany({ where: { email: COO_EMAIL } });
    await server.close();
  });

  const login = async (role: string) => {
    const user = await prisma.user.findFirst({
      where: { role, active: true, mustChangePassword: false },
      orderBy: { id: "asc" },
      select: { id: true, tokenVersion: true, passwordExpiresAt: true },
    });
    assert.ok(user, `the dev database needs an active ${role} login`);
    assert.ok(
      user!.passwordExpiresAt === null || user!.passwordExpiresAt.getTime() > Date.now(),
      `${role} credential must not be expired`
    );
    return signToken({ id: user!.id, tokenVersion: user!.tokenVersion });
  };

  const cooToken = signToken({ id: coo.id, tokenVersion: coo.tokenVersion });

  // The three roles that hold viewPortfolioDashboard reach the report.
  for (const [label, token] of [
    ["ADMIN", await login("ADMIN")],
    ["PM", await login("PM")],
    ["COO", cooToken],
  ] as const) {
    const res = await get(server.base, "/api/reports/portfolio", token);
    assert.equal(res.status, 200, `${label} must reach the portfolio report (got ${res.status})`);
    assert.ok(res.body.pulse, `${label} body carries the pulse`);
    assert.ok(Array.isArray(res.body.needsPush), `${label} body carries the push list`);
  }

  // The Department-scoped / non-portfolio roles: SUPERVISOR and EMPLOYEE are refused. HOD now
  // reaches the report but with its own Department narrow scope, so it is checked in its own test.
  for (const role of ["SUPERVISOR", "EMPLOYEE"] as const) {
    const res = await get(server.base, "/api/reports/portfolio", await login(role));
    assert.equal(res.status, 403, `${role} must be forbidden (got ${res.status})`);
    assert.equal(res.body.code, "FORBIDDEN");
  }

  // Unauthenticated is refused by the auth gate, before the role gate.
  const unauth = await get(server.base, "/api/reports/portfolio");
  assert.equal(unauth.status, 401);

  // A bad filter is a 400 in the house shape, not a silent degradation to "all".
  const badFilter = await get(server.base, "/api/reports/portfolio?band=PURPLE", await login("ADMIN"));
  assert.equal(badFilter.status, 400);
  assert.equal(badFilter.body.code, "INVALID_BAND");
  assert.ok(typeof badFilter.body.error === "string" && badFilter.body.error.length > 0);
});

/* ================================================================== *
 * HOD / DEPT_HEAD department scope — THE PRIVILEGE BOUNDARY
 *
 * The happy path (a head can OPEN the dashboard) is the LEAST interesting assertion in this
 * section. What matters is the boundary: a head can never read another Department, every HOD
 * SHAPE reads its WHOLE Department, a request can never widen the scope it was handed, and a
 * head with no mapping reads nothing at all. The leak tests below are the reason this change
 * exists.
 * ================================================================== */

/** The fixture graph a scoping test needs: two Departments, three Sections, two Projects. */
type ScopeFixture = {
  deptA: number; // the HOD's own Department
  deptB: number; // the FOREIGN Department the HOD must never see
  sectionA1: number;
  sectionA2: number; // a second Section of deptA
  sectionB1: number;
  projectIds: number[];
  wbsIds: number[];
  jobOrderIds: { a1: number; a2: number; b1: number };
  cleanup: () => Promise<void>;
};

/**
 * Build two Departments with their Sections and Projects and three Job Orders:
 *   joA1 -> Department A, Section A1  (Project P1)
 *   joA2 -> Department A, Section A2  (Project P2)   a DIFFERENT Section of the SAME Department
 *   joB1 -> Department B, Section B1  (Project P1)   the FOREIGN department, sharing P1 with joA1
 *
 * Every id is suffixed so repeated runs (and a shared dev DB) never collide, and cleanup deletes
 * exactly what it created.
 */
async function createScopeFixture(tag: string): Promise<ScopeFixture> {
  const suffix = `${tag}-${Date.now().toString(36)}`;
  const stamp = suffix.replace(/[^a-z0-9]/gi, "").slice(-12).toUpperCase();
  const uom = await prisma.uom.findFirst({ orderBy: { id: "asc" }, select: { id: true } });
  assert.ok(uom, "the dev database needs a UoM");

  const deptA = await prisma.department.create({
    data: { name: `Scope A ${suffix}`, code: `SCOPEA_${stamp}` },
    select: { id: true },
  });
  const deptB = await prisma.department.create({
    data: { name: `Scope B ${suffix}`, code: `SCOPEB_${stamp}` },
    select: { id: true },
  });
  const sectionA1 = await prisma.section.create({
    data: { departmentId: deptA.id, code: `SA1_${stamp}`, name: `Sec A1 ${suffix}` },
    select: { id: true },
  });
  const sectionA2 = await prisma.section.create({
    data: { departmentId: deptA.id, code: `SA2_${stamp}`, name: `Sec A2 ${suffix}` },
    select: { id: true },
  });
  const sectionB1 = await prisma.section.create({
    data: { departmentId: deptB.id, code: `SB1_${stamp}`, name: `Sec B1 ${suffix}` },
    select: { id: true },
  });

  const projectIds: number[] = [];
  const wbsIds: number[] = [];
  const networkIds: number[] = [];
  for (const [index, label] of ["P1", "P2"].entries()) {
    const project = await prisma.project.create({
      data: {
        code: `SCOPE-${stamp}-${label}`,
        name: `Scope ${label} ${suffix}`,
        colorKey: `${label}${stamp.slice(-4)}`,
        active: true,
      },
      select: { id: true },
    });
    projectIds.push(project.id);
    const wbs = await prisma.projectWbs.create({
      data: { projectId: project.id, wbsCode: `W${index}`, name: `Scope WBS ${label}` },
      select: { id: true },
    });
    wbsIds.push(wbs.id);
    const network = await prisma.network.create({
      data: {
        projectId: project.id,
        wbsId: wbs.id,
        code: `SCOPE-NW-${stamp}-${label}`,
        name: "Scope network",
      },
      select: { id: true },
    });
    networkIds.push(network.id);
  }

  const makeJo = (code: string, projectIndex: number, departmentId: number, sectionId: number) =>
    prisma.jobOrder.create({
      data: {
        projectId: projectIds[projectIndex],
        projectWbsId: wbsIds[projectIndex],
        networkId: networkIds[projectIndex],
        code,
        name: `Scope jo ${code}`,
        uomId: uom.id,
        budgetedHours: 100,
        budgetedQuantity: 10,
        departmentId,
        sectionId,
        status: "active",
      },
      select: { id: true },
    });

  const joA1 = await makeJo(`SCOPE-A1-${stamp}`, 0, deptA.id, sectionA1.id);
  const joA2 = await makeJo(`SCOPE-A2-${stamp}`, 1, deptA.id, sectionA2.id);
  const joB1 = await makeJo(`SCOPE-B1-${stamp}`, 0, deptB.id, sectionB1.id);

  return {
    deptA: deptA.id,
    deptB: deptB.id,
    sectionA1: sectionA1.id,
    sectionA2: sectionA2.id,
    sectionB1: sectionB1.id,
    projectIds,
    wbsIds,
    jobOrderIds: { a1: joA1.id, a2: joA2.id, b1: joB1.id },
    cleanup: async () => {
      await prisma.jobOrder.deleteMany({ where: { projectId: { in: projectIds } } });
      await prisma.network.deleteMany({ where: { projectId: { in: projectIds } } });
      await prisma.projectWbs.deleteMany({ where: { projectId: { in: projectIds } } });
      await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
      await prisma.section.deleteMany({ where: { departmentId: { in: [deptA.id, deptB.id] } } });
      await prisma.department.deleteMany({ where: { id: { in: [deptA.id, deptB.id] } } });
    },
  };
}

const sortedIds = (rows: Array<{ id: number }>): number[] => rows.map((row) => row.id).sort((a, b) => a - b);

/**
 * (b) THE LEAK TEST — the reason this whole change exists.
 *
 * An HOD sees ONLY his own Department. When he passes ANOTHER department's id the request is
 * INTERSECTED with his scope (never trusted), the intersection is EMPTY, and the honest result is
 * ZERO rows — we never "helpfully" substitute his own department, nor hand him the requested one.
 */
test("report scope LEAK TEST: an HOD sees ONLY his own department, and requesting another department never returns its rows", async (t) => {
  const fx = await createScopeFixture("leak");
  t.after(fx.cleanup);

  const hod: ReportActor = { id: 1, name: "HOD A", role: "HOD", departmentId: fx.deptA };
  const pm: ReportActor = { id: 2, name: "PM", role: "PM", departmentId: null };

  // (1) HIS OWN, WHOLE DEPARTMENT: with no department filter the HOD reads BOTH of his Department's
  // job orders (one in EACH of two Sections) and NEVER the other Department's row.
  const own = await buildPortfolioReport(filters(), hod, NOW);
  assert.deepEqual(
    sortedIds(own.jobWork),
    [fx.jobOrderIds.a1, fx.jobOrderIds.a2].sort((a, b) => a - b),
    "the HOD sees every Job Order of HIS department, across both of its Sections"
  );
  assert.ok(!own.jobWork.some((row) => row.id === fx.jobOrderIds.b1), "and never the other department's job order");
  assert.deepEqual(
    own.provenance.scope,
    { kind: "DEPARTMENT", departmentId: fx.deptA, description: `Department ${fx.deptA} (whole department)` },
    "the report states the scope actually applied"
  );

  // (2) THE LEAK: the HOD passes the OTHER department's id. He must not receive it. The request is
  // intersected with his scope, so the effective filter is EMPTY and he gets ZERO rows. We do NOT
  // fall back to his own department: a report that quietly ignores the filter it was given is
  // worse than an empty one.
  const foreign = await buildPortfolioReport(filters({ departmentIds: [fx.deptB] }), hod, NOW);
  assert.equal(foreign.jobWork.length, 0, "an HOD asking for another department receives ZERO rows");
  assert.ok(!foreign.jobWork.some((row) => row.id === fx.jobOrderIds.b1), "the other department's job order is NEVER returned");
  assert.equal(foreign.provenance.scope.departmentId, fx.deptA, "the applied scope is still the HOD's own department");

  // (3) The data really exists: PM asking for the same department DOES get the B job order, so (2)
  // is a scope decision and not an empty fixture.
  const pmForeign = await buildPortfolioReport(filters({ departmentIds: [fx.deptB] }), pm, NOW);
  assert.ok(pmForeign.jobWork.some((row) => row.id === fx.jobOrderIds.b1), "the foreign department's data exists and PM can read it");

  // (4) Asking for his OWN department narrows to it (and still excludes B).
  const narrowed = await buildPortfolioReport(filters({ departmentIds: [fx.deptA] }), hod, NOW);
  assert.deepEqual(sortedIds(narrowed.jobWork), sortedIds(own.jobWork), "his own id narrows to the same set");

  // (5) A SECTION id of another department must not reach across either. Section ids are globally
  // unique, so the Department predicate alone already yields zero rows for a Section that is not
  // in his Department.
  const foreignSection = await buildPortfolioReport(filters({ sectionIds: [fx.sectionB1] }), hod, NOW);
  assert.equal(foreignSection.jobWork.length, 0, "an HOD asking for another department's Section receives ZERO rows");

  // (6) A PROJECT shared across departments cannot leak the foreign row either: Project P1 holds
  // joA1 (HOD's) AND joB1 (foreign), so asking for P1 must yield only the HOD's own P1 row.
  const byProject = await buildPortfolioReport(filters({ projectIds: [fx.projectIds[0]] }), hod, NOW);
  assert.deepEqual(sortedIds(byProject.jobWork), [fx.jobOrderIds.a1], "a shared project yields only the HOD's own department's job order");
});

/**
 * (b2) THE DISCLOSURE TEST — the provenance must describe the report PRODUCED, not the request.
 *
 * The rows were always contained (see the leak test above), but an HOD's export used to PRINT
 * "Department: 1, 2" for `departmentIds=[1,2]` and "Department: 2" for a foreign `departmentIds=2`
 * — affirmatively claiming a Department he was never allowed to read, and stamping that claim into
 * the filename hash. A forwarded report therefore lied about the boundary the rest of this feature
 * enforces. These assertions fail on the pre-fix code.
 */
const departmentLineOf = (report: {
  provenance: { filters: Array<{ label: string; value: string }> };
}): string => report.provenance.filters.find((entry) => entry.label === "Department")?.value ?? "";

/** The Department ids a provenance line NAMES (so "2" is not confused with the "2" in "12"). */
const namedDepartments = (line: string): string[] =>
  line.split(",").map((token) => token.trim());

test("provenance DISCLOSURE: an HOD's report names the APPLIED department and never a foreign one it was denied", async (t) => {
  const fx = await createScopeFixture("disclosure");
  t.after(fx.cleanup);

  const hod: ReportActor = { id: 1, name: "HOD A", role: "HOD", departmentId: fx.deptA };
  const pm: ReportActor = { id: 2, name: "PM", role: "PM", departmentId: null };

  // (a) A FOREIGN department only. Zero rows (the leak test proves this), and the provenance must
  // NOT name the foreign Department — nor fall back to printing a blank line that reads as "no
  // Department filter was applied". It must say a Department filter was applied and admits nothing.
  const foreignHod = await buildPortfolioReport(filters({ departmentIds: [fx.deptB] }), hod, NOW);
  assert.equal(foreignHod.jobWork.length, 0, "a foreign-only request still yields zero rows");
  const foreignLine = departmentLineOf(foreignHod);
  assert.ok(
    !namedDepartments(foreignLine).includes(String(fx.deptB)),
    `the Department line must NOT name the foreign department ${fx.deptB}, got "${foreignLine}"`
  );
  assert.match(foreignLine, /None/, "an empty applied set is stated explicitly, never printed blank");

  // (b) OWN + FOREIGN. He reads only his own rows (correct), and the printed line must name ONLY
  // his own department. The same request made by an ORGANISATION actor applies BOTH departments, so
  // its provenance and HASH must differ — proving the hash follows the effective set, not the
  // request string.
  const mixedRequest = filters({ departmentIds: [fx.deptA, fx.deptB] });
  const mixedHod = await buildPortfolioReport(mixedRequest, hod, NOW);
  assert.deepEqual(
    sortedIds(mixedHod.jobWork),
    [fx.jobOrderIds.a1, fx.jobOrderIds.a2].sort((a, b) => a - b),
    "the HOD still reads exactly his own department's rows"
  );
  const mixedLine = departmentLineOf(mixedHod);
  assert.ok(
    namedDepartments(mixedLine).includes(String(fx.deptA)),
    `the Department line must name the APPLIED department ${fx.deptA}, got "${mixedLine}"`
  );
  assert.ok(
    !namedDepartments(mixedLine).includes(String(fx.deptB)),
    `the Department line must NOT name the foreign department ${fx.deptB}, got "${mixedLine}"`
  );
  const mixedPm = await buildPortfolioReport(mixedRequest, pm, NOW);
  assert.equal(namedDepartments(departmentLineOf(mixedPm)).join(", "), `${fx.deptA}, ${fx.deptB}`,
    "an ORGANISATION actor's identical request DOES name both (its effective set is both)");
  assert.notEqual(
    mixedHod.provenance.filtersHash,
    mixedPm.provenance.filtersHash,
    "same request, different APPLIED set -> different hash, so two reports over different data never share a filename"
  );

  // (c) NO REGRESSION for the organisation scope: an ORGANISATION actor's requested department is
  // passed through unchanged and is still named in the line.
  const org = await buildPortfolioReport(filters({ departmentIds: [fx.deptB] }), pm, NOW);
  assert.ok(
    namedDepartments(departmentLineOf(org)).includes(String(fx.deptB)),
    "an ORGANISATION actor still prints the department it asked for"
  );

  // (d) HASH STABILITY + follows the EFFECTIVE SET: the same request twice is stable, and an HOD
  // and a PM whose requests both resolve to the SAME effective set share a hash.
  const mixedHodAgain = await buildPortfolioReport(filters({ departmentIds: [fx.deptA, fx.deptB] }), hod, NOW);
  assert.equal(mixedHodAgain.provenance.filtersHash, mixedHod.provenance.filtersHash, "identical effective set -> identical hash");
  const hodOwn = await buildPortfolioReport(filters({ departmentIds: [fx.deptA] }), hod, NOW);
  const pmOwn = await buildPortfolioReport(filters({ departmentIds: [fx.deptA] }), pm, NOW);
  assert.equal(hodOwn.provenance.filtersHash, pmOwn.provenance.filtersHash, "different roles, SAME effective set -> same hash");

  // (e) The narrowing is RECORDED (not lost): the reader can see that what was requested was
  // clamped, not chosen. Absent when nothing changed.
  assert.ok(
    mixedHod.definitions.notes.some((note) => note.startsWith("Requested Department filter")),
    "a narrowed request is recorded in the provenance notes"
  );
  assert.ok(
    !org.definitions.notes.some((note) => note.startsWith("Requested Department filter")),
    "an un-narrowed request adds no redundant note"
  );
});

/**
 * The same defect, caught at the PURE assembly layer with no database: the assembler builds the
 * filter line and the hash from `effectiveDepartmentIds`, not from `filters.departmentIds`.
 */
test("provenance DISCLOSURE (pure): assemblePortfolioReport prints and hashes the EFFECTIVE department set", () => {
  const requested = filters({ departmentIds: [1, 2] });
  const hod: ReportActor = { id: 9, name: "HOD", role: "HOD", departmentId: 1 };

  const applied = assemblePortfolioReport({
    facts: [],
    filters: requested,
    actor: hod,
    asOf: NOW,
    now: NOW,
    scope: { kind: "DEPARTMENT", departmentId: 1 },
    effectiveDepartmentIds: [1],
  });
  assert.equal(departmentLineOf(applied), "1", "the printed Department line shows only the APPLIED department");
  assert.ok(
    applied.definitions.notes.some((note) => note.startsWith("Requested Department filter")),
    "the request that was narrowed is still recorded"
  );

  // The SAME requested filters, but an effective set equal to the request (an organisation actor):
  // a different applied set must give a different hash, so the filename cannot key off the request.
  const passedThrough = assemblePortfolioReport({
    facts: [],
    filters: requested,
    actor: ACTOR,
    asOf: NOW,
    now: NOW,
    scope: { kind: "ORGANISATION" },
    effectiveDepartmentIds: [1, 2],
  });
  assert.notEqual(
    applied.provenance.filtersHash,
    passedThrough.provenance.filtersHash,
    "different applied set -> different hash"
  );
  assert.equal(departmentLineOf(passedThrough), "1, 2", "an un-narrowed request is printed as asked");
});

/**
 * (c) EVERY HOD SHAPE READS THE WHOLE DEPARTMENT — the agreed rule.
 *
 * A section-narrowed account and a department-wide account behave identically here, and so does a
 * DEPT_HEAD. The scope DECISION (`reportScopeFor`) takes only (role, departmentId): Section is
 * deliberately NOT an input, so the two shapes cannot diverge. This test proves the observable
 * consequence — two Sections of one Department are merged into one report.
 */
test("a Section-narrowed HOD account and a department-wide HOD account read the SAME whole Department", async (t) => {
  const fx = await createScopeFixture("hodshape");
  t.after(fx.cleanup);

  const sectionHead: ReportActor = { id: 1, name: "Section Head", role: "HOD", departmentId: fx.deptA };
  const departmentWide: ReportActor = { id: 2, name: "Department HOD", role: "HOD", departmentId: fx.deptA };
  const deptHead: ReportActor = { id: 3, name: "Department Head", role: "DEPT_HEAD", departmentId: fx.deptA };

  const expected = [fx.jobOrderIds.a1, fx.jobOrderIds.a2].sort((a, b) => a - b);
  const sectionHeadReport = await buildPortfolioReport(filters(), sectionHead, NOW);
  const departmentWideReport = await buildPortfolioReport(filters(), departmentWide, NOW);
  const deptHeadReport = await buildPortfolioReport(filters(), deptHead, NOW);

  assert.deepEqual(sortedIds(sectionHeadReport.jobWork), expected, "the whole department, both Sections, for a Section-narrowed HOD");
  assert.deepEqual(sortedIds(departmentWideReport.jobWork), expected, "a department-wide HOD account reads the SAME set");
  assert.deepEqual(sortedIds(deptHeadReport.jobWork), expected, "a DEPT_HEAD reads the SAME set");

  // Proof the two Sections are genuinely distinct rows in the one report.
  const seenSections = new Set(sectionHeadReport.jobWork.map((row) => row.section?.id));
  assert.ok(
    seenSections.has(fx.sectionA1) && seenSections.has(fx.sectionA2),
    "both Sections of the Department are present in the single department-wide report"
  );
});

/**
 * (d) FAIL CLOSED — a head with no Department mapping reads NOTHING.
 *
 * This is the guard against the exact Prisma trap: an EMPTY `where` object matches EVERY row, so
 * an unmapped head must produce an impossible filter (`{ in: [] }`, the `{ id: -1 }` idiom), never
 * no filter at all. PM, in the SAME fixture, reads every row — proving the zero is a scope fact.
 */
test("a head with NO department mapping reads ZERO rows, while PM reads every row in the same fixture", async (t) => {
  const fx = await createScopeFixture("failclosed");
  t.after(fx.cleanup);

  const unmappedHod: ReportActor = { id: 1, name: "Unmapped HOD", role: "HOD", departmentId: null };
  const unmappedDeptHead: ReportActor = { id: 2, name: "Unmapped Dept Head", role: "DEPT_HEAD", departmentId: null };
  const pm: ReportActor = { id: 3, name: "PM", role: "PM", departmentId: null };

  const hodReport = await buildPortfolioReport(filters(), unmappedHod, NOW);
  assert.equal(hodReport.jobWork.length, 0, "an unmapped HOD must read NOTHING, never the whole portfolio");
  assert.deepEqual(
    hodReport.provenance.scope,
    { kind: "NONE", departmentId: null, description: "No department mapping — nothing in scope" },
    "the empty report states WHY it is empty"
  );
  assert.equal((await buildPortfolioReport(filters(), unmappedDeptHead, NOW)).jobWork.length, 0, "an unmapped DEPT_HEAD likewise");

  const pmReport = await buildPortfolioReport(filters(), pm, NOW);
  assert.ok(pmReport.jobWork.length >= 3, "PM reads every job order in the fixture (plus the seeded ones)");
  assert.ok(pmReport.jobWork.some((row) => row.id === fx.jobOrderIds.b1), "including the foreign department's row");
});

/** Sign a token for an active, non-expired user of `role` (the dev DB's seeded accounts). */
async function liveToken(role: string): Promise<{ token: string; id: number }> {
  const user = await prisma.user.findFirst({
    where: { role, active: true, mustChangePassword: false },
    orderBy: { id: "asc" },
    select: { id: true, tokenVersion: true, passwordExpiresAt: true },
  });
  assert.ok(user, `the dev database needs an active ${role} login`);
  assert.ok(
    user!.passwordExpiresAt === null || user!.passwordExpiresAt.getTime() > Date.now(),
    `${role} credential must not be expired`
  );
  return { token: signToken({ id: user!.id, tokenVersion: user!.tokenVersion }), id: user!.id };
}

/** A raw probe: status + bytes + parsed JSON (binary downloads need the bytes, not JSON). */
async function probe(
  base: string,
  path: string,
  token?: string
): Promise<{ status: number; buffer: Buffer; json: unknown }> {
  const res = await fetch(base + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  const buffer = Buffer.from(await res.arrayBuffer());
  let json: unknown = null;
  if ((res.headers.get("content-type") ?? "").includes("application/json")) {
    try {
      json = JSON.parse(buffer.toString("utf8"));
    } catch {
      json = null;
    }
  }
  return { status: res.status, buffer, json };
}

/** Every non-null cell of a sheet, flattened, for substring assertions. */
function sheetTextAll(sheet: ExcelJS.Worksheet): string {
  const parts: string[] = [];
  sheet.eachRow((row) =>
    row.eachCell((cell) => {
      if (cell.value !== null && cell.value !== undefined) parts.push(String(cell.value));
    })
  );
  return parts.join(" | ");
}

const SCOPE_EMAILS = {
  coo: "hod-scope-coo@workforce.local",
  hod: "hod-scope-hod@workforce.local",
  deptHead: "hod-scope-depthead@workforce.local",
};

/**
 * (e) REAL HTTP through the mounted router, on the JSON route AND both downloads.
 *
 * The classic leak this catches: a screen scoped correctly while the export is not. The single
 * router-level `requireRoles` covers all three routes, so the gate and the scope cannot diverge.
 */
test("GET /api/reports/portfolio, .xlsx and .pdf: HOD/DEPT_HEAD/PM/ADMIN/COO are 200 and scoped, SUPERVISOR/EMPLOYEE are 403", async (t) => {
  const fx = await createScopeFixture("http");
  const app = express();
  app.use(express.json());
  app.use("/api/reports", reportsRouter); // same mount shape as src/index.ts
  const server = await listen(app);

  await prisma.user.deleteMany({ where: { email: { in: Object.values(SCOPE_EMAILS) } } });
  const makeUser = (email: string, role: string, departmentId: number | null) =>
    prisma.user.create({
      data: { email, passwordHash: "test-fixture", name: `${role} scope test`, role, active: true, departmentId },
      select: { id: true, tokenVersion: true },
    });
  const hod = await makeUser(SCOPE_EMAILS.hod, "HOD", fx.deptA);
  const deptHead = await makeUser(SCOPE_EMAILS.deptHead, "DEPT_HEAD", fx.deptA);
  const coo = await makeUser(SCOPE_EMAILS.coo, "COO", null);

  t.after(async () => {
    await prisma.user.deleteMany({ where: { email: { in: Object.values(SCOPE_EMAILS) } } });
    await fx.cleanup();
    await server.close();
  });

  const tokenFor = (user: { id: number; tokenVersion: number }) => signToken({ id: user.id, tokenVersion: user.tokenVersion });
  const pm = await liveToken("PM");
  const admin = await liveToken("ADMIN");
  const supervisor = await liveToken("SUPERVISOR");
  const employee = await liveToken("EMPLOYEE");
  const hodToken = tokenFor(hod);

  const allowed: Array<[string, string]> = [
    ["HOD", hodToken],
    ["DEPT_HEAD", tokenFor(deptHead)],
    ["PM", pm.token],
    ["ADMIN", admin.token],
    ["COO", tokenFor(coo)],
  ];
  const denied: Array<[string, string]> = [
    ["SUPERVISOR", supervisor.token],
    ["EMPLOYEE", employee.token],
  ];

  for (const path of ["/api/reports/portfolio", "/api/reports/portfolio.xlsx", "/api/reports/portfolio.pdf"]) {
    for (const [label, token] of allowed) {
      const res = await probe(server.base, path, token);
      assert.equal(res.status, 200, `${label} must reach ${path} (got ${res.status})`);
    }
    for (const [label, token] of denied) {
      const res = await probe(server.base, path, token);
      assert.equal(res.status, 403, `${label} must be refused ${path} (got ${res.status})`);
    }
  }

  // The HOD's JSON screen states the scope ACTUALLY applied.
  const scoped = await probe(server.base, "/api/reports/portfolio", hodToken);
  const scopedJson = scoped.json as { jobWork: Array<{ id: number }>; provenance: { scope: unknown } };
  assert.deepEqual(
    scopedJson.provenance.scope,
    { kind: "DEPARTMENT", departmentId: fx.deptA, description: `Department ${fx.deptA} (whole department)` },
    "the HOD's report names its own department as the applied scope"
  );
  assert.deepEqual(sortedIds(scopedJson.jobWork), [fx.jobOrderIds.a1, fx.jobOrderIds.a2].sort((a, b) => a - b), "the HOD's screen is his department only");

  // A request for ANOTHER department is still a 200 (the gate is satisfied) but yields ZERO rows,
  // and the provenance still names his OWN department — the request was intersected away.
  const foreign = await probe(server.base, `/api/reports/portfolio?departmentIds=${fx.deptB}`, hodToken);
  assert.equal(foreign.status, 200);
  const foreignJson = foreign.json as { jobWork: Array<{ id: number }>; provenance: { scope: { departmentId: number | null } } };
  assert.equal(foreignJson.jobWork.length, 0, "the foreign department request returned ZERO rows");
  assert.equal(foreignJson.provenance.scope.departmentId, fx.deptA, "the applied scope is still the HOD's own department");
});

/**
 * (f) EXPORT PARITY — the download cannot leak what the screen hides.
 *
 * The XLSX is built from the SAME scoped report the JSON returns, so a HOD's workbook must carry
 * exactly his scoped row count — and none of the foreign department's rows.
 */
test("export parity: the HOD's XLSX Job work row count EQUALS his scoped JSON row count", async (t) => {
  const fx = await createScopeFixture("parity");
  const app = express();
  app.use(express.json());
  app.use("/api/reports", reportsRouter);
  const server = await listen(app);

  const email = "hod-scope-parity@workforce.local";
  await prisma.user.deleteMany({ where: { email } });
  const hod = await prisma.user.create({
    data: { email, passwordHash: "test-fixture", name: "HOD parity", role: "HOD", active: true, departmentId: fx.deptA },
    select: { id: true, tokenVersion: true },
  });
  t.after(async () => {
    await prisma.user.deleteMany({ where: { email } });
    await fx.cleanup();
    await server.close();
  });
  const token = signToken({ id: hod.id, tokenVersion: hod.tokenVersion });

  const jsonRes = await probe(server.base, "/api/reports/portfolio", token);
  const jsonBody = jsonRes.json as { jobWork: Array<{ id: number }> };
  assert.deepEqual(
    sortedIds(jsonBody.jobWork),
    [fx.jobOrderIds.a1, fx.jobOrderIds.a2].sort((a, b) => a - b),
    "the HOD's screen is his department only"
  );

  const xlsxRes = await probe(server.base, "/api/reports/portfolio.xlsx", token);
  assert.equal(xlsxRes.status, 200);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(xlsxRes.buffer as unknown as ExcelJS.Buffer);
  const jobWorkSheet = workbook.getWorksheet("Job work");
  assert.ok(jobWorkSheet, "the workbook has a Job work sheet");
  // rowCount includes the header row; no subtotal rows are appended, so this is a true parity check.
  assert.equal(jobWorkSheet!.rowCount - 1, jsonBody.jobWork.length, "the download cannot drop or ADD a job order");
  assert.ok(!sheetTextAll(jobWorkSheet!).includes("SCOPE-B1-"), "no foreign-department job order appears anywhere in the workbook");
});

