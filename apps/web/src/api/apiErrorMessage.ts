/**
 * Turn an API error body into the sentence a user can act on.
 *
 * Why this is a separate, unit-tested function: the API answers a validation failure with a
 * Zod *flattened* error, i.e. `{ error: { formErrors: [], fieldErrors: { newPassword: [...] } } }`.
 * The old extraction read `err.formErrors?.[0] || err.message || res.statusText`, and Zod
 * flattening reports per-field messages in `fieldErrors` with `formErrors` empty — so it fell
 * through to the HTTP reason phrase and the screen showed "Bad Request". Six routes produce
 * that shape (auth/login, auth/change-password, teams/today, timesheet/day, /bulk-assign,
 * /entry), which is why the fix belongs here rather than in each page.
 *
 * Deliberately tolerant: it must produce a usable sentence for every shape the API can
 * return, and never the string "[object Object]".
 */

type Flattened = {
  formErrors?: unknown;
  fieldErrors?: Record<string, unknown>;
};

/** A Zod field name -> the label a person recognises. */
const FIELD_LABELS: Record<string, string> = {
  newPassword: "New password",
  currentPassword: "Current password",
  password: "Password",
  identifier: "EC No or email",
};

function firstString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = firstString(entry);
      if (found) return found;
    }
  }
  return null;
}

function fromFieldErrors(fieldErrors: Record<string, unknown> | undefined): string | null {
  if (!fieldErrors) return null;
  const parts: string[] = [];
  for (const [field, messages] of Object.entries(fieldErrors)) {
    const message = firstString(messages);
    if (!message) continue;
    const label = FIELD_LABELS[field] ?? field;
    // The Zod messages are already complete sentences about their field ("Password must
    // contain a symbol", "New password must be different from the current password"), so the
    // label is only added when the message does not mention the field at all — e.g. a bare
    // "Required". Comparing core words rather than prefixes is what makes "New password" and
    // "Password must contain a symbol" recognise each other.
    const core = label.toLowerCase().replace(/^(new|current|confirm|temporary)\s+/, "");
    parts.push(message.toLowerCase().includes(core) ? message : `${label}: ${message}`);
  }
  return parts.length ? parts.join(" ") : null;
}

/**
 * @param error   the `error` value from the response body (string, flattened Zod object, or anything else)
 * @param statusText the HTTP reason phrase, used only as a last resort
 */
export function apiErrorMessage(error: unknown, statusText = "Request failed"): string {
  if (typeof error === "string" && error.trim()) return error;
  if (error && typeof error === "object") {
    const flat = error as Flattened;
    const field = fromFieldErrors(flat.fieldErrors);
    if (field) return field;
    const form = firstString(flat.formErrors);
    if (form) return form;
    const message = firstString((error as { message?: unknown }).message);
    if (message) return message;
  }
  return statusText || "Request failed";
}
