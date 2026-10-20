import test from "node:test";
import assert from "node:assert/strict";
import {
  buildEscalateHref,
  decideEscalationMode,
  escalationPrefill,
  parseEscalateIntent,
  portfolioReturnHref,
} from "./escalateLink";

/** The Portfolio → conversation link, and the rules that keep it from duplicating escalations. */

test("a row's link carries the Job Order, the intent, the kind, the origin and the tab", () => {
  const href = buildEscalateHref({ jobOrderId: 366, origin: "PORTFOLIO_NEEDS_PUSH", projectId: 15 });
  const url = new URL(href, "http://x");
  assert.equal(url.pathname, "/conversations");
  assert.equal(url.searchParams.get("jobOrder"), "366");
  assert.equal(url.searchParams.get("intent"), "escalate");
  assert.equal(url.searchParams.get("kind"), "ESCALATION");
  assert.equal(url.searchParams.get("origin"), "PORTFOLIO_NEEDS_PUSH");
  assert.equal(url.searchParams.get("from"), "needs-push");
  assert.equal(url.searchParams.get("projectId"), "15");
});

test("the structure origin maps to its own tab and origin", () => {
  const href = buildEscalateHref({ jobOrderId: 9, origin: "PORTFOLIO_STRUCTURE" });
  const url = new URL(href, "http://x");
  assert.equal(url.searchParams.get("from"), "project-structure");
  assert.equal(url.searchParams.get("projectId"), null);
});

test("a plain deep link arms nothing — the old behaviour is preserved exactly", () => {
  assert.deepEqual(parseEscalateIntent(new URLSearchParams("jobOrder=366")), { active: false });
  assert.deepEqual(parseEscalateIntent(new URLSearchParams("")), { active: false });
});

test("the intent is read back, and an unknown origin becomes null rather than a lie", () => {
  const intent = parseEscalateIntent(
    new URLSearchParams("intent=escalate&kind=escalation&origin=PORTFOLIO_SCHEDULE&from=schedule-delays&projectId=15")
  );
  assert.equal(intent.active, true);
  if (!intent.active) return;
  assert.equal(intent.kind, "ESCALATION");
  assert.equal(intent.origin, "PORTFOLIO_SCHEDULE");
  assert.equal(intent.fromTab, "schedule-delays");
  assert.equal(intent.projectId, 15);

  const odd = parseEscalateIntent(new URLSearchParams("intent=escalate&origin=/etc/passwd"));
  assert.equal(odd.active, true);
  if (odd.active) assert.equal(odd.origin, null);
});

test("the return link restores the tab and the project filter", () => {
  const intent = parseEscalateIntent(
    new URLSearchParams("intent=escalate&origin=PORTFOLIO_NEEDS_PUSH&from=needs-push&projectId=15")
  );
  assert.equal(intent.active, true);
  if (!intent.active) return;
  const href = portfolioReturnHref(intent);
  const url = new URL(href, "http://x");
  assert.equal(url.pathname, "/portfolio");
  assert.equal(url.searchParams.get("returnTab"), "needs-push");
  assert.equal(url.searchParams.get("returnProject"), "15");
});

test("the prefill quotes the row's numbers and invents nothing", () => {
  const text = escalationPrefill(
    { code: "B1049" },
    { scheduleBand: "DELAYED", daysToEnd: -6, qtyCompletePct: 0.36, burnPct: 0.82, hoursBand: "AMBER" }
  );
  assert.equal(text.startsWith("B1049 is 6 days past its planned end"), true, text);
  assert.equal(text.includes("36% quantity complete"), true);
  assert.equal(text.includes("82% of budget hours used (AMBER)"), true);
  assert.equal(text.includes("Please confirm the recovery date"), true);
});

test("a row with no plan is escalated as unscheduled, not as late", () => {
  const text = escalationPrefill({ code: "B1049" }, { scheduleBand: "NOT_SCHEDULED", qtyCompletePct: 0 });
  assert.equal(text.includes("no planned window at all"), true);
  assert.equal(text.includes("day"), false, text);
  assert.equal(text.includes("Please set the planned window"), true);
});

test("missing figures drop out of the sentence instead of becoming a zero", () => {
  const text = escalationPrefill({ code: "B1049" }, { burnPct: null, qtyCompletePct: null, scheduleBand: null });
  // Nothing measurable: the Job Order is still named and a date is still asked for, but no number is
  // invented — not even a zero.
  assert.equal(text.startsWith("B1049."), true, text);
  assert.equal(text.includes("%"), false);
  assert.equal(text.includes("NaN"), false);
  assert.equal(text.includes("Please confirm the recovery date"), true);
});

test("an open escalation turns the click into a reply, never a second escalation", () => {
  const messages = [
    { kind: "FOLLOW_UP", seq: 1, createdAt: "2026-10-19T08:00:00Z", acknowledgedAt: null },
    { kind: "ESCALATION", seq: 2, createdAt: "2026-10-19T09:00:00Z", acknowledgedAt: null },
    { kind: "REPLY", seq: 3, createdAt: "2026-10-19T10:00:00Z", acknowledgedAt: null },
  ];
  const mode = decideEscalationMode(messages);
  assert.equal(mode.mode, "REPLY_TO_OPEN");
  if (mode.mode === "REPLY_TO_OPEN") assert.equal(mode.seq, 2);
});

test("an acknowledged escalation no longer blocks a new one", () => {
  const mode = decideEscalationMode([
    { kind: "ESCALATION", seq: 2, createdAt: "2026-10-19T09:00:00Z", acknowledgedAt: "2026-10-19T11:00:00Z" },
  ]);
  assert.equal(mode.mode, "NEW");
});

test("two open escalations: the newest is the one replied to", () => {
  const mode = decideEscalationMode([
    { kind: "ESCALATION", seq: 2, createdAt: "2026-10-18T09:00:00Z", acknowledgedAt: null },
    { kind: "ESCALATION", seq: 5, createdAt: "2026-10-19T09:00:00Z", acknowledgedAt: null },
  ]);
  assert.equal(mode.mode, "REPLY_TO_OPEN");
  if (mode.mode === "REPLY_TO_OPEN") assert.equal(mode.seq, 5);
});
