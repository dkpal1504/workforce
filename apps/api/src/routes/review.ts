import { Request, Response, Router } from "express";
import { requireAuth, requireRoles } from "../middleware/auth";
import { prisma } from "../db";
import {
  ReviewNotFound,
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

function fail(response: Response, error: unknown): void {
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
    const kind = String(request.query.kind ?? "WEEKLY").toUpperCase() === "MONTHLY" ? "MONTHLY" : "WEEKLY";
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
