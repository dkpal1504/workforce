/**
 * Job Order conversations — the in-app spine.
 *
 * Every route re-derives the caller's scope from the DATABASE (never from the token or the query
 * string) and then intersects it with the Job Order. A conversation is therefore never a way around
 * the register: if you cannot see the Job Order, you cannot see — or join — its thread.
 *
 * `POST /job-orders/:id/conversation/messages` answers 201 with the stored message and the delivery
 * rows, and starts the e-mail afterwards (`void deliverMessage`). Sending never waits for SMTP.
 */

import express, { Router, type Request } from "express";
import { createHash } from "node:crypto";
import { prisma } from "../db";
import { requireAuth, requireRoles } from "../middleware/auth";
import { writeAudit } from "../audit";
import {
  CONVERSATION_ROLES,
  canAccessJobOrder,
  conversationScopeFor,
  isUserMessageKind,
  jobOrderScopeWhere,
  mayPostKind,
  type ConversationActor,
} from "../services/conversationScope";
import {
  acknowledge,
  listThreads,
  threadScopeWhere,
  markRead,
  postMessage,
  postSystemMessage,
  setThreadStatus,
  threadFor,
  unreadTotal,
} from "../services/conversations";
import { resolveOwner } from "../services/jobOrderContext";
import { isMessageOrigin } from "../services/conversationOrigins";
import { summariseEscalations } from "../services/escalationStats";
import { deliverMessage, conversationEmailEnabled } from "../services/notificationMail";
import { remindersEnabled } from "../services/conversationReminders";
import { elapsedHours, responseStats, slaChip, ageingBucket } from "../services/sla";
import { runSlaLadder } from "../services/slaLadder";
import {
  DELAY_REASONS,
  canChooseReason,
  insightSentence,
  isDelayReason,
  isInsightPeriod,
  periodRange,
  summariseReasons,
  topReasons,
} from "../services/delayReasons";
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_MESSAGE, attachToMessage, downloadTicket, saveUpload, sendDownload, sweepOrphanUploads } from "../services/attachments";
import { deliverySummary } from "../services/conversationText";

export const conversationsRouter = Router();

/**
 * THE GATE IS PER ROUTE, NEVER `use()`.
 *
 * This router is mounted at "/" (its paths cover both /conversations/… and /job-orders/…), and a
 * router-level `use(requireRoles(...))` runs for EVERY request that reaches the mount — including
 * `/departments` and `/teams/pool`, which belong to other routers. A Supervisor, an Employee, HR or
 * Finance is not in CONVERSATION_ROLES, so the blanket gate answered 403 before the request ever
 * reached masters or teams: the whole app died for those roles while looking like "the Department
 * dropdown is blank".
 *
 * Applied per route, a request to any other path simply falls through to the next router via next().
 */
const guarded = [requireAuth, requireRoles(...CONVERSATION_ROLES)];

function actorOf(req: Request): ConversationActor {
  const user = req.user!;
  return {
    id: user.id,
    role: user.role,
    departmentId: user.departmentId,
    sectionId: user.sectionId,
    sectionScope: user.sectionScope,
  };
}

function authorOf(req: Request, source: "APP" | "MAGIC_LINK" = "APP") {
  const user = req.user!;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    source,
    ipHash: hashIp(req.ip ?? ""),
  };
}

function hashIp(ip: string): string | null {
  if (!ip) return null;
  return createHash("sha256").update(ip).digest("hex").slice(0, 32);
}

/** 404 vs 403: an id that does not exist is not "forbidden", and saying so leaks nothing. */
function deny(res: import("express").Response, code: "JOB_ORDER_NOT_FOUND" | "OUT_OF_SCOPE") {
  return res.status(code === "JOB_ORDER_NOT_FOUND" ? 404 : 403).json({
    error: code === "JOB_ORDER_NOT_FOUND" ? "Job Order not found." : "This Job Order is outside your scope.",
    code,
  });
}

/** GET /api/conversations/threads?unread=1 — the list, escalations first. */
conversationsRouter.get("/conversations/threads", ...guarded, async (req, res) => {
  const scope = await conversationScopeFor(actorOf(req));
  const threads = await listThreads(scope, req.user!.email, {
    unreadOnly: req.query.unread === "1",
    take: Math.min(200, Number(req.query.take ?? 100) || 100),
  });
  res.json({ threads, scope: scope.kind, emailEnabled: conversationEmailEnabled() });
});

/**
 * GET /api/conversations/job-orders?q=&projectId=&wbsId=&networkId= — the Job Orders this caller may
 * start a thread on.
 *
 * The three structural filters exist for the Project-structure popover: a WBS or Network node owns
 * several Job Orders and cannot name one itself. They NARROW the scope and never widen it — an id from
 * another project simply intersects to nothing.
 */
conversationsRouter.get("/conversations/job-orders", ...guarded, async (req, res) => {
  const scope = await conversationScopeFor(actorOf(req));
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const asId = (value: unknown): number | undefined => {
    const id = Number(value);
    return Number.isInteger(id) && id > 0 ? id : undefined;
  };
  const projectId = asId(req.query.projectId);
  const wbsId = asId(req.query.wbsId);
  const networkId = asId(req.query.networkId);
  const jobOrders = await prisma.jobOrder.findMany({
    where: {
      ...jobOrderScopeWhere(scope),
      ...(projectId ? { projectId } : {}),
      ...(wbsId ? { projectWbsId: wbsId } : {}),
      ...(networkId ? { networkId } : {}),
      ...(q ? { OR: [{ code: { contains: q } }, { name: { contains: q } }] } : {}),
    },
    orderBy: { code: "asc" },
    take: 60,
    select: {
      id: true,
      code: true,
      name: true,
      status: true,
      project: { select: { code: true, name: true } },
      department: { select: { name: true } },
      section: { select: { name: true } },
      thread: { select: { id: true, messageCount: true, lastMessageAt: true } },
    },
  });
  res.json({ jobOrders });
});

/**
 * GET /api/conversations/escalation-stats?days=90 — did the dashboard button actually start
 * conversations? Scoped like every other read, so a Project Manager sees its own projects only.
 *
 * The first reply is found per escalation with ONE grouped read over the thread's messages: the query
 * pulls the escalations with their thread's messages after them, and the first one by another person
 * wins. Bounded to 500 escalations, which is far more than a quarter produces.
 */
conversationsRouter.get("/conversations/escalation-stats", ...guarded, async (req, res) => {
  const scope = await conversationScopeFor(actorOf(req));
  const days = Math.min(365, Math.max(1, Number(req.query.days ?? 90) || 90));
  const since = new Date(Date.now() - days * 86_400_000);

  const escalations = await prisma.jobOrderMessage.findMany({
    where: { kind: "ESCALATION", createdAt: { gte: since }, thread: threadScopeWhere(scope) },
    orderBy: { createdAt: "desc" },
    take: 500,
    select: {
      id: true,
      seq: true,
      createdAt: true,
      origin: true,
      acknowledgedAt: true,
      authorEmail: true,
      threadId: true,
      thread: {
        select: {
          messages: {
            where: { seq: { gt: 0 } },
            orderBy: { seq: "asc" },
            select: { seq: true, createdAt: true, authorEmail: true },
          },
        },
      },
    },
  });

  const facts = escalations.map((row) => {
    const answer = row.thread.messages.find(
      (message) => message.seq > row.seq && message.authorEmail.toLowerCase() !== row.authorEmail.toLowerCase()
    );
    return {
      id: row.id,
      seq: row.seq,
      createdAt: row.createdAt,
      origin: row.origin,
      acknowledgedAt: row.acknowledgedAt,
      firstReplyAt: answer?.createdAt ?? null,
    };
  });

  res.json({ windowDays: days, ...summariseEscalations(facts) });
});

/** GET /api/conversations/unread — the bell. */
conversationsRouter.get("/conversations/unread", ...guarded, async (req, res) => {
  const scope = await conversationScopeFor(actorOf(req));
  res.json({ unread: await unreadTotal(scope, req.user!.email) });
});

/** GET /api/job-orders/:id/conversation — the drawer. `thread: null` is the empty state, not an error. */
conversationsRouter.get("/job-orders/:id/conversation", ...guarded, async (req, res) => {
  const jobOrderId = Number(req.params.id);
  if (!Number.isInteger(jobOrderId)) return res.status(400).json({ error: "Invalid Job Order." });
  const access = await canAccessJobOrder(actorOf(req), jobOrderId);
  if (!access.ok) return deny(res, access.code);

  const [thread, owner] = await Promise.all([threadFor(jobOrderId), resolveOwner(jobOrderId)]);
  const kinds = ["FOLLOW_UP", "INSTRUCTION", "ESCALATION", "REPLY", "DECISION"].filter((kind) =>
    mayPostKind(req.user!.role, kind)
  );

  if (thread) await markRead(thread.id, req.user!.email);

  // The chip is computed here, once, with one 'now': a screen that subtracts its own clock from a deadline
  // disagrees with the sweep by the length of a tab switch, and the two numbers get reported as a bug.
  const now = new Date();
  const messagesWithSla = thread
    ? {
        ...thread,
        messages: thread.messages.map((message) => {
          const answered = message.answeredBy?.[0]?.createdAt ?? null;
          const targetHours = message.responseDueAt
            ? Math.max(1, Math.round((message.responseDueAt.getTime() - message.createdAt.getTime()) / 3_600_000))
            : 0;
          const chip = slaChip({
            postedAt: message.createdAt,
            dueAt: message.responseDueAt,
            answeredAt: answered,
            now,
            targetHours,
          });
          return {
            ...message,
            sla: {
              targetHours,
              state: chip.state,
              elapsedHours: elapsedHours(message.createdAt, answered ?? now),
              remainingHours: Math.round(chip.remainingHours),
              answeredAt: answered,
              ladderStep: message.ladderStep ?? null,
            },
          };
        }),
      }
    : null;

  res.json({
    jobOrder: access.jobOrder,
    owner,
    thread: messagesWithSla,
    canPostKinds: kinds,
    emailEnabled: conversationEmailEnabled(),
    // Shown as a chip in the drawer: a quiet ladder is then a visible choice, not a mystery.
    remindersEnabled: remindersEnabled(),
    me: { id: req.user!.id, name: req.user!.name, role: req.user!.role, email: req.user!.email },
  });
});

/**
 * GET /api/conversations/reasons — the causes, read from the table rather than a constant.
 *
 * A fresh database is seeded by migration, so this normally returns eight rows. The fallback keeps a
 * half-migrated environment from rendering an empty chip row that looks like a bug in the screen.
 */
conversationsRouter.get("/conversations/reasons", ...guarded, async (_req, res) => {
  const reasons = await prisma.delayReason.findMany({
    where: { active: true },
    orderBy: { sortOrder: "asc" },
    select: { code: true, label: true },
  });
  res.json({ reasons: reasons.length ? reasons : DELAY_REASONS });
});

/**
 * GET /api/job-orders/:id/conversation/insights — the causes on THIS Job Order.
 *
 * Deliberately small: the drawer shows the top three and a total, not a chart. The full picture lives on
 * Reports, where the scope is the reader's portfolio or department.
 */
conversationsRouter.get("/job-orders/:id/conversation/insights", ...guarded, async (req, res) => {
  const jobOrderId = Number(req.params.id);
  if (!Number.isInteger(jobOrderId)) return res.status(400).json({ error: "Invalid Job Order." });
  const access = await canAccessJobOrder(actorOf(req), jobOrderId);
  if (!access.ok) return deny(res, access.code);

  const rows = await prisma.jobOrderMessage.findMany({
    where: { thread: { jobOrderId }, reasonCode: { not: null } },
    select: { reasonCode: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  const summary = summariseReasons(
    rows.map((row) => ({ reasonCode: row.reasonCode, raisedAt: row.createdAt, closedAt: null })),
    new Date()
  );

  res.json({
    total: summary.total,
    uncoded: summary.uncoded,
    top: topReasons(summary, 3),
    byReason: summary.byReason,
  });
});

/**
 * GET /api/conversations/insights/delays — the quarterly picture, scoped like the conversation list.
 *
 * A PM is "Central Planning" here: the scope resolves to his portfolio, HOD/DEPT_HEAD to their
 * department, ADMIN and COO to everything. The window is a calendar period (see periodRange), because a
 * sliding 90 days is a number nobody can reconcile with a board pack.
 */
conversationsRouter.get("/conversations/insights/delays", ...guarded, async (req, res) => {
  const scope = await conversationScopeFor(actorOf(req));
  const period = isInsightPeriod(req.query.period) ? req.query.period : "quarter";
  const now = new Date();
  const { from, to } = periodRange(period, now);

  const departmentId = Number.isInteger(Number(req.query.departmentId)) ? Number(req.query.departmentId) : null;
  const sectionId = Number.isInteger(Number(req.query.sectionId)) ? Number(req.query.sectionId) : null;
  const projectId = Number.isInteger(Number(req.query.projectId)) ? Number(req.query.projectId) : null;

  const rows = await prisma.jobOrderMessage.findMany({
    where: { reasonCode: { not: null }, createdAt: { gte: from, lte: to }, thread: threadScopeWhere(scope) },
    select: {
      reasonCode: true,
      createdAt: true,
      thread: {
        select: { jobOrder: { select: { departmentId: true, sectionId: true, projectId: true } } },
      },
    },
  });

  // The organisational filters are applied here rather than in the query: the row set is one quarter of
  // coded messages, and one WHERE that has to be composed differently for three optional columns is
  // where a scope bug hides.
  const filtered = rows.filter((row) => {
    const order = row.thread.jobOrder;
    if (departmentId != null && order.departmentId !== departmentId) return false;
    if (sectionId != null && order.sectionId !== sectionId) return false;
    if (projectId != null && order.projectId !== projectId) return false;
    return true;
  });

  const summary = summariseReasons(
    filtered.map((row) => ({ reasonCode: row.reasonCode, raisedAt: row.createdAt, closedAt: null })),
    now
  );

  res.json({
    period,
    from: from.toISOString(),
    to: to.toISOString(),
    filters: { departmentId, sectionId, projectId },
    summary,
    sentence: insightSentence(summary, period),
  });
});

/**
 * GET /api/conversations/sla/stats — the response-time panel on Reports.
 *
 * Same scope as the conversation list, same period windows as delay insights. Every message that expected
 * a reply is counted once, and its target travels with it: a 4h escalation and a 24h recovery are not the
 * same promise and must not be averaged together.
 */
conversationsRouter.get("/conversations/sla/stats", ...guarded, async (req, res) => {
  const scope = await conversationScopeFor(actorOf(req));
  const period = isInsightPeriod(req.query.period) ? req.query.period : "quarter";
  const now = new Date();
  const { from, to } = periodRange(period, now);

  const rows = await prisma.jobOrderMessage.findMany({
    where: { responseDueAt: { not: null }, createdAt: { gte: from, lte: to }, thread: threadScopeWhere(scope) },
    select: {
      createdAt: true,
      responseDueAt: true,
      ladderStep: true,
      answeredBy: { select: { createdAt: true }, take: 1, orderBy: { createdAt: "asc" } },
    },
  });

  const stats = responseStats(
    rows.map((row) => ({
      postedAt: row.createdAt,
      dueAt: row.responseDueAt,
      answeredAt: row.answeredBy[0]?.createdAt ?? null,
      targetHours: row.responseDueAt
        ? Math.max(1, Math.round((row.responseDueAt.getTime() - row.createdAt.getTime()) / 3_600_000))
        : 0,
    })),
    now
  );

  res.json({
    period,
    from: from.toISOString(),
    to: to.toISOString(),
    remindersEnabled: remindersEnabled(),
    ...stats,
    buckets: Object.entries(stats.open).map(([bucket, count]) => ({ bucket, count })),
  });
});

/**
 * POST /api/conversations/sla/sweep — run the ladder once, now.
 *
 * Refused while reminders are off: an operator pressing this button must not be able to make the
 * application mail people behind the switch that the policy says is off. When it is on, the timer and this
 * button run the same code.
 */
conversationsRouter.post("/conversations/sla/sweep", ...guarded, async (req, res) => {
  if (req.user!.role !== "PM" && req.user!.role !== "ADMIN" && req.user!.role !== "PROJECT_MANAGER") {
    return res.status(403).json({ error: "Only a Project Manager or an administrator may run the sweep.", code: "SWEEP_NOT_ALLOWED" });
  }
  if (!remindersEnabled()) {
    return res.status(409).json({
      error: "Reminders are switched off on this server (CONVERSATION_REMINDERS_ENABLED), so the sweep will not send anything.",
      code: "REMINDERS_OFF",
    });
  }
  const result = await runSlaLadder(new Date());
  res.json({ ...result, ranAt: new Date().toISOString() });
});

/** POST /api/job-orders/:id/conversation/messages */
conversationsRouter.post("/job-orders/:id/conversation/messages", ...guarded, async (req, res) => {
  const jobOrderId = Number(req.params.id);
  if (!Number.isInteger(jobOrderId)) return res.status(400).json({ error: "Invalid Job Order." });

  const access = await canAccessJobOrder(actorOf(req), jobOrderId);
  if (!access.ok) return deny(res, access.code);

  const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
  const kind = String(req.body?.kind ?? "REPLY").toUpperCase();
  if (!isUserMessageKind(kind) || !mayPostKind(req.user!.role, kind)) {
    return res.status(403).json({ error: `${req.user!.role} may not post a ${kind} message.`, code: "KIND_NOT_ALLOWED" });
  }
  if (!body) return res.status(400).json({ error: "A message cannot be empty.", code: "EMPTY" });
  if (body.length > 4000) return res.status(400).json({ error: "Keep a message under 4000 characters.", code: "TOO_LONG" });

  const replyToId = Number.isInteger(Number(req.body?.replyToId)) ? Number(req.body.replyToId) : null;
  if (replyToId != null) {
    const parent = await prisma.jobOrderMessage.findUnique({
      where: { id: replyToId },
      select: { thread: { select: { jobOrderId: true } } },
    });
    if (!parent || parent.thread.jobOrderId !== jobOrderId) {
      return res.status(400).json({ error: "That message belongs to another Job Order.", code: "BAD_REPLY_TO" });
    }
  }

  // A cause belongs to the person accountable for the work, or to a PM speaking for him. The route is
  // the only place the two facts (the code exists, this author may stamp it) can both be checked against
  // the database, so it is checked here rather than trusted from the client.
  const rawReason = req.body?.reasonCode ?? null;
  let reasonCode: string | null = null;
  if (rawReason !== null && rawReason !== "") {
    if (!isDelayReason(rawReason)) {
      return res.status(400).json({ error: "Unknown delay cause.", code: "BAD_REASON" });
    }
    const owner = await resolveOwner(jobOrderId);
    if (!canChooseReason({ role: req.user!.role, isOwner: owner.userId === req.user!.id })) {
      return res
        .status(403)
        .json({ error: "Only the Job Order owner or a Project Manager may record a delay cause.", code: "REASON_NOT_ALLOWED" });
    }
    reasonCode = rawReason;
  }

  // A DECISION carries a proposed change; only the two roles that may edit Project Master reach here.
  let proposal: unknown = null;
  if (kind === "DECISION") {
    const raw = req.body?.proposal;
    if (raw && typeof raw === "object") {
      const allowed = ["status", "plannedStartDate", "plannedEndDate", "budgetHours", "budgetQuantity"];
      const clean: Record<string, unknown> = {};
      for (const key of allowed) if (key in raw) clean[key] = (raw as Record<string, unknown>)[key];
      proposal = Object.keys(clean).length ? clean : null;
    }
    if (!proposal) return res.status(400).json({ error: "A decision must propose a change.", code: "NO_PROPOSAL" });
  }

  // A CLOSED list. An unknown origin is a client bug, and storing it would poison the only number
  // this column exists to produce.
  const rawOrigin = req.body?.origin ?? null;
  if (rawOrigin !== null && !isMessageOrigin(rawOrigin)) {
    return res.status(400).json({ error: "Unknown origin.", code: "BAD_ORIGIN" });
  }

  const posted = await postMessage({
    jobOrderId,
    author: authorOf(req),
    kind,
    body,
    replyToId,
    proposal,
    emailOwner: req.body?.emailOwner !== false,
    origin: rawOrigin,
    reasonCode,
  });

  const attachmentIds = Array.isArray(req.body?.attachmentIds)
    ? req.body.attachmentIds.map(Number).filter((id: number) => Number.isInteger(id) && id > 0)
    : [];
  const attached = attachmentIds.length
    ? await attachToMessage({ attachmentIds, threadId: posted.threadId, messageId: posted.id, uploadedById: req.user!.id })
    : 0;

  // After the response is committed: mail is a side effect, never a gate.
  void deliverMessage(posted.id).catch(() => undefined);

  res.status(201).json({
    message: {
      id: posted.id,
      seq: posted.seq,
      threadId: posted.threadId,
      kind,
      createdAt: posted.createdAt,
      contextLine: posted.contextLine,
      attachments: attached,
      deliveries: deliverySummary(posted.recipients),
    },
    commitments: posted.commitments,
  });
});

/** POST /api/job-orders/:id/conversation/attachments?filename=… — raw body, one file per request. */
conversationsRouter.post(
  "/job-orders/:id/conversation/attachments",
  ...guarded,
  // The body parser comes AFTER the guard: an unauthenticated caller must be refused before its
  // bytes are buffered into memory.
  express.raw({ type: () => true, limit: MAX_ATTACHMENT_BYTES + 4096 }),
  async (req: Request, res) => {
    const jobOrderId = Number(req.params.id);
    const access = await canAccessJobOrder(actorOf(req), jobOrderId);
    if (!access.ok) return deny(res, access.code);

    const filename = typeof req.query.filename === "string" ? req.query.filename : "";
    if (!filename) return res.status(400).json({ error: "A filename is required.", code: "NO_FILENAME" });
    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

    const thread = await prisma.jobOrderThread.findUnique({ where: { jobOrderId }, select: { id: true } });
    const threadId = thread?.id ?? (await prisma.jobOrderThread.create({ data: { jobOrderId, openedById: req.user!.id }, select: { id: true } })).id;

    const pending = await prisma.jobOrderMessageAttachment.count({ where: { threadId, messageId: null } });
    if (pending >= MAX_ATTACHMENTS_PER_MESSAGE * 2) {
      return res.status(429).json({ error: "Too many unsent attachments on this thread. Send or remove them first.", code: "TOO_MANY_PENDING" });
    }

    const saved = await saveUpload({ threadId, uploadedById: req.user!.id, filename, bytes });
    if ("ok" in saved) {
      return res.status(400).json({
        error:
          saved.reason === "TOO_LARGE"
            ? "A file may be at most 10 MB."
            : saved.reason === "TYPE_NOT_ALLOWED" || saved.reason === "NO_EXTENSION"
              ? "That file type is not accepted. Allowed: PDF, images (PNG/JPG/WEBP), Excel, Word, PowerPoint, CSV, TXT, ZIP."
              : "The file is empty.",
        code: saved.reason,
      });
    }
    res.status(201).json({ attachment: saved, max: MAX_ATTACHMENTS_PER_MESSAGE });
  }
);

/** GET /api/conversations/attachments/:id — scope-checked download. */
conversationsRouter.get("/conversations/attachments/:id", ...guarded, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid attachment." });
  const row = await prisma.jobOrderMessageAttachment.findUnique({ where: { id }, select: { thread: { select: { jobOrderId: true } } } });
  if (!row) return res.status(404).json({ error: "Not found." });
  const access = await canAccessJobOrder(actorOf(req), row.thread.jobOrderId);
  if (!access.ok) return deny(res, access.code);
  const ticket = await downloadTicket(id);
  if (!ticket) return res.status(410).json({ error: "The file is no longer available." });
  sendDownload(res, ticket);
});

/** POST /api/conversations/:id/read */
conversationsRouter.post("/conversations/:id/read", ...guarded, async (req, res) => {
  const thread = await loadThread(req);
  if (!thread) return res.status(404).json({ error: "Not found." });
  const access = await canAccessJobOrder(actorOf(req), thread.jobOrderId);
  if (!access.ok) return deny(res, access.code);
  await markRead(thread.id, req.user!.email);
  res.json({ ok: true });
});

/** POST /api/conversations/:id/resolve | /reopen — a system line records who did it. */
conversationsRouter.post("/conversations/:id/:action(resolve|reopen)", ...guarded, async (req, res) => {
  const thread = await loadThread(req);
  if (!thread) return res.status(404).json({ error: "Not found." });
  const access = await canAccessJobOrder(actorOf(req), thread.jobOrderId);
  if (!access.ok) return deny(res, access.code);

  const status = req.params.action === "resolve" ? "RESOLVED" : "OPEN";
  await setThreadStatus(thread.id, status, req.user!.id);
  await postSystemMessage(
    thread.jobOrderId,
    status === "RESOLVED"
      ? `${req.user!.name} (${req.user!.role}) marked this thread resolved. A new message reopens it.`
      : `${req.user!.name} (${req.user!.role}) reopened this thread.`,
    authorOf(req, "APP")
  );
  res.json({ id: thread.id, status });
});

/** POST /api/conversations/:id/mute {muted: boolean} — per person, per thread. */
conversationsRouter.post("/conversations/:id/mute", ...guarded, async (req, res) => {
  const thread = await loadThread(req);
  if (!thread) return res.status(404).json({ error: "Not found." });
  const access = await canAccessJobOrder(actorOf(req), thread.jobOrderId);
  if (!access.ok) return deny(res, access.code);
  const muted = req.body?.muted !== false;
  await prisma.jobOrderThreadParticipant.updateMany({
    where: { threadId: thread.id, email: req.user!.email.toLowerCase() },
    data: { mutedAt: muted ? new Date() : null },
  });
  res.json({ muted });
});

/** POST /api/conversations/:id/messages/:messageId/acknowledge — "I have seen this". */
conversationsRouter.post("/conversations/:id/messages/:messageId/acknowledge", ...guarded, async (req, res) => {
  const thread = await loadThread(req);
  if (!thread) return res.status(404).json({ error: "Not found." });
  const access = await canAccessJobOrder(actorOf(req), thread.jobOrderId);
  if (!access.ok) return deny(res, access.code);
  const ok = await acknowledge(thread.id, Number(req.params.messageId), req.user!.email);
  if (!ok) return res.status(409).json({ error: "That escalation is already acknowledged, or is not one.", code: "NOT_ACKNOWLEDGEABLE" });
  await postSystemMessage(
    thread.jobOrderId,
    `${req.user!.name} (${req.user!.role}) acknowledged the escalation.`,
    authorOf(req, "APP")
  );
  res.json({ acknowledged: true });
});

/**
 * GET /api/job-orders/:id/conversation/owner — the name the Portfolio popover promises to escalate to.
 * Two queries, cached by the browser for the session; scope-checked like everything else.
 */
conversationsRouter.get("/job-orders/:id/conversation/owner", ...guarded, async (req, res) => {
  const jobOrderId = Number(req.params.id);
  const access = await canAccessJobOrder(actorOf(req), jobOrderId);
  if (!access.ok) return deny(res, access.code);
  const owner = await resolveOwner(jobOrderId);
  res.json({
    owner,
    // What the popover prints while the person has no routable address.
    deliveryNote: owner.email ? null : owner.userId ? "No e-mail address on file" : "No owner set",
  });
});

/** GET /api/job-orders/:id/conversation/owner-candidates — who this Job Order could name as owner. */
conversationsRouter.get("/job-orders/:id/conversation/owner-candidates", ...guarded, async (req, res) => {
  const jobOrderId = Number(req.params.id);
  const access = await canAccessJobOrder(actorOf(req), jobOrderId);
  if (!access.ok) return deny(res, access.code);
  const candidates = await prisma.user.findMany({
    where: {
      active: true,
      departmentId: access.jobOrder.departmentId,
      role: { in: ["HOD", "DEPT_HEAD", "SUPERVISOR", "PM", "PROJECT_MANAGER"] },
    },
    orderBy: { name: "asc" },
    select: { id: true, name: true, role: true, email: true, notificationEmail: true, sectionId: true },
  });
  res.json({
    candidates: candidates.map((user) => ({
      ...user,
      email: user.notificationEmail ?? (user.email.endsWith("@employee.local") ? null : user.email),
    })),
    current: await resolveOwner(jobOrderId),
  });
});

/** PUT /api/job-orders/:id/owner {userId | null} — PM/ADMIN, audited, with a system line in the thread. */
conversationsRouter.put("/job-orders/:id/owner", ...guarded, async (req, res) => {
  if (req.user!.role !== "PM" && req.user!.role !== "ADMIN") {
    return res.status(403).json({ error: "Only a Project Manager or an Admin may name a Job Order owner.", code: "FORBIDDEN" });
  }
  const jobOrderId = Number(req.params.id);
  const access = await canAccessJobOrder(actorOf(req), jobOrderId);
  if (!access.ok) return deny(res, access.code);

  const raw = req.body?.userId;
  const userId = raw === null || raw === "" || raw === undefined ? null : Number(raw);
  if (userId !== null) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, active: true, name: true } });
    if (!user || !user.active) return res.status(400).json({ error: "That account is not active.", code: "BAD_USER" });
    await prisma.jobOrder.update({
      where: { id: jobOrderId },
      data: { ownerUserId: userId, ownerAssignedById: req.user!.id, ownerAssignedAt: new Date() },
    });
    await writeAudit(req.user!.id, "JOB_ORDER_OWNER_SET", "job_order", jobOrderId, { ownerUserId: userId });
    await postSystemMessage(jobOrderId, `${req.user!.name} named ${user.name} as the owner of this Job Order.`, authorOf(req));
  } else {
    await prisma.jobOrder.update({
      where: { id: jobOrderId },
      data: { ownerUserId: null, ownerAssignedById: req.user!.id, ownerAssignedAt: new Date() },
    });
    await writeAudit(req.user!.id, "JOB_ORDER_OWNER_CLEARED", "job_order", jobOrderId, {});
    await postSystemMessage(jobOrderId, `${req.user!.name} cleared the named owner; the Section HOD is addressed instead.`, authorOf(req));
  }

  res.json({ owner: await resolveOwner(jobOrderId) });
});

/** POST /api/conversations/sweep-uploads — the scheduler's hook, exposed for an operator too. */
conversationsRouter.post("/conversations/sweep-uploads", ...guarded, async (req, res) => {
  if (req.user!.role !== "ADMIN") return res.status(403).json({ error: "Admin only." });
  const removed = await sweepOrphanUploads(new Date(Date.now() - 24 * 3_600_000));
  res.json({ removed });
});

async function loadThread(req: Request): Promise<{ id: number; jobOrderId: number } | null> {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return null;
  return prisma.jobOrderThread.findUnique({ where: { id }, select: { id: true, jobOrderId: true } });
}
