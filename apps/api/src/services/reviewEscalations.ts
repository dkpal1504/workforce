/**
 * Open escalations by age — the one number a review meeting always asks for and the app never had.
 *
 * THE RULE FOR "OPEN" IS THE SHIPPED ONE, not a new one: an ESCALATION message is open when its thread is
 * still OPEN and no later message in that thread was authored by somebody other than the escalation
 * itself. That is exactly `escalationStats.hoursToFirstReply`'s definition of an answer, and re-using it
 * means the review cannot disagree with the Jobs Order screen. Acknowledgement does not close an
 * escalation: acknowledging is not answering, and the product already says so.
 *
 * Age is measured from the escalation's own `createdAt`, in the yard's clock, in five buckets a supervisor
 * can act on. The bounds are inclusive on the low side (exactly 3 days is "3-7"), pinned by a test.
 */

export type EscalationMessage = {
  id: number;
  threadId: number;
  threadStatus: string;
  createdAt: Date;
  authorEmail: string | null;
  dueAt: Date | null;
  acknowledgedAt: Date | null;
  jobOrderId: number | null;
  jobOrderCode: string | null;
};

/** A later message in the same thread, reduced to what "was it answered" needs. */
export type ThreadReply = {
  threadId: number;
  createdAt: Date;
  authorEmail: string | null;
};

export const AGE_BUCKETS = [
  { key: "0-2", label: "0–2 days", maxDays: 2 },
  { key: "3-7", label: "3–7 days", maxDays: 7 },
  { key: "8-14", label: "8–14 days", maxDays: 14 },
  { key: "15-30", label: "15–30 days", maxDays: 30 },
  { key: ">30", label: "Over 30 days", maxDays: Number.POSITIVE_INFINITY },
] as const;

export type AgeBucketKey = (typeof AGE_BUCKETS)[number]["key"];

const DAY_MS = 86_400_000;

function sameAuthor(a: string | null, b: string | null): boolean {
  if (!a || !b) return a === b;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Open = the thread still stands AND nobody else has spoken since. A reply by the escalation's own author
 * (a chase, a correction) is not an answer, so it leaves the escalation open.
 */
export function isOpenEscalation(escalation: EscalationMessage, replies: readonly ThreadReply[]): boolean {
  if (String(escalation.threadStatus || "").toUpperCase() !== "OPEN") return false;
  return !replies.some(
    (reply) =>
      reply.threadId === escalation.threadId &&
      reply.createdAt.getTime() > escalation.createdAt.getTime() &&
      !sameAuthor(reply.authorEmail, escalation.authorEmail)
  );
}

export function ageDays(escalation: EscalationMessage, now: Date): number {
  return Math.max(0, (now.getTime() - escalation.createdAt.getTime()) / DAY_MS);
}

/** Inclusive on the low side: 3.0 days is "3-7", not "0-2". */
export function ageBucket(age: number): AgeBucketKey {
  const wholeDays = Math.floor(age);
  for (const bucket of AGE_BUCKETS) {
    if (wholeDays <= bucket.maxDays) return bucket.key;
  }
  return ">30";
}

export type EscalationAgeRow = {
  id: number;
  jobOrderId: number | null;
  jobOrderCode: string | null;
  createdAt: Date;
  ageDays: number;
  bucket: AgeBucketKey;
  overdue: boolean;
  acknowledgedUnanswered: boolean;
};

export type EscalationAgeSummary = {
  buckets: Array<{ key: AgeBucketKey; label: string; count: number }>;
  total: number;
  overdue: number;
  acknowledgedUnanswered: number;
  /** The oldest open escalations, worst first — what a pack prints. */
  oldest: EscalationAgeRow[];
  /** Escalations examined, open or not, so a reader can see how many were closed. */
  examined: number;
};

export function summariseEscalationsByAge(input: {
  escalations: readonly EscalationMessage[];
  replies: readonly ThreadReply[];
  now: Date;
  oldestLimit?: number;
}): EscalationAgeSummary {
  const rows: EscalationAgeRow[] = [];
  for (const escalation of input.escalations) {
    if (!isOpenEscalation(escalation, input.replies)) continue;
    const age = ageDays(escalation, input.now);
    rows.push({
      id: escalation.id,
      jobOrderId: escalation.jobOrderId,
      jobOrderCode: escalation.jobOrderCode,
      createdAt: escalation.createdAt,
      ageDays: Math.round(age * 10) / 10,
      bucket: ageBucket(age),
      overdue: escalation.dueAt !== null && escalation.dueAt.getTime() < input.now.getTime(),
      acknowledgedUnanswered: escalation.acknowledgedAt !== null,
    });
  }

  const buckets = AGE_BUCKETS.map((bucket) => ({
    key: bucket.key,
    label: bucket.label,
    count: rows.filter((row) => row.bucket === bucket.key).length,
  }));

  const sorted = [...rows].sort((a, b) => b.ageDays - a.ageDays || a.id - b.id);
  return {
    buckets,
    total: rows.length,
    overdue: rows.filter((row) => row.overdue).length,
    acknowledgedUnanswered: rows.filter((row) => row.acknowledgedUnanswered).length,
    oldest: sorted.slice(0, Math.max(0, input.oldestLimit ?? 10)),
    examined: input.escalations.length,
  };
}
