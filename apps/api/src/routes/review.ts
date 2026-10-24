import { Request, Response, Router } from "express";
import { requireAuth, requireRoles } from "../middleware/auth";
import { prisma } from "../db";
import { captureReviewSnapshot, loadSnapshot, SnapshotCorrupt, SnapshotMissing } from "../services/reviewSnapshot";
import {
  ReviewNotFound,
  loadJobOrderCurve,
  loadReviewDashboard,
  loadReviewProjects,
  resolveWindow,
  windowDays,
  type ReviewActor,
} from "../services/reviewData";

export const reviewRouter = Router();

/**
 * WHO may see the review, and who may RUN one.
 *
 * VIEW: PM, ADMIN, COO read every project; an HOD or Department Head reads its OWN department's Job Orders
 * inside a project; a Project Manager reads the projects assigned to them. The gate is only the door — the
 * SCOPE is resolved server-side in `resolveReviewScope` by `reportScopeFor`, and it is enforced per query.
 *
 * RUN: opening and closing a review is the PM team's and the COO's call. An HOD may read the numbers and
 * record an action against their own department's work later, but holding the meeting is not their
 * capability, and a Project Manager views rather than runs until the owner says otherwise.
 */
const REVIEW_VIEW_ROLES = ["PM", "ADMIN", "COO", "HOD", "DEPT_HEAD", "PROJECT_MANAGER"] as const;
export const REVIEW_RUN_ROLES = ["PM", "ADMIN", "COO"] as const;

function actorOf(request: Request): ReviewActor {
  const user = request.user as { id: number; name: string; role: string; departmentId?: number | null };
  return {
    id: user.id,
    name: user.name,
    role: user.role,
    departmentId: user.departmentId ?? null,
  };
}

/** Running a review (freezing it) is not the same door as reading one. */
function requireRunRole(request: Request, response: Response): boolean {
  const role = (request.user as { role?: string } | undefined)?.role ?? "";
  if (!(REVIEW_RUN_ROLES as readonly string[]).includes(role)) {
    response.status(403).json({ error: "FORBIDDEN", code: "REVIEW_RUN_REQUIRED" });
    return false;
  }
  return true;
}

function fail(response: Response, error: unknown): void {
  if (error instanceof SnapshotMissing) {
    response.status(404).json({ error: "SNAPSHOT_NOT_FOUND" });
    return;
  }
  if (error instanceof SnapshotCorrupt) {
    // A stored payload that no longer matches its hash was edited outside this application. Rendering it
    // would publish numbers nobody can vouch for, which is the one thing a frozen pack exists to prevent.
    response.status(500).json({ error: "SNAPSHOT_CORRUPT" });
    return;
  }
  if (error instanceof ReviewNotFound) {
    const code = error.message;
    // BAD_PERIOD is the caller's fault; an out-of-scope project id is reported as absent, because an id
    // the actor cannot see does not exist for them.
    const status = code === "BAD_PERIOD" ? 400 : 404;
    response.status(status).json({ error: code });
    return;
  }
  console.error("[review]", error);
  response.status(500).json({ error: "REVIEW_FAILED" });
}

reviewRouter.use(requireAuth);
reviewRouter.use(requireRoles(...REVIEW_VIEW_ROLES));

/**
 * The Review home list. `scope` travels with it so the screen can print why it sees what it sees — an HOD
 * reading one department should never wonder whether the list is empty because of the data or the role.
 */
reviewRouter.get("/projects", async (request: Request, response: Response) => {
  try {
    const result = await loadReviewProjects(actorOf(request));
    response.json(result);
  } catch (error) {
    fail(response, error);
  }
});

reviewRouter.get("/projects/:id/dashboard", async (request: Request, response: Response) => {
  try {
    const projectId = Number(request.params.id);
    if (!Number.isInteger(projectId) || projectId <= 0) throw new ReviewNotFound();
    // Last month is the default review window (owner's instruction); `kind=weekly` asks for 12 weeks instead.
    const kind = String(request.query.kind ?? "MONTHLY").toUpperCase() === "WEEKLY" ? "WEEKLY" : "MONTHLY";
    const period = {
      kind: kind as "WEEKLY" | "MONTHLY",
      start: typeof request.query.from === "string" ? request.query.from : undefined,
      end: typeof request.query.to === "string" ? request.query.to : undefined,
      granularity: (request.query.granularity === "day" ? "day" : "week") as "day" | "week",
    };
    const dashboard = await loadReviewDashboard({ projectId, actor: actorOf(request), period });
    const window = resolveWindow(period, new Date());
    // The day list travels with the payload so the screen can print the period it actually divided by,
    // the same provenance habit the Reports tabs follow.
    response.json({
      ...dashboard.payload,
      scope: dashboard.scope,
      window: { ...window, days: windowDays(window) },
    });
  } catch (error) {
    fail(response, error);
  }
});

/**
 * Freeze this project's review for a period. Re-capturing appends a revision; a provisional snapshot (the
 * period has not ended) is REPLACED instead, because a running week is not history yet.
 */
reviewRouter.post("/projects/:id/snapshots", async (request: Request, response: Response) => {
  try {
    if (!requireRunRole(request, response)) return;
    const projectId = Number(request.params.id);
    if (!Number.isInteger(projectId) || projectId <= 0) throw new ReviewNotFound();
    const body = (request.body ?? {}) as { kind?: string; from?: string; to?: string; force?: boolean };
    const kind = String(body.kind ?? "MONTHLY").toUpperCase() === "WEEKLY" ? "WEEKLY" : "MONTHLY";
    const result = await captureReviewSnapshot({
      projectId,
      actor: actorOf(request),
      period: { kind: kind as "WEEKLY" | "MONTHLY", start: body.from, end: body.to },
      trigger: "ON_DEMAND",
      force: body.force === true,
    });
    response.status(result.created ? 201 : 200).json(result);
  } catch (error) {
    fail(response, error);
  }
});

/** The frozen history list: summary columns only, newest revision of each period first. */
reviewRouter.get("/projects/:id/snapshots", async (request: Request, response: Response) => {
  try {
    const projectId = Number(request.params.id);
    if (!Number.isInteger(projectId) || projectId <= 0) throw new ReviewNotFound();
    const projects = await loadReviewProjects(actorOf(request));
    if (!projects.projects.some((project) => project.id === projectId)) throw new ReviewNotFound();
    const limit = Math.min(200, Math.max(1, Number(request.query.limit ?? 50) || 50));
    const rows = await prisma.reportSnapshot.findMany({
      where: { projectId },
      select: {
        id: true,
        kind: true,
        periodFrom: true,
        periodTo: true,
        revision: true,
        provisional: true,
        captureTrigger: true,
        frozenAt: true,
        payloadBytes: true,
        contentHash: true,
        jobOrders: true,
        budgetHours: true,
        actualHours: true,
        burnPct: true,
        delayedCount: true,
        openEscalations: true,
        actionsOpen: true,
        actionsOverdue: true,
        headcountPeak: true,
      },
      orderBy: [{ periodTo: "desc" }, { revision: "desc" }],
      take: limit,
    });
    response.json({
      projectId,
      snapshots: rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        periodFrom: row.periodFrom.toISOString().slice(0, 10),
        periodTo: row.periodTo.toISOString().slice(0, 10),
        revision: row.revision,
        provisional: row.provisional,
        trigger: row.captureTrigger,
        capturedAt: row.frozenAt.toISOString(),
        payloadBytes: row.payloadBytes,
        contentHash: row.contentHash,
        jobOrders: row.jobOrders,
        budgetHours: row.budgetHours,
        actualHours: row.actualHours,
        burnPct: row.burnPct,
        delayed: row.delayedCount,
        openEscalations: row.openEscalations,
        actionsOpen: row.actionsOpen,
        actionsOverdue: row.actionsOverdue,
        headcountPeak: row.headcountPeak,
      })),
    });
  } catch (error) {
    fail(response, error);
  }
});

/**
 * The frozen payload itself. One query, on report_snapshot only: if this path ever touched a live table, the
 * freeze would be a promise rather than a fact.
 */
reviewRouter.get("/snapshots/:id", async (request: Request, response: Response) => {
  try {
    const snapshotId = Number(request.params.id);
    if (!Number.isInteger(snapshotId) || snapshotId <= 0) throw new SnapshotMissing();
    const frozen = await loadSnapshot(snapshotId);
    // Scope: a snapshot of a project this account cannot review does not exist for them.
    if (frozen.snapshot.projectId !== null) {
      const projects = await loadReviewProjects(actorOf(request));
      if (!projects.projects.some((project) => project.id === frozen.snapshot.projectId)) {
        throw new SnapshotMissing();
      }
    }
    response.json({ ...frozen.payload, frozenSnapshot: frozen.snapshot });
  } catch (error) {
    fail(response, error);
  }
});

/**
 * One curve at one level: the project, a WBS node, or a single Job Order.
 *
 * The project and WBS levels travel with the dashboard payload, because a WBS list is small and bounded. A
 * Job Order level cannot: a project may hold four hundred of them, and shipping four hundred curves to draw
 * one would make the screen slow to answer a question nobody asked. So this endpoint exists for the third
 * kind, and it enforces the same scope as the dashboard — an HOD may not plot another department's Job
 * Order curve just because they guessed its id.
 */
reviewRouter.get("/projects/:id/curve", async (request: Request, response: Response) => {
  try {
    const projectId = Number(request.params.id);
    if (!Number.isInteger(projectId) || projectId <= 0) throw new ReviewNotFound();
    const jobOrderId = Number(request.query.jobOrderId);
    if (!Number.isInteger(jobOrderId) || jobOrderId <= 0) throw new ReviewNotFound("BAD_PERIOD");
    const kind = String(request.query.kind ?? "MONTHLY").toUpperCase() === "WEEKLY" ? "WEEKLY" : "MONTHLY";
    const curve = await loadJobOrderCurve({
      projectId,
      jobOrderId,
      actor: actorOf(request),
      period: {
        kind: kind as "WEEKLY" | "MONTHLY",
        start: typeof request.query.from === "string" ? request.query.from : undefined,
        end: typeof request.query.to === "string" ? request.query.to : undefined,
        granularity: request.query.granularity === "day" ? "day" : "week",
      },
    });
    response.json(curve);
  } catch (error) {
    fail(response, error);
  }
});

/**
 * Snapshot history, summary columns only — no payload is parsed on this path, so a project with three
 * years of weeks still answers instantly. Empty until the capture job (Phase 2) has run once.
 */
reviewRouter.get("/projects/:id/trend", async (request: Request, response: Response) => {
  try {
    const projectId = Number(request.params.id);
    if (!Number.isInteger(projectId) || projectId <= 0) throw new ReviewNotFound();
    const scope = await loadReviewProjects(actorOf(request));
    if (!scope.projects.some((project) => project.id === projectId)) throw new ReviewNotFound();

    const limit = Math.min(104, Math.max(1, Number(request.query.weeks ?? 26) || 26));
    const snapshots = await prisma.reportSnapshot.findMany({
      where: { projectId },
      select: {
        id: true,
        kind: true,
        periodFrom: true,
        periodTo: true,
        revision: true,
        provisional: true,
        captureTrigger: true,
        frozenAt: true,
        jobOrders: true,
        budgetHours: true,
        actualHours: true,
        burnPct: true,
        delayedCount: true,
        openEscalations: true,
        actionsOverdue: true,
        headcountPeak: true,
      },
      orderBy: [{ periodTo: "desc" }, { revision: "desc" }],
      take: limit,
    });

    response.json({
      projectId,
      points: snapshots
        .map((row) => ({
          id: row.id,
          kind: row.kind,
          periodFrom: row.periodFrom.toISOString().slice(0, 10),
          periodTo: row.periodTo.toISOString().slice(0, 10),
          revision: row.revision,
          provisional: row.provisional,
          trigger: row.captureTrigger,
          frozenAt: row.frozenAt.toISOString(),
          jobOrders: row.jobOrders,
          budgetHours: row.budgetHours,
          actualHours: row.actualHours,
          burnPct: row.burnPct,
          delayed: row.delayedCount,
          openEscalations: row.openEscalations,
          actionsOverdue: row.actionsOverdue,
          headcountPeak: row.headcountPeak,
        }))
        .reverse(),
    });
  } catch (error) {
    fail(response, error);
  }
});
