/**
 * The text of a conversation — subjects, excerpts, and the HTML the e-mail carries.
 *
 * PURE. The e-mail is built here, not in the route, so the same string can be asserted in a test and
 * so an unescaped body can never be sent: every interpolation goes through `escapeHtml`.
 */

/** The first line of a body, trimmed for a list row or an inbox subject. */
export function excerpt(body: string, limit = 90): string {
  const flat = body.replace(/\s+/g, " ").trim();
  if (flat.length <= limit) return flat;
  return `${flat.slice(0, limit - 1).trimEnd()}…`;
}

/** The Job Order label used in every subject: `1900000107 · Pipe Spool Installation`. */
export function jobOrderLabel(code: string, name: string): string {
  return `${code} · ${name}`;
}

export const KIND_LABELS: Record<string, string> = {
  FOLLOW_UP: "Follow-up",
  INSTRUCTION: "Instruction",
  ESCALATION: "Escalation",
  REPLY: "Reply",
  DECISION: "Decision",
  SYSTEM: "System",
};

export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

/**
 * `[JO 1900000107 · Pipe Spool Installation] Follow-up — re-sequence spools`
 *
 * The kind and the excerpt travel in the subject so the mailbox list is scannable without opening
 * anything, and the `[JO …]` prefix is what mail clients thread on in practice.
 */
export function emailSubject(jobOrder: { code: string; name: string }, kind: string, body: string): string {
  return `[JO ${jobOrderLabel(jobOrder.code, jobOrder.name)}] ${kindLabel(kind)} — ${excerpt(body, 60)}`;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Turn bare URLs into anchors, and NOTHING else. Deliberately not a markdown renderer: a message is
 * plain text, so there is no syntax to execute and no HTML to sanitise beyond the escaping above.
 */
export function linkify(escaped: string): string {
  return escaped.replace(/(https?:\/\/[^\s<]+)/g, (url) => `<a href="${url}">${url}</a>`);
}

/** A body ready to sit inside a `<div>`: escaped, newlines kept, links clickable. */
export function renderBodyHtml(body: string): string {
  return linkify(escapeHtml(body)).replace(/\r?\n/g, "<br>");
}

export type DeliveryLine = { email: string; state: string };

/**
 * One honest sentence per recipient, shown under the message in the app:
 *   "emailed to r.patil@swan.co.in · delivered 14:32"
 *   "not emailed — no address on file"
 * It never says "sent" without a recipient, which is how a silent failure hides.
 */
export function deliverySummary(lines: readonly DeliveryLine[]): string[] {
  return lines.map((line) => {
    if (line.state === "SENT") return `emailed to ${line.email}`;
    if (line.state === "QUEUED") return `queued for ${line.email}`;
    if (line.state === "FAILED") return `could not email ${line.email}`;
    if (line.state === "NO_ADDRESS") return "not emailed — no address on file";
    if (line.state === "MUTED") return `not emailed — ${line.email} muted this thread`;
    if (line.state === "EMAIL_OFF") return "not emailed — e-mail is switched off";
    return `${line.state.toLowerCase()} · ${line.email}`;
  });
}
