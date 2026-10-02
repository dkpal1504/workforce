import test from "node:test";
import assert from "node:assert/strict";
import { burnSummary, healthSummary, BURN_SCALE_MAX } from "./portfolioHero";

/**
 * These tests exist because the burn tile SHIPPED WRONG: it compared the API's ratio against 100,
 * so a portfolio 11% over budget showed a green "Within budget" pill and an empty bar. Every
 * assertion below is a version of that boundary. If someone later "fixes" the units back to
 * percentages, the first test fails loudly instead of the screen quietly lying.
 */

test("burn is a RATIO: 1.109 must read as over budget, not as within it", () => {
  const over = burnSummary(1.109);
  assert.equal(over.measurable, true);
  assert.equal(over.over, true, "111% is over budget");
  assert.equal(over.tag?.text, "Over budget");
  assert.equal(over.tag?.tone, "bad");
  // The regression in one line: a ratio of 1.109 must never be judged as small.
  assert.notEqual(over.tag?.tone, "good");
});

test("the fill is a percentage of the 0-150% track, so 111% fills about three quarters", () => {
  // 1.109 / 1.5 = 73.95%
  assert.ok(Math.abs(burnSummary(1.109).fillPct - 73.95) < 0.1);
  assert.equal(burnSummary(1.5).fillPct, 100, "150% is a full track");
  assert.equal(burnSummary(0.75).fillPct, 50, "75% is half the track");
  // Beyond the scale the fill clamps rather than overflowing its track.
  assert.equal(burnSummary(3).fillPct, 100);
  assert.equal(BURN_SCALE_MAX, 1.5);
});

test("the 100% boundary is exclusive: exactly at budget is not yet over", () => {
  assert.equal(burnSummary(1).over, false, "spending exactly the budget is not over budget");
  assert.equal(burnSummary(1.0001).over, true);
  assert.equal(burnSummary(0.9999).over, false);
});

test("the amber threshold uses the same ratio units", () => {
  assert.equal(burnSummary(0.75).tag?.text, "75% or more used");
  assert.equal(burnSummary(0.75).tag?.tone, "warn");
  assert.equal(burnSummary(0.7499).tag?.text, "Within budget");
  assert.equal(burnSummary(0.1).tag?.tone, "good");
});

test("no denominator is NOT MEASURABLE, never a green verdict", () => {
  for (const missing of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
    const summary = burnSummary(missing as number | null | undefined);
    assert.equal(summary.measurable, false, `${String(missing)} has no denominator`);
    assert.equal(summary.tag, null, "nothing to judge, so no pill at all");
    assert.equal(summary.over, false, "an absent denominator must never read as over budget either");
    assert.equal(summary.fillPct, 0, "an empty track, not a full one");
  }
});

test("a negative burn floors at an empty fill rather than drawing outside the track", () => {
  const negative = burnSummary(-0.2);
  assert.equal(negative.fillPct, 0);
  assert.equal(negative.measurable, true, "it IS measurable — the value is just not meaningful");
});

test("health counts every band, but only the measurable three make the burn share", () => {
  // The live production shape: 3 red, 0 amber, 6 green, 54 not measurable of 63.
  const health = healthSummary({ RED: 3, AMBER: 0, GREEN: 6, NOT_MEASURABLE: 54 });
  assert.equal(health.total, 63);
  assert.equal(health.measurable, 9, "not-measurable is excluded from the measurable share");
  assert.equal(health.measurableShare, 14, "9 of 63 rounds to 14%");
});

test("an empty scope yields 0%, never NaN", () => {
  const empty = healthSummary({ RED: 0, AMBER: 0, GREEN: 0, NOT_MEASURABLE: 0 });
  assert.equal(empty.total, 0);
  assert.equal(empty.measurableShare, 0);
  assert.ok(Number.isFinite(empty.measurableShare), "a NaN here would render as 'NaN%'");
});

test("missing or malformed band data degrades to zero instead of NaN", () => {
  const missing = healthSummary(undefined);
  assert.equal(missing.total, 0);
  assert.equal(missing.measurableShare, 0);

  const malformed = healthSummary({ RED: Number.NaN, GREEN: 5 } as Record<string, number>);
  assert.equal(malformed.total, 5, "a NaN count is dropped, not propagated");
  assert.ok(Number.isFinite(malformed.measurableShare));
});

test("the segment order is fixed so the bar and the legend cannot disagree", () => {
  const health = healthSummary({ RED: 1, AMBER: 2, GREEN: 3, NOT_MEASURABLE: 4 });
  assert.deepEqual(
    health.order.map((entry) => entry.band),
    ["RED", "AMBER", "GREEN", "NOT_MEASURABLE"]
  );
  assert.deepEqual(
    health.order.map((entry) => entry.count),
    [1, 2, 3, 4]
  );
});
