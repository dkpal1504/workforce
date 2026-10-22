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
import { remindersEnabled } from "./conversationReminders";
import { runSlaLadder } from "./slaLadder";
import { isCommitmentDue } from "./commitmentExtraction";
import { postSystemMessage } from "./conversations";
import { sweepOrphanUploads } from "./attachments";

// The wording of a rung lives with the ladder that writes it (slaLadder.ts), so the line and the mail
// that accompanies it cannot drift apart.

export type SweepResult = { reminded: number; escalated: number; chased: number; orphans: number };

export async function runConversationSweep(now: Date = new Date()): Promise<SweepResult> {
  const result: SweepResult = { reminded: 0, escalated: 0, chased: 0, orphans: 0 };

  // The ladder lives in its own module: it is the only part that speaks to people, and it has to be
  // testable without a timer. The sweep calls it and keeps doing the quiet housekeeping around it.
  const ladder = await runSlaLadder(now);
  result.reminded = ladder.reminded;
  result.escalated = ladder.escalated;

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

/**
 * Start the sweep.
 *
 * TWO gates, both must be true: the rider's master switch (`CONVERSATION_REMINDERS_ENABLED`) and this
 * scheduler's own switch. An operator who enables reminders still has to turn the timer on, and an
 * operator who turns the timer on still cannot send unattended mail while reminders are off. Belt and
 * braces on purpose: this is the only code path that speaks without a person pressing Send.
 */
export function startConversationScheduler(): void {
  if (!remindersEnabled()) return;
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
