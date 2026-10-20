/**
 * Where a message was raised from, when it was not the conversation screen itself.
 *
 * A CLOSED list, deliberately. The value is stored on the message and read months later to answer
 * "did the dashboard button actually start conversations, or just clicks?" — an open string would decay
 * into twelve spellings of the same three tabs.
 *
 * `null` on a message means the drawer: somebody typed it in the conversation, which is the default and
 * needs no label. Only a message that arrived through a Portfolio row carries an origin.
 */

export const MESSAGE_ORIGINS = [
  "PORTFOLIO_NEEDS_PUSH",
  "PORTFOLIO_SCHEDULE",
  "PORTFOLIO_STRUCTURE",
] as const;

export type MessageOrigin = (typeof MESSAGE_ORIGINS)[number];

const LABELS: Record<MessageOrigin, string> = {
  PORTFOLIO_NEEDS_PUSH: "Portfolio · Needs push",
  PORTFOLIO_SCHEDULE: "Portfolio · Schedule & delays",
  PORTFOLIO_STRUCTURE: "Portfolio · Project structure",
};

export function isMessageOrigin(value: unknown): value is MessageOrigin {
  return typeof value === "string" && (MESSAGE_ORIGINS as readonly string[]).includes(value);
}

/** The label printed on a message that arrived from the dashboard. */
export function originLabel(origin: string | null | undefined): string | null {
  if (!origin) return null;
  return (LABELS as Record<string, string>)[origin] ?? origin;
}

/**
 * The tab a return link should restore. Kept here so the API and the screen agree on what a valid
 * origin maps back to.
 */
export function tabForOrigin(origin: string | null | undefined): "needs-push" | "schedule-delays" | "project-structure" | null {
  switch (origin) {
    case "PORTFOLIO_NEEDS_PUSH":
      return "needs-push";
    case "PORTFOLIO_SCHEDULE":
      return "schedule-delays";
    case "PORTFOLIO_STRUCTURE":
      return "project-structure";
    default:
      return null;
  }
}
