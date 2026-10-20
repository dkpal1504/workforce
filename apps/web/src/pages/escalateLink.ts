/**
 * The link from a Portfolio row to the Job Order's conversation — built, parsed and prefilled here so
 * every rule is a unit test rather than a click.
 *
 * THE CONTRACT IS THE URL. `/conversations?jobOrder=<id>&intent=escalate&origin=…&from=…` is what a
 * row produces; the conversation screen reads it once, prefills the composer, and then CLEARS the
 * intent (replace, not push) so a refresh does not re-arm an escalation somebody dismissed.
 */

export const PORTFOLIO_ORIGINS = [
  "PORTFOLIO_NEEDS_PUSH",
  "PORTFOLIO_SCHEDULE",
  "PORTFOLIO_STRUCTURE",
] as const;

export type PortfolioOrigin = (typeof PORTFOLIO_ORIGINS)[number];

/** The tab an origin comes from, and the label the banner prints. */
export const ORIGIN_META: Record<PortfolioOrigin, { tab: string; label: string }> = {
  PORTFOLIO_NEEDS_PUSH: { tab: "needs-push", label: "Portfolio · Needs push" },
  PORTFOLIO_SCHEDULE: { tab: "schedule-delays", label: "Portfolio · Schedule & delays" },
  PORTFOLIO_STRUCTURE: { tab: "project-structure", label: "Portfolio · Project structure" },
};

export function isPortfolioOrigin(value: unknown): value is PortfolioOrigin {
  return typeof value === "string" && (PORTFOLIO_ORIGINS as readonly string[]).includes(value);
}

export type EscalateLinkInput = {
  jobOrderId: number;
  origin: PortfolioOrigin;
  /** Kept so the drawer can print the project while the thread loads, and the return link can restore it. */
  projectId?: number | null;
  /** The kind to preselect. Only ESCALATION is offered today. */
  kind?: "ESCALATION" | "FOLLOW_UP" | "INSTRUCTION";
};

/** The href a row's Escalate action navigates to. */
export function buildEscalateHref(input: EscalateLinkInput): string {
  const params = new URLSearchParams();
  params.set("jobOrder", String(input.jobOrderId));
  params.set("intent", "escalate");
  params.set("kind", input.kind ?? "ESCALATION");
  params.set("origin", input.origin);
  params.set("from", ORIGIN_META[input.origin].tab);
  if (input.projectId != null) params.set("projectId", String(input.projectId));
  return `/conversations?${params.toString()}`;
}

export type EscalateIntent =
  | { active: false }
  | {
      active: true;
      kind: string;
      origin: PortfolioOrigin | null;
      fromTab: string | null;
      projectId: number | null;
    };

/**
 * What the conversation screen should do with the query string.
 *
 * Only `intent=escalate` arms anything; a bare `?jobOrder=366` is the ordinary deep link and must keep
 * behaving exactly as it did before this feature existed.
 */
export function parseEscalateIntent(params: URLSearchParams): EscalateIntent {
  if (params.get("intent") !== "escalate") return { active: false };
  const rawOrigin = params.get("origin");
  const projectId = Number(params.get("projectId"));
  return {
    active: true,
    kind: (params.get("kind") ?? "ESCALATION").toUpperCase(),
    origin: isPortfolioOrigin(rawOrigin) ? rawOrigin : null,
    fromTab: params.get("from"),
    projectId: Number.isInteger(projectId) && projectId > 0 ? projectId : null,
  };
}

/** Where "Back to the portfolio" goes: same tab, same project filter. */
export function portfolioReturnHref(intent: Extract<EscalateIntent, { active: true }>): string {
  const params = new URLSearchParams();
  const tab = intent.fromTab ?? (intent.origin ? ORIGIN_META[intent.origin].tab : null);
  if (tab) params.set("returnTab", tab);
  if (intent.projectId != null) params.set("returnProject", String(intent.projectId));
  const query = params.toString();
  return query ? `/portfolio?${query}` : "/portfolio";
}

export type PrefillFacts = {
  burnPct?: number | null;
  hoursBand?: string | null;
  scheduleBand?: string | null;
  daysToEnd?: number | null;
  qtyCompletePct?: number | null;
};

function pct(value: number | null | undefined): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  return `${Math.round(value * 100)}%`;
}

/**
 * The opening line of an escalation, built ONLY from figures the report already computed.
 *
 * No model, no template engine, no invention: the same numbers the row was showing, in a sentence a
 * Section Head can act on. If a figure is missing, the sentence drops it rather than guessing — an
 * escalation that quotes a number the dashboard never showed is how trust in both is lost.
 */
export function escalationPrefill(jobOrder: { code: string; name?: string | null }, facts: PrefillFacts): string {
  const parts: string[] = [];

  const schedule = (() => {
    if (facts.scheduleBand === "DELAYED" && facts.daysToEnd != null && facts.daysToEnd < 0) {
      return `${Math.abs(facts.daysToEnd)} day${Math.abs(facts.daysToEnd) === 1 ? "" : "s"} past its planned end`;
    }
    if (facts.scheduleBand === "AT_RISK") return "projected to run past its planned end";
    if (facts.scheduleBand === "DUE_SOON") return "due within days";
    if (facts.scheduleBand === "NOT_SCHEDULED") return "carrying no planned window at all";
    return null;
  })();

  const qty = pct(facts.qtyCompletePct);
  const burn = pct(facts.burnPct);

  // One sentence, a list of true statements. A row with no measurable figures still names the Job
  // Order and still asks for a date — it just does not pretend a number exists.
  const statements: string[] = [];
  if (schedule) statements.push(schedule);
  if (qty) statements.push(`${qty} quantity complete`);
  if (burn) statements.push(`${burn} of budget hours used${facts.hoursBand ? ` (${facts.hoursBand})` : ""}`);
  parts.push(statements.length ? `${jobOrder.code} is ${statements.join(", ")}` : jobOrder.code);

  const ask = schedule === "carrying no planned window at all"
    ? "Please set the planned window and the quantity target, and confirm the date the work will be complete."
    : "Please confirm the recovery date and the crew plan for the remaining scope.";

  return `${parts.join("")}. ${ask}`;
}

export type EscalationMode =
  | { mode: "NEW" }
  | { mode: "REPLY_TO_OPEN"; seq: number; createdAt: string };

/**
 * Never duplicate a live escalation.
 *
 * An escalation starts an 8-hour clock and e-mails somebody. If the thread already carries one that
 * nobody acknowledged, the screen opens on THAT one in reply mode instead of prefilling a second — the
 * single rule that stops the button becoming a machine for raising the same escalation twice.
 */
export function decideEscalationMode(
  messages: ReadonlyArray<{ kind: string; seq: number; createdAt: string; acknowledgedAt: string | null }>
): EscalationMode {
  const open = messages
    .filter((message) => message.kind === "ESCALATION" && !message.acknowledgedAt)
    .sort((a, b) => b.seq - a.seq)[0];
  return open ? { mode: "REPLY_TO_OPEN", seq: open.seq, createdAt: open.createdAt } : { mode: "NEW" };
}
