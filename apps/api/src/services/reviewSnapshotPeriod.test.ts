import assert from "node:assert/strict";
import test from "node:test";
import { previousMonthWindow, previousWeekWindow } from "./reviewSnapshotScheduler";

test("the weekly freeze covers the week that just ended, Monday to Sunday", () => {
  // Monday 26 Oct 2026, 00:30 — the week just gone is 19..25 Oct.
  const window = previousWeekWindow(new Date("2026-10-26T00:30:00Z"));
  assert.deepEqual(window, { start: "2026-10-19", end: "2026-10-25" });
  // Mid-week still names the same previous week, never a partial one.
  assert.deepEqual(previousWeekWindow(new Date("2026-10-28T09:00:00Z")), {
    start: "2026-10-19",
    end: "2026-10-25",
  });
});

test("the weekly freeze across a month boundary is still a whole Monday-to-Sunday week", () => {
  assert.deepEqual(previousWeekWindow(new Date("2026-11-02T00:30:00Z")), {
    start: "2026-10-26",
    end: "2026-11-01",
  });
});

test("the monthly freeze covers the calendar month that just ended", () => {
  assert.deepEqual(previousMonthWindow(new Date("2026-11-01T01:30:00Z")), {
    start: "2026-10-01",
    end: "2026-10-31",
  });
  // A February, and a leap-year February, are the two cases a hand-rolled month length gets wrong.
  assert.deepEqual(previousMonthWindow(new Date("2027-03-01T01:30:00Z")), {
    start: "2027-02-01",
    end: "2027-02-28",
  });
  assert.deepEqual(previousMonthWindow(new Date("2028-03-01T01:30:00Z")), {
    start: "2028-02-01",
    end: "2028-02-29",
  });
});
