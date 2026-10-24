import assert from "node:assert/strict";
import test from "node:test";
import { defaultPeriod, periodLabel, resolveWindow } from "./reviewData";

test("the default review window is the last month, ending today", () => {
  const now = new Date("2026-10-24T09:00:00Z");
  const month = defaultPeriod(now);
  assert.equal(month.end, "2026-10-24");
  assert.equal(month.start, "2026-09-25", "30 days inclusive of today");
  const days = (new Date(month.end).getTime() - new Date(month.start).getTime()) / 86_400_000 + 1;
  assert.equal(days, 30);
});

test("a twelve-week window is still available when asked for explicitly", () => {
  const weekly = defaultPeriod(new Date("2026-10-24T09:00:00Z"), "WEEKLY");
  assert.equal(weekly.end, "2026-10-24");
  assert.equal(weekly.start, "2026-08-02");
  const days = (new Date(weekly.end).getTime() - new Date(weekly.start).getTime()) / 86_400_000 + 1;
  assert.equal(days, 84);
});

test("an explicit window wins, and a broken one is refused rather than guessed", () => {
  const now = new Date("2026-10-24T09:00:00Z");
  assert.deepEqual(resolveWindow({ kind: "MONTHLY", start: "2026-09-01", end: "2026-09-30" }, now), {
    start: "2026-09-01",
    end: "2026-09-30",
  });
  assert.throws(() => resolveWindow({ kind: "MONTHLY", start: "2026-10-30", end: "2026-10-01" }, now), /BAD_PERIOD/);
  assert.throws(() => resolveWindow({ kind: "MONTHLY", start: "30-09-2026", end: "2026-10-01" }, now), /BAD_PERIOD/);
});

test("a rolling month is labelled as a range, a calendar month by its name", () => {
  // The default window is 30 days ending today, which spans two calendar months. Calling that
  // "September 2026" would mislabel a month of numbers, so it prints the range.
  // en-GB short month for September is "Sept" in this ICU build — pin what the screen really prints.
  assert.equal(periodLabel({ start: "2026-09-25", end: "2026-10-24" }, "MONTHLY"), "25 Sept 2026 – 24 Oct 2026");
  assert.equal(periodLabel({ start: "2026-09-01", end: "2026-09-30" }, "MONTHLY"), "September 2026");
  assert.equal(periodLabel({ start: "2026-10-01", end: "2026-10-31" }, "MONTHLY"), "October 2026");
  assert.equal(periodLabel({ start: "2026-10-19", end: "2026-10-25" }, "WEEKLY"), "19 Oct 2026 – 25 Oct 2026");
});
