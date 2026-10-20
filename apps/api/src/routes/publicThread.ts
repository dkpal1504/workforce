/**
 * The no-login reply page — one signed link, one Job Order, one address.
 *
 * Deliberately outside `requireAuth`, and deliberately narrow: GET renders the whole trail for that
 * Job Order (the user's answer 5), POST appends a reply. It cannot list threads, cannot touch another
 * Job Order, cannot approve, cannot read a budget, and expires in 30 days.
 *
 * No "click to confirm" anywhere: a mail scanner that follows links only ever GETs, so following the
 * link has no side effect at all.
 */

import { Router } from "express";
import { prisma } from "../db";
import { hashReplyToken, tokenState } from "../services/replyToken";
import { deliverMessage } from "../services/notificationMail";
import { postMessage } from "../services/conversations";
import { downloadTicket, sendDownload } from "../services/attachments";

export const publicThreadRouter = Router();

/** A coarse in-memory brake: 10 replies per token per 10 minutes. Restart clears it — acceptable. */
const attempts = new Map<string, { count: number; resetAt: number }>();
function allowAttempt(key: string): boolean {
  const now = Date.now();
  const row = attempts.get(key);
  if (!row || row.resetAt < now) {
    attempts.set(key, { count: 1, resetAt: now + 600_000 });
    return true;
  }
  if (row.count >= 10) return false;
  row.count += 1;
  return true;
}

type Loaded = Awaited<ReturnType<typeof loadByToken>>;

async function loadByToken(token: string) {
  if (!token || token.length < 20 || token.length > 128) return null;
  const row = await prisma.jobOrderReplyToken.findUnique({
    where: { tokenHash: hashReplyToken(token) },
    select: {
      id: true,
      email: true,
      userId: true,
      expiresAt: true,
      revokedAt: true,
      useCount: true,
      thread: {
        select: {
          id: true,
          status: true,
          messageCount: true,
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
              authorName: true,
              authorRole: true,
              authorEmail: true,
              body: true,
              createdAt: true,
              contextJson: true,
              acknowledgedAt: true,
              attachments: { select: { id: true, filename: true, sizeBytes: true } },
            },
          },
        },
      },
    },
  });

  if (!row) return null;
  const state = tokenState(row, new Date());
  if (state !== "USABLE") return { state, row } as const;
  return { state: "USABLE" as const, row };
}

/** GET /api/thread/:token — the thread, the sender's identity, and what the page may do. */
publicThreadRouter.get("/:token", async (req, res) => {
  const loaded = await loadByToken(req.params.token);
  if (!loaded) return res.status(404).json({ error: "This link is not valid.", code: "INVALID_LINK" });
  if (loaded.state !== "USABLE") {
    return res.status(410).json({
      error: loaded.state === "EXPIRED" ? "This link has expired. Ask for a new message." : "This link has been revoked.",
      code: loaded.state,
    });
  }

  const { row } = loaded;
  const person = row.userId
    ? await prisma.user.findUnique({ where: { id: row.userId }, select: { name: true, role: true } })
    : null;

  res.json({
    thread: row.thread,
    me: { email: row.email, name: person?.name ?? row.email.split("@")[0], role: person?.role ?? "Guest" },
    // Even a RESOLVED thread accepts a reply: the message reopens it, which is the documented rule.
    canReply: true,
    expiresAt: row.expiresAt,
  });
});

/** POST /api/thread/:token/messages — append a reply as the addressed person. */
publicThreadRouter.post("/:token/messages", async (req, res) => {
  if (!allowAttempt(`token:${req.params.token}`)) {
    return res.status(429).json({ error: "Too many replies from this link. Try again in a few minutes.", code: "RATE_LIMITED" });
  }
  const loaded = await loadByToken(req.params.token);
  if (!loaded || loaded.state !== "USABLE") {
    return res.status(410).json({ error: "This link is no longer valid.", code: "LINK_NOT_USABLE" });
  }
  const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
  if (!body) return res.status(400).json({ error: "A reply cannot be empty.", code: "EMPTY" });
  if (body.length > 4000) return res.status(400).json({ error: "Keep a reply under 4000 characters.", code: "TOO_LONG" });

  const { row } = loaded;
  const person = row.userId
    ? await prisma.user.findUnique({ where: { id: row.userId }, select: { name: true, role: true } })
    : null;

  const posted = await postMessage({
    jobOrderId: row.thread.jobOrder.id,
    author: {
      id: row.userId,
      email: row.email,
      name: person?.name ?? row.email.split("@")[0],
      role: person?.role ?? "Guest",
      source: "MAGIC_LINK",
      ipHash: null,
    },
    kind: "REPLY",
    body,
    emailOwner: true,
  });

  const attachmentIds = Array.isArray(req.body?.attachmentIds)
    ? req.body.attachmentIds.map(Number).filter((id: number) => Number.isInteger(id) && id > 0)
    : [];
  if (attachmentIds.length) {
    // Only the sender's own pending uploads in THIS thread are attachable — the same rule as in-app.
    const updated = await prisma.jobOrderMessageAttachment.updateMany({
      where: { id: { in: attachmentIds.slice(0, 5) }, threadId: row.thread.id, messageId: null },
      data: { messageId: posted.id },
    });
    if (!updated.count) {
      /* nothing attached; the reply still stands */
    }
  }

  await prisma.jobOrderReplyToken.update({
    where: { id: row.id },
    data: { useCount: { increment: 1 }, lastUsedAt: new Date() },
  });
  await prisma.jobOrderThreadParticipant.updateMany({
    where: { threadId: row.thread.id, email: row.email.toLowerCase() },
    data: { lastReadAt: new Date(), lastReadSeq: row.thread.messageCount },
  });

  void deliverMessage(posted.id).catch(() => undefined);

  res.status(201).json({ ok: true, seq: posted.seq });
});

/** GET /api/thread/:token/attachments/:id — the same file, authorised by the token instead of a login. */
publicThreadRouter.get("/:token/attachments/:id", async (req, res) => {
  const loaded = await loadByToken(req.params.token);
  if (!loaded || loaded.state !== "USABLE") return res.status(410).json({ error: "This link is no longer valid." });
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid attachment." });
  const row = await prisma.jobOrderMessageAttachment.findUnique({
    where: { id },
    select: { threadId: true },
  });
  if (!row || row.threadId !== loaded.row.thread.id) return res.status(404).json({ error: "Not found." });
  const ticket = await downloadTicket(id);
  if (!ticket) return res.status(410).json({ error: "The file is no longer available." });
  sendDownload(res, ticket);
});

/** POST /api/thread/:token/acknowledge/:messageId */
publicThreadRouter.post("/:token/acknowledge/:messageId", async (req, res) => {
  const loaded = await loadByToken(req.params.token);
  if (!loaded || loaded.state !== "USABLE") return res.status(410).json({ error: "This link is no longer valid." });
  const updated = await prisma.jobOrderMessage.updateMany({
    where: { id: Number(req.params.messageId), threadId: loaded.row.thread.id, kind: "ESCALATION", acknowledgedAt: null },
    data: { acknowledgedAt: new Date(), acknowledgedByEmail: loaded.row.email.toLowerCase() },
  });
  if (!updated.count) return res.status(409).json({ error: "Already acknowledged, or not an escalation." });
  res.json({ acknowledged: true });
});
