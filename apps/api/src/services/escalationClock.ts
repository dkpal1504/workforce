/**
 * The escalation clock — a promise that somebody will notice.
 *
 * PURE. An ESCALATION message carries `escalationDueAt`; the sweep in
 * `conversationScheduler.ts` asks this module what should happen next. Every step is written into the
 * thread as a SYSTEM message, so the ladder itself is part of the trail rather than a silent cron.
 *
 * The defaults are configuration, not constants: 8 hours to the owner's HOD, 24 to the COO and the
 * Project Manager. A message that has been acknowledged stops the ladder at whatever rung it reached.
 */

export type EscalationClockConfig = {
  /** Hours after posting when the owner's HOD is told. */
  remindHours: number;
  /** Hours after posting when the COO and the Project Manager are told. */
  escalateHours: number;
};

export const DEFAULT_ESCALATION_CLOCK: EscalationClockConfig = { remindHours: 8, escalateHours: 24 };

export type EscalationStep = "NONE" | "REMIND_HOD" | "ESCALATE_COO";

/**
 * Which rung the ladder is on.
 *
 * `acknowledgedAt !== null` short-circuits everything: an acknowledged escalation is done, however
 * old it is. `lastStep` records the rung already taken so a sweep every 15 minutes does not repeat it.
 */
export function escalationStep(input: {
  postedAt: Date;
  now: Date;
  acknowledgedAt: Date | null;
  lastStep: "NONE" | "REMIND_HOD" | "ESCALATE_COO";
  clock?: EscalationClockConfig;
}): EscalationStep {
  if (input.acknowledgedAt) return "NONE";
  const clock = input.clock ?? DEFAULT_ESCALATION_CLOCK;
  const hours = (input.now.getTime() - input.postedAt.getTime()) / 3_600_000;

  if (hours >= clock.escalateHours && input.lastStep !== "ESCALATE_COO") return "ESCALATE_COO";
  if (hours >= clock.remindHours && input.lastStep === "NONE") return "REMIND_HOD";
  return "NONE";
}

/** The instant the clock is due to start, stored on the message so the UI can show a countdown. */
export function escalationDueAt(postedAt: Date, clock: EscalationClockConfig = DEFAULT_ESCALATION_CLOCK): Date {
  return new Date(postedAt.getTime() + clock.escalateHours * 3_600_000);
}

/** "8h unanswered" — the one number the COO actually asks for. */
export function unansweredHours(postedAt: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - postedAt.getTime()) / 3_600_000));
}
