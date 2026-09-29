import test from "node:test";
import assert from "node:assert/strict";
import { describeAge, formatRefreshedAt, lastTriggerNote, syncBadge, type SyncStatus } from "./syncBadge";

/**
 * The badge exists because "is the LabourWorks refresh happening on time?" could only be
 * answered by running SQL. These tests pin the two things that make it trustworthy rather
 * than decorative: every timestamp NAMES its timezone, and a switched-off schedule is not
 * dressed up as a fault.
 */

function status(overrides: Partial<SyncStatus> = {}): SyncStatus {
  return {
    source: "LABOURWORKS",
    enabled: true,
    cron: "0 6,18 * * *",
    schedule: { runsPerDay: 2, maxGapHours: 12, overdueAfterHours: 14 },
    nowUtc: "2026-09-29T10:02:57.159Z",
    lastRefreshAt: "2026-09-29T09:56:23.687Z",
    ageHours: 0.1,
    overdueAfterHours: 14,
    state: "FRESH",
    lastRun: { action: "SYNC_SCHEDULED_RUN", trigger: "the schedule", at: "2026-09-29T09:56:44.994Z", ok: true, error: null },
    recentRuns: [],
    openExceptions: 0,
    ...overrides,
  };
}

test("a rendered timestamp names its timezone, so 00:30 UTC is never mistaken for 00:30 IST", () => {
  // 00:30 UTC on 29 Sep is 06:00 IST — the 06:00 run the operator is looking for.
  const text = formatRefreshedAt("2026-09-28T00:30:00.000Z");
  assert.equal(text, "28 Sep 2026, 06:00 IST");
  assert.match(text!, /IST/);
});

test("the same instant renders differently in two zones, and both are labelled", () => {
  const utc = formatRefreshedAt("2026-09-29T09:56:00.000Z", "UTC");
  const ist = formatRefreshedAt("2026-09-29T09:56:00.000Z");
  assert.match(utc!, /09:56 UTC/);
  assert.match(ist!, /15:26 IST/);
});

test("an absent or unparseable timestamp renders as nothing rather than an invalid Date", () => {
  assert.equal(formatRefreshedAt(null), null);
  assert.equal(formatRefreshedAt("not-a-date"), null);
  assert.equal(formatRefreshedAt(""), null);
});

test("ages read the way a person says them", () => {
  assert.equal(describeAge(null), "no data yet");
  assert.equal(describeAge(0), "just now");
  assert.equal(describeAge(0.005), "just now");
  assert.equal(describeAge(0.2), "12m ago");
  assert.equal(describeAge(1), "1h ago");
  assert.equal(describeAge(1.5), "1h 30m ago");
  assert.equal(describeAge(23.9), "23h 54m ago");
  assert.equal(describeAge(24), "1d ago");
  assert.equal(describeAge(52), "2d 4h ago");
});

test("a fresh, enabled schedule reports ok and says when it last refreshed", () => {
  const badge = syncBadge(status());
  assert.equal(badge.tone, "ok");
  assert.match(badge.headline, /^Last refreshed: 29 Sep 2026, 15:26 IST$/);
  assert.match(badge.detail, /On time/);
});

test("a switched-off schedule is muted, NOT an alarm — otherwise it cries wolf forever", () => {
  // This is the dev/production default (BADGEVIEW_SYNC_ENABLED=false). Reporting OVERDUE here
  // sends the operator hunting for a bug that is not there.
  const badge = syncBadge(status({ enabled: false, state: "OVERDUE", ageHours: 24.1 }));
  assert.equal(badge.tone, "muted");
  assert.match(badge.detail, /switched off/);
  assert.match(badge.detail, /BADGEVIEW_SYNC_ENABLED=false/);
  assert.ok(!/Overdue/.test(badge.detail));
});

test("a switched-off schedule that has never run says so plainly", () => {
  const badge = syncBadge(status({ enabled: false, lastRefreshAt: null, ageHours: null, state: "NEVER", lastRun: null }));
  assert.equal(badge.headline, "Never refreshed");
  assert.equal(badge.tone, "muted");
  assert.match(badge.detail, /one-shot run/);
});

test("an enabled schedule with no data at all is an alarm with the next step", () => {
  const badge = syncBadge(status({ lastRefreshAt: null, ageHours: null, state: "NEVER", lastRun: null }));
  assert.equal(badge.tone, "bad");
  assert.equal(badge.headline, "Never refreshed");
  assert.match(badge.detail, /Run the sync once/);
});

test("a failed run shows the error, not just that the data is old", () => {
  const badge = syncBadge(status({
    state: "FAILED",
    ageHours: 0.5,
    lastRun: { action: "SYNC_SCHEDULED_RUN", trigger: "the schedule", at: "2026-09-29T09:56:00.000Z", ok: false, error: "Login failed for user 'it'." },
  }));
  assert.equal(badge.tone, "bad");
  assert.match(badge.detail, /Login failed for user 'it'\./);
  assert.match(badge.headline, /Last refreshed:/);
});

test("a failed run with no recorded message still tells the operator where to look", () => {
  const badge = syncBadge(status({
    state: "FAILED",
    lastRun: { action: "SYNC_SCHEDULED_RUN", trigger: "the schedule", at: "2026-09-29T09:56:00.000Z", ok: false, error: null },
  }));
  assert.match(badge.detail, /Check the API log/);
});

test("overdue names the threshold it was judged against, so the number is not mysterious", () => {
  const badge = syncBadge(status({ state: "OVERDUE", ageHours: 24.1 }));
  assert.equal(badge.tone, "warn");
  assert.match(badge.detail, /Overdue — 1d ago/);
  assert.match(badge.detail, /expected within 14h/);
  assert.match(badge.detail, /Runs 2 times a day/);
});

test("an unreadable cron says the alarm is not applied instead of inventing a threshold", () => {
  const badge = syncBadge(status({ schedule: null, overdueAfterHours: null }));
  assert.match(badge.detail, /could not be read/);
  assert.match(badge.detail, /no staleness alarm/);
  assert.doesNotMatch(badge.detail, /Overdue/);
});

test("a once-a-day schedule is described in the singular", () => {
  const badge = syncBadge(status({ cron: "30 6 * * *", schedule: { runsPerDay: 1, maxGapHours: 24, overdueAfterHours: 26 } }));
  assert.match(badge.detail, /Runs once a day/);
});

test("the trigger note distinguishes the schedule from a button press", () => {
  assert.match(lastTriggerNote(status()), /triggered by the schedule/);
  const oneShot = status({ lastRun: { action: "SYNC_ONE_SHOT_RUN", trigger: "a one-shot run in the container", at: "2026-09-29T09:56:00.000Z", ok: true, error: null } });
  assert.match(lastTriggerNote(oneShot), /one-shot run in the container/);
  const admin = status({ lastRun: { action: "ADMIN_BADGEVIEW_SYNC", trigger: "an admin refresh", at: "2026-09-29T09:56:00.000Z", ok: true, error: null } });
  assert.match(lastTriggerNote(admin), /an admin refresh/);
});

test("open exceptions are surfaced next to a successful run", () => {
  // A run that reports ok while rows fail to import is only half-working.
  const note = lastTriggerNote(status({ openExceptions: 7 }));
  assert.match(note, /7 row\(s\) could not be imported/);
  assert.doesNotMatch(lastTriggerNote(status()), /could not be imported/);
});

test("no recorded run is stated rather than left blank", () => {
  assert.equal(lastTriggerNote(status({ lastRun: null })), "No run has been recorded yet.");
});

test("a run with an unknown outcome is not described as failed", () => {
  const unknown = status({ lastRun: { action: "SYNC_SCHEDULED_RUN", trigger: "the schedule", at: "2026-09-29T09:56:00.000Z", ok: null, error: null } });
  const note = lastTriggerNote(unknown);
  assert.match(note, /Last run ended/);
  assert.ok(!/failed/.test(note), "an unknown outcome must not be reported as a failure");
});
