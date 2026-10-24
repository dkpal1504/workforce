import assert from "node:assert/strict";
import test from "node:test";
import { chooseSettledCoverage } from "./settledWorkDays";

const range = ["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27"];

test("the flag being off keeps every calendar day for every man", () => {
  const coverage = chooseSettledCoverage({ mode: "CALENDAR", employeeIds: [1, 2], rangeDays: range, settled: [] });
  assert.equal(coverage.mode, "CALENDAR");
  assert.equal(coverage.pairs, null);
  assert.equal(coverage.pairCount, 14);
});

test("two men with different weekly offs each owe only their own days", () => {
  // This is the case a yard-wide calendar cannot express: A rests on Sunday, B rests on Friday.
  const settled = [
    ...[range[0], range[1], range[2], range[3], range[4], range[5]].map((date) => ({
      employeeId: 1, date, attendanceClass: "WORKED",
    })),
    { employeeId: 1, date: range[6], attendanceClass: "OFF" }, // A's Sunday
    ...[range[0], range[1], range[2], range[3], range[6]].map((date) => ({
      employeeId: 2, date, attendanceClass: "WORKED",
    })),
    { employeeId: 2, date: range[4], attendanceClass: "OFF" }, // B's Friday
    { employeeId: 2, date: range[5], attendanceClass: "ABSENT" },
  ];

  const coverage = chooseSettledCoverage({ mode: "SETTLED", employeeIds: [1, 2], rangeDays: range, settled });
  assert.equal(coverage.mode, "SETTLED");
  assert.equal(coverage.pairCount, 11, "6 days for A plus 5 for B");
  assert.equal(coverage.pairs?.has("1:2026-09-27"), false, "A's weekly off is not a day he owed");
  assert.equal(coverage.pairs?.has("2:2026-09-25"), false, "B's weekly off is not a day he owed");
  assert.equal(coverage.pairs?.has("2:2026-09-26"), false, "an absence is not a day he owed either");
  assert.equal(coverage.pairs?.has("1:2026-09-25"), true, "A worked the day B rested");
});

test("a man with no settled attendance keeps his calendar days and is named", () => {
  const settled = [{ employeeId: 1, date: range[0], attendanceClass: "WORKED" }];
  const coverage = chooseSettledCoverage({ mode: "SETTLED", employeeIds: [1, 2], rangeDays: range, settled });
  assert.deepEqual(coverage.employeesOnCalendarDays, [2]);
  assert.equal(coverage.pairs?.has("2:2026-09-27"), true);
  assert.equal(coverage.daysByEmployee?.get(2)?.length, 7);
});

test("if nobody has settled attendance the report behaves exactly as before", () => {
  const coverage = chooseSettledCoverage({ mode: "SETTLED", employeeIds: [1, 2], rangeDays: range, settled: [] });
  assert.equal(coverage.mode, "CALENDAR");
  assert.equal(coverage.pairs, null);
  assert.deepEqual(coverage.employeesOnCalendarDays, [1, 2]);
});
