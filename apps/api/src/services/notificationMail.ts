/**
 * One e-mail per message, and an honest record of what happened to it.
 *
 * The mail is the same conversation, not a copy: it carries the Job Order, the frozen context line,
 * the sender's role, the body, every attachment NAME (never the bytes — a 10 MB drawing does not belong
 * in an inbox), and a button that opens the thread without an account.
 *
 * Failure never rolls back the message: the message is already in the trail, and the recipient row
 * records what went wrong, so the UI can say "could not email" instead of pretending.
 */

import { prisma } from "../db";
import { safeSmtpError, smtpConfigured, createSmtpTransport } from "./smtp";
import { emailSubject, escapeHtml, jobOrderLabel, kindLabel, renderBodyHtml, type DeliveryLine } from "./conversationText";
import { createReplyTokenValue, hashReplyToken, replyLink, replyTokenExpiry } from "./replyToken";
import { fromModeFromEnv, mailIdentity } from "./mailIdentity";

export function conversationEmailEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.CONVERSATION_EMAIL_ENABLED ?? "true").toLowerCase() !== "false" && smtpConfigured();
}

export function appBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.APP_BASE_URL ?? "http://localhost:5173").replace(/\/+$/, "");
}

export type MailInput = {
  jobOrder: { code: string; name: string; project: string; department: string };
  kind: string;
  authorName: string;
  authorRole: string;
  body: string;
  contextLine: string | null;
  attachments: Array<{ filename: string; sizeBytes: number }>;
  link: string;
  seq: number;
  threadStatus: string;
};

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The message. Table-based, inline styles, no web font: the corporate mail client is the target, not
 * a browser. Colours are the Nocturne palette's neutrals so the mail does not look like another product.
 */
export function buildMessageEmail(input: MailInput): { subject: string; html: string; text: string } {
  const subject = emailSubject(input.jobOrder, input.kind, input.body);
  const attachments = input.attachments.length
    ? `<tr><td style="padding:0 24px 16px"><div style="font:12px/1.6 Segoe UI,Arial,sans-serif;color:#6b7785">Attachments: ${input.attachments
        .map((file) => `${escapeHtml(file.filename)} (${humanSize(file.sizeBytes)})`)
        .join(" · ")}</div></td></tr>`
    : "";
  const context = input.contextLine
    ? `<tr><td style="padding:0 24px 14px"><div style="font:12px/1.6 Consolas,monospace;color:#8a94a3;border-left:2px solid #2f3a4a;padding-left:10px">${escapeHtml(
        input.contextLine
      )}</div></td></tr>`
    : "";

  const html = `<!doctype html><html><body style="margin:0;background:#0f141b;padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto;background:#151c25;border:1px solid #26303d;border-radius:10px">
  <tr><td style="padding:20px 24px 8px">
    <div style="font:11px/1.4 Segoe UI,Arial,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:#8a94a3">
      ${escapeHtml(input.jobOrder.project)} · ${escapeHtml(input.jobOrder.department)}
    </div>
    <div style="font:600 18px/1.35 Segoe UI,Arial,sans-serif;color:#e8eef6;margin-top:6px">
      ${escapeHtml(jobOrderLabel(input.jobOrder.code, input.jobOrder.name))}
    </div>
    <div style="font:12px/1.5 Segoe UI,Arial,sans-serif;color:#8a94a3;margin-top:4px">
      ${escapeHtml(kindLabel(input.kind))} #${input.seq} · ${escapeHtml(input.authorName)} (${escapeHtml(input.authorRole)})
    </div>
  </td></tr>
  ${context}
  <tr><td style="padding:0 24px 4px">
    <div style="font:14px/1.65 Segoe UI,Arial,sans-serif;color:#dbe3ee">${renderBodyHtml(input.body)}</div>
  </td></tr>
  ${attachments}
  <tr><td style="padding:8px 24px 22px">
    <a href="${input.link}" style="display:inline-block;background:#3b82f6;color:#ffffff;text-decoration:none;font:600 14px/1 Segoe UI,Arial,sans-serif;padding:12px 18px;border-radius:6px">Reply to this thread</a>
    <div style="font:11px/1.6 Segoe UI,Arial,sans-serif;color:#6b7785;margin-top:10px">
      You can answer without signing in. The link opens this Job Order's conversation only, and expires in 30 days.
    </div>
  </td></tr>
  <tr><td style="padding:0 24px 20px">
    <div style="font:11px/1.6 Segoe UI,Arial,sans-serif;color:#6b7785;border-top:1px solid #26303d;padding-top:12px">
      Workforce · ${escapeHtml(input.jobOrder.code)} · thread ${escapeHtml(input.threadStatus.toLowerCase())}
    </div>
  </td></tr>
</table></body></html>`;

  const text = [
    `${jobOrderLabel(input.jobOrder.code, input.jobOrder.name)} — ${kindLabel(input.kind)} #${input.seq}`,
    `${input.authorName} (${input.authorRole})`,
    input.contextLine ? `[${input.contextLine}]` : "",
    "",
    input.body,
    "",
    ...(input.attachments.length ? [`Attachments: ${input.attachments.map((file) => file.filename).join(", ")}`, ""] : []),
    `Reply: ${input.link}`,
  ]
    .filter((line) => line !== "")
    .join("\n");

  return { subject, html, text };
}

/** A usable token for this address on this thread: reuse a live one, else mint one. */
async function tokenFor(threadId: number, email: string, userId: number | null): Promise<string> {
  const now = new Date();
  const existing = await prisma.jobOrderReplyToken.findFirst({
    where: { threadId, email: email.toLowerCase(), revokedAt: null, expiresAt: { gt: now } },
    orderBy: { createdAt: "desc" },
  });
  if (existing) {
    const value = createReplyTokenValue();
    // We cannot recover a stored token from its hash, so a live row is not enough: mint a fresh one and
    // let the old row expire naturally. Only ONE usable value exists per send, which is what bounds the
    // blast radius of a forwarded mail.
    await prisma.jobOrderReplyToken.create({
      data: {
        tokenHash: hashReplyToken(value),
        threadId,
        email: email.toLowerCase(),
        userId,
        expiresAt: replyTokenExpiry(now),
      },
    });
    return value;
  }
  const value = createReplyTokenValue();
  await prisma.jobOrderReplyToken.create({
    data: {
      tokenHash: hashReplyToken(value),
      threadId,
      email: email.toLowerCase(),
      userId,
      expiresAt: replyTokenExpiry(now),
    },
  });
  return value;
}

/**
 * Send every QUEUED recipient row of one message.
 *
 * Fire-and-forget from the route (`void deliverMessage(id)`), so the HTTP response never waits on
 * SMTP. Each row is updated to SENT / FAILED, or EMAIL_OFF when the feature is not configured — the
 * third state matters: "queued" for ever is a lie.
 */
export async function deliverMessage(messageId: number): Promise<DeliveryLine[]> {
  const message = await prisma.jobOrderMessage.findUnique({
    where: { id: messageId },
    select: {
      id: true,
      seq: true,
      kind: true,
      body: true,
      contextJson: true,
      createdAt: true,
      threadId: true,
      authorName: true,
      authorRole: true,
      authorEmail: true,
      recipients: { where: { state: "QUEUED" }, select: { id: true, email: true, userId: true } },
      attachments: { select: { filename: true, sizeBytes: true } },
      thread: {
        select: {
          status: true,
          jobOrder: {
            select: {
              code: true,
              name: true,
              project: { select: { code: true, name: true } },
              department: { select: { name: true } },
            },
          },
        },
      },
    },
  });
  if (!message || message.recipients.length === 0) return [];

  const lines: DeliveryLine[] = [];
  if (!conversationEmailEnabled()) {
    await prisma.jobOrderMessageRecipient.updateMany({
      where: { id: { in: message.recipients.map((row) => row.id) } },
      data: { state: "EMAIL_OFF" },
    });
    return message.recipients.map((row) => ({ email: row.email, state: "EMAIL_OFF" }));
  }

  const contextLine = message.contextJson
    ? (() => {
        try {
          const data = JSON.parse(message.contextJson) as { burnPct: number | null; hoursBand: string; scheduleBand: string; daysToEnd: number | null; qtyCompletePct: number | null; revisionNo: number | null };
          const pct = (value: number | null) => (value === null ? "—" : `${Math.round(value * 100)}%`);
          return `Burn ${pct(data.burnPct)} ${data.hoursBand} · Schedule ${data.scheduleBand}${data.daysToEnd !== null && data.daysToEnd < 0 ? ` ${Math.abs(data.daysToEnd)}d` : ""} · Qty ${pct(data.qtyCompletePct)} · ${data.revisionNo === null ? "no budget revision" : `Budget rev ${data.revisionNo}`}`;
        } catch {
          return null;
        }
      })()
    : null;

  const transport = createSmtpTransport();
  const serviceFrom = process.env.CONVERSATION_FROM ?? process.env.SMTP_FROM ?? process.env.SMTP_USER ?? "workforce@localhost";
  // The person who wrote the message speaks through the notification: their name on the From line, and
  // — when they have a real address — their mailbox as Reply-To. The authenticated envelope stays the
  // service account, which is what keeps the mail deliverable. See services/mailIdentity.ts.
  const identity = mailIdentity({
    authorName: message.authorName,
    authorRole: message.authorRole,
    authorEmail: message.authorEmail,
    serviceFrom,
    mode: fromModeFromEnv(process.env.CONVERSATION_FROM_MODE),
  });

  for (const recipient of message.recipients) {
    try {
      const token = await tokenFor(message.threadId, recipient.email, recipient.userId);
      const mail = buildMessageEmail({
        jobOrder: {
          code: message.thread.jobOrder.code,
          name: message.thread.jobOrder.name,
          project: `${message.thread.jobOrder.project.code} · ${message.thread.jobOrder.project.name}`,
          department: message.thread.jobOrder.department.name,
        },
        kind: message.kind,
        authorName: message.authorName,
        authorRole: message.authorRole,
        body: message.body,
        contextLine,
        attachments: message.attachments,
        link: replyLink(appBaseUrl(), token),
        seq: message.seq,
        threadStatus: message.thread.status,
      });
      await transport.sendMail({
        from: identity.from,
        to: recipient.email,
        ...(identity.replyTo ? { replyTo: identity.replyTo } : {}),
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      });
      await prisma.jobOrderMessageRecipient.update({ where: { id: recipient.id }, data: { state: "SENT", sentAt: new Date() } });
      lines.push({ email: recipient.email, state: "SENT" });
    } catch (error) {
      await prisma.jobOrderMessageRecipient.update({
        where: { id: recipient.id },
        data: { state: "FAILED", error: safeSmtpError(error).slice(0, 300) },
      });
      lines.push({ email: recipient.email, state: "FAILED" });
    }
  }
  return lines;
}
