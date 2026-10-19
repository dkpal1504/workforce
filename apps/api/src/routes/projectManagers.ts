/**
 * Project Managers — assign an ACCOUNT to the Projects it manages.
 *
 * Admin-only, and deliberately narrow: this endpoint grants a READ SCOPE over work, so it is an
 * administrative act. It does NOT give anyone the PROJECT_MANAGER role (that is Role Assignment's
 * job); it binds an account that ALREADY holds the role to one or more projects. The refusal in
 * `planAssignment` says exactly that, because an assignment on an HOD or an Admin would be a row
 * that reads as access and grants none — `reportScopeFor` consults assignments for one role only.
 *
 * ROWS ARE NEVER DELETED. `DELETE` revokes (status + revokedAt) so the history stays answerable, and
 * re-assigning the same pair REUSES the row. The unique pair is the history line.
 *
 * NO `tokenVersion` BUMP. The scope is read from the database per request, so editing an assignment
 * takes effect on the next fetch; bumping would log a manager out of a screen they are reading while
 * an Admin tidies the panel.
 */

import { Router } from "express";
import { prisma } from "../db";
import { requireAuth, requireRoles } from "../middleware/auth";
import { writeAudit } from "../audit";
import { planAssignment, planRevocation } from "../services/projectManagerAssignment";

export const projectManagersRouter = Router();

projectManagersRouter.use(requireAuth, requireRoles("ADMIN"));

/** A login identifier that actually signs in: the EC No for an employee-linked account, else e-mail. */
function loginOf(account: { email: string; employee: { ecNo: string } | null }): string {
  return account.employee?.ecNo ?? account.email;
}

/**
 * GET /api/admin/project-managers — every project with its managers, plus the accounts eligible to
 * be assigned.
 *
 * A project with NO manager is listed with an empty `managers` array, never omitted: "nobody owns
 * this project" is the fact the panel exists to surface.
 */
projectManagersRouter.get("/", async (_req, res) => {
  const [projects, assignments, roleAccounts] = await Promise.all([
    prisma.project.findMany({
      orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
      select: { id: true, code: true, name: true, active: true, isNonProject: true },
    }),
    prisma.projectManagerAssignment.findMany({
      orderBy: [{ status: "asc" }, { assignedAt: "desc" }],
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
            active: true,
            employee: { select: { ecNo: true } },
          },
        },
        assignedBy: { select: { id: true, name: true } },
      },
    }),
    prisma.user.findMany({
      where: { role: "PROJECT_MANAGER" },
      orderBy: { name: "asc" },
      select: { id: true, name: true, email: true, active: true, employee: { select: { ecNo: true } } },
    }),
  ]);

  res.json({
    projects: projects.map((project) => ({
      ...project,
      managers: assignments
        .filter((assignment) => assignment.projectId === project.id)
        .map((assignment) => ({
          assignmentId: assignment.id,
          userId: assignment.user.id,
          name: assignment.user.name,
          login: loginOf(assignment.user),
          accountActive: assignment.user.active,
          status: assignment.status,
          assignedAt: assignment.assignedAt,
          assignedBy: assignment.assignedBy?.name ?? null,
          revokedAt: assignment.revokedAt,
          note: assignment.note,
        })),
    })),
    assignments: assignments.map((assignment) => ({
      id: assignment.id,
      projectId: assignment.projectId,
      userId: assignment.user.id,
      userName: assignment.user.name,
      login: loginOf(assignment.user),
      status: assignment.status,
      assignedAt: assignment.assignedAt,
      assignedBy: assignment.assignedBy?.name ?? null,
      revokedAt: assignment.revokedAt,
      note: assignment.note,
    })),
    // The picker. Empty is a REAL answer the panel must state ("no account holds the Project
    // Manager role yet — assign it on Role Assignment"), never a silently missing control.
    eligibleUsers: roleAccounts.map((account) => ({
      id: account.id,
      name: account.name,
      login: loginOf(account),
      active: account.active,
    })),
  });
});

/** POST /api/admin/project-managers — bind (or re-activate) one account to one project. */
projectManagersRouter.post("/", async (req, res) => {
  const projectId = Number(req.body?.projectId);
  const userId = Number(req.body?.userId);
  const note = typeof req.body?.note === "string" && req.body.note.trim() !== "" ? req.body.note.trim() : null;
  if (!Number.isInteger(projectId) || !Number.isInteger(userId)) {
    return res.status(400).json({
      error: "projectId and userId are required integers.",
      code: "INVALID_ASSIGNMENT_REQUEST",
    });
  }

  const [project, user, existing] = await Promise.all([
    prisma.project.findUnique({ where: { id: projectId }, select: { id: true, code: true, name: true, active: true } }),
    prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, role: true, active: true, employee: { select: { ecNo: true } } },
    }),
    prisma.projectManagerAssignment.findUnique({
      where: { projectId_userId: { projectId, userId } },
      select: { id: true, status: true },
    }),
  ]);

  const plan = planAssignment({ project, user, existing });
  if (!plan.ok) {
    // 409 only for a STATE CONFLICT (an active or revoked row already exists); a rejected request
    // is a 400. The same distinction the role-assignment work established.
    const conflict = plan.code === "ALREADY_ASSIGNED";
    return res.status(conflict ? 409 : 400).json({ error: plan.error, code: plan.code });
  }

  const now = new Date();
  const row = plan.action === "create"
    ? await prisma.projectManagerAssignment.create({
        data: { projectId, userId, status: "active", assignedById: req.user!.id, note },
        select: { id: true },
      })
    : await prisma.projectManagerAssignment.update({
        // REUSE the row: the unique pair is the history line, and a second row for the same pair
        // would make "who managed this project" ambiguous (the constraint would refuse it anyway).
        where: { id: existing!.id },
        data: { status: "active", revokedAt: null, assignedById: req.user!.id, assignedAt: now, note },
        select: { id: true },
      });

  await writeAudit(req.user!.id, "PROJECT_MANAGER_ASSIGN", "project_manager_assignment", String(row.id), {
    action: plan.action,
    projectId,
    projectCode: project!.code,
    userId,
    userName: user!.name,
  });

  return res.status(plan.action === "create" ? 201 : 200).json({
    assignment: { id: row.id, projectId, userId, status: "active" },
    action: plan.action,
  });
});

/** DELETE /api/admin/project-managers/:id — revoke. The row stays, the history stays. */
projectManagersRouter.delete("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "A numeric assignment id is required.", code: "INVALID_ASSIGNMENT_ID" });
  }

  const existing = await prisma.projectManagerAssignment.findUnique({
    where: { id },
    select: { id: true, status: true, projectId: true, userId: true },
  });
  const plan = planRevocation(existing);
  if (!plan.ok) {
    return res.status(plan.code === "ALREADY_REVOKED" ? 409 : 404).json({ error: plan.error, code: plan.code });
  }

  const revoked = await prisma.projectManagerAssignment.update({
    where: { id },
    data: { status: "revoked", revokedAt: new Date() },
    select: { id: true, projectId: true, userId: true, revokedAt: true },
  });

  await writeAudit(req.user!.id, "PROJECT_MANAGER_REVOKE", "project_manager_assignment", String(id), {
    projectId: revoked.projectId,
    userId: revoked.userId,
    revokedAt: revoked.revokedAt?.toISOString() ?? null,
  });

  return res.json({ assignment: revoked, action: "revoked" });
});
