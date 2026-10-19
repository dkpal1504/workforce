/**
 * Which Projects an account may read.
 *
 * ONE implementation of the question "what is this actor's project scope?", used by the report
 * loader AND by the master pickers. Two copies would let the dashboard clamp a manager to his
 * projects while the Project dropdown beside it still listed every project in the organisation —
 * the report would be contained and the SCREEN would still disclose the portfolio's structure.
 *
 * THE ROLE GATE IS THE POINT. Only PROJECT_MANAGER is narrowed by assignment. Every other role gets
 * `null` ("no project narrowing") with NO QUERY AT ALL, so an assignment row accidentally attached
 * to an Admin or an HOD is inert: it can neither narrow that role's report nor widen it. That is
 * why this is a pure predicate (`scopesProjectsByAssignment`) plus one query, not a filter applied
 * to whatever rows happen to exist.
 */

import { prisma } from "../db";

export type ProjectScopeActor = {
  id: number;
  role: string;
  departmentId?: number | null;
};

/**
 * Is this role's project scope decided by its assignments?
 *
 * PURE and exported so the gate is tested without a database: the whole security property is that
 * this returns true for ONE role, and a future edit that widened it (e.g. to "any role with an
 * assignment") would be a silent scope change on every screen built on the report.
 */
export function scopesProjectsByAssignment(role: string): boolean {
  return role === "PROJECT_MANAGER";
}

/**
 * The projects this actor MANAGES, or `null` when its role is not project-scoped.
 *
 * `null` and `[]` are different answers and the difference is load-bearing:
 *   null — this actor's report is not narrowed by project (PM/ADMIN/COO/HOD/DEPT_HEAD/…).
 *   []   — this actor IS project-scoped and manages nothing: the report must read NOTHING.
 *
 * The caller passes the result to `reportScopeFor`, which turns `[]` into the fail-closed NONE
 * scope. Returning `null` there instead would silently promote an unassigned manager to the whole
 * organisation, which is the exact leak the scope type exists to prevent.
 */
export async function assignedProjectIdsFor(actor: ProjectScopeActor): Promise<number[] | null> {
  if (!scopesProjectsByAssignment(actor.role)) return null;
  const rows = await prisma.projectManagerAssignment.findMany({
    where: { userId: actor.id, status: "active" },
    select: { projectId: true },
    orderBy: { projectId: "asc" },
  });
  return [...new Set(rows.map((row) => row.projectId))];
}

/**
 * The Prisma predicate that narrows a Project/WBS/Network picker to the actor's scope.
 *
 *   null -> `{}`            no narrowing (every other role, unchanged behaviour)
 *   []   -> `{ id: { in: [] } }`  matches NOTHING. Prisma treats an empty `in` as no match, which
 *            is the fail-closed shape: a project-scoped actor with no assignment must not be shown
 *            the whole portfolio in a dropdown. An `{}` here would be EVERY row.
 */
export function projectPickerWhere(projectIds: readonly number[] | null): { id?: { in: number[] } } {
  if (projectIds === null) return {};
  return { id: { in: [...projectIds] } };
}
