import test from "node:test";
import assert from "node:assert/strict";
import {
  approvedOtByEcNo,
  approvedOtCarrierDayIds,
  approvedOtForDays,
  attributeApprovedOt,
  parseApprovedOt,
  parseApprovedOtFixture,
  planApprovedOtUpdate,
  approvedOtDateRange,
  type ApprovedOtForDate,
  type SheetForApprovedOt,
} from "./approvedOt";

/**
 * WHY THESE TESTS EXIST: the approved figure decides what a man is PAID, so the four decisions that
 * can silently pay the wrong number are pinned here — an unread date must write nothing, a missing
 * source row must write 0 rather than the punch, a MANUAL value must never be touched, and one
 * employee-day must never be counted twice because two supervisors booked him.
 */

function sheet(overrides: Partial<SheetForApprovedOt> = {}): SheetForApprovedOt {
  return {
    dayId: 1,
    employeeId: 10,
    employeeName: "A. Worker",
    ecNo: "BAPL0123",
    workDate: "2026-11-24",
    status: "SUBMITTED",
    punchedOtHours: 3,
    previousHours: null,
    previousSource: null,
    ...overrides,
  };
}

function readings(entries: Record<string, number | null>): ApprovedOtForDate {
  return approvedOtByEcNo(
    Object.entries(entries).map(([IdNo, ApprovedOT]) => ({ IdNo, ApprovedOT, Records: 1 }))
  );
}

test("parseApprovedOt accepts numbers, strings and comma decimals, and refuses nonsense", () => {
  assert.equal(parseApprovedOt(2), 2);
  assert.equal(parseApprovedOt("2.5"), 2.5);
  assert.equal(parseApprovedOt(" 2,5 "), 2.5);
  assert.equal(parseApprovedOt(null), null);
  assert.equal(parseApprovedOt("abc"), null);
});

test("approvedOtByEcNo keys ids upper-cased and adds split-day rows", () => {
  const map = approvedOtByEcNo([
    { IdNo: " bapl0123 ", ApprovedOT: 2, Records: 1 },
    { IdNo: "BAPL0123", ApprovedOT: 1, Records: 1 },
    { IdNo: "BAPL9999", ApprovedOT: null, Records: 1 },
  ]);
  assert.deepEqual(map.get("BAPL0123"), { ecNo: "bapl0123", hours: 3, records: 2 });
  assert.deepEqual(map.get("BAPL9999"), { ecNo: "BAPL9999", hours: null, records: 1 });
});

test("a matching CLMS row replaces the punch with the approved figure", () => {
  const plan = planApprovedOtUpdate(
    [sheet()],
    new Map([["2026-11-24", readings({ BAPL0123: 2 })]]),
    new Set(["2026-11-24"])
  );
  assert.equal(plan[0].outcome, "MATCHED");
  assert.equal(plan[0].approvedHours, 2);
  assert.equal(plan[0].punchedOtHours, 3, "the punch is carried as a reference");
  assert.equal(plan[0].wouldChange, true);
});

test("no source row for the id means ZERO approved overtime, never the punch", () => {
  const plan = planApprovedOtUpdate(
    [sheet({ punchedOtHours: 5 })],
    new Map([["2026-11-24", readings({ BAPL0001: 4 })]]),
    new Set(["2026-11-24"])
  );
  assert.equal(plan[0].outcome, "NONE_APPROVED");
  assert.equal(plan[0].approvedHours, 0);
});

test("a date the source did not answer writes NOTHING, not zero", () => {
  const plan = planApprovedOtUpdate(
    [sheet({ previousHours: 2, previousSource: "LABOURWORKS" })],
    new Map(),
    new Set()
  );
  assert.equal(plan[0].outcome, "UNREAD");
  assert.equal(plan[0].wouldChange, false);
  assert.equal(plan[0].approvedHours, 2, "the previous figure survives a failed read");
});

test("a MANUAL value is never overwritten or even compared", () => {
  const plan = planApprovedOtUpdate(
    [sheet({ previousHours: 1, previousSource: "MANUAL" })],
    new Map([["2026-11-24", readings({ BAPL0123: 4 })]]),
    new Set(["2026-11-24"])
  );
  assert.equal(plan[0].outcome, "MANUAL");
  assert.equal(plan[0].wouldChange, false);
  assert.equal(plan[0].approvedHours, 1);
});

test("re-running with the same source writes nothing (idempotent)", () => {
  const plan = planApprovedOtUpdate(
    [sheet({ previousHours: 2, previousSource: "LABOURWORKS" })],
    new Map([["2026-11-24", readings({ BAPL0123: 2 })]]),
    new Set(["2026-11-24"])
  );
  assert.equal(plan[0].wouldChange, false);
});

test("two supervisors' sheets for one man-day collapse to ONE approved fact", () => {
  const byDay = approvedOtForDays([
    { employeeId: 10, workDate: new Date("2026-11-24T00:00:00Z"), approvedOtHours: 2, approvedOtSource: "LABOURWORKS" },
    { employeeId: 10, workDate: new Date("2026-11-24T00:00:00Z"), approvedOtHours: 2, approvedOtSource: "LABOURWORKS" },
  ]);
  assert.equal(byDay.size, 1);
  assert.equal(byDay.get("10|2026-11-24")?.hours, 2);
});

test("the approved OT is attributed to ONE carrier sheet per employee-day", () => {
  const carriers = approvedOtCarrierDayIds([
    { id: 7, employeeId: 10, workDate: "2026-11-24", entries: [{ otHours: null }] },
    { id: 8, employeeId: 10, workDate: "2026-11-24", entries: [{ otHours: 2 }] },
    { id: 9, employeeId: 10, workDate: "2026-11-25", entries: [{ otHours: null }] },
    { id: 12, employeeId: 10, workDate: "2026-11-25", entries: [{ otHours: null }] },
  ]);
  assert.ok(carriers.has(8), "the sheet that booked the OT carries it");
  assert.ok(!carriers.has(7));
  assert.ok(carriers.has(9), "a day with no OT booking is carried by its lowest day id");
  assert.ok(!carriers.has(12));
});

test("entry-level attribution gives the whole day to the lowest OT row and zero to the rest", () => {
  const byDay = approvedOtForDays([
    { employeeId: 10, workDate: "2026-11-24", approvedOtHours: 3, approvedOtSource: "LABOURWORKS" },
  ]);
  const attributed = attributeApprovedOt(
    [
      { id: 30, employeeId: 10, workDate: "2026-11-24", otHours: 2 },
      { id: 31, employeeId: 10, workDate: "2026-11-24", otHours: 1 },
      { id: 32, employeeId: 10, workDate: "2026-11-24", otHours: null },
    ],
    byDay
  );
  assert.equal(attributed.get(30), 3);
  assert.equal(attributed.get(31), 0);
  assert.equal(attributed.has(32), false, "a slot row is not an OT row");
});

test("fixtures: JSON and CSV both mirror the SQL shape", () => {
  const json = parseApprovedOtFixture('{"2026-11-24":{"BAPL0123":2,"BAPL0124":0}}');
  assert.equal(json.get("2026-11-24")?.get("BAPL0123")?.hours, 2);
  assert.equal(json.get("2026-11-24")?.get("BAPL0124")?.hours, 0);

  const csv = parseApprovedOtFixture("date,IDNo,AcceptedOT\n2026-11-24,BAPL0123,2.5\n");
  assert.equal(csv.get("2026-11-24")?.get("BAPL0123")?.hours, 2.5);
});

test("date ranges refuse a backwards range", () => {
  assert.deepEqual(approvedOtDateRange("2026-11-24", "2026-11-25"), ["2026-11-24", "2026-11-25"]);
  assert.throws(() => approvedOtDateRange("2026-11-25", "2026-11-24"));
});
