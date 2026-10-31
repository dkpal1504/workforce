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

/** The columns a mail audience is built from, in one place so the two rungs cannot disagree. */
const USER_FOR_MAIL = {
  id: true,
  email: true,
  notificationEmail: true,
  sectionId: true,
  scopeSections: { select: { sectionId: true } },
} as const;

export type AudiencePerson = {
  id: number;
  email: string;
  notificationEmail: string | null;
  sectionId: number | null;
  scopeSections: Array<{ sectionId: number }>;
};

/** The mailbox a person is reached at: the notification address wins, exactly as everywhere else. */
export function audienceAddress(person: AudiencePerson): string | null {
  const address = (person.notificationEmail?.trim() || person.email?.trim() || "").trim();
  return address ? address.toLowerCase() : null;
}

/**
 * One row per PERSON, not per role. A PM who is also named Project Manager on the project — or a COO who
 * is also a PM — must receive one copy, so the first mention wins and later ones are dropped.
 */
export function uniqueAudience(people: AudiencePerson[]): Array<{ userId: number | null; email: string | null }> {
  const seen = new Set<number>();
  const out: Array<{ userId: number | null; email: string | null }> = [];
  for (const person of people) {
    if (seen.has(person.id)) continue;
    seen.add(person.id);
    out.push({ userId: person.id, email: audienceAddress(person) });
  }
  return out;
}

/**
 * The Section Head whose scope contains this Job Order's section comes first, the rest of the department's
 * heads follow, and the rung stops at four people. Pure, so the ordering the escalation promises is a test
 * rather than a hope.
 */
export function sectionHeadAudience(hods: AudiencePerson[], sectionId: number | null): AudiencePerson[] {
  const covers = (person: AudiencePerson) => {
    const sections = person.scopeSections.length
      ? person.scopeSections.map((row) => row.sectionId)
      : person.sectionId == null
        ? []
        : [person.sectionId];
    return sectionId != null && sections.includes(sectionId);
  };
  return [...hods].sort((a, b) => Number(covers(b)) - Number(covers(a))).slice(0, 4);
}

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
      select: USER_FOR_MAIL,
    });
    return uniqueAudience(sectionHeadAudience(hods, order.sectionId));
  }

  // ESCALATE_COO: everybody who must see an unanswered escalation — the COO and every PM org-wide, plus
  // the Project Managers ASSIGNED to this project and to no other. The assignment is filtered to `active`:
  // a revoked manager is history, not a recipient, and mailing him would be a leak dressed as diligence.
  const [coos, pms, assigned] = await Promise.all([
    prisma.user.findMany({ where: { role: "COO", active: true }, select: USER_FOR_MAIL }),
    prisma.user.findMany({ where: { role: "PM", active: true }, select: USER_FOR_MAIL }),
    prisma.projectManagerAssignment.findMany({
      where: { projectId: order.projectId, status: "active", user: { active: true } },
      select: { user: { select: USER_FOR_MAIL } },
    }),
  ]);
  return uniqueAudience([...coos, ...pms, ...assigned.map((row) => row.user)]);
}

/**
 * Who is told the moment an escalation is RAISED — not after the clock runs out.
 *
 * An escalation names real people: the Section Heads whose sections the work sits in, every PM and the
 * COO, and the Project Managers of that project. The ladder rungs say the same thing later, when nobody
 * answers; this is the first breath, so the heads learn of it while it is still actionable.
 */
export async function escalationNotifyAudience(
  jobOrderId: number
): Promise<Array<{ userId: number | null; email: string | null }>> {
  const [heads, leads] = await Promise.all([audienceFor(jobOrderId, "REMIND_HOD"), audienceFor(jobOrderId, "ESCALATE_COO")]);
  const seen = new Set<number>();
  const out: Array<{ userId: number | null; email: string | null }> = [];
  for (const person of [...heads, ...leads]) {
    if (person.userId != null) {
      if (seen.has(person.userId)) continue;
      seen.add(person.userId);
    }
    out.push(person);
  }
  return out;
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
