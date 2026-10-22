/**
 * Conversations — the database side.
 *
 * One thread per Job Order, append-only messages with a per-thread `seq`, participants, per-recipient
 * delivery rows, commitments found in a reply, and the frozen context snapshot. Every write happens in
 * ONE transaction so a message can never exist without its thread counters, participants or recipients.
 *
 * The rules (who may see, which kinds) live in `conversationScope.ts` and are pure/tested; this module
 * only stores what the route has already authorised.
 */

import { prisma } from "../db";
import { extractCommitments } from "./commitmentExtraction";
import { escalationDueAt } from "./escalationClock";
import type { ConversationScope } from "./conversationScope";
import { jobOrderContextFor, resolveOwner } from "./jobOrderContext";
import { isRoutableAddress } from "./mailIdentity";
import { expectsReply, resolvePolicy } from "./sla";

export type ConversationAuthor = {
  id: number | null;
  email: string;
  name: string;
  role: string;
  source?: "APP" | "MAGIC_LINK" | "SYSTEM";
  ipHash?: string | null;
};

/** The Prisma `where` for "threads whose Job Order is inside this scope". Fail-closed on NONE. */
export function threadScopeWhere(scope: ConversationScope) {
  switch (scope.kind) {
    case "ORGANISATION":
      return {};
    case "PROJECTS":
      return { jobOrder: { projectId: { in: scope.projectIds } } };
    case "DEPARTMENT":
      return {
        jobOrder: {
          departmentId: scope.departmentId,
          // An EMPTY section set means the whole Department; a Job Order without a section belongs to
          // every HOD of that Department (standing work), the same rule the queues apply.
          ...(scope.sectionIds.length
            ? { OR: [{ sectionId: null }, { sectionId: { in: scope.sectionIds } }] }
            : {}),
        },
      };
    default:
      return { id: -1 };
  }
}

/** The thread for a Job Order, created on first use. */
export async function ensureThread(jobOrderId: number, openedById: number | null) {
  const existing = await prisma.jobOrderThread.findUnique({ where: { jobOrderId }, select: { id: true } });
  if (existing) return existing.id;
  const created = await prisma.jobOrderThread.create({
    data: { jobOrderId, openedById },
    select: { id: true },
  });
  return created.id;
}

export type PostMessageInput = {
  jobOrderId: number;
  author: ConversationAuthor;
  kind: string;
  body: string;
  replyToId?: number | null;
  proposal?: unknown | null;
  /** The owner is e-mailed unless the author unticked the box. */
  emailOwner: boolean;
  /** Where it was raised from, when not the drawer (a Portfolio row). Validated by the route. */
  origin?: string | null;
  /** The cause of the delay, when the author is the owner or a PM. Validated against delay_reasons. */
  reasonCode?: string | null;
  /**
   * A SYSTEM line that is ALLOWED to speak to people: the rungs of the SLA ladder. A system line with no
   * audience still e-mails nobody, which is what keeps every other automated note quiet.
   */
  audience?: Array<{ userId: number | null; email: string | null }>;
  /** REMIND_HOD | ESCALATE_COO on a ladder line; makes a second sweep harmless. */
  ladderStep?: "REMIND_HOD" | "ESCALATE_COO" | null;
  now?: Date;
};

export type PostedMessage = {
  id: number;
  threadId: number;
  seq: number;
  kind: string;
  createdAt: Date;
  contextLine: string | null;
  recipients: Array<{ email: string; state: string }>;
  commitments: Array<{ id: number; dueOn: Date; text: string }>;
};

/**
 * Append a message.
 *
 * The sequence number is `messageCount + 1` INSIDE the transaction, and the unique constraint
 * `(threadId, seq)` is the guard: two people posting at once cannot take the same number — the second
 * transaction fails and the caller retries, rather than silently duplicating `#7`.
 */
/**
 * Where ONE recipient's copy of ONE message is delivered, and what the delivery row says happened.
 *
 * `key` is the participant's identity inside the thread: the LOGIN handle (`40032021@employee.local`),
 * which is what the unread badge looks a reader up by. It is NOT a mailbox, so it is only ever used as
 * the display value of a row that is not being delivered.
 *
 * `accountAddress` is the routable address resolved from the account behind that key — `notification_email`
 * first, then a real login address. `ownerEmail` is the same thing for an owner, coming from the owner
 * ladder in `resolveOwner` (explicit owner → section HOD → department HOD → COO → ADMIN).
 *
 * Pure and exported because the failure it prevents is invisible: a participant with no routable address
 * used to be QUEUED at his login handle, the relay refused it, and the screen said "failed" with no hint
 * that the cause was the address on file rather than the mail server.
 */
export function deliveryTarget(input: {
  key: string;
  isOwner: boolean;
  ownerEmail: string | null;
  accountAddress: string | null;
  mutedAt: Date | null;
  emailOwner: boolean;
}): { address: string; state: "QUEUED" | "MUTED" | "NO_ADDRESS" } {
  const key = input.key.toLowerCase();
  const routable = input.isOwner
    ? (input.ownerEmail && isRoutableAddress(input.ownerEmail) ? input.ownerEmail.toLowerCase() : null)
    : (input.accountAddress && isRoutableAddress(input.accountAddress) ? input.accountAddress.toLowerCase() : null);

  const address = routable ?? key;
  if (input.mutedAt) return { address, state: "MUTED" };
  if (input.isOwner && !input.emailOwner) return { address, state: "MUTED" };
  if (!routable) return { address, state: "NO_ADDRESS" };
  return { address, state: "QUEUED" };
}

export async function postMessage(input: PostMessageInput): Promise<PostedMessage> {
  const now = input.now ?? new Date();
  const context = await jobOrderContextFor(input.jobOrderId, now);
  const owner = await resolveOwner(input.jobOrderId);
  const threadId = await ensureThread(input.jobOrderId, input.author.id);

  const created = await prisma.$transaction(async (tx) => {
    const thread = await tx.jobOrderThread.findUnique({
      where: { id: threadId },
      select: { id: true, messageCount: true, status: true, jobOrderId: true },
    });
    if (!thread) throw new Error("THREAD_NOT_FOUND");

    const seq = thread.messageCount + 1;

    // Participants: the author and the owner are always in the thread. Their addresses are what the
    // delivery rows and the badge read.
    const people = new Map<string, { userId: number | null; email: string; role: string }>();
    if (input.author.source !== "SYSTEM") {
      people.set(input.author.email.toLowerCase(), {
        userId: input.author.id,
        email: input.author.email.toLowerCase(),
        role: input.author.role,
      });
    }
    // The owner is keyed by the LOGIN handle, not the routable address: that is the key the badge
    // looks a reader up by. The address is only used for the mail.
    const ownerKey = (owner.loginEmail ?? owner.email)?.toLowerCase();
    if (ownerKey) {
      people.set(ownerKey, { userId: owner.userId, email: ownerKey, role: "OWNER" });
    }
    for (const person of people.values()) {
      await tx.jobOrderThreadParticipant.upsert({
        where: { threadId_email: { threadId, email: person.email } },
        create: { threadId, userId: person.userId, email: person.email, roleAtJoin: person.role },
        update: { userId: person.userId ?? undefined },
      });
    }

    // ── the clock ────────────────────────────────────────────────────────────────────────────────
    // A message that expects a reply carries its own deadline and its own target, from the policy in force
    // for its kind and the Job Order's department at the moment it was written. Storing the deadline (not
    // just the policy) is what keeps an old message honest after somebody edits the policy.
    let responseDueAt: Date | null = null;
    let answersMessageId: number | null = null;
    let escalationDue: Date | null = null;

    if (expectsReply(input.kind)) {
      const order = await tx.jobOrder.findUnique({ where: { id: input.jobOrderId }, select: { departmentId: true } });
      const policies = await tx.slaPolicy.findMany({ where: { kind: input.kind, active: true } });
      const policy = resolvePolicy(input.kind, policies, order?.departmentId ?? null);
      responseDueAt = new Date(now.getTime() + policy.responseHours * 3_600_000);
      escalationDue = new Date(now.getTime() + policy.escalateHours * 3_600_000);
    } else if (input.kind !== "SYSTEM") {
      // A reply stops the clock on the newest message that expected one and is still unanswered. One link,
      // written once, so "responded in 6h" never has to be recomputed from the thread.
      const candidates = await tx.jobOrderMessage.findMany({
        where: {
          threadId,
          responseDueAt: { not: null },
          createdAt: { lte: now },
          authorEmail: { not: input.author.email.toLowerCase() },
        },
        orderBy: { createdAt: "desc" },
        take: 5,
        select: { id: true, _count: { select: { answeredBy: true } } },
      });
      answersMessageId = candidates.find((candidate) => candidate._count.answeredBy === 0)?.id ?? null;
    }

    const message = await tx.jobOrderMessage.create({
      data: {
        threadId,
        seq,
        kind: input.kind,
        reasonCode: input.reasonCode ?? null,
        responseDueAt,
        answersMessageId,
        ladderStep: input.ladderStep ?? null,
        authorUserId: input.author.id,
        authorEmail: input.author.email,
        authorName: input.author.name,
        authorRole: input.author.role,
        source: input.author.source ?? "APP",
        body: input.body,
        replyToId: input.replyToId ?? null,
        contextJson: context ? JSON.stringify(context.data) : null,
        proposalJson: input.proposal ? JSON.stringify(input.proposal) : null,
        escalationDueAt: escalationDue,
        origin: input.origin ?? null,
        ipHash: input.author.ipHash ?? null,
        createdAt: now,
      },
      select: { id: true },
    });

    await tx.jobOrderThread.update({
      where: { id: threadId },
      data: {
        messageCount: seq,
        lastMessageAt: now,
        lastMessageById: input.author.id,
        // A message on a RESOLVED thread reopens it — silence must not be mistaken for closure.
        status: "OPEN",
        resolvedAt: null,
        resolvedById: null,
      },
    });

    // Delivery truth: one row per participant, so the message can say what actually happened.
    // A SYSTEM line is a record, not a message: it never e-mails anyone. Its participants still exist
    // for the badge, so the row is not "sent" in the abstract — there is simply nothing to deliver.
    if (input.kind === "SYSTEM") {
      // A ladder rung is the ONE system line allowed to reach people: it exists to tell a named role that
      // nobody answered. Everything else SYSTEM stays silent, and `audience` absent means silent.
      const rows: Array<{ email: string; state: string }> = [];
      for (const person of input.audience ?? []) {
        const address = person.email?.trim().toLowerCase() ?? "";
        const routable = isRoutableAddress(address);
        await tx.jobOrderMessageRecipient.create({
          data: { messageId: message.id, email: routable ? address : `${address || "unknown"}`, userId: person.userId, state: routable ? "QUEUED" : "NO_ADDRESS" },
        });
        rows.push({ email: address || "unknown", state: routable ? "QUEUED" : "NO_ADDRESS" });
      }
      return { id: message.id, seq, recipients: rows, commitments: [] as Array<{ id: number; dueOn: Date; text: string }> };
    }

    const participants = await tx.jobOrderThreadParticipant.findMany({
      where: { threadId },
      select: { email: true, userId: true, mutedAt: true },
    });

    // Every participant's DELIVERY address is resolved here, per message, from the account behind the
    // participant key. The key itself is a login handle and is never a mailbox. Before this, only the
    // owner was addressed at a routable address; a PM who had posted on the thread was QUEUED at
    // `40032021@employee.local`, the relay refused it, and the delivery line said FAILED for a cause
    // nobody could see from the screen.
    const userIds = participants.map((p) => p.userId).filter((id): id is number => id != null);
    const accountAddresses = new Map<number, string>();
    if (userIds.length) {
      const accounts = await tx.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, email: true, notificationEmail: true },
      });
      for (const account of accounts) {
        const address = (account.notificationEmail?.trim() || account.email || "").trim().toLowerCase();
        if (isRoutableAddress(address)) accountAddresses.set(account.id, address);
      }
    }

    const recipientRows: Array<{ email: string; state: string }> = [];

    for (const participant of participants) {
      const key = participant.email.toLowerCase();
      if (key === input.author.email.toLowerCase()) continue;

      const isOwner = ownerKey != null && key === ownerKey;
      const { address, state } = deliveryTarget({
        key,
        isOwner,
        ownerEmail: owner.email ?? null,
        accountAddress: participant.userId != null ? accountAddresses.get(participant.userId) ?? null : null,
        mutedAt: participant.mutedAt,
        emailOwner: input.emailOwner,
      });
      await tx.jobOrderMessageRecipient.create({
        data: { messageId: message.id, email: address, userId: participant.userId, state },
      });
      recipientRows.push({ email: address, state });
    }

    // Commitments are recorded from any human message, and always editable by a person afterwards.
    const found = input.kind === "SYSTEM" ? [] : extractCommitments(input.body, now);
    const commitments: Array<{ id: number; dueOn: Date; text: string }> = [];
    for (const commitment of found) {
      const row = await tx.jobOrderCommitment.create({
        data: {
          threadId,
          messageId: message.id,
          jobOrderId: input.jobOrderId,
          ownerEmail: input.author.email.toLowerCase(),
          ownerUserId: input.author.id,
          dueOn: commitment.dueOn,
          text: commitment.text,
        },
        select: { id: true, dueOn: true, text: true },
      });
      commitments.push(row);
    }

    return { id: message.id, seq, recipients: recipientRows, commitments };
  });

  return {
    id: created.id,
    threadId,
    seq: created.seq,
    kind: input.kind,
    createdAt: now,
    contextLine: context?.line ?? null,
    recipients: created.recipients,
    commitments: created.commitments,
  };
}

/** A system line: assignment, acknowledgement, escalation rung, resolution. Never e-mailed. */
/**
 * A SYSTEM line.
 *
 * Returns the posted message because a LADDER rung needs its id to queue the mail that goes with it. The
 * optional `ladder` argument is the only way a system line may address people; without it, a system line
 * still e-mails nobody.
 */
export async function postSystemMessage(
  jobOrderId: number,
  body: string,
  author: ConversationAuthor,
  now: Date = new Date(),
  ladder?: { audience?: Array<{ userId: number | null; email: string | null }>; ladderStep?: "REMIND_HOD" | "ESCALATE_COO" }
): Promise<PostedMessage> {
  return postMessage({
    jobOrderId,
    author: { ...author, source: "SYSTEM" },
    kind: "SYSTEM",
    body,
    emailOwner: false,
    now,
    audience: ladder?.audience,
    ladderStep: ladder?.ladderStep ?? null,
  });
}

export type ThreadRow = {
  id: number;
  status: string;
  messageCount: number;
  lastMessageAt: Date;
  unread: number;
};

/** The rows the Conversations page shows, scoped, escalations first. */
export async function listThreads(
  scope: ConversationScope,
  viewerEmail: string,
  options: { take?: number; unreadOnly?: boolean } = {}
) {
  const rows = await prisma.jobOrderThread.findMany({
    where: threadScopeWhere(scope),
    orderBy: [{ lastMessageAt: "desc" }],
    take: options.take ?? 100,
    select: {
      id: true,
      status: true,
      messageCount: true,
      lastMessageAt: true,
      jobOrder: {
        select: {
          id: true,
          code: true,
          name: true,
          department: { select: { name: true } },
          section: { select: { name: true } },
          project: { select: { code: true, name: true } },
        },
      },
      messages: {
        orderBy: { seq: "desc" },
        take: 1,
        select: {
          seq: true,
          kind: true,
          body: true,
          authorName: true,
          authorRole: true,
          createdAt: true,
          escalationDueAt: true,
          acknowledgedAt: true,
        },
      },
      participants: {
        where: { email: viewerEmail.toLowerCase() },
        select: { lastReadSeq: true, mutedAt: true },
      },
    },
  });

  return rows
    .map((row) => {
      const mine = row.participants[0];
      const unread = Math.max(0, row.messageCount - (mine?.lastReadSeq ?? 0));
      return {
        id: row.id,
        jobOrder: row.jobOrder,
        status: row.status,
        messageCount: row.messageCount,
        lastMessageAt: row.lastMessageAt,
        lastMessage: row.messages[0] ?? null,
        unread,
        muted: Boolean(mine?.mutedAt),
      };
    })
    .filter((row) => (options.unreadOnly ? row.unread > 0 : true))
    .sort(orderThreads);
}

export type ThreadOrderRow = {
  unread: number;
  lastMessageAt: Date;
  status: string;
  lastMessage: { kind: string; acknowledgedAt: Date | null } | null;
};

/**
 * The order of the list. PURE, so it is pinned by a test rather than by squinting at a screen.
 *
 * NEW FIRST. A conversation screen is read to find out what has arrived since you last looked, so a
 * thread with unread messages outranks one without — however recently the quiet one was touched.
 * Inside each group an UNANSWERED ESCALATION comes first (it is the one with a clock running), then
 * the most recent activity.
 *
 * This is why an answered escalation no longer floats to the top: being escalated is history once
 * somebody has acknowledged it, and hoisting it above unread work was hiding the thing being asked for.
 */
export function orderThreads<T extends ThreadOrderRow>(a: T, b: T): number {
  const rank = (row: T): number => {
    // A thread opened for a draft but never posted to has nothing to show; it belongs at the end.
    if (!row.lastMessage) return -1;
    const unread = row.unread > 0 ? 2 : 0;
    const escalated = row.status === "OPEN" && row.lastMessage?.kind === "ESCALATION" && !row.lastMessage.acknowledgedAt ? 1 : 0;
    return unread + escalated;
  };
  const byRank = rank(b) - rank(a);
  if (byRank !== 0) return byRank;
  const byUnreadCount = b.unread - a.unread;
  if (byUnreadCount !== 0) return byUnreadCount;
  return b.lastMessageAt.getTime() - a.lastMessageAt.getTime();
}

/** The whole thread for a Job Order, oldest-to-newest (the UI renders it reversed). */
export async function threadFor(jobOrderId: number) {
  return prisma.jobOrderThread.findUnique({
    where: { jobOrderId },
    select: {
      id: true,
      status: true,
      messageCount: true,
      lastMessageAt: true,
      jobOrder: {
        select: {
          id: true,
          code: true,
          name: true,
          status: true,
          project: { select: { code: true, name: true } },
          projectWbs: { select: { wbsCode: true } },
          network: { select: { code: true } },
          department: { select: { name: true } },
          section: { select: { name: true } },
        },
      },
      messages: {
        orderBy: { seq: "asc" },
        select: {
          id: true,
          seq: true,
          kind: true,
          authorUserId: true,
          authorEmail: true,
          authorName: true,
          authorRole: true,
          source: true,
          body: true,
          bodyRevision: true,
          editedAt: true,
          replyToId: true,
          contextJson: true,
          proposalJson: true,
          reasonCode: true,
          responseDueAt: true,
          answersMessageId: true,
          ladderStep: true,
          answeredBy: { select: { id: true, createdAt: true, authorName: true }, take: 1, orderBy: { createdAt: "asc" } },
          escalationDueAt: true,
          acknowledgedAt: true,
          acknowledgedByEmail: true,
          origin: true,
          createdAt: true,
          recipients: { select: { email: true, state: true, sentAt: true } },
          attachments: { select: { id: true, filename: true, sizeBytes: true } },
          commitments: { select: { id: true, dueOn: true, text: true, state: true, ownerEmail: true } },
        },
      },
      participants: {
        orderBy: { addedAt: "asc" },
        select: { id: true, userId: true, email: true, roleAtJoin: true, mutedAt: true, lastReadSeq: true, addedAt: true },
      },
    },
  });
}

export async function markRead(threadId: number, email: string): Promise<void> {
  const thread = await prisma.jobOrderThread.findUnique({ where: { id: threadId }, select: { messageCount: true } });
  if (!thread) return;
  await prisma.jobOrderThreadParticipant.updateMany({
    where: { threadId, email: email.toLowerCase() },
    data: { lastReadAt: new Date(), lastReadSeq: thread.messageCount },
  });
}

/** Unread total for the bell — one grouped read, not one per thread. */
export async function unreadTotal(scope: ConversationScope, email: string): Promise<number> {
  const rows = await prisma.jobOrderThread.findMany({
    where: { ...threadScopeWhere(scope), status: "OPEN" },
    select: { messageCount: true, participants: { where: { email: email.toLowerCase() }, select: { lastReadSeq: true } } },
  });
  return rows.reduce((sum, row) => sum + Math.max(0, row.messageCount - (row.participants[0]?.lastReadSeq ?? 0)), 0);
}

export async function acknowledge(threadId: number, messageId: number, email: string): Promise<boolean> {
  const updated = await prisma.jobOrderMessage.updateMany({
    where: { id: messageId, threadId, kind: "ESCALATION", acknowledgedAt: null },
    data: { acknowledgedAt: new Date(), acknowledgedByEmail: email.toLowerCase() },
  });
  return updated.count > 0;
}

export async function setThreadStatus(threadId: number, status: "OPEN" | "RESOLVED", userId: number | null) {
  return prisma.jobOrderThread.update({
    where: { id: threadId },
    data:
      status === "RESOLVED"
        ? { status, resolvedAt: new Date(), resolvedById: userId }
        : { status, resolvedAt: null, resolvedById: null },
    select: { id: true, status: true },
  });
}
