import test from "node:test";
import assert from "node:assert/strict";
import {
  DELAY_REASONS,
  canChooseReason,
  insightSentence,
  isDelayReason,
  periodRange,
  reasonLabel,
  summariseReasons,
  topReasons,
} from "./delayReasons";

/**
 * The numbers Central Planning will quote. Each case pins something that would otherwise be a plausible
 * lie: a share that does not add up, an uncoded reply folded into a percentage, a ranking off two rows.
 */

const NOW = new Date("2026-10-21T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

const row = (code: string | null, ageDays: number, closedAfterDays: number | null = null) => ({
  reasonCode: code,
  raisedAt: daysAgo(ageDays),
  closedAt: closedAfterDays === null ? null : daysAgo(ageDays - closedAfterDays),
});

test("a period is a calendar window, not a sliding 90 days", () => {
  const inQuarter = periodRange("quarter", new Date("2026-10-21T00:00:00Z"));
  assert.equal(inQuarter.from.toISOString().slice(0, 10), "2026-10-01");
  assert.equal(inQuarter.to.toISOString().slice(0, 10), "2026-12-31");

  const inMonth = periodRange("month", new Date("2026-02-15T00:00:00Z"));
  assert.equal(inMonth.from.toISOString().slice(0, 10), "2026-02-01");
  assert.equal(inMonth.to.toISOString().slice(0, 10), "2026-02-28");

  const inYear = periodRange("year", new Date("2026-10-21T00:00:00Z"));
  assert.equal(inYear.from.toISOString().slice(0, 10), "2026-01-01");
  assert.equal(inYear.to.toISOString().slice(0, 10), "2026-12-31");
});

test("the eight codes are exactly the eight, and a ninth is refused", () => {
  assert.equal(DELAY_REASONS.length, 8);
  assert.equal(isDelayReason("MATERIAL"), true);
  assert.equal(isDelayReason("material"), false, "codes are upper-case; a lower-case value is a client bug");
  assert.equal(isDelayReason("OTHER"), false);
  assert.equal(reasonLabel("MATERIAL"), "Material not available");
  assert.equal(reasonLabel("NONSENSE"), null);
});

test("the owner may always stamp a cause; a PM may; a supervisor may not", () => {
  assert.equal(canChooseReason({ role: "HOD", isOwner: true }), true);
  assert.equal(canChooseReason({ role: "PM", isOwner: false }), true);
  assert.equal(canChooseReason({ role: "ADMIN", isOwner: false }), true);
  assert.equal(canChooseReason({ role: "SUPERVISOR", isOwner: false }), false);
  assert.equal(canChooseReason({ role: "HOD", isOwner: false }), false);
});

test("shares are whole percentages of the coded rows and add up to 100 (within rounding)", () => {
  const rows = [
    ...Array.from({ length: 3 }, () => row("MATERIAL", 2)),
    ...Array.from({ length: 2 }, () => row("MANPOWER", 1)),
    row("DRAWING", 4),
  ];
  const summary = summariseReasons(rows, NOW);
  assert.equal(summary.total, 6);
  assert.equal(summary.byReason[0].code, "MATERIAL");
  assert.equal(summary.byReason[0].count, 3);
  assert.equal(summary.byReason[0].share, 50);
  const sum = summary.byReason.reduce((total, entry) => total + entry.share, 0);
  assert.ok(Math.abs(sum - 100) <= 1, `shares summed to ${sum}`);
});

test("a reply with no code is counted as uncoded and never enters a percentage", () => {
  const summary = summariseReasons([row("MATERIAL", 1), row(null, 1), row("NOT_A_CODE", 1)], NOW);
  assert.equal(summary.total, 1);
  assert.equal(summary.uncoded, 2);
  assert.equal(summary.byReason[0].share, 100, "the only coded row is 100% of the coded rows");
});

test("age stops at closure, so a closed cause does not grow older every day", () => {
  const summary = summariseReasons([row("MATERIAL", 10, 4)], NOW);
  assert.equal(summary.byReason[0].averageOpenDays, 4);
});

test("an open cause ages to now", () => {
  const summary = summariseReasons([row("MATERIAL", 6)], NOW);
  assert.equal(summary.byReason[0].averageOpenDays, 6);
});

test("the drawer shows at most three causes, largest first", () => {
  const rows = [row("REWORK", 1), row("REWORK", 1), row("WEATHER", 1), row("PERMIT", 1), row("MATERIAL", 1)];
  const top = topReasons(summariseReasons(rows, NOW), 3);
  assert.equal(top.length, 3);
  assert.equal(top[0].code, "REWORK");
});

test("the sentence names the largest cause and its share with a sample size", () => {
  const rows = [
    ...Array.from({ length: 8 }, () => row("MATERIAL", 9)),
    ...Array.from({ length: 2 }, () => row("MANPOWER", 4)),
  ];
  const sentence = insightSentence(summariseReasons(rows, NOW), "quarter");
  assert.match(sentence, /Material not available is the largest cause this quarter: 80% of 10 reported delays/);
  assert.match(sentence, /average of 9\.0 days open/);
});

test("below five reports it refuses to rank, and says the count", () => {
  const sentence = insightSentence(summariseReasons([row("WEATHER", 1), row("WEATHER", 1)], NOW), "month");
  assert.match(sentence, /Only 2 delays reported this month — too few to rank causes/);
});

test("a period with nothing reported says so instead of showing an empty chart silently", () => {
  assert.match(insightSentence(summariseReasons([], NOW), "quarter"), /Nothing reported this quarter/);
});

test("'slowest to close' is only claimed when it is a different cause and the gap is a day or more", () => {
  const rows = [
    ...Array.from({ length: 6 }, () => row("MATERIAL", 5)),
    ...Array.from({ length: 4 }, () => row("CLIENT_HOLD", 11)),
  ];
  const sentence = insightSentence(summariseReasons(rows, NOW), "year");
  assert.match(sentence, /Client hold stays open longest \(avg 11\.0 days\)/);

  const sameGap = insightSentence(summariseReasons([...Array.from({ length: 6 }, () => row("MATERIAL", 5)), row("REWORK", 5.4)], NOW), "year");
  assert.equal(/stays open longest/.test(sameGap), false, "a 0.4-day gap is not a finding");
});
