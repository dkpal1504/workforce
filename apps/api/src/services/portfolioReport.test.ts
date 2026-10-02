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
import { prisma } from "../db";
import { signToken } from "../middleware/auth";
import { reportsRouter } from "../routes/reports";
import { buildJobOrderFacts, type JobOrderFacts } from "./portfolioReporting";
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

  // The three Department-scoped / non-portfolio roles are refused.
  for (const role of ["SUPERVISOR", "EMPLOYEE", "HOD"] as const) {
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
