/**
 * The review ledger's rules: what is overdue, what carries forward, and what a review's own pack must
 * show. All pure, because these are the rules a reviewer will argue with at 19:00 on a Friday.
 *
 * D7 — OVERDUE IS DERIVED, NEVER STORED. `status` is only OPEN / DONE / CANCELLED; an item is overdue when
 * `dueOn` is before today and it is still open. Nothing rewrites rows overnight, so a frozen snapshot can
 * never contradict an item's own history. "Before today" is by DAY, not by instant: an action due today is
 * due today, not late.
 *
 * D8 — CARRY-FORWARD IS A COPY CHAIN. Closing period N and opening N+1 copies each still-open item into the
 * new session and links both sides. Moving the row instead would erase it from period N's pack — the pack
 * that was shown in the meeting that decided it.
 */

export type ReviewItemStatus = "OPEN" | "DONE" | "CANCELLED";
export type ReviewItemKind = "DECISION" | "ACTION" | "NOTE";

/** The part of a review item these rules need. */
export type ReviewItemLike = {
  id: number;
  kind: ReviewItemKind | string;
  status: ReviewItemStatus | string;
  dueOn: Date | null;
  carriedFromId: number | null;
  carriedToId: number | null;
  carryCount: number;
  ownerUserId: number | null;
  ownerEmail: string | null;
  ownerName: string | null;
  projectWbsId: number | null;
  jobOrderId: number | null;
  body: string;
  closedAt?: Date | null;
};

const DAY_MS = 86_400_000;

/** Midnight of the day `value` falls on, in UTC — the yard's day boundary for a due date. */
function startOfDay(value: Date): number {
  return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
}

/** Due yesterday = overdue. Due today = not overdue until tomorrow. */
export function isOverdue(item: Pick<ReviewItemLike, "status" | "dueOn">, today: Date): boolean {
  if (item.status !== "OPEN" || !item.dueOn) return false;
  return startOfDay(item.dueOn) < startOfDay(today);
}

/** Days late, or 0 when not late. Never negative, so a caller can print it without guarding. */
export function daysOverdue(item: Pick<ReviewItemLike, "status" | "dueOn">, today: Date): number {
  if (!isOverdue(item, today)) return 0;
  return Math.floor((startOfDay(today) - startOfDay(item.dueOn as Date)) / DAY_MS);
}

/** Open and not yet carried into a later review: the register of live work. */
export function carryableItems(items: readonly ReviewItemLike[]): ReviewItemLike[] {
  return items.filter((item) => item.status === "OPEN" && item.carriedToId === null);
}

export type CarryPlan = {
  /** Items to copy into the new session, in a deterministic order. */
  copies: Array<{
    sourceId: number;
    kind: string;
    body: string;
    ownerUserId: number | null;
    ownerEmail: string | null;
    ownerName: string | null;
    dueOn: Date | null;
    projectWbsId: number | null;
    jobOrderId: number | null;
    carriedFromId: number;
    carryCount: number;
  }>;
  /** Items that stay behind, with the reason a reader can check. */
  skipped: Array<{ id: number; reason: "DONE" | "CANCELLED" | "ALREADY_CARRIED" | "DECISION_IS_MINUTES" }>;
};

/**
 * What carrying into a new session would copy. Idempotent by construction: an item that already has a
 * `carriedTo` is never copied twice, so re-running the step (or re-opening a review) cannot duplicate the
 * register.
 */
export function carryForwardPlan(previous: readonly ReviewItemLike[]): CarryPlan {
  const plan: CarryPlan = { copies: [], skipped: [] };
  const ordered = [...previous].sort((a, b) => a.id - b.id);
  for (const item of ordered) {
    if (item.carriedToId !== null) {
      plan.skipped.push({ id: item.id, reason: "ALREADY_CARRIED" });
      continue;
    }
    if (item.status === "DONE") {
      plan.skipped.push({ id: item.id, reason: "DONE" });
      continue;
    }
    if (item.status === "CANCELLED") {
      plan.skipped.push({ id: item.id, reason: "CANCELLED" });
      continue;
    }
    // A decision is a minute of the meeting that took it, not open work: it stays in its own review.
    if (item.kind === "DECISION") {
      plan.skipped.push({ id: item.id, reason: "DECISION_IS_MINUTES" });
      continue;
    }
    plan.copies.push({
      sourceId: item.id,
      kind: item.kind,
      body: item.body,
      ownerUserId: item.ownerUserId,
      ownerEmail: item.ownerEmail,
      ownerName: item.ownerName,
      dueOn: item.dueOn,
      projectWbsId: item.projectWbsId,
      jobOrderId: item.jobOrderId,
      carriedFromId: item.id,
      carryCount: item.carryCount + 1,
    });
  }
  return plan;
}

export type ActionCounts = {
  open: number;
  overdue: number;
  done: number;
  cancelled: number;
  /** Carried two or more times and still open — the zombie check. */
  carriedTwiceOrMore: number;
  /** Open items whose owner has no e-mail on record: nothing can chase them. */
  unowned: number;
};

export function actionCounts(items: readonly ReviewItemLike[], today: Date): ActionCounts {
  const actions = items.filter((item) => item.kind === "ACTION");
  return {
    open: actions.filter((item) => item.status === "OPEN").length,
    overdue: actions.filter((item) => isOverdue(item, today)).length,
    done: actions.filter((item) => item.status === "DONE").length,
    cancelled: actions.filter((item) => item.status === "CANCELLED").length,
    carriedTwiceOrMore: actions.filter((item) => item.status === "OPEN" && item.carryCount >= 2).length,
    unowned: actions.filter((item) => item.status === "OPEN" && !item.ownerEmail).length,
  };
}

/** The close dialog's sentence: closing with open work is normal, closing without saying so is not. */
export function closeWarning(items: readonly ReviewItemLike[]): string {
  const open = items.filter((item) => item.kind === "ACTION" && item.status === "OPEN").length;
  if (!open) return "No open actions carry to the next review.";
  return `${open} open action(s) will carry to the next review.`;
}
