import test from "node:test";
import assert from "node:assert/strict";
import { dayOf, extractCommitments, isCommitmentDue, readDate } from "./commitmentExtraction";
import { escalationStep, escalationDueAt, unansweredHours, DEFAULT_ESCALATION_CLOCK } from "./escalationClock";
import { createReplyTokenValue, hashReplyToken, replyTokenExpiry, replyTokenMatches, tokenState } from "./replyToken";

/** The promise register and the clock. Both pure; both are what make a follow-up answerable. */

// 2026-10-19 is a Monday.
const MONDAY = new Date("2026-10-19T09:30:00Z");

test("a weekday resolves to the NEXT occurrence, never today", () => {
  const friday = readDate("spools resume Friday", MONDAY);
  assert.equal(friday?.basis, "WEEKDAY");
  assert.equal(friday?.date.toISOString().slice(0, 10), "2026-10-23");
  const monday = readDate("will confirm Monday", MONDAY);
  assert.equal(monday?.date.toISOString().slice(0, 10), "2026-10-26");
});

test("explicit dates are read in every shape the yard writes them", () => {
  assert.equal(readDate("done by 23-10-2026", MONDAY)?.date.toISOString().slice(0, 10), "2026-10-23");
  assert.equal(readDate("done by 23/10/2026", MONDAY)?.date.toISOString().slice(0, 10), "2026-10-23");
  assert.equal(readDate("done by 2026-10-23", MONDAY)?.date.toISOString().slice(0, 10), "2026-10-23");
  assert.equal(readDate("done by 23 Oct", MONDAY)?.date.toISOString().slice(0, 10), "2026-10-23");
  assert.equal(readDate("done by 23 October", MONDAY)?.date.toISOString().slice(0, 10), "2026-10-23");
});

test("relative words are relative to the posting day", () => {
  assert.equal(readDate("finish today", MONDAY)?.date.toISOString().slice(0, 10), "2026-10-19");
  assert.equal(readDate("finish tomorrow", MONDAY)?.date.toISOString().slice(0, 10), "2026-10-20");
  assert.equal(readDate("finish next week", MONDAY)?.date.toISOString().slice(0, 10), "2026-10-26");
});

test("a sentence needs BOTH a forward verb and a date to be a promise", () => {
  const withBoth = extractCommitments("Two fitters are on the grating; spools resume Friday.", MONDAY);
  assert.equal(withBoth.length, 1);
  assert.equal(withBoth[0].text.includes("spools resume"), true);

  assert.equal(extractCommitments("Thanks, noted.", MONDAY).length, 0);
  assert.equal(extractCommitments("Friday was busy and the yard flooded.", MONDAY).length, 0);
});

test("at most three promises are taken from one message", () => {
  const body = [
    "We will resume Monday.",
    "Delivery confirmed Tuesday.",
    "Survey submitted Wednesday.",
    "Painting finished Thursday.",
    "Handover Friday.",
  ].join(" ");
  assert.equal(extractCommitments(body, MONDAY).length, 3);
});

test("a commitment is chased from its due day, and only while OPEN", () => {
  const due = new Date("2026-10-23T00:00:00Z");
  assert.equal(isCommitmentDue("OPEN", due, new Date("2026-10-22T23:00:00Z")), false);
  assert.equal(isCommitmentDue("OPEN", due, new Date("2026-10-23T06:00:00Z")), true);
  assert.equal(isCommitmentDue("KEPT", due, new Date("2026-10-24T06:00:00Z")), false);
});

test("the clock walks 8h → HOD, 24h → COO, and stops at an acknowledgement", () => {
  const posted = new Date("2026-10-19T08:00:00Z");
  const at = (hours: number) => new Date(posted.getTime() + hours * 3_600_000);

  assert.equal(escalationStep({ postedAt: posted, now: at(7), acknowledgedAt: null, lastStep: "NONE" }), "NONE");
  assert.equal(escalationStep({ postedAt: posted, now: at(8), acknowledgedAt: null, lastStep: "NONE" }), "REMIND_HOD");
  assert.equal(escalationStep({ postedAt: posted, now: at(9), acknowledgedAt: null, lastStep: "REMIND_HOD" }), "NONE");
  assert.equal(escalationStep({ postedAt: posted, now: at(24), acknowledgedAt: null, lastStep: "REMIND_HOD" }), "ESCALATE_COO");
  assert.equal(escalationStep({ postedAt: posted, now: at(48), acknowledgedAt: null, lastStep: "ESCALATE_COO" }), "NONE");
  assert.equal(escalationStep({ postedAt: posted, now: at(48), acknowledgedAt: at(2), lastStep: "NONE" }), "NONE");
});

test("the stored due instant and the unanswered hours agree with the clock", () => {
  const posted = new Date("2026-10-19T08:00:00Z");
  assert.equal(
    escalationDueAt(posted).toISOString(),
    new Date(posted.getTime() + DEFAULT_ESCALATION_CLOCK.escalateHours * 3_600_000).toISOString()
  );
  assert.equal(unansweredHours(posted, new Date(posted.getTime() + 5 * 3_600_000)), 5);
});

test("a reply token is stored as a hash, and only its own value matches", () => {
  const value = createReplyTokenValue();
  const hash = hashReplyToken(value);
  assert.notEqual(hash, value);
  assert.equal(hash.length, 64);
  assert.equal(replyTokenMatches(value, hash), true);
  assert.equal(replyTokenMatches(`${value}x`, hash), false);
});

test("expiry is 30 days out, and a revoked token outranks an expired one", () => {
  const now = new Date("2026-10-19T00:00:00Z");
  const expiry = replyTokenExpiry(now);
  assert.equal(expiry.toISOString().slice(0, 10), "2026-11-18");
  assert.equal(tokenState({ expiresAt: expiry, revokedAt: null }, now), "USABLE");
  assert.equal(tokenState({ expiresAt: expiry, revokedAt: null }, expiry), "EXPIRED");
  assert.equal(tokenState({ expiresAt: expiry, revokedAt: now }, now), "REVOKED");
});

test("a UTC day ignores the time of day", () => {
  assert.equal(dayOf(new Date("2026-10-19T23:59:00Z")).toISOString(), "2026-10-19T00:00:00.000Z");
});
