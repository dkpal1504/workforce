import test from "node:test";
import assert from "node:assert/strict";
import {
  parseCronHours,
  runTriggerLabel,
  syncCadence,
  syncFreshness,
  type FreshnessState,
} from "./syncFreshness";

const HOUR = 3_600_000;
const NOW = new Date("2026-09-29T12:00:00Z");

function ago(hours: number): Date {
  return new Date(NOW.getTime() - hours * HOUR);
}

/**
 * The badge that answers "is the refresh happening on time?" is only trustworthy if its
 * threshold comes from the configured cadence. Every state is asserted at both sides of its
 * boundary, because an off-by-one threshold either cries wolf every quiet afternoon or hides
 * a real outage behind "FRESH".
 */

test("the default schedule is read as two runs a day, 12 hours apart", () => {
  // 0 6,18 * * * -> 06:00 and 18:00, so the worst case is the 12h overnight gap.
  const cadence = syncCadence("0 6,18 * * *");
  assert.deepEqual(cadence, { runsPerDay: 2, maxGapHours: 12, overdueAfterHours: 14 });
});

test("a daily schedule gives a 24-hour gap, so 'overdue' must not mean 'past noon'", () => {
  const cadence = syncCadence("30 6 * * *");
  assert.equal(cadence?.maxGapHours, 24);
  assert.equal(cadence?.overdueAfterHours, 26);
  // The trap this guards: a fixed 24h rule would call a once-a-day 06:00 feed late by 14:00.
  const state = syncFreshness({ lastRefreshAt: ago(20), lastRunOk: true, now: NOW, overdueAfterHours: cadence!.overdueAfterHours });
  assert.equal(state.state, "FRESH");
});

test("an hourly schedule is overdue after 3 hours, not after 14", () => {
  const cadence = syncCadence("0 * * * *");
  assert.deepEqual(cadence, { runsPerDay: 24, maxGapHours: 1, overdueAfterHours: 3 });
  assert.equal(syncFreshness({ lastRefreshAt: ago(1), lastRunOk: true, now: NOW, overdueAfterHours: 3 }).state, "FRESH");
  assert.equal(syncFreshness({ lastRefreshAt: ago(4), lastRunOk: true, now: NOW, overdueAfterHours: 3 }).state, "OVERDUE");
});

test("an every-6-hours schedule is overdue after 8 hours", () => {
  const cadence = syncCadence("0 */6 * * *");
  assert.deepEqual(cadence, { runsPerDay: 4, maxGapHours: 6, overdueAfterHours: 8 });
});

test("the boundary itself is fresh, and the first hour past it is overdue", () => {
  const overdueAfterHours = 14;
  assert.equal(syncFreshness({ lastRefreshAt: ago(12), lastRunOk: true, now: NOW, overdueAfterHours }).state, "FRESH");
  assert.equal(syncFreshness({ lastRefreshAt: ago(13.99), lastRunOk: true, now: NOW, overdueAfterHours }).state, "FRESH");
  assert.equal(syncFreshness({ lastRefreshAt: ago(14.01), lastRunOk: true, now: NOW, overdueAfterHours }).state, "OVERDUE");
});

test("never having refreshed outranks everything — there is no data to judge", () => {
  for (const ok of [true, false, null]) {
    const state = syncFreshness({ lastRefreshAt: null, lastRunOk: ok, now: NOW, overdueAfterHours: 14 });
    assert.equal(state.state, "NEVER");
    assert.equal(state.ageHours, null);
  }
});

test("a failed run names the cause instead of only reporting staleness", () => {
  // Fresh data but the last ATTEMPT threw: the operator needs to see the failure.
  const state = syncFreshness({ lastRefreshAt: ago(0.5), lastRunOk: false, now: NOW, overdueAfterHours: 14 });
  assert.equal(state.state, "FAILED");
  assert.equal(state.ageHours, 0.5);
});

test("a failed run that is also old is still reported as the failure", () => {
  // FAILED outranks OVERDUE: the failure is usually the REASON it is overdue.
  const state = syncFreshness({ lastRefreshAt: ago(40), lastRunOk: false, now: NOW, overdueAfterHours: 14 });
  assert.equal(state.state, "FAILED");
});

test("an unknown cadence still reports freshness and failure, and never false-alarms", () => {
  // parseCronHours refuses what it cannot read, and the caller passes null. Reporting OVERDUE
  // against a guessed threshold is worse than reporting nothing.
  const state = syncFreshness({ lastRefreshAt: ago(400), lastRunOk: true, now: NOW, overdueAfterHours: null });
  assert.equal(state.state, "FRESH");
  assert.equal(state.overdueAfterHours, null);
  assert.equal(state.ageHours, 400);
});

test("a clock skew into the future clamps to zero rather than showing a negative age", () => {
  const future = new Date(NOW.getTime() + 5 * HOUR);
  const state = syncFreshness({ lastRefreshAt: future, lastRunOk: true, now: NOW, overdueAfterHours: 14 });
  assert.equal(state.ageHours, 0);
  assert.equal(state.state, "FRESH");
});

test("an unreadable or unsupported cron expression is refused, not guessed", () => {
  for (const expr of ["", "0 6,18 * *", "0 6,18 * * * *", "0 6,18 * * MON", "@daily", "0 25 * * *", "0 6,a * * *", "0 6-18 * * *"]) {
    assert.equal(parseCronHours(expr), null, `"${expr}" must not be guessed`);
    assert.equal(syncCadence(expr), null);
  }
});

test("cron hour forms that the job does use are read correctly", () => {
  assert.deepEqual(parseCronHours("0 6,18 * * *"), [6, 18]);
  assert.deepEqual(parseCronHours("15 0 * * *"), [0]);
  assert.deepEqual(parseCronHours("0 0,6,12,18 * * *"), [0, 6, 12, 18]);
  assert.deepEqual(parseCronHours("0 */12 * * *"), [0, 12]);
  assert.equal(parseCronHours("0 * * * *")?.length, 24);
});

test("the overnight wrap is counted, so the longest gap is not assumed to be midday", () => {
  // 06:00 and 18:00: gaps are 12h and 12h. A single 23:00 run has ONE gap of 24h (not 1h).
  assert.equal(syncCadence("0 6,18 * * *")?.maxGapHours, 12);
  assert.equal(syncCadence("0 23 * * *")?.maxGapHours, 24);
  // 02:00 and 20:00 -> gaps 18h and 6h; the overnight one is the maximum.
  assert.equal(syncCadence("0 2,20 * * *")?.maxGapHours, 18);
});

test("every state is reachable and distinct", () => {
  const seen = new Set<FreshnessState>([
    syncFreshness({ lastRefreshAt: null, lastRunOk: null, now: NOW, overdueAfterHours: 14 }).state,
    syncFreshness({ lastRefreshAt: ago(1), lastRunOk: false, now: NOW, overdueAfterHours: 14 }).state,
    syncFreshness({ lastRefreshAt: ago(40), lastRunOk: true, now: NOW, overdueAfterHours: 14 }).state,
    syncFreshness({ lastRefreshAt: ago(1), lastRunOk: true, now: NOW, overdueAfterHours: 14 }).state,
  ]);
  assert.equal(seen.size, 4);
});

test("the trigger is named in words, so the badge distinguishes schedule from button", () => {
  assert.equal(runTriggerLabel("SYNC_SCHEDULED_RUN"), "the schedule");
  assert.equal(runTriggerLabel("SYNC_ONE_SHOT_RUN"), "a one-shot run in the container");
  assert.equal(runTriggerLabel("ADMIN_BADGEVIEW_SYNC"), "an admin refresh");
  // An unrecognised action passes through rather than being mislabelled as one of the three.
  assert.equal(runTriggerLabel("SOMETHING_ELSE"), "SOMETHING_ELSE");
});
