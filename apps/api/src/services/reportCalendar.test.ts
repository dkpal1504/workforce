import assert from "node:assert/strict";
import test from "node:test";
import { chooseReportDays } from "./reportCalendar";

const range = ["2026-10-16", "2026-10-17", "2026-10-18", "2026-10-19"];

test("with the calendar off, every calendar day is a day the report divides by", () => {
  const result = chooseReportDays({ rangeDays: range, mode: "CALENDAR", calendar: new Map() });
  assert.deepEqual(result.days, range);
  assert.equal(result.fellBack, false);
  assert.equal(result.mode, "CALENDAR");
});

test("with a settled calendar, a Sunday and a holiday stop being gaps", () => {
  const calendar = new Map([
    ["2026-10-16", "WORKING"],
    ["2026-10-17", "WORKING"],
    ["2026-10-18", "WEEKLY_OFF"], // Sunday
    ["2026-10-19", "HOLIDAY"], // Diwali
  ]);
  const result = chooseReportDays({ rangeDays: range, mode: "SETTLED", calendar });
  assert.deepEqual(result.days, ["2026-10-16", "2026-10-17"]);
  assert.equal(result.mode, "SETTLED");
  assert.equal(result.unsettledDates.length, 0);
});

test("a PARTIAL calendar falls back to the LARGER denominator, never a flattering one", () => {
  // Only one date has been settled. Dividing by it would shrink the denominator from 4 to 1 and make a
  // single filled day look like complete coverage.
  const calendar = new Map([["2026-10-16", "WORKING"]]);
  const result = chooseReportDays({ rangeDays: range, mode: "SETTLED", calendar });
  assert.equal(result.mode, "CALENDAR");
  assert.equal(result.fellBack, true);
  assert.deepEqual(result.days, range);
  assert.deepEqual(result.unsettledDates, ["2026-10-17", "2026-10-18", "2026-10-19"]);
});

test("a range with no working day returns no days rather than dividing by zero", () => {
  const calendar = new Map([
    ["2026-10-16", "HOLIDAY"],
    ["2026-10-17", "WEEKLY_OFF"],
    ["2026-10-18", "WEEKLY_OFF"],
    ["2026-10-19", "HOLIDAY"],
  ]);
  const result = chooseReportDays({ rangeDays: range, mode: "SETTLED", calendar });
  assert.deepEqual(result.days, []);
  assert.equal(result.mode, "SETTLED");
});
