/**
 * Commitments — the promise inside a reply, turned into something the yard can be held to.
 *
 * PURE and deliberately CONSERVATIVE. It only records a commitment when a sentence carries BOTH a
 * forward-looking verb (resume / finish / confirm / submit / …) AND a recognisable date. A false
 * promise is worse than a missed one: it chases somebody who never promised anything, and after two
 * of those the register is ignored.
 *
 * Every extraction is EDITED BY A HUMAN before it counts — the UI shows "promise recorded: … due …"
 * with "not a promise" one click away, and a dismissed commitment stays dismissed.
 */

export type ExtractedCommitment = {
  text: string;
  dueOn: Date;
  /** How the date was read, so the UI can be honest about a guess. */
  basis: "EXPLICIT" | "WEEKDAY" | "RELATIVE";
};

const VERBS = [
  "resume", "restart", "start", "finish", "complete", "deliver", "confirm", "submit", "send",
  "share", "close", "hand over", "handover", "mobilise", "mobilize", "return", "revert", "provide",
  "arrange", "clear", "release", "be done", "will", "shall", "can do",
];

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** A day at UTC midnight — the app's one representation of a DAY. */
function utcDay(year: number, monthIndex: number, day: number): Date | null {
  const date = new Date(Date.UTC(year, monthIndex, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== monthIndex || date.getUTCDate() !== day) return null;
  return date;
}

/** Add whole days to a UTC day. */
function addDays(day: Date, days: number): Date {
  return new Date(day.getTime() + days * 86_400_000);
}

/** The UTC day of an instant (a message's createdAt). */
export function dayOf(instant: Date): Date {
  return new Date(Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate()));
}

type DateRead = { date: Date; basis: ExtractedCommitment["basis"] } | null;

/**
 * Read ONE date expression from a sentence, relative to `reference`.
 * Order matters: an explicit day is never mistaken for a weekday.
 */
export function readDate(text: string, reference: Date): DateRead {
  const lower = text.toLowerCase();
  const today = dayOf(reference);

  // 1. dd-mm-yyyy / dd/mm/yyyy / dd.mm.yyyy
  const numeric = lower.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/);
  if (numeric) {
    const date = utcDay(Number(numeric[3]), Number(numeric[2]) - 1, Number(numeric[1]));
    if (date) return { date, basis: "EXPLICIT" };
  }

  // 2. yyyy-mm-dd (how the app stores a day)
  const iso = lower.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) {
    const date = utcDay(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    if (date) return { date, basis: "EXPLICIT" };
  }

  // 3. "23 Oct" / "23 October" / "Oct 23" — the year is the reference's.
  const dm = lower.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\b/);
  if (dm) {
    const monthIndex = MONTHS.findIndex((name) => name.startsWith(dm[2].slice(0, 3)));
    if (monthIndex >= 0) {
      const candidate = utcDay(reference.getUTCFullYear(), monthIndex, Number(dm[1]));
      if (candidate) return { date: candidate, basis: "EXPLICIT" };
    }
  }
  const md = lower.match(/\b([a-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?\b/);
  if (md) {
    const monthIndex = MONTHS.findIndex((name) => name.startsWith(md[1].slice(0, 3)));
    if (monthIndex >= 0) {
      const candidate = utcDay(reference.getUTCFullYear(), monthIndex, Number(md[2]));
      if (candidate) return { date: candidate, basis: "EXPLICIT" };
    }
  }

  // 4. A weekday name: the NEXT occurrence, strictly after today.
  for (const [index, name] of WEEKDAYS.entries()) {
    if (new RegExp(`\\b${name}\\b`).test(lower)) {
      const delta = (index - today.getUTCDay() + 7) % 7 || 7;
      return { date: addDays(today, delta), basis: "WEEKDAY" };
    }
  }

  // 5. Relative words. "today" is accepted because "done today" is a promise like any other.
  if (/\btoday\b|\btonight\b|\beod\b|\bend of (the )?day\b/.test(lower)) return { date: today, basis: "RELATIVE" };
  if (/\btomorrow\b/.test(lower)) return { date: addDays(today, 1), basis: "RELATIVE" };
  if (/\bnext week\b/.test(lower)) return { date: addDays(today, 7), basis: "RELATIVE" };
  if (/\bnext month\b/.test(lower)) {
    const date = utcDay(reference.getUTCFullYear(), reference.getUTCMonth() + 1, reference.getUTCDate());
    return date ? { date, basis: "RELATIVE" } : null;
  }
  return null;
}

/**
 * The sentences of a body that read as a commitment.
 *
 * A sentence qualifies when it carries a forward-looking verb AND a date. "Two fitters are on the
 * grating; spools resume Friday." yields one commitment; "Thanks" yields none. At most three are
 * returned, because a message that promises four things needs a human to split it.
 */
export function extractCommitments(body: string, postedAt: Date): ExtractedCommitment[] {
  const out: ExtractedCommitment[] = [];
  const sentences = body
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  for (const sentence of sentences) {
    const lower = sentence.toLowerCase();
    if (!VERBS.some((verb) => lower.includes(verb))) continue;
    const read = readDate(sentence, postedAt);
    if (!read) continue;
    out.push({ text: sentence, dueOn: read.date, basis: read.basis });
    if (out.length === 3) break;
  }
  return out;
}

/** A commitment is only chased once it is due and still open. */
export function isCommitmentDue(state: string, dueOn: Date, now: Date): boolean {
  return state === "OPEN" && dayOf(now).getTime() >= dayOf(dueOn).getTime();
}
