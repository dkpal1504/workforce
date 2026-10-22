/**
 * The response clock — how long a reply is expected to take, and what the thread says when it does not.
 *
 * PURE. The sweep asks this module what rung is due; the screen asks it what a chip should read; Reports
 * asks it for a median. All three must give the same answer, which is why the arithmetic lives here once
 * rather than in a query, a JSX expression and a cron.
 *
 * The clock is counted from the message that expects a reply. A REPLY that answers it stops the ladder at
 * whatever rung it reached — an answer is an answer, however late.
 */

export type SlaKind = "ESCALATION" | "RECOVERY";

export type SlaPolicy = {
  kind: SlaKind;
  departmentId: number | null;
  responseHours: number;
  remindHours: number;
  escalateHours: number;
};

/** The seed, mirroring the migration. An escalation is expected inside a shift; a recovery inside three. */
export const DEFAULT_SLA: Record<SlaKind, SlaPolicy> = {
  ESCALATION: { kind: "ESCALATION", departmentId: null, responseHours: 4, remindHours: 8, escalateHours: 24 },
  RECOVERY: { kind: "RECOVERY", departmentId: null, responseHours: 24, remindHours: 48, escalateHours: 72 },
};

/** Does this kind of message expect a reply at all? A decision, a system line and a bare reply do not. */
export function expectsReply(kind: string): kind is SlaKind {
  return kind === "ESCALATION" || kind === "RECOVERY";
}

/**
 * The policy in force for a kind in a department.
 *
 * A department row wins over the null row; the null row is the default. `active=false` rows are ignored,
 * so switching a clock off is a data change rather than a deploy.
 */
export function resolvePolicy(
  kind: SlaKind,
  rows: ReadonlyArray<Omit<SlaPolicy, "kind"> & { kind: string; active?: boolean }>,
  departmentId: number | null
): SlaPolicy {
  const usable = rows.filter((row) => row.kind === kind && row.active !== false);
  const scoped = departmentId == null ? undefined : usable.find((row) => row.departmentId === departmentId);
  const fallback = usable.find((row) => row.departmentId == null);
  const chosen = scoped ?? fallback;
  // The row's own `kind` came back as a string from the database; the caller already asked for THIS kind,
  // so the narrowed value is the honest one to return.
  return chosen
    ? {
        kind,
        departmentId: chosen.departmentId,
        responseHours: chosen.responseHours,
        remindHours: chosen.remindHours,
        escalateHours: chosen.escalateHours,
      }
    : DEFAULT_SLA[kind];
}

export type SlaState = "NONE" | "ANSWERED" | "OPEN" | "DUE_SOON" | "OVERDUE";

export type SlaChip = {
  state: SlaState;
  /** Hours the expectation is stated in. */
  targetHours: number;
  /** Hours elapsed since the message that expects the answer. */
  elapsedHours: number;
  /** Hours until due (negative when late). */
  remainingHours: number;
};

const HOUR = 3_600_000;
const hours = (from: Date, to: Date) => (to.getTime() - from.getTime()) / HOUR;

/**
 * What the chip on a message should read.
 *
 * DUE_SOON is the last quarter of the window, not a fixed two hours: a 4-hour expectation should start
 * shouting at 3 hours, a 24-hour one at 18. A fixed threshold would either nag the short clock or say
 * nothing about the long one.
 */
export function slaChip(input: {
  postedAt: Date;
  dueAt: Date | null;
  answeredAt: Date | null;
  now: Date;
  targetHours: number;
}): SlaChip {
  if (!input.dueAt) return { state: "NONE", targetHours: input.targetHours, elapsedHours: 0, remainingHours: 0 };

  const elapsed = hours(input.postedAt, input.now);
  const answeredAt = input.answeredAt;
  if (answeredAt) {
    return {
      state: "ANSWERED",
      targetHours: input.targetHours,
      elapsedHours: Math.max(0, hours(input.postedAt, answeredAt)),
      remainingHours: Math.max(0, hours(answeredAt, input.dueAt)) * -1,
    };
  }

  const remaining = hours(input.now, input.dueAt);
  const state: SlaState = remaining < 0 ? "OVERDUE" : remaining <= input.targetHours / 4 ? "DUE_SOON" : "OPEN";
  return { state, targetHours: input.targetHours, elapsedHours: Math.max(0, elapsed), remainingHours: remaining };
}

export type AgeingBucket = "under4" | "4to8" | "8to24" | "over24";

/** Which ageing bucket an unanswered message falls in, by hours since it was posted. */
export function ageingBucket(elapsedHours: number): AgeingBucket {
  if (elapsedHours < 4) return "under4";
  if (elapsedHours < 8) return "4to8";
  if (elapsedHours < 24) return "8to24";
  return "over24";
}

export type ResponseStats = {
  /** Messages that expected a reply and got one. */
  answered: number;
  /** Messages that expected a reply at all (answered + still open). */
  expected: number;
  /** Median hours to first answer over the answered set; null when nothing was answered. */
  medianHours: number | null;
  /** Share of answered messages that were answered inside their own target; null when none answered. */
  withinTargetPct: number | null;
  /** Unanswered messages, bucketed by age. */
  open: Record<AgeingBucket, number>;
  /** Unanswered older than 24h — the number the COO asks for. */
  overdue24: number;
};

/**
 * The numbers on the Reports panel.
 *
 * Median, not mean: one three-week-old escalation should not make a department look slow for a quarter.
 * The share is computed per message against ITS OWN target (a 4h escalation and a 24h recovery are not the
 * same promise), which is why the per-row target travels with the row.
 */
export function responseStats(
  rows: ReadonlyArray<{ postedAt: Date; dueAt: Date | null; answeredAt: Date | null; targetHours: number }>,
  now: Date
): ResponseStats {
  const expectedRows = rows.filter((row) => row.dueAt != null);
  const answeredRows = expectedRows.filter((row) => row.answeredAt != null);

  const open: Record<AgeingBucket, number> = { under4: 0, "4to8": 0, "8to24": 0, over24: 0 };
  for (const row of expectedRows) {
    if (row.answeredAt) continue;
    open[ageingBucket(Math.max(0, hours(row.postedAt, now)))] += 1;
  }

  const durations = answeredRows
    .map((row) => Math.max(0, hours(row.postedAt, row.answeredAt as Date)))
    .sort((a, b) => a - b);

  let median: number | null = null;
  if (durations.length > 0) {
    const mid = Math.floor(durations.length / 2);
    median = durations.length % 2 === 1 ? durations[mid] : (durations[mid - 1] + durations[mid]) / 2;
  }

  const within = answeredRows.filter((row) => hours(row.postedAt, row.answeredAt as Date) <= row.targetHours).length;

  return {
    answered: answeredRows.length,
    expected: expectedRows.length,
    medianHours: median == null ? null : Math.round(median * 10) / 10,
    withinTargetPct: answeredRows.length === 0 ? null : Math.round((within / answeredRows.length) * 100),
    open,
    overdue24: open.over24,
  };
}

export type LadderStep = "NONE" | "REMIND_HOD" | "ESCALATE_COO";

/**
 * Which rung is due, if any.
 *
 * Idempotent by construction: the caller passes the rung already recorded on the message, and a rung that
 * has been taken is never returned again. An answer or an acknowledgement short-circuits everything —
 * however old the message, the ladder stops the moment somebody responded.
 */
export function nextLadderStep(input: {
  postedAt: Date;
  now: Date;
  answeredAt: Date | null;
  acknowledgedAt: Date | null;
  lastStep: LadderStep;
  policy: SlaPolicy;
}): LadderStep {
  if (input.answeredAt || input.acknowledgedAt) return "NONE";
  const elapsed = hours(input.postedAt, input.now);
  if (elapsed >= input.policy.escalateHours && input.lastStep !== "ESCALATE_COO") return "ESCALATE_COO";
  if (elapsed >= input.policy.remindHours && input.lastStep === "NONE") return "REMIND_HOD";
  return "NONE";
}

/** Hours since posting, floored, for a chip's "31h" and for the ladder's comparison in tests. */
export function elapsedHours(postedAt: Date, now: Date): number {
  return Math.max(0, Math.floor(hours(postedAt, now)));
}
