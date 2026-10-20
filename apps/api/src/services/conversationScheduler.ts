/**
 * The conversation sweeps — the part that makes the trail self-maintaining.
 *
 * Every 15 minutes:
 *   1. an ESCALATION that nobody acknowledged walks the ladder: at 8 h the owner's HOD is told, at
 *      24 h the COO and the Project Manager are told. Each rung is a SYSTEM line, so the ladder is on
 *      the record rather than hidden in a cron log;
 *   2. a promise that came due is chased once, as a SYSTEM line;
 *   3. uploads that were never sent are deleted after 24 hours.
 *
 * Idempotent by construction: the rung is read from the SYSTEM lines already in the thread, so a
 * restart or a double tick cannot send the same notice twice. Never throws into the process.
 */

import { prisma } from "../db";
import { escalationStep, DEFAULT_ESCALATION_CLOCK, type EscalationStep } from "./escalationClock";
import { isCommitmentDue } from "./commitmentExtraction";
import { postSystemMessage } from "./conversations";
import { sweepOrphanUploads } from "./attachments";

const REMIND = (seq: number) => `Escalation #${seq} reminded to the Section HOD and HOD after ${DEFAULT_ESCALATION_CLOCK.remindHours}h without acknowledgement.`;
const ESCALATE = (seq: number) => `Escalation #${seq} escalated to the COO and the Project Manager after ${DEFAULT_ESCALATION_CLOCK.escalateHours}h without acknowledgement.`;

export type SweepResult = { reminded: number; escalated: number; chased: number; orphans: number };

export async function runConversationSweep(now: Date = new Date()): Promise<SweepResult> {
  const result: SweepResult = { reminded: 0, escalated: 0, chased: 0, orphans: 0 };

  const open = await prisma.jobOrderMessage.findMany({
    where: { kind: "ESCALATION", acknowledgedAt: null },
    orderBy: { createdAt: "asc" },
    take: 200,
    select: {
      id: true,
      seq: true,
      createdAt: true,
      threadId: true,
      thread: {
        select: {
          jobOrderId: true,
          messages: { where: { kind: "SYSTEM" }, select: { body: true } },
        },
      },
    },
  });

  for (const escalation of open) {
    const bodies = escalation.thread.messages.map((message) => message.body);
    const lastStep: EscalationStep = bodies.some((body) => body.startsWith(`Escalation #${escalation.seq} escalated`))
      ? "ESCALATE_COO"
      : bodies.some((body) => body.startsWith(`Escalation #${escalation.seq} reminded`))
        ? "REMIND_HOD"
        : "NONE";

    const step = escalationStep({
      postedAt: escalation.createdAt,
      now,
      acknowledgedAt: null,
      lastStep,
    });
    if (step === "NONE") continue;

    await postSystemMessage(
      escalation.thread.jobOrderId,
      step === "REMIND_HOD" ? REMIND(escalation.seq) : ESCALATE(escalation.seq),
      { id: null, email: "system@workforce", name: "Workforce", role: "SYSTEM", source: "SYSTEM" },
      now
    );
    if (step === "REMIND_HOD") result.reminded += 1;
    else result.escalated += 1;
  }

  const due = await prisma.jobOrderCommitment.findMany({
    where: { state: "OPEN", chasedAt: null, dueOn: { lte: now } },
    take: 200,
    select: { id: true, text: true, dueOn: true, threadId: true, jobOrderId: true, ownerEmail: true },
  });
  for (const commitment of due) {
    if (!isCommitmentDue("OPEN", commitment.dueOn, now)) continue;
    await prisma.jobOrderCommitment.update({ where: { id: commitment.id }, data: { chasedAt: now } });
    await postSystemMessage(
      commitment.jobOrderId,
      `Promise due ${commitment.dueOn.toISOString().slice(0, 10)} from ${commitment.ownerEmail}: "${commitment.text.slice(0, 200)}" — no reply recorded yet.`,
      { id: null, email: "system@workforce", name: "Workforce", role: "SYSTEM", source: "SYSTEM" },
      now
    );
    result.chased += 1;
  }

  result.orphans = await sweepOrphanUploads(new Date(now.getTime() - 24 * 3_600_000));
  return result;
}

let timer: NodeJS.Timeout | null = null;

/** Start the sweep. Off unless CONVERSATION_SCHEDULER_ENABLED=true, so a dev box does not chase anybody. */
export function startConversationScheduler(): void {
  if ((process.env.CONVERSATION_SCHEDULER_ENABLED ?? "false").toLowerCase() !== "true") return;
  if (timer) return;
  const minutes = Math.max(5, Number(process.env.CONVERSATION_SCHEDULER_MINUTES ?? 15));
  timer = setInterval(() => {
    runConversationSweep().catch((error) => {
      console.error("[conversations] sweep failed", error instanceof Error ? error.message : error);
    });
  }, minutes * 60_000);
  timer.unref?.();
  console.log(`[conversations] sweep every ${minutes} min`);
}

export function stopConversationScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
