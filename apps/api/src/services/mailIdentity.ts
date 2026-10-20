/**
 * Who the notification says it is from, and who a reply goes to.
 *
 * THE SEPARATION THAT MATTERS: the mailbox that AUTHENTICATES (the envelope, checked by SPF/DKIM/DMARC)
 * stays one service account; the From LINE carries the person's name, and Reply-To carries their
 * address. Recipients see "Sunil Babariya (Project Manager) · Workforce" and replying writes to Sunil —
 * without the app ever pretending to be his mailbox, which is what gets mail junked.
 *
 * `CONVERSATION_FROM_MODE=sender` exists for the case where IT has granted Send As on the mailboxes and
 * the relay genuinely accepts the person's address. It is NOT the default and it falls back to `display`
 * the moment the author has no routable address, because a From with a login handle (40032021@employee.local)
 * is worse than the robot's.
 *
 * Pure: the header strings are asserted in a test, not discovered in a mailbox.
 */

export type FromMode = "display" | "sender";

const ROLE_LABELS: Record<string, string> = {
  PROJECT_MANAGER: "Project Manager",
  PM: "Project Head",
  HOD: "Section HOD",
  DEPT_HEAD: "Department Head",
  COO: "COO",
  ADMIN: "Administrator",
  SUPERVISOR: "Supervisor",
  EMPLOYEE: "Employee",
  HR: "HR",
  FINANCE: "Finance",
};

export function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role.replace(/_/g, " ").toLowerCase();
}

/**
 * A login handle is not a mailbox. `@employee.local` is the placeholder the import writes, and
 * `noreply`-style addresses should never receive a reply.
 */
export function isRoutableAddress(email: string | null | undefined): boolean {
  if (!email) return false;
  const value = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) return false;
  if (value.endsWith("@employee.local")) return false;
  if (value.startsWith("noreply@") || value.startsWith("no-reply@")) return false;
  return true;
}

/** The bare address inside `"Name" <a@b.c>`, or the string itself. */
export function addressOf(mailbox: string): string {
  const angled = /<([^>]+)>/.exec(mailbox);
  return (angled ? angled[1] : mailbox).trim();
}

/**
 * A display name safe for a header: no quotes, angle brackets, commas, control characters.
 * A name is data from the users table and must not be able to break the header.
 */
export function safeDisplayName(name: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/["<>,;:\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return cleaned || "Workforce";
}

export type MailIdentity = {
  /** The full From header value. */
  from: string;
  /** Reply-To, or null when the author has no routable address. */
  replyTo: string | null;
  /** Which mode was actually applied — `sender` degrades to `display` without an address. */
  appliedMode: FromMode;
  /** Why it degraded, for the delivery row / the log. */
  note: string | null;
};

export function mailIdentity(input: {
  authorName: string;
  authorRole: string;
  authorEmail: string | null | undefined;
  /** The authenticated mailbox, e.g. `noreply@swan.co.in` or `"Workforce" <noreply@swan.co.in>`. */
  serviceFrom: string;
  mode?: FromMode;
}): MailIdentity {
  const wanted: FromMode = input.mode ?? "display";
  const serviceAddress = addressOf(input.serviceFrom);
  const label = `${safeDisplayName(input.authorName)} (${roleLabel(input.authorRole)}) - Workforce`;
  const routable = isRoutableAddress(input.authorEmail) ? (input.authorEmail as string).trim() : null;

  if (wanted === "sender") {
    if (routable) {
      return { from: `"${label}" <${routable}>`, replyTo: routable, appliedMode: "sender", note: null };
    }
    return {
      from: `"${label}" <${serviceAddress}>`,
      replyTo: null,
      appliedMode: "display",
      note: "The author has no routable address, so the notification is sent from the service mailbox.",
    };
  }

  return {
    from: `"${label}" <${serviceAddress}>`,
    replyTo: routable,
    appliedMode: "display",
    note: routable ? null : "The author has no routable address, so replies go to the service mailbox.",
  };
}

export function fromModeFromEnv(value: string | undefined): FromMode {
  return (value ?? "").trim().toLowerCase() === "sender" ? "sender" : "display";
}
