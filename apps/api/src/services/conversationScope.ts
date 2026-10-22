/**
 * Who may take part in a Job Order conversation.
 *
 * PURE where it can be (`maySeeJobOrder`, `mayPostKind`) and one thin database read where it must be
 * (`conversationScopeFor`). The scope vocabulary is deliberately the SAME as the report's — an
 * assigned Project Manager reads his projects, an HOD reads his department + section set, COO/PM/
 * ADMIN read everything — so a conversation can never show a Job Order the reader could not already
 * open in the register.
 *
 * FAIL CLOSED: an unmapped head, an unassigned Project Manager and every other role resolve to NONE
 * and see no thread at all.
 */

import { prisma } from "../db";
import { isDepartmentViewRole } from "./roleAccess";
import { assignedProjectIdsFor } from "./projectScope";

export type ConversationScope =
  | { kind: "ORGANISATION" }
  | { kind: "PROJECTS"; projectIds: number[] }
  | { kind: "DEPARTMENT"; departmentId: number; sectionIds: number[] }
  | { kind: "NONE" };

export type ConversationActor = {
  id: number;
  role: string;
  departmentId: number | null;
  /** The Sections this account may act within; EMPTY means every Section of its Department. */
  sectionScope: number[];
  /** The legacy single-Section mirror, which is all a pre-conversion account carries. */
  sectionId: number | null;
};

/** The roles admitted to the feature at all (the router list and the web capability use this). */
export const CONVERSATION_ROLES = [
  "PROJECT_MANAGER",
  "PM",
  "HOD",
  "DEPT_HEAD",
  "COO",
  "ADMIN",
] as const;

export function isConversationRole(role: string): boolean {
  return (CONVERSATION_ROLES as readonly string[]).includes(role);
}

/**
 * The actor's conversation scope.
 *
 * Mirrors `reportScopeFor`, with one addition: an HOD is narrowed to its SECTION SET here (the
 * report deliberately widens a Section Head to the whole Department, but a conversation names real
 * people, so the narrower of the two rules is the right one).
 */
export async function conversationScopeFor(actor: ConversationActor): Promise<ConversationScope> {
  if (actor.role === "PM" || actor.role === "ADMIN" || actor.role === "COO") {
    return { kind: "ORGANISATION" };
  }
  if (actor.role === "PROJECT_MANAGER") {
    const projectIds = await assignedProjectIdsFor(actor);
    return projectIds && projectIds.length ? { kind: "PROJECTS", projectIds } : { kind: "NONE" };
  }
  if (isDepartmentViewRole(actor.role)) {
    if (actor.departmentId == null) return { kind: "NONE" };
    // An EMPTY set with a NON-NULL mirror is SECTIONAL on that mirror, not department-wide.
    const sectionIds = actor.sectionScope.length
      ? [...actor.sectionScope]
      : actor.sectionId != null
        ? [actor.sectionId]
        : [];
    return { kind: "DEPARTMENT", departmentId: actor.departmentId, sectionIds };
  }
  return { kind: "NONE" };
}

export type JobOrderScopeFields = {
  projectId: number;
  departmentId: number;
  sectionId: number | null;
};

/**
 * May this scope see this Job Order?
 *
 * The section test mirrors `hodScopeMatchesSet`: an EMPTY section set means the whole Department, and
 * a Job Order with NO section (standing / non-project work) is readable by every HOD of its
 * Department — the same rule the timesheet queues already apply to unassigned work.
 */
export function maySeeJobOrder(scope: ConversationScope, jobOrder: JobOrderScopeFields): boolean {
  switch (scope.kind) {
    case "ORGANISATION":
      return true;
    case "PROJECTS":
      return scope.projectIds.includes(jobOrder.projectId);
    case "DEPARTMENT":
      if (scope.departmentId !== jobOrder.departmentId) return false;
      if (scope.sectionIds.length === 0) return true;
      return jobOrder.sectionId == null || scope.sectionIds.includes(jobOrder.sectionId);
    default:
      return false;
  }
}

/**
 * The Prisma `where` for "Job Orders inside this scope" — the same three rules as `maySeeJobOrder`,
 * expressed once so the picker and the thread list cannot disagree. Fail-closed on NONE.
 */
export function jobOrderScopeWhere(scope: ConversationScope) {
  switch (scope.kind) {
    case "ORGANISATION":
      return {};
    case "PROJECTS":
      return { projectId: { in: scope.projectIds } };
    case "DEPARTMENT":
      return {
        departmentId: scope.departmentId,
        ...(scope.sectionIds.length
          ? { OR: [{ sectionId: null }, { sectionId: { in: scope.sectionIds } }] }
          : {}),
      };
    default:
      return { id: -1 };
  }
}

/**
 * Which message kinds this role may post.
 *
 * REPLY / FOLLOW_UP / INSTRUCTION / ESCALATION are communication: every admitted role may use them.
 * DECISION is different — it can carry a proposed change to the Job Order — so it is limited to the
 * roles that already hold that right in Project Master (PM and Admin). SYSTEM is never a user kind.
 */
export const USER_MESSAGE_KINDS = ["FOLLOW_UP", "INSTRUCTION", "ESCALATION", "REPLY", "DECISION", "RECOVERY"] as const;
export type UserMessageKind = (typeof USER_MESSAGE_KINDS)[number];

export function mayPostKind(role: string, kind: string): boolean {
  if (!isConversationRole(role)) return false;
  if (kind === "DECISION") return role === "PM" || role === "ADMIN";
  // A recovery is proposed by the owner (checked against ownership in the route) or by a PM. The generic
  // message route cannot see ownership, so it admits the two roles that may always speak for the work.
  if (kind === "RECOVERY") return role === "PM" || role === "PROJECT_MANAGER" || role === "ADMIN";
  return (USER_MESSAGE_KINDS as readonly string[]).includes(kind);
}

export function isUserMessageKind(kind: unknown): kind is UserMessageKind {
  return typeof kind === "string" && (USER_MESSAGE_KINDS as readonly string[]).includes(kind);
}

/**
 * The Job Order whose conversation is being read, with the fields scope is judged on.
 * Returns null when the id does not exist; scope is a separate question (`maySeeJobOrder`).
 */
export async function jobOrderScopeRow(jobOrderId: number): Promise<
  | (JobOrderScopeFields & { id: number; code: string; name: string; project: { id: number; code: string; name: string }; projectWbsId: number })
  | null
> {
  const row = await prisma.jobOrder.findUnique({
    where: { id: jobOrderId },
    select: {
      id: true,
      code: true,
      name: true,
      projectId: true,
      projectWbsId: true,
      departmentId: true,
      sectionId: true,
      project: { select: { id: true, code: true, name: true } },
    },
  });
  return row ?? null;
}

/** May this actor read/post on this Job Order? One read of the Job Order, one of the scope. */
export async function canAccessJobOrder(actor: ConversationActor, jobOrderId: number): Promise<
  | { ok: true; jobOrder: NonNullable<Awaited<ReturnType<typeof jobOrderScopeRow>>>; scope: ConversationScope }
  | { ok: false; code: "JOB_ORDER_NOT_FOUND" | "OUT_OF_SCOPE" }
> {
  const jobOrder = await jobOrderScopeRow(jobOrderId);
  if (!jobOrder) return { ok: false, code: "JOB_ORDER_NOT_FOUND" };
  const scope = await conversationScopeFor(actor);
  if (!maySeeJobOrder(scope, jobOrder)) return { ok: false, code: "OUT_OF_SCOPE" };
  return { ok: true, jobOrder, scope };
}
