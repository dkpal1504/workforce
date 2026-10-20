/**
 * How long an escalation waits for its first human answer.
 *
 * PURE and deliberately simple: an escalation's clock runs until the first message in the thread that
 * (a) comes after it and (b) was written by somebody else. A reply by the escalator to their own
 * message does not stop the clock — that is the failure mode this number exists to expose.
 *
 * Median, not mean: one escalation forgotten for a month must not hide eight answered in an hour. An
 * odd count takes the middle value; an even count averages the two middle values.
 */

export type EscalationFact = {
  id: number;
  seq: number;
  createdAt: Date;
  origin: string | null;
  acknowledgedAt: Date | null;
  /** The first answer by another person, if there is one. */
  firstReplyAt: Date | null;
};

export function medianHours(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return Math.round(value * 10) / 10;
}

/** Hours from the escalation to its first human answer, or null when nobody has answered yet. */
export function hoursToFirstReply(fact: EscalationFact): number | null {
  if (!fact.firstReplyAt) return null;
  const hours = (fact.firstReplyAt.getTime() - fact.createdAt.getTime()) / 3_600_000;
  return hours >= 0 ? Math.round(hours * 10) / 10 : null;
}

export type EscalationStats = {
  /** Escalations raised from a Portfolio row in the window. */
  raisedFromPortfolio: number;
  /** Escalations raised in the drawer (null origin) in the same window. */
  raisedInDrawer: number;
  byOrigin: Array<{ origin: string; count: number }>;
  answered: number;
  unanswered: number;
  /** Median hours to the first human answer, over the answered ones. Null when none were answered. */
  medianHoursToFirstReply: number | null;
};

/**
 * The headline the Conversations screen prints. `firstReplyAt` is computed by the caller (one grouped
 * query), so this stays pure and testable.
 */
export function summariseEscalations(facts: readonly EscalationFact[]): EscalationStats {
  const fromPortfolio = facts.filter((fact) => fact.origin != null);
  const answered = facts.filter((fact) => fact.firstReplyAt != null);
  const byOrigin = new Map<string, number>();
  for (const fact of fromPortfolio) {
    byOrigin.set(fact.origin as string, (byOrigin.get(fact.origin as string) ?? 0) + 1);
  }
  const hours = answered.map(hoursToFirstReply).filter((value): value is number => value !== null);
  return {
    raisedFromPortfolio: fromPortfolio.length,
    raisedInDrawer: facts.length - fromPortfolio.length,
    byOrigin: [...byOrigin.entries()]
      .map(([origin, count]) => ({ origin, count }))
      .sort((a, b) => b.count - a.count),
    answered: answered.length,
    unanswered: facts.length - answered.length,
    medianHoursToFirstReply: medianHours(hours),
  };
}
