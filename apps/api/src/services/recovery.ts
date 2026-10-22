/**
 * Recovery offers and hindrances — the pure rules.
 *
 * PURE. A recovery is a negotiation with four states and one rule that matters: only a PM (or an
 * administrator) may accept, and accepting writes a date the application owns. A hindrance is a record
 * with two rules: who may close it, and how old it is.
 */

export type RecoveryState = "PROPOSED" | "ACCEPTED" | "REJECTED" | "SUPERSEDED";
export type RecoveryDecision = "ACCEPT" | "REJECT";

export type ManpowerLine = {
  trade: string;
  headcount: number;
  hoursPerDay: number;
  fromDate: string | null;
  toDate: string | null;
};

/** Who may propose: the owner of the work, or a PM speaking for him. Same rule as a delay cause. */
export function canProposeRecovery(input: { role: string; isOwner: boolean }): boolean {
  if (input.isOwner) return true;
  return input.role === "PM" || input.role === "PROJECT_MANAGER" || input.role === "ADMIN";
}

/** Who may decide: only the two roles that may move a plan. A proposer cannot accept his own offer. */
export const MANAGER_ROLES = ["PM", "PROJECT_MANAGER", "ADMIN"] as const;

export function canDecideRecovery(input: { role: string; proposerUserId: number | null; actorUserId: number }): boolean {
  // PROJECT_MANAGER is the role this application actually assigns to a project manager; PM is the older
  // name for the same authority. Checking only PM meant the people who run projects could not accept a
  // recovery they did not propose.
  if (!(MANAGER_ROLES as readonly string[]).includes(input.role)) return false;
  return input.proposerUserId !== input.actorUserId || input.role === "ADMIN";
}

/**
 * Is this offer still open?
 *
 * A decision on an offer that is no longer PROPOSED is refused rather than applied twice: the audit trail
 * must not contain two acceptances of one proposal.
 */
export function isOpenForDecision(state: string): boolean {
  return state === "PROPOSED";
}

export type ManpowerValidation = { ok: true; plan: ManpowerLine[] } | { ok: false; error: string };

/**
 * Validate a manpower plan.
 *
 * Eight rows, four fields each, is what a section head will actually type. Anything larger is a
 * spreadsheet, and a spreadsheet pasted into a JSON column is a data-entry exercise that will be wrong.
 */
export function validateManpowerPlan(input: unknown): ManpowerValidation {
  if (input == null) return { ok: true, plan: [] };
  if (!Array.isArray(input)) return { ok: false, error: "A manpower plan must be a list of lines." };
  if (input.length > 8) return { ok: false, error: "Keep the manpower plan to eight lines or fewer." };

  const plan: ManpowerLine[] = [];
  for (const [index, raw] of input.entries()) {
    const row = raw as Record<string, unknown>;
    const trade = typeof row?.trade === "string" ? row.trade.trim() : "";
    const headcount = Number(row?.headcount);
    const hoursPerDay = Number(row?.hoursPerDay ?? 8);
    if (!trade) return { ok: false, error: `Line ${index + 1}: name the trade.` };
    if (!Number.isFinite(headcount) || headcount <= 0 || headcount > 500) {
      return { ok: false, error: `Line ${index + 1}: headcount must be between 1 and 500.` };
    }
    if (!Number.isFinite(hoursPerDay) || hoursPerDay <= 0 || hoursPerDay > 24) {
      return { ok: false, error: `Line ${index + 1}: hours per day must be between 1 and 24.` };
    }
    plan.push({
      trade: trade.slice(0, 60),
      headcount: Math.round(headcount),
      hoursPerDay: Math.round(hoursPerDay * 10) / 10,
      fromDate: typeof row?.fromDate === "string" && row.fromDate ? row.fromDate : null,
      toDate: typeof row?.toDate === "string" && row.toDate ? row.toDate : null,
    });
  }
  return { ok: true, plan };
}

/** Days between the plan and the offer, signed. The card says "+12 days" from this. */
export function slipDays(plannedEndDate: Date | null, revisedFinishDate: Date): number | null {
  if (!plannedEndDate) return null;
  return Math.round((revisedFinishDate.getTime() - plannedEndDate.getTime()) / 86_400_000);
}

/**
 * Has the plan moved since the commitment was accepted?
 *
 * This is the warning the card shows when a later upload rewrites the CLMS plan: the commitment is not
 * wrong, the plan is simply no longer the one it was measured against.
 */
export function planHasMoved(input: { plannedEndDate: Date | null; appliedFrom: Date | null }): boolean {
  if (!input.plannedEndDate || !input.appliedFrom) return false;
  return input.plannedEndDate.getTime() !== input.appliedFrom.getTime();
}

export type HindranceAge = { days: number; stale: boolean };

/** Age of an open hindrance. Fourteen days is the point at which Central Planning stops calling it "open". */
export const STALE_AFTER_DAYS = 14;

export function hindranceAge(raisedAt: Date, closedAt: Date | null, now: Date): HindranceAge {
  const end = closedAt ?? now;
  const days = Math.max(0, Math.floor((end.getTime() - raisedAt.getTime()) / 86_400_000));
  return { days, stale: closedAt == null && days >= STALE_AFTER_DAYS };
}

/** Who may close: the person who raised it, or the two roles that may move a plan. */
export function canCloseHindrance(input: { role: string; raisedByUserId: number | null; actorUserId: number }): boolean {
  if (input.raisedByUserId != null && input.raisedByUserId === input.actorUserId) return true;
  return (MANAGER_ROLES as readonly string[]).includes(input.role);
}
