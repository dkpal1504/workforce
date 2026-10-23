import assert from "node:assert/strict";
import test from "node:test";
import { eachDay, notBookedCsv, summariseNotBooked } from "./notBooked";

const people = [
  { id: 1, ecNo: "E1", name: "Absent All Week", department: "Production", section: "Piping", category: "CONTRACTOR" },
  { id: 2, ecNo: "E2", name: "Works Every Day", department: "Production", section: "Piping", category: "CONTRACTOR" },
  { id: 3, ecNo: "E3", name: "Odd Day Off", department: "Production", section: "Steel", category: "CONTRACTOR" },
];

// 3-day range; everyone except #2 has some gap
const booked = new Map<number, Set<string>>([
  [1, new Set()],
  [2, new Set(["2026-09-01", "2026-09-02", "2026-09-03"])],
  [3, new Set(["2026-09-02"])],
]);

const report = summariseNotBooked({
  from: "2026-09-01",
  to: "2026-09-03",
  maxDailyHours: 8,
  people,
  booked,
  rateFor: () => 100,
});

test("a person booked on every day is not listed at all", () => {
  assert.equal(report.people.some((p) => p.id === 2), false);
  assert.equal(report.totals.roster, 3);
  assert.equal(report.totals.peopleWithAnyGap, 2);
});

test("consecutive days collapse into one run, and the longest run is what is reported", () => {
  const absent = report.people.find((p) => p.id === 1)!;
  assert.equal(absent.notBookedDays, 3);
  assert.equal(absent.longestRun, 3);
  assert.equal(absent.runAtEnd, 3);
  assert.equal(absent.hours, 24);
  assert.equal(absent.cost, 2400);
});

test("a day worked in the middle breaks the run", () => {
  const odd = report.people.find((p) => p.id === 3)!;
  assert.equal(odd.notBookedDays, 2);
  assert.equal(odd.longestRun, 1);   // 1 Sep and 3 Sep, not a 2-day run
  assert.equal(odd.runAtEnd, 1);     // he was unbooked on the last day
  assert.equal(odd.firstDay, "2026-09-01");
  assert.equal(odd.lastDay, "2026-09-03");
});

test("people are ordered by the size of the gap, worst first", () => {
  assert.deepEqual(report.people.map((p) => p.id), [1, 3]);
});

test("the CSV carries the header and one line per listed person", () => {
  const rows = notBookedCsv(report);
  assert.equal(rows[0][0], "EC No");
  assert.equal(rows.length, 3);
  assert.equal(rows[1][0], "E1");
  assert.equal(rows[1][12], "2400.00");
});

test("eachDay includes both ends and refuses an inverted range", () => {
  assert.deepEqual(eachDay("2026-09-01", "2026-09-03"), ["2026-09-01", "2026-09-02", "2026-09-03"]);
  assert.deepEqual(eachDay("2026-09-03", "2026-09-01"), []);
});
