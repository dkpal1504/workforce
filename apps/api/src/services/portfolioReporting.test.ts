import test from "node:test";
import assert from "node:assert/strict";
import {
  attentionFor,
  buildJobOrderFacts,
  burnPct,
  forecastExhaustedOn,
  hoursBand,
  hoursPerDay,
  quantityBand,
  qtyCompletePct,
  rollUpDepartments,
  rollUpProjects,
  sortByAttention,
  BOOKED_HOURS_NOTE,
  BOOKED_HOURS_STATUSES,
  SUMMARY_APPROVED_HOURS_STATUSES,
  type JobOrderFacts,
} from "./portfolioReporting";

const DAY = 24 * 60 * 60 * 1000;

function daysAgo(now: Date, days: number): Date {
  return new Date(now.getTime() - days * DAY);
}

function dayKey(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

/* ------------------------------------------------------------------ *
 * Task 1 — the hours-burn band
 * ------------------------------------------------------------------ */

test("hoursBurnBand: an exhaustively correct band with NOT_MEASURABLE for unbudgeted work", () => {
  // No budget at all: never GREEN. An unbudgeted job order that has booked hours
  // must not be painted as healthy — the whole point of the band.
  assert.equal(hoursBand(0, 0), "NOT_MEASURABLE");
  assert.equal(hoursBand(0, 50), "NOT_MEASURABLE");
  assert.equal(hoursBand(-10, 50), "NOT_MEASURABLE");

  // Boundary: burnPct >= 1.00 is RED, and the 1.00 boundary itself is RED.
  assert.equal(hoursBand(100, 104), "RED");
  assert.equal(hoursBand(100, 100), "RED");

  // Boundary: burnPct >= 0.75 is AMBER, and the 0.75 boundary itself is AMBER.
  assert.equal(hoursBand(100, 80), "AMBER");
  assert.equal(hoursBand(100, 75), "AMBER");

  // Below 0.75 is GREEN.
  assert.equal(hoursBand(100, 74), "GREEN");
  assert.equal(hoursBand(100, 0), "GREEN");
});

test("burnPct: null when there is no budget to burn against", () => {
  assert.equal(burnPct(0, 50), null);
  assert.equal(burnPct(-5, 50), null);
  assert.equal(burnPct(100, 104), 1.04);
  assert.equal(burnPct(100, 50), 0.5);
});

test("hoursBand: a non-finite operand is NOT_MEASURABLE, NEVER GREEN", () => {
  // THE bug this suite was missing. Every comparison is false against NaN/Infinity, so
  // an unguarded band falls through to `return "GREEN"` — the module painting corrupt
  // data as healthy. A finite denominator with a corrupt numerator is still corrupt.
  assert.equal(hoursBand(100, NaN), "NOT_MEASURABLE");
  assert.equal(hoursBand(100, Infinity), "NOT_MEASURABLE");
  assert.equal(hoursBand(100, -Infinity), "NOT_MEASURABLE");
  assert.equal(hoursBand(Infinity, 50), "NOT_MEASURABLE");
  assert.equal(hoursBand(NaN, NaN), "NOT_MEASURABLE");
  assert.equal(hoursBand(NaN, 0), "NOT_MEASURABLE");
  // And the guard must not swallow the genuine GREEN case.
  assert.equal(hoursBand(100, 10), "GREEN");
});

test("burnPct: null for a non-finite operand, never a NaN/Infinity percentage", () => {
  assert.equal(burnPct(100, NaN), null);
  assert.equal(burnPct(100, Infinity), null);
  assert.equal(burnPct(Infinity, 50), null);
  assert.equal(burnPct(NaN, NaN), null);
  // A finite burn still computes.
  assert.equal(burnPct(100, 10), 0.1);
});

/* ------------------------------------------------------------------ *
 * Task 1b — the quantity-achievement band (same vocabulary, own direction)
 * ------------------------------------------------------------------ */

test("quantityBand: achievement reads in its own direction — most of target is GREEN, none is RED", () => {
  // The inverted-vocabulary trap: hoursBand(100, 0) is GREEN ("healthy burn", nothing
  // spent) while quantity achieved 0 of 100 is the WORST case. quantityBand must not
  // reuse the hours comparison.
  assert.equal(quantityBand(100, 0), "RED", "nothing achieved is RED, never GREEN");
  assert.equal(quantityBand(100, 100), "GREEN", "fully achieved is GREEN");
  assert.equal(quantityBand(100, 150), "GREEN", "over-achievement stays GREEN");
  // Same band vocabulary as the hours rule, just read the other way.
  assert.equal(quantityBand(100, 50), "AMBER");
  assert.equal(quantityBand(0, 0), "NOT_MEASURABLE", "no target is not measurable");
  assert.equal(quantityBand(100, NaN), "NOT_MEASURABLE");
});

test("quantityBand: the 75% edge is AMBER so it agrees with the attention reason, and 25% is the other edge", () => {
  // attentionFor fires "quantity behind target" at qtyPct <= 0.75, so exactly 75% MUST
  // NOT be GREEN — otherwise one row shows GREEN while its own reason says behind.
  assert.equal(quantityBand(100, 75), "AMBER", "the band edge is 75%: NOT green");
  assert.equal(quantityBand(100, 76), "GREEN");
  // The other edge: below 25% is RED, exactly 25% is AMBER.
  assert.equal(quantityBand(100, 24), "RED");
  assert.equal(quantityBand(100, 25), "AMBER");
});

/* ------------------------------------------------------------------ *
 * Task 1c — the finite quantity-completion percentage
 * ------------------------------------------------------------------ */

test("qtyCompletePct: a divide-by-zero displays as 0, never NaN/blank", () => {
  // THE case the operator named: no quantity budget to measure against. The old
  // `achieved / target` would be 0/0 = NaN here, and 50/0 = Infinity. Both are
  // forbidden — the numeric column must print a finite number, and 0 is that number.
  assert.equal(qtyCompletePct(0, 0), 0, "0 budgeted of 0 is 0 percent, not NaN");
  assert.equal(qtyCompletePct(0, 50), 0, "nothing budgeted means no percent to state");
});

test("qtyCompletePct: a negative or corrupt target is 0, never a negative percent", () => {
  // A negative target is not a denominator. Dividing by it would flip the sign and
  // print a NEGATIVE completion, which is nonsense in a quantity column.
  assert.equal(qtyCompletePct(-100, 50), 0);
  assert.equal(qtyCompletePct(NaN, 50), 0, "a NaN target is unmeasurable, not NaN percent");
  assert.equal(qtyCompletePct(Infinity, 50), 0, "an infinite target is unmeasurable");
});

test("qtyCompletePct: a corrupt achieved quantity is 0, never NaN/Infinity percent", () => {
  // Corrupt input must never resolve to a NaN or Infinity percentage; those corrupt
  // the column and every downstream arithmetic. 0 is the module's honest fallback.
  assert.equal(qtyCompletePct(100, NaN), 0);
  assert.equal(qtyCompletePct(100, Infinity), 0);
  assert.equal(qtyCompletePct(100, -Infinity), 0);
  // A finite negative numerator would divide to a NEGATIVE percent; the contract is
  // "never negative", so corrupt negative delivery resolves to 0 too.
  assert.equal(qtyCompletePct(100, -50), 0);
});

test("qtyCompletePct: ordinary completion is achieved/target", () => {
  assert.equal(qtyCompletePct(100, 0), 0, "target set but nothing achieved is a real 0");
  assert.equal(qtyCompletePct(100, 55), 0.55);
  assert.equal(qtyCompletePct(100, 100), 1);
  assert.equal(qtyCompletePct(200, 50), 0.25);
});

test("qtyCompletePct: over-achievement is NOT clamped — 150 of 100 is 1.5", () => {
  // Over-achievement is REAL information (a crew delivered beyond the plan) and the
  // quantity band already treats it as GREEN. Clamping to 1 would erase the fact that
  // more than the target was delivered, so the raw ratio is carried unchanged.
  assert.equal(qtyCompletePct(100, 150), 1.5);
});

test("qtyCompletePct: the result is always finite and never negative across a grid (invariant)", () => {
  // The contract, stated once: for ANY pair of numbers — including NaN, ±Infinity,
  // negatives and zeros — the return value is a finite number >= 0. This is the
  // property the three surfaces (web, Excel, PDF) rely on to render one definition.
  const values = [0, 1, -1, 0.5, 55, 100, 150, -100, NaN, Infinity, -Infinity];
  for (const targetQty of values) {
    for (const achievedQty of values) {
      const pct = qtyCompletePct(targetQty, achievedQty);
      assert.ok(Number.isFinite(pct), `not finite for target=${targetQty} achieved=${achievedQty}`);
      assert.ok(pct >= 0, `negative for target=${targetQty} achieved=${achievedQty}`);
    }
  }
});


/* ------------------------------------------------------------------ *
 * Task 2 — forecast exhaustion date
 * ------------------------------------------------------------------ */

test("forecastExhaustedOn: at the observed rate, when is the budget gone?", () => {
  const first = new Date("2026-09-26T00:00:00Z");
  const last = new Date("2026-09-30T00:00:00Z"); // 5 inclusive days of activity

  // 50h over 5 days = 10h/day; 50h remaining = 5 more days after the last booking.
  const rate = hoursPerDay({ actualHours: 50, firstBooking: first, lastBooking: last });
  assert.equal(rate, 10);

  const forecast = forecastExhaustedOn({
    budgetHours: 100,
    actualHours: 50,
    firstBooking: first,
    lastBooking: last,
  });
  assert.equal(dayKey(forecast), "2026-10-05");
});

test("forecastExhaustedOn: null whenever no rate can be observed", () => {
  const last = new Date("2026-09-30T00:00:00Z");
  const empty = { budgetHours: 100, actualHours: 50, firstBooking: null, lastBooking: last };

  assert.equal(forecastExhaustedOn({ ...empty, firstBooking: null }), null);
  assert.equal(forecastExhaustedOn({ ...empty, lastBooking: null }), null);
  assert.equal(forecastExhaustedOn({ ...empty, budgetHours: 0 }), null);
  assert.equal(forecastExhaustedOn({ ...empty, actualHours: 0 }), null);

  // A single booking gives a point, not a rate: the span is zero days.
  assert.equal(
    forecastExhaustedOn({ budgetHours: 100, actualHours: 50, firstBooking: last, lastBooking: last }),
    null
  );
  assert.equal(hoursPerDay({ actualHours: 50, firstBooking: last, lastBooking: last }), null);
});

test("forecastExhaustedOn: a non-finite budget or burn returns null, never an Invalid Date", () => {
  // With budgetHours Infinity the old guard passed, remaining/rate was Infinity and the
  // constructed Date was NaN — an Invalid Date that silently serialises to null and
  // breaks comparisons. The contract is "Date or null", so corrupt input is null.
  const first = new Date("2026-09-26T00:00:00Z");
  const last = new Date("2026-09-30T00:00:00Z");

  assert.equal(
    forecastExhaustedOn({ budgetHours: Infinity, actualHours: 50, firstBooking: first, lastBooking: last }),
    null
  );
  assert.equal(
    forecastExhaustedOn({ budgetHours: 100, actualHours: NaN, firstBooking: first, lastBooking: last }),
    null
  );
  assert.equal(
    forecastExhaustedOn({ budgetHours: 100, actualHours: Infinity, firstBooking: first, lastBooking: last }),
    null
  );
});

test("forecastExhaustedOn: every returned Date has a finite time (property check)", () => {
  const first = new Date("2026-09-26T00:00:00Z");
  const last = new Date("2026-09-30T00:00:00Z");
  const cases: Array<Parameters<typeof forecastExhaustedOn>[0]> = [
    { budgetHours: 100, actualHours: 50, firstBooking: first, lastBooking: last }, // projected
    { budgetHours: 100, actualHours: 120, firstBooking: first, lastBooking: last }, // exhausted
    { budgetHours: 100, actualHours: 100, firstBooking: first, lastBooking: last }, // exactly at budget
    { budgetHours: 1000, actualHours: 1, firstBooking: first, lastBooking: last }, // long projection
    { budgetHours: 100, actualHours: 50, firstBooking: last, lastBooking: last }, // null (point)
    { budgetHours: Infinity, actualHours: 50, firstBooking: first, lastBooking: last }, // null
  ];
  for (const params of cases) {
    const result = forecastExhaustedOn(params);
    if (result !== null) {
      assert.equal(
        Number.isNaN(result.getTime()),
        false,
        `returned an Invalid Date for ${JSON.stringify(params)}`
      );
      assert.ok(Number.isFinite(result.getTime()), "the returned instant must be finite");
    }
  }
});

test("forecastExhaustedOn: an already-exhausted budget returns the last booking date", () => {
  const first = new Date("2026-09-26T00:00:00Z");
  const last = new Date("2026-09-30T00:00:00Z");
  const exhausted = forecastExhaustedOn({
    budgetHours: 100,
    actualHours: 120,
    firstBooking: first,
    lastBooking: last,
  });
  assert.equal(dayKey(exhausted), "2026-09-30");
});

test("forecastExhaustedOn: BOTH branches normalise to UTC midnight when the booking carries a time-of-day", () => {
  // A caller must never get a raw datetime from one branch and a UTC-midnight boundary
  // from the other: the printed date column has to be one kind of value. 14:23 is a
  // deliberately non-midnight instant.
  const first = new Date("2026-09-26T09:11:00Z");
  const last = new Date("2026-09-30T14:23:00Z");

  const projected = forecastExhaustedOn({
    budgetHours: 100,
    actualHours: 50,
    firstBooking: first,
    lastBooking: last,
  });
  assert.ok(projected !== null, "a rate is observable, so a projection exists");
  assert.equal(projected.toISOString(), "2026-10-05T00:00:00.000Z");
  assert.equal(projected.getUTCHours(), 0);
  assert.equal(projected.getUTCMinutes(), 0);

  const alreadyExhausted = forecastExhaustedOn({
    budgetHours: 100,
    actualHours: 120,
    firstBooking: first,
    lastBooking: last,
  });
  assert.ok(alreadyExhausted !== null);
  assert.equal(alreadyExhausted.toISOString(), "2026-09-30T00:00:00.000Z");
  assert.equal(alreadyExhausted.getUTCHours(), 0);
  assert.equal(alreadyExhausted.getUTCMinutes(), 0);

  // Same shape in both branches: identical to the day-normalised key of the booking.
  assert.equal(dayKey(alreadyExhausted), dayKey(new Date("2026-09-30T00:00:00Z")));
});

test("hoursPerDay / forecast: the resolved rate convention is pinned", () => {
  // RESOLVED ambiguity 1: inclusive calendar-day denominator. 26th -> 30th is FIVE
  // days, so 50h / 5 = 10 (not 50h / 4 = 12.5).
  const first = new Date("2026-09-26T00:00:00Z");
  const last = new Date("2026-09-30T00:00:00Z");
  assert.equal(hoursPerDay({ actualHours: 50, firstBooking: first, lastBooking: last }), 10);

  // 50h remaining at 10h/day is 5 further days after the last booking -> 2026-10-05.
  assert.equal(
    dayKey(forecastExhaustedOn({ budgetHours: 100, actualHours: 50, firstBooking: first, lastBooking: last })),
    "2026-10-05"
  );

  // RESOLVED ambiguity 2: one same-day booking is a point, not a rate — null, never
  // an invented number, and therefore no forecast either.
  assert.equal(hoursPerDay({ actualHours: 50, firstBooking: last, lastBooking: last }), null);
  assert.equal(
    forecastExhaustedOn({ budgetHours: 100, actualHours: 50, firstBooking: last, lastBooking: last }),
    null
  );
});

/* ------------------------------------------------------------------ *
 * Task 3 — attention score with NAMED reasons
 * ------------------------------------------------------------------ */

function attentionInput(over: Partial<Parameters<typeof attentionFor>[0]> = {}) {
  return {
    budgetHours: 100,
    actualHours: 0,
    burnPct: 0,
    hoursBand: "GREEN" as const,
    measurableOnHours: true,
    measurableOnQuantity: false,
    qtyPct: null,
    lastBooking: null,
    unapprovedHours: 0,
    oldestUnapprovedAt: null,
    // The default window: existing cases below that were written for the old fixed 7 days set
    // this explicitly, so their expected reason strings remain "no hours booked in the last 7 days".
    activityDays: 7,
    ...over,
  };
}

const NOW = new Date("2026-10-02T00:00:00Z");

test("attention: a RED hours band scores +40 and names the exhausted budget", () => {
  const result = attentionFor(
    attentionInput({ hoursBand: "RED", burnPct: 1.04, actualHours: 104, lastBooking: daysAgo(NOW, 1) }),
    NOW
  );
  assert.equal(result.score, 40);
  assert.ok(result.reasons.includes("hours budget exhausted"));
});

test("attention: an AMBER hours band scores +25 and names the rounded percentage", () => {
  const result = attentionFor(
    attentionInput({ hoursBand: "AMBER", burnPct: 0.8, actualHours: 80, lastBooking: daysAgo(NOW, 1) }),
    NOW
  );
  assert.equal(result.score, 25);
  assert.ok(result.reasons.includes("hours budget 80% consumed"));
});

test("attention: measurable on hours with no booking in 7 days scores +30", () => {
  const stale = attentionFor(attentionInput({ lastBooking: daysAgo(NOW, 10) }), NOW);
  assert.equal(stale.score, 30);
  assert.ok(stale.reasons.includes("no hours booked in the last 7 days"));

  // Never booked at all is the same signal.
  const never = attentionFor(attentionInput({ lastBooking: null }), NOW);
  assert.equal(never.score, 30);

  // Booked inside the window is not a signal.
  const live = attentionFor(attentionInput({ lastBooking: daysAgo(NOW, 2) }), NOW);
  assert.equal(live.score, 0);
});

test("attention: a row cannot claim BOTH 'budget exhausted' AND 'no hours booked' (the contradiction)", () => {
  // THE reproduced contradiction: budgetHours 100, actualHours 104 (hours EXIST),
  // lastBooking null. The old +30 branch treated a null date as "stalled" even though
  // 104 booked hours prove activity happened, so the row printed both "hours budget
  // exhausted" (+40) and "no hours booked in the last 7 days" (+30) — two mutually
  // exclusive sentences for ONE job order. The hours exist; only the DATE is missing.
  const result = attentionFor(
    attentionInput({
      budgetHours: 100,
      actualHours: 104,
      burnPct: 1.04,
      hoursBand: "RED",
      measurableOnHours: true,
      lastBooking: null,
    }),
    NOW
  );

  assert.equal(result.score, 70, "both weights still apply — the missing date stays a signal");
  assert.ok(result.reasons.includes("hours budget exhausted"));
  // The pair is impossible: an exhausted-budget line and a "no hours booked" line must
  // never appear together, because the second is provably false when hours exist.
  const saysNoBooking = result.reasons.includes("no hours booked in the last 7 days");
  assert.equal(saysNoBooking, false, `contradictory reasons: ${JSON.stringify(result.reasons)}`);
  assert.ok(
    result.reasons.includes("activity recorded but no booking date"),
    "the missing date is reported honestly instead"
  );
});

test("attention: a null booking date with zero hours is still the genuine no-activity signal", () => {
  // The counter-case: no hours AND no date really is "nothing happened", so the
  // original wording is correct here and must be preserved.
  const result = attentionFor(attentionInput({ actualHours: 0, lastBooking: null }), NOW);
  assert.equal(result.score, 30);
  assert.ok(result.reasons.includes("no hours booked in the last 7 days"));
  assert.equal(result.reasons.includes("activity recorded but no booking date"), false);
});

test("attention: the 7-day no-activity edge is inclusive — day 7 does not fire, day 8 does", () => {
  // RESOLVED boundary: a booking exactly 7 days old is still "in the last 7 days",
  // so the `> 7` test must NOT trigger. Day 8 is the first day outside the window.
  const day7 = attentionFor(attentionInput({ lastBooking: daysAgo(NOW, 7) }), NOW);
  assert.equal(day7.score, 0);
  assert.equal(day7.reasons.includes("no hours booked in the last 7 days"), false);

  const day8 = attentionFor(attentionInput({ lastBooking: daysAgo(NOW, 8) }), NOW);
  assert.equal(day8.score, 30);
  assert.ok(day8.reasons.includes("no hours booked in the last 7 days"));
});

test("attention: the activity window is the OPERATOR'S — idle 10 days is fine at 14, stalled at 7", () => {
  // THE defect this change exists to fix. With ?activityDays=14 a job order 10 days idle is
  // INSIDE the window the operator asked for and must NOT be flagged; under the old hardcoded 7
  // it was wrongly pushed at the COO with "no hours booked in the last 7 days".
  const idle10At14 = attentionFor(
    attentionInput({ lastBooking: daysAgo(NOW, 10), activityDays: 14 }),
    NOW
  );
  assert.equal(idle10At14.score, 0, "10 days idle is inside a 14-day window");
  assert.equal(
    idle10At14.reasons.some((r: string) => r.includes("no hours booked")),
    false,
    "no stalled reason inside the operator's window"
  );

  // The same row under the 7-day window IS stalled, and its reason names 7.
  const idle10At7 = attentionFor(
    attentionInput({ lastBooking: daysAgo(NOW, 10), activityDays: 7 }),
    NOW
  );
  assert.equal(idle10At7.score, 30);
  assert.ok(idle10At7.reasons.includes("no hours booked in the last 7 days"));

  // 15 days idle IS outside a 14-day window, and the reason names 14 — not 7.
  const idle15At14 = attentionFor(
    attentionInput({ lastBooking: daysAgo(NOW, 15), activityDays: 14 }),
    NOW
  );
  assert.equal(idle15At14.score, 30, "15 days idle is outside a 14-day window");
  assert.ok(
    idle15At14.reasons.includes("no hours booked in the last 14 days"),
    `reason must name the real window, got ${JSON.stringify(idle15At14.reasons)}`
  );
  assert.equal(
    idle15At14.reasons.includes("no hours booked in the last 7 days"),
    false,
    "the reason must never hardcode 7 when the window is 14"
  );
});

test("attention: the window edge is inclusive at ANY window — day N does not fire, day N+1 does", () => {
  // The 7-day boundary is already pinned above; this proves the rule generalises to the
  // operator's window so the > activityDays comparison is the only thing deciding it.
  const day14 = attentionFor(attentionInput({ lastBooking: daysAgo(NOW, 14), activityDays: 14 }), NOW);
  assert.equal(day14.score, 0, "exactly 14 days old is still inside a 14-day window");
  const day15 = attentionFor(attentionInput({ lastBooking: daysAgo(NOW, 15), activityDays: 14 }), NOW);
  assert.equal(day15.score, 30, "day 15 is the first day outside a 14-day window");

  const day30 = attentionFor(attentionInput({ lastBooking: daysAgo(NOW, 30), activityDays: 30 }), NOW);
  assert.equal(day30.score, 0);
  const day31 = attentionFor(attentionInput({ lastBooking: daysAgo(NOW, 31), activityDays: 30 }), NOW);
  assert.equal(day31.score, 30);
});

test("attention: hours stuck in approval older than 3 days scores +20", () => {
  const result = attentionFor(
    attentionInput({ unapprovedHours: 12, oldestUnapprovedAt: daysAgo(NOW, 5), lastBooking: daysAgo(NOW, 1) }),
    NOW
  );
  assert.equal(result.score, 20);
  assert.ok(
    result.reasons.some((r) => /12 h awaiting approval since 2026-09-27/.test(r)),
    `reason not found in ${JSON.stringify(result.reasons)}`
  );

  // Freshly submitted unapproved hours are not yet a problem.
  const fresh = attentionFor(
    attentionInput({ unapprovedHours: 12, oldestUnapprovedAt: daysAgo(NOW, 1), lastBooking: daysAgo(NOW, 1) }),
    NOW
  );
  assert.equal(fresh.score, 0);
});

test("attention: quantity more than 25% below target scores +15", () => {
  const behind = attentionFor(
    attentionInput({ measurableOnQuantity: true, qtyPct: 0.5, lastBooking: daysAgo(NOW, 1) }),
    NOW
  );
  assert.equal(behind.score, 15);
  assert.ok(behind.reasons.includes("quantity behind target"));

  const onTrack = attentionFor(
    attentionInput({ measurableOnQuantity: true, qtyPct: 0.9, lastBooking: daysAgo(NOW, 1) }),
    NOW
  );
  assert.equal(onTrack.score, 0);
});

test("attention: the qty-behind edge is inclusive — exactly 25% below (0.75) fires, 0.76 does not", () => {
  // Boundary bug fix: the spec says the weight applies when the job order is AT LEAST
  // 25% below target, so qtyPct === 0.75 must score +15 with its reason present.
  const exactly = attentionFor(
    attentionInput({ measurableOnQuantity: true, qtyPct: 0.75, lastBooking: daysAgo(NOW, 1) }),
    NOW
  );
  assert.equal(exactly.score, 15);
  assert.ok(exactly.reasons.includes("quantity behind target"));

  // 0.76 is only 24% below target: still on the safe side of the boundary.
  const justInside = attentionFor(
    attentionInput({ measurableOnQuantity: true, qtyPct: 0.76, lastBooking: daysAgo(NOW, 1) }),
    NOW
  );
  assert.equal(justInside.score, 0);
  assert.equal(justInside.reasons.includes("quantity behind target"), false);
});

test("attention: an unbudgeted job order scores +10 and says so", () => {
  const result = attentionFor(
    attentionInput({ budgetHours: 0, burnPct: null, hoursBand: "NOT_MEASURABLE", measurableOnHours: false, lastBooking: daysAgo(NOW, 1) }),
    NOW
  );
  assert.equal(result.score, 10);
  assert.ok(result.reasons.includes("no hours budget set"));
});

test("attention: sortByAttention orders by score desc, then budgeted hours desc", () => {
  // Red with a small budget scores 40; two ambers score 25 and must break by budget.
  type Tagged = { tag: string; attentionScore: number; budgetHours: number };
  const high: Tagged = { tag: "high", attentionScore: 40, budgetHours: 50 };
  const midBig: Tagged = { tag: "midBig", attentionScore: 25, budgetHours: 500 };
  const midSmall: Tagged = { tag: "midSmall", attentionScore: 25, budgetHours: 100 };

  const sorted = sortByAttention([midSmall, high, midBig]);
  assert.deepEqual(
    sorted.map((row) => row.tag),
    ["high", "midBig", "midSmall"]
  );
  // The input array is not mutated.
  assert.deepEqual(
    [midSmall, high, midBig].map((row) => row.tag),
    ["midSmall", "high", "midBig"]
  );
});

/* ------------------------------------------------------------------ *
 * Task 4 — the job-order facts builder
 * ------------------------------------------------------------------ */

type BuildInput = Parameters<typeof buildJobOrderFacts>[0];

function buildInput(over: Partial<BuildInput> = {}): BuildInput {
  return {
    jobOrder: {
      id: 1,
      code: "JO-1",
      name: "Piling",
      status: "active",
      budgetedHours: 100,
      budgetedQuantity: 0,
      uom: "MTR",
      project: { id: 1, code: "PRJ.001", name: "Project One" },
      wbs: { id: 1, wbsCode: "W1", name: "WBS One" },
      department: { id: 1, name: "Dept One" },
      section: { id: 1, name: "Section One" },
    },
    budgetRevisions: [],
    actualHours: 0,
    unapprovedHours: 0,
    oldestUnapprovedAt: null,
    firstBooking: null,
    lastBooking: null,
    progressRows: [],
    asOf: new Date("2026-03-01T00:00:00Z"),
    now: new Date("2026-10-02T00:00:00Z"),
    ...over,
  };
}

test("buildJobOrderFacts: uses the budget revision in force on the as-of date", () => {
  const facts = buildJobOrderFacts(
    buildInput({
      // Current budget on the job order is 200, but on 2026-03-01 only rev 1 (100h) was in force.
      jobOrder: { ...buildInput().jobOrder, budgetedHours: 200 },
      budgetRevisions: [
        { revisionNo: 1, budgetedHours: 100, budgetedQuantity: 0, effectiveFrom: new Date("2026-01-01T00:00:00Z") },
        { revisionNo: 2, budgetedHours: 200, budgetedQuantity: 0, effectiveFrom: new Date("2026-06-01T00:00:00Z") },
      ],
      actualHours: 40,
    })
  );
  assert.equal(facts.budgetHours, 100, "the revision effective on asOf must win");
});

test("buildJobOrderFacts: a zero budget is NOT_MEASURABLE on hours, never GREEN", () => {
  const facts = buildJobOrderFacts(
    buildInput({
      jobOrder: { ...buildInput().jobOrder, budgetedHours: 0 },
      actualHours: 50,
    })
  );
  assert.equal(facts.measurableOnHours, false);
  assert.equal(facts.hoursBand, "NOT_MEASURABLE");
  assert.equal(facts.burnPct, null);
});

test("buildJobOrderFacts: no progress rows means quantity is NOT_MEASURABLE", () => {
  const facts = buildJobOrderFacts(
    buildInput({
      jobOrder: { ...buildInput().jobOrder, budgetedQuantity: 100 },
      budgetRevisions: [
        { revisionNo: 1, budgetedHours: 100, budgetedQuantity: 100, effectiveFrom: new Date("2026-01-01T00:00:00Z") },
      ],
      progressRows: [],
    })
  );
  assert.equal(facts.measurableOnQuantity, false);
  assert.equal(facts.qtyBand, "NOT_MEASURABLE");
  assert.equal(facts.qtyPct, null);
});

test("buildJobOrderFacts: an approved progress row makes quantity measurable and banded", () => {
  const facts = buildJobOrderFacts(
    buildInput({
      jobOrder: { ...buildInput().jobOrder, budgetedQuantity: 100 },
      budgetRevisions: [
        { revisionNo: 1, budgetedHours: 100, budgetedQuantity: 100, effectiveFrom: new Date("2026-01-01T00:00:00Z") },
      ],
      progressRows: [
        { status: "APPROVED", cumulativeQuantity: 55, progressDate: new Date("2026-02-20T00:00:00Z"), revisionNo: 1 },
        { status: "REJECTED", cumulativeQuantity: 90, progressDate: new Date("2026-02-25T00:00:00Z"), revisionNo: 1 },
      ],
    })
  );
  assert.equal(facts.measurableOnQuantity, true);
  assert.equal(facts.achievedQty, 55, "only APPROVED rows count");
  assert.equal(facts.qtyPct, 0.55);
  // 55 of 100 is between 25% and 75%, so AMBER under the corrected (own-direction)
  // quantity band. The old inverted reuse called this GREEN while the same row's
  // reason said "quantity behind target".
  assert.equal(facts.qtyBand, "AMBER");
  assert.equal(facts.reasons.includes("quantity behind target"), true, "reason agrees with AMBER");
  assert.equal(facts.balanceQty, 45);
});

test("buildJobOrderFacts: the quantity band and its reason AGREE — never GREEN while 'behind target'", () => {
  const buildQty = (cumulativeQuantity: number) =>
    buildJobOrderFacts(
      buildInput({
        jobOrder: { ...buildInput().jobOrder, budgetedQuantity: 100 },
        budgetRevisions: [
          { revisionNo: 1, budgetedHours: 100, budgetedQuantity: 100, effectiveFrom: new Date("2026-01-01T00:00:00Z") },
        ],
        progressRows: [
          { status: "APPROVED", cumulativeQuantity, progressDate: new Date("2026-02-20T00:00:00Z"), revisionNo: 1 },
        ],
      })
    );

  // 0 of 100: RED, and the reason is present — the two no longer disagree.
  const nothing = buildQty(0);
  assert.equal(nothing.qtyBand, "RED");
  assert.equal(nothing.reasons.includes("quantity behind target"), true);

  // Exactly 75 of 100: the band edge, AMBER, and the reason fires — they match.
  const edge = buildQty(75);
  assert.equal(edge.qtyBand, "AMBER");
  assert.equal(edge.reasons.includes("quantity behind target"), true);

  // 100 of 100: GREEN and NO "behind" reason.
  const done = buildQty(100);
  assert.equal(done.qtyBand, "GREEN");
  assert.equal(done.reasons.includes("quantity behind target"), false);

  // The invariant, stated once: a GREEN quantity band can never carry the behind reason.
  for (const q of [0, 25, 50, 75, 76, 100]) {
    const facts = buildQty(q);
    if (facts.qtyBand === "GREEN") {
      assert.equal(facts.reasons.includes("quantity behind target"), false, `GREEN at qty ${q} says behind`);
    }
  }
});

test("buildJobOrderFacts: carries the finite qtyCompletePct alongside the existing qty facts", () => {
  // The new ADDITIVE field: present and correct on the assembled facts, computed from
  // the SAME target/achieved figures as qtyPct, through the shared pure helper.
  const facts = buildJobOrderFacts(
    buildInput({
      jobOrder: { ...buildInput().jobOrder, budgetedQuantity: 100 },
      budgetRevisions: [
        { revisionNo: 1, budgetedHours: 100, budgetedQuantity: 100, effectiveFrom: new Date("2026-01-01T00:00:00Z") },
      ],
      progressRows: [
        { status: "APPROVED", cumulativeQuantity: 55, progressDate: new Date("2026-02-20T00:00:00Z"), revisionNo: 1 },
      ],
    })
  );
  assert.equal(facts.qtyCompletePct, 0.55, "55 of 100 is 0.55");
  // The pre-existing facts are untouched: qtyPct keeps its measurable-ratio semantics.
  assert.equal(facts.qtyPct, 0.55);
  assert.equal(facts.qtyBand, "AMBER");
  assert.equal(facts.measurableOnQuantity, true);
});

test("buildJobOrderFacts: an unbudgeted job order reports qtyCompletePct 0 AND keeps qtyBand NOT_MEASURABLE", () => {
  // THE distinction this field must not erase. No quantity budget means the band is
  // NOT_MEASURABLE and qtyPct is null (the job is not measurable on quantity), yet the
  // numeric column still prints 0 rather than a blank/NaN. Both facts coexist: the
  // reader learns WHY via the Band column, not by a hole in the percentage column.
  const facts = buildJobOrderFacts(
    buildInput({
      jobOrder: { ...buildInput().jobOrder, budgetedQuantity: 0 },
      progressRows: [],
    })
  );
  assert.equal(facts.qtyCompletePct, 0, "no budget to measure against shows 0 percent");
  assert.equal(facts.targetQty, 0, "targetQty 0 = no quantity budget, preserved");
  assert.equal(facts.measurableOnQuantity, false, "not measurable: unchanged");
  assert.equal(facts.qtyBand, "NOT_MEASURABLE", "the band still says why 0 is not a good 0");
  assert.equal(facts.qtyPct, null, "qtyPct keeps its null = not measurable semantics");
});

test("buildJobOrderFacts: a NaN actualHours is NOT_MEASURABLE on hours, never GREEN", () => {
  // THE test the reviewer said was missing. A corrupt hours figure must not be painted
  // GREEN, and no burn percentage or attention band may be invented from it.
  const facts = buildJobOrderFacts(
    buildInput({
      jobOrder: { ...buildInput().jobOrder, budgetedHours: 100 },
      budgetRevisions: [
        { revisionNo: 1, budgetedHours: 100, budgetedQuantity: 0, effectiveFrom: new Date("2026-01-01T00:00:00Z") },
      ],
      actualHours: NaN,
    })
  );
  assert.equal(facts.hoursBand, "NOT_MEASURABLE", "corrupt hours is never GREEN");
  assert.equal(facts.burnPct, null);
  assert.equal(facts.measurableOnHours, true, "the budget itself is still known");
});

test("buildJobOrderFacts: carries identity, activity age and an attention score with reasons", () => {
  const now = new Date("2026-10-02T00:00:00Z");
  const facts = buildJobOrderFacts(
    buildInput({
      jobOrder: { ...buildInput().jobOrder, budgetedHours: 100 },
      budgetRevisions: [
        { revisionNo: 1, budgetedHours: 100, budgetedQuantity: 0, effectiveFrom: new Date("2026-01-01T00:00:00Z") },
      ],
      actualHours: 104,
      firstBooking: new Date("2026-09-20T00:00:00Z"),
      lastBooking: new Date("2026-09-30T00:00:00Z"),
      now,
    })
  );
  assert.equal(facts.displayName, "JO-1-Piling");
  assert.equal(facts.hoursBand, "RED");
  assert.equal(facts.burnPct, 1.04);
  assert.equal(facts.daysSinceActivity, 2);
  assert.equal(facts.attentionScore, 40);
  assert.ok(facts.reasons.includes("hours budget exhausted"));
  assert.equal(dayKey(facts.lastBooking), "2026-09-30");
});

test("buildJobOrderFacts: threads the operator's activityDays into the reason (default 7, explicit 14)", () => {
  const now = new Date("2026-10-02T00:00:00Z");
  // 10 days idle. With NO activityDays supplied the builder defaults to 7 (today's behaviour),
  // so the row is stalled and the reason names 7.
  const byDefault = buildJobOrderFacts(
    buildInput({
      jobOrder: { ...buildInput().jobOrder, budgetedHours: 100 },
      budgetRevisions: [
        { revisionNo: 1, budgetedHours: 100, budgetedQuantity: 0, effectiveFrom: new Date("2026-01-01T00:00:00Z") },
      ],
      actualHours: 20,
      lastBooking: daysAgo(now, 10),
      now,
    })
  );
  assert.equal(byDefault.attentionScore, 30, "default window is 7 -> 10 days idle IS stalled");
  assert.ok(byDefault.reasons.includes("no hours booked in the last 7 days"));

  // With activityDays: 14 the SAME row is inside the window and carries no stalled reason.
  const wider = buildJobOrderFacts(
    buildInput({
      jobOrder: { ...buildInput().jobOrder, budgetedHours: 100 },
      budgetRevisions: [
        { revisionNo: 1, budgetedHours: 100, budgetedQuantity: 0, effectiveFrom: new Date("2026-01-01T00:00:00Z") },
      ],
      actualHours: 20,
      lastBooking: daysAgo(now, 10),
      now,
      activityDays: 14,
    })
  );
  assert.equal(wider.attentionScore, 0, "14-day window -> 10 days idle is NOT stalled");
  assert.equal(wider.reasons.some((r: string) => r.includes("no hours booked")), false);

  // 15 days idle with activityDays: 14 IS stalled, and the reason states 14.
  const idle15 = buildJobOrderFacts(
    buildInput({
      jobOrder: { ...buildInput().jobOrder, budgetedHours: 100 },
      budgetRevisions: [
        { revisionNo: 1, budgetedHours: 100, budgetedQuantity: 0, effectiveFrom: new Date("2026-01-01T00:00:00Z") },
      ],
      actualHours: 20,
      lastBooking: daysAgo(now, 15),
      now,
      activityDays: 14,
    })
  );
  assert.equal(idle15.attentionScore, 30);
  assert.ok(idle15.reasons.includes("no hours booked in the last 14 days"));
});

/* ------------------------------------------------------------------ *
 * Task 5 — roll-ups
 * ------------------------------------------------------------------ */

function makeFacts(over: Partial<JobOrderFacts> = {}): JobOrderFacts {
  return {
    id: 1,
    code: "JO-1",
    name: "Job One",
    displayName: "JO-1-Job One",
    project: { id: 1, code: "P1", name: "Project One" },
    wbs: { id: 1, wbsCode: "W1", name: "WBS One" },
    department: { id: 1, name: "Dept One" },
    section: { id: 1, name: "Section One" },
    status: "active",
    uom: "MTR",
    budgetHours: 100,
    actualHours: 10,
    burnPct: 0.1,
    hoursBand: "GREEN",
    hoursPerDay: null,
    forecastExhaustedOn: null,
    targetQty: 0,
    achievedQty: 0,
    qtyPct: null,
    qtyCompletePct: 0,
    qtyBand: "NOT_MEASURABLE",
    balanceQty: 0,
    lastBooking: null,
    daysSinceActivity: null,
    unapprovedHours: 0,
    oldestUnapprovedAt: null,
    measurableOnHours: true,
    measurableOnQuantity: false,
    attentionScore: 0,
    reasons: [],
    ...over,
  };
}

test("rollUpProjects: the worst band wins, and the attention score is the sum", () => {
  const project = { id: 1, code: "P1", name: "Project One" };
  const facts = [
    makeFacts({ id: 1, project, hoursBand: "RED", actualHours: 110, attentionScore: 40 }),
    makeFacts({ id: 2, project, hoursBand: "GREEN", actualHours: 10, attentionScore: 0 }),
  ];

  const rolls = rollUpProjects(facts);
  assert.equal(rolls.length, 1);
  assert.equal(rolls[0].hoursBand, "RED", "RED beats GREEN");
  assert.equal(rolls[0].attentionScore, 40);
  assert.equal(rolls[0].jobOrderCount, 2);
  assert.equal(rolls[0].redCount, 1);
  assert.equal(rolls[0].greenCount, 1);
  assert.equal(rolls[0].budgetHours, 200, "budgeted hours are summed");
  assert.equal(rolls[0].actualHours, 120, "booked hours are summed");
});

test("rollUpProjects: a project of only unmeasurable job orders is NOT_MEASURABLE", () => {
  const project = { id: 2, code: "P2", name: "Project Two" };
  const facts = [
    makeFacts({ id: 3, project, budgetHours: 0, measurableOnHours: false, hoursBand: "NOT_MEASURABLE" }),
    makeFacts({ id: 4, project, budgetHours: 0, measurableOnHours: false, hoursBand: "NOT_MEASURABLE" }),
  ];

  const rolls = rollUpProjects(facts);
  assert.equal(rolls[0].hoursBand, "NOT_MEASURABLE");
  assert.equal(rolls[0].notMeasurableCount, 2);
});

test("rollUpProjects: sorted by attention score descending", () => {
  const facts = [
    makeFacts({ id: 1, project: { id: 1, code: "P1", name: "One" }, attentionScore: 10 }),
    makeFacts({ id: 2, project: { id: 2, code: "P2", name: "Two" }, attentionScore: 55 }),
  ];
  const rolls = rollUpProjects(facts);
  assert.equal(rolls[0].project.id, 2);
  assert.equal(rolls[1].project.id, 1);
});

test("rollUpDepartments: totals equal the sum of their job orders", () => {
  const department = { id: 3, name: "Dept Three" };
  const facts = [
    makeFacts({ id: 1, department, budgetHours: 100, actualHours: 30, hoursBand: "GREEN", attentionScore: 10 }),
    makeFacts({ id: 2, department, budgetHours: 200, actualHours: 220, hoursBand: "RED", attentionScore: 40 }),
  ];

  const rolls = rollUpDepartments(facts);
  assert.equal(rolls.length, 1);
  assert.equal(rolls[0].budgetHours, 300);
  assert.equal(rolls[0].actualHours, 250);
  assert.equal(rolls[0].jobOrderCount, 2);
  assert.equal(rolls[0].attentionScore, 50);
  assert.equal(rolls[0].hoursBand, "RED");
  assert.equal(rolls[0].sectionCount, 1);
});

/* ------------------------------------------------------------------ *
 * The booked-hours definition — the note must be TRUE
 * ------------------------------------------------------------------ */

test("booked hours: the definition note does NOT claim parity with the Summary, and names the exact statuses summed", () => {
  // THE regression test for the false claim this change removes. The shipped note said
  // "Booked hours match GET /api/summary/job-order", which was untrue: this dashboard counts
  // SUBMITTED/SUP_APPROVED alongside HOD_APPROVED/PM_APPROVED, while the Summary counts only
  // PM_APPROVED. The note is printed on the screen, in the XLSX Filters sheet and on PDF page 1,
  // so a false parity claim there is a lie to every reader. This test fails if the claim comes back.
  const note = BOOKED_HOURS_NOTE;

  // (a) No statement of parity with the Summary — in any of its old phrasings.
  assert.ok(
    !/match(es)?\s+GET \/api\/summary\/job-order/i.test(note),
    `the note must not claim it matches the Summary: ${note}`
  );
  assert.ok(!/\bmatch(es)?\b/i.test(note), `the note must not use "match" about the Summary: ${note}`);
  assert.ok(
    !/same (figure|as) .*summary/i.test(note),
    `the note must not claim the same figure as the Summary: ${note}`
  );

  // (b) It must EXPLICITLY distinguish the two figures, not merely omit the false claim.
  assert.ok(
    /NOT the Summary/i.test(note),
    `the note must say plainly it is NOT the Summary's figure: ${note}`
  );
  assert.ok(
    /PM_APPROVED/.test(note),
    `the note must name the Summary's approved-only population so the difference is checkable: ${note}`
  );
  assert.ok(
    /awaiting approval/i.test(note) && /exceed|higher/i.test(note),
    `the note must say the booked figure includes not-yet-approved hours and can exceed the Summary's: ${note}`
  );

  // (c) The note documents the EXACT set the figure sums, named in full.
  for (const status of BOOKED_HOURS_STATUSES) {
    assert.ok(note.includes(status), `the note must name the status "${status}" it sums: ${note}`);
  }

  // (d) The documented statuses are exactly the set, in order, and a strict superset of the
  // Summary's — the structural reason the booked figure equals or exceeds the approved-only one.
  assert.deepEqual(
    [...BOOKED_HOURS_STATUSES],
    ["SUBMITTED", "SUP_APPROVED", "HOD_APPROVED", "PM_APPROVED"],
    "the documented booked-hour statuses are exactly these four"
  );
  assert.deepEqual([...SUMMARY_APPROVED_HOURS_STATUSES], ["PM_APPROVED"]);
  for (const status of SUMMARY_APPROVED_HOURS_STATUSES) {
    assert.ok(
      (BOOKED_HOURS_STATUSES as readonly string[]).includes(status),
      `every Summary-approved status must also be counted as booked, or the figures could invert: ${status}`
    );
  }
  assert.ok(
    BOOKED_HOURS_STATUSES.length > SUMMARY_APPROVED_HOURS_STATUSES.length,
    "booked is a STRICT superset of approved, which is why booked >= approved"
  );
  // DRAFT is deliberately NOT booked: never-submitted work is not yet booked.
  assert.ok(!(BOOKED_HOURS_STATUSES as readonly string[]).includes("DRAFT"));
});
