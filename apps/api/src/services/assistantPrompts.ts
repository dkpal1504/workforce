/**
 * The assistant's PROMPTS — pure, and that is the point.
 *
 * Every number the model is allowed to mention is passed in as the SAME figure the report computed
 * (the Job Order's context stamp): budget/actual hours, burn %, schedule band, days late, quantity
 * completion, days since a booking, unapproved hours, open escalations, overdue promises. The model
 * is told, in the prompt, that it may not introduce a number — and `buildBriefPrompt` returns that
 * fact block as data so a test can assert every figure in the prompt came from it.
 *
 * The model is an OPTIONAL layer: if it is unreachable or disabled, the caller renders the template
 * (no summary paragraph), and every feature still works.
 */

export type BriefFacts = {
  code: string;
  name: string;
  project: string;
  wbs: string;
  network: string | null;
  department: string;
  section: string | null;
  status: string;
  budgetHours: number;
  actualHours: number;
  burnPct: number | null;
  hoursBand: string;
  plannedStart: string | null;
  plannedEnd: string | null;
  scheduleBand: string;
  daysToEnd: number | null;
  targetQty: number;
  achievedQty: number;
  qtyCompletePct: number | null;
  daysSinceActivity: number | null;
  unapprovedHours: number;
  openEscalations: number;
  promisesOverdue: number;
  lastMessages: Array<{ seq: number; kind: string; role: string; body: string }>;
};

/** The fact block, as data. Nothing outside this object may appear as a number in the prompt. */
export function briefFactsBlock(facts: BriefFacts): Record<string, string | number | null> {
  return {
    job_order: `${facts.code} · ${facts.name}`,
    project: facts.project,
    wbs: facts.wbs,
    network: facts.network,
    department: facts.section ? `${facts.department} / ${facts.section}` : facts.department,
    status: facts.status,
    budget_hours: round(facts.budgetHours),
    actual_hours: round(facts.actualHours),
    burn_pct: facts.burnPct === null ? null : round(facts.burnPct * 100),
    hours_band: facts.hoursBand,
    planned_start: facts.plannedStart,
    planned_end: facts.plannedEnd,
    schedule_band: facts.scheduleBand,
    days_to_planned_end: facts.daysToEnd,
    quantity_target: round(facts.targetQty),
    quantity_achieved: round(facts.achievedQty),
    quantity_complete_pct: facts.qtyCompletePct === null ? null : round(facts.qtyCompletePct * 100),
    days_since_last_booking: facts.daysSinceActivity,
    unapproved_hours: round(facts.unapprovedHours),
    open_escalations: facts.openEscalations,
    promises_overdue: facts.promisesOverdue,
  };
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

const SYSTEM = [
  "You are the operations assistant inside Workforce, a shipyard manpower and job-order system.",
  "You write for a shipyard: short sentences, plain words, no marketing language, no emoji.",
  "You may ONLY use the numbers in the FACTS block. Never calculate a new one, never estimate, never mention a figure that is not there.",
  "If the facts do not support a conclusion, say what is missing instead of guessing.",
  "Never write as if you were a person. Never claim a decision was made. You are drafting text for a named human to review.",
].join(" ");

export function buildBriefPrompt(facts: BriefFacts): { system: string; user: string } {
  return {
    system: SYSTEM,
    user: [
      "Write a three-sentence bottleneck brief for this Job Order, then one final line.",
      "Sentence 1: what is happening (schedule and quantity, using the facts).",
      "Sentence 2: what it means operationally (effort still being booked? stalled? approval backlog?).",
      "Sentence 3: the single most likely constraint, but only if the facts or the last messages support it.",
      "Final line, exactly: 'Action for <role>: <one concrete next step>.' Choose the role from Section Head, HOD, Project Manager, Project Planning.",
      "Do not use bullet points. Do not exceed 90 words in total.",
      "",
      `FACTS: ${JSON.stringify(briefFactsBlock(facts))}`,
      facts.lastMessages.length
        ? `LAST MESSAGES:\n${facts.lastMessages.map((m) => `#${m.seq} ${m.role} ${m.kind}: ${m.body}`).join("\n")}`
        : "LAST MESSAGES: none",
    ].join("\n"),
  };
}

export function buildSummaryPrompt(input: {
  jobOrder: string;
  messages: Array<{ seq: number; kind: string; role: string; body: string }>;
  facts: Record<string, string | number | null>;
}): { system: string; user: string } {
  return {
    system: SYSTEM,
    user: [
      "Summarise this Job Order conversation for somebody who has not read it.",
      "Three bullets, each under 18 words: (1) what was asked, (2) what was answered or promised, (3) what is still open.",
      "If a promise carries a date, keep the date as written. Do not add anything that is not in the messages.",
      "",
      `FACTS: ${JSON.stringify(input.facts)}`,
      input.messages.map((m) => `#${m.seq} ${m.role} ${m.kind}: ${m.body}`).join("\n"),
    ].join("\n"),
  };
}

export function buildDraftPrompt(input: {
  kind: string;
  facts: BriefFacts;
  messages: Array<{ seq: number; kind: string; role: string; body: string }>;
  authorRole: string;
  ownerName: string;
  ownerRole: string;
}): { system: string; user: string } {
  const shape = {
    FOLLOW_UP: "a short status chase: what you need, by when, and why it matters",
    INSTRUCTION: "a clear direction: what to do, in what order, and what to report back",
    ESCALATION: "an escalation: the fact, the impact, the decision you need and by when",
    REPLY: "an answer that confirms what you will do and when",
  }[input.kind] ?? "a concise message";

  return {
    system: SYSTEM,
    user: [
      `Draft ${shape}, as ${input.authorRole}, addressed to ${input.ownerName} (${input.ownerRole}).`,
      "At most 70 words. No greeting, no sign-off. If a date is needed, use a date from the facts or one already promised in the messages.",
      "Do not repeat the facts block back; use at most two figures from it.",
      "",
      `FACTS: ${JSON.stringify(briefFactsBlock(input.facts))}`,
      input.messages.length
        ? `LAST MESSAGES:\n${input.messages.map((m) => `#${m.seq} ${m.role} ${m.kind}: ${m.body}`).join("\n")}`
        : "LAST MESSAGES: none",
    ].join("\n"),
  };
}

/**
 * The deterministic half, used when there is no model: the same brief, without the prose.
 * This is what "degrades to a template" means in practice, and it is why the feature is useful on day
 * one even before an endpoint exists.
 */
export function templateBrief(facts: BriefFacts): string {
  const parts: string[] = [];
  const late = facts.daysToEnd !== null && facts.daysToEnd < 0 ? `${Math.abs(facts.daysToEnd)} day(s) past its planned end` : null;
  const qty = facts.qtyCompletePct === null ? null : `${Math.round(facts.qtyCompletePct * 100)}% quantity complete`;
  parts.push(
    [late ?? `${facts.scheduleBand.toLowerCase().replace(/_/g, " ")} on its planned window`, qty]
      .filter(Boolean)
      .join(", ")
  );
  parts.push(
    facts.burnPct === null
      ? "No budget hours are in force, so burn cannot be measured."
      : `${Math.round(facts.burnPct * 100)}% of budget hours booked (${facts.hoursBand}), ${facts.unapprovedHours > 0 ? `${facts.unapprovedHours}h awaiting approval` : "nothing awaiting approval"}.`
  );
  parts.push(
    facts.daysSinceActivity === null
      ? "No booking has ever been made against it."
      : `No hours booked for ${facts.daysSinceActivity} day(s).`
  );
  const role = facts.openEscalations > 0 ? "HOD" : facts.promisesOverdue > 0 ? "Section Head" : "Project Manager";
  const action = facts.openEscalations > 0
    ? "answer the open escalation in the thread"
    : facts.promisesOverdue > 0
      ? "chase the overdue promise and give a date"
      : "confirm the next milestone and the date it will be met";
  return `${parts.join(" ")} Action for ${role}: ${action}.`;
}
