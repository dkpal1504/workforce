/**
 * The SLA sweep — the only code in the application that speaks without a person pressing Send.
 *
 * Every tick, for every message that expects a reply and has not received one:
 *   at `remindHours`   tell the Section HOD(s) and the Department HOD — in the thread and by mail;
 *   at `escalateHours` tell the COO and the Project Manager(s) — in the thread and by mail.
 *
 * WHY IT WRITES A SYSTEM LINE AS WELL AS MAILING: the ladder must be on the record. A mail that says
 * "nobody answered for 24 hours" is evidence in a mailbox, not in the dossier; the line is what the audit
 * and the next reader see.
 *
 * IDEMPOTENT BY CONSTRUCTION: the rung already taken is stored on the line (`ladder_step`), and an answer
 * or an acknowledgement short-circuits the ladder entirely. A restart, a double tick, or an operator
 * pressing "run now" cannot send the same notice twice.
 */
import { prisma } from "../db";
import { postSystemMessage } from "./conversations";
import { deliverMessage } from "./notificationMail";
import { nextLadderStep, resolvePolicy, type LadderStep, type SlaPolicy } from "./sla";

const SYSTEM_AUTHOR = { id: null, email: "system@workforce", name: "Workforce", role: "SYSTEM", source: "SYSTEM" as const };

export type LadderResult = { reminded: number; escalated: number; skipped: number };

/** The line the HOD reads. It names the message, the age, and what is expected next. */
export function remindLine(seq: number, hours: number): string {
  return `Escalation #${seq} reminded to the Section HOD and the Department HOD after ${hours}h without a reply.`;
}

/** The line the COO and the PM read. */
export function escalateLine(seq: number, hours: number): string {
  return `Escalation #${seq} escalated to the COO and the Project Manager after ${hours}h without a reply.`;
}

async function audienceFor(jobOrderId: number, rung: LadderStep): Promise<Array<{ userId: number | null; email: string | null }>> {
  const order = await prisma.jobOrder.findUnique({
    where: { id: jobOrderId },
    select: { departmentId: true, sectionId: true, projectId: true },
  });
  if (!order) return [];

  if (rung === "REMIND_HOD") {
    // Section HOD first (his scope contains the Job Order's section), then the department's HODs who are
    // not already covered. The section head is the person who can actually move the work; the department
    // head is told because a section head who is on leave is otherwise a silent dead end.
    const hods = await prisma.user.findMany({
      where: { role: "HOD", active: true, departmentId: order.departmentId },
      select: { id: true, email: true, notificationEmail: true, sectionId: true, scopeSections: { select: { sectionId: true } } },
    });
    const covers = (user: (typeof hods)[number]) => {
      const sections = user.scopeSections.length ? user.scopeSections.map((row) => row.sectionId) : user.sectionId == null ? [] : [user.sectionId];
      return order.sectionId != null && sections.includes(order.sectionId);
    };
    const sectionFirst = [...hods].sort((a, b) => Number(covers(b)) - Number(covers(a)));
    return sectionFirst.slice(0, 4).map((user) => ({ userId: user.id, email: user.notificationEmail ?? user.email }));
  }

  // ESCALATE_COO: the COO (org-wide) and every PM assigned to the project.
  const [coos, managers] = await Promise.all([
    prisma.user.findMany({ where: { role: "COO", active: true }, select: { id: true, email: true, notificationEmail: true } }),
    prisma.projectManagerAssignment.findMany({
      where: { projectId: order.projectId },
      select: { user: { select: { id: true, email: true, notificationEmail: true } } },
    }),
  ]);
  return [
    ...coos.map((user) => ({ userId: user.id, email: user.notificationEmail ?? user.email })),
    ...managers.map((row) => ({ userId: row.user.id, email: row.user.notificationEmail ?? row.user.email })),
  ];
}

/**
 * Walk the ladder once.
 *
 * `policyFor` is a parameter so a test can hand in a 1h/2h clock instead of waiting a day; production omits
 * it and the stored policies are used.
 */
export async function runSlaLadder(
  now: Date = new Date(),
  policyFor?: (kind: "ESCALATION" | "RECOVERY", departmentId: number | null) => Promise<SlaPolicy>
): Promise<LadderResult> {
  const result: LadderResult = { reminded: 0, escalated: 0, skipped: 0 };

  const pending = await prisma.jobOrderMessage.findMany({
    where: {
      responseDueAt: { not: null },
      acknowledgedAt: null,
      // `not: "ESCALATE_COO"` alone is SQL `<> 'ESCALATE_COO'`, which is NULL - and therefore not true -
      // for a message whose rung has never been taken. Written out, the first rung is reachable.
      OR: [{ ladderStep: null }, { ladderStep: { not: "ESCALATE_COO" } }],
      kind: { in: ["ESCALATION", "RECOVERY"] },
    },
    orderBy: { createdAt: "asc" },
    take: 200,
    select: {
      id: true,
      seq: true,
      kind: true,
      createdAt: true,
      ladderStep: true,
      acknowledgedAt: true,
      thread: { select: { jobOrderId: true, jobOrder: { select: { departmentId: true } } } },
      answeredBy: { select: { id: true }, take: 1 },
    },
  });

  for (const message of pending) {
    const departmentId = message.thread.jobOrder.departmentId;
    const policy = policyFor
      ? await policyFor(message.kind as "ESCALATION" | "RECOVERY", departmentId)
      : resolvePolicy(
          message.kind as "ESCALATION" | "RECOVERY",
          await prisma.slaPolicy.findMany({ where: { kind: message.kind, active: true } }),
          departmentId
        );

    const step = nextLadderStep({
      postedAt: message.createdAt,
      now,
      answeredAt: message.answeredBy[0]?.id ? now : null,
      acknowledgedAt: message.acknowledgedAt,
      lastStep: (message.ladderStep as LadderStep) ?? "NONE",
      policy,
    });
    if (step === "NONE") continue;

    const hours = step === "REMIND_HOD" ? policy.remindHours : policy.escalateHours;
    const audience = await audienceFor(message.thread.jobOrderId, step);
    const posted = await postSystemMessage(
      message.thread.jobOrderId,
      step === "REMIND_HOD" ? remindLine(message.seq, hours) : escalateLine(message.seq, hours),
      SYSTEM_AUTHOR,
      now,
      { audience, ladderStep: step }
    );

    // THE GUARD LIVES ON THE SOURCE MESSAGE. Writing the rung only onto the SYSTEM line left the
    // escalation itself looking untouched, so the next sweep took the same rung again - measured: two
    // "reminded" lines for one escalation one second apart. The line keeps its own ladderStep for display;
    // the source keeps the one the sweep reads.
    await prisma.jobOrderMessage.update({ where: { id: message.id }, data: { ladderStep: step } });

    if (step === "REMIND_HOD") result.reminded += 1;
    else result.escalated += 1;

    // Mail is a side effect: the line is committed first, so a mail server that is down cannot erase the
    // fact that the rung was taken. `deliverMessage` records FAILED/EMAIL_OFF on the recipient rows.
    void deliverMessage(posted.id).catch(() => undefined);
  }

  return result;
}
