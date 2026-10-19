import test from "node:test";
import assert from "node:assert/strict";
import { formatDay, formatStamp } from "./formatDate";

/**
 * The ONE date format, pinned: `dd-mm-yyyy`.
 *
 * These tests exist because the format drifted back twice already — a new screen would reach for
 * `toLocaleDateString()` or `.slice(0, 10)` and print a different date from the one beside it. A
 * failure here means a screen is about to print a second format, not that the expectation is wrong.
 */

test("a stored DAY prints dd-mm-yyyy, whether it arrives as a key or an instant", () => {
  assert.equal(formatDay("2026-10-16"), "16-10-2026");
  assert.equal(formatDay("2026-10-16T00:00:00.000Z"), "16-10-2026");
  assert.equal(formatDay("2026-01-05"), "05-01-2026", "day and month are zero-padded");
  assert.equal(formatDay("2026-12-31T23:00:00.000Z"), "31-12-2026", "UTC day, never shifted by the machine's zone");
});

test("a missing or unreadable day is visible, never silently a dash or today", () => {
  assert.equal(formatDay(null), "—");
  assert.equal(formatDay(undefined), "—");
  assert.equal(formatDay(""), "—");
  // Unparseable input is returned AS IT ARRIVED: a wrong-looking date is better than a quiet dash.
  assert.equal(formatDay("16/10/2026"), "16/10/2026");
});

test("a stored INSTANT prints dd-mm-yyyy HH:mm in the operator's own zone", () => {
  const iso = "2026-10-16T07:05:00.000Z";
  const shown = formatStamp(iso);
  assert.match(shown, /^\d{2}-\d{2}-\d{4} \d{2}:\d{2}$/, `got "${shown}"`);

  // The day and time must be the LOCAL reading of that instant, which is what the operator saw on
  // the clock. Computed here the same way rather than hardcoded, so the test holds in any zone.
  const local = new Date(iso);
  const expected = `${String(local.getDate()).padStart(2, "0")}-${String(local.getMonth() + 1).padStart(2, "0")}-${local.getFullYear()}`
    + ` ${String(local.getHours()).padStart(2, "0")}:${String(local.getMinutes()).padStart(2, "0")}`;
  assert.equal(shown, expected);
});

test("a missing or unreadable instant behaves like a day", () => {
  assert.equal(formatStamp(null), "—");
  assert.equal(formatStamp(""), "—");
  assert.equal(formatStamp("not a date"), "not a date");
});
