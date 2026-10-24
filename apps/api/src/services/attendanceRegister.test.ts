import test from "node:test";
import assert from "node:assert/strict";
import {
  aggregateRegisterRows,
  classFor,
  isPresentStatus,
  clockedHoursOf,
  dayTypeForStatuses,
  normaliseRegisterStatus,
  parseWeeklyOff,
  presenceRank,
  registerStatusLabel,
  workedHoursOnOffDay,
  type RawRegisterRow,
} from "./attendanceRegister";

function row(overrides: Partial<RawRegisterRow> = {}): RawRegisterRow {
  return {
    workDate: "2026-10-12",
    idNo: "BAPL0123",
    isWeeklyOff: 0,
    originalStatus: "P",
    acceptedManHours: 8.5,
    acceptedOt: 0,
    rawManHours: 8.5,
    records: 1,
    ...overrides,
  };
}

test("status vocabulary is normalised, and anything unrecognised is UNKNOWN (never present)", () => {
  assert.equal(normaliseRegisterStatus(" p/wo "), "P/WO");
  assert.equal(normaliseRegisterStatus("P_HL"), "P/HL");
  assert.equal(normaliseRegisterStatus("a"), "A");
  assert.equal(normaliseRegisterStatus("A/HL"), "A/HL");
  // Junk and null are NOT presence.
  assert.equal(normaliseRegisterStatus("LEAVE"), "UNKNOWN");
  assert.equal(normaliseRegisterStatus(null), "UNKNOWN");
  assert.equal(normaliseRegisterStatus(""), "UNKNOWN");
});

test("isWeeklyOff is read from every shape the view might use", () => {
  assert.equal(parseWeeklyOff(1), true);
  assert.equal(parseWeeklyOff("1"), true);
  assert.equal(parseWeeklyOff(true), true);
  assert.equal(parseWeeklyOff("Y"), true);
  assert.equal(parseWeeklyOff(0), false);
  assert.equal(parseWeeklyOff("0"), false);
  assert.equal(parseWeeklyOff(null), false);
  assert.equal(parseWeeklyOff("N"), false);
});

test("day type: a holiday status makes the date a holiday, and HOLIDAY beats WEEKLY_OFF", () => {
  assert.equal(dayTypeForStatuses(["P/HL"], false), "HOLIDAY");
  assert.equal(dayTypeForStatuses(["A/HL"], false), "HOLIDAY");
  assert.equal(dayTypeForStatuses(["A/HL"], true), "HOLIDAY", "a holiday on a Sunday is still a holiday");
  assert.equal(dayTypeForStatuses(["A"], true), "WEEKLY_OFF");
  assert.equal(dayTypeForStatuses(["P"], false), "WORKING");
  assert.equal(dayTypeForStatuses([], true), "WEEKLY_OFF");
  assert.equal(dayTypeForStatuses([], false), "WORKING");
});

test("the class matrix: every cell the reports depend on", () => {
  assert.equal(classFor("WORKING", "P"), "WORKED");
  assert.equal(classFor("WORKING", "A"), "ABSENT");
  // The status wins over the date flag: P/WO is overtime work whenever it appears.
  assert.equal(classFor("WORKING", "P/WO"), "WORKED_WEEKLY_OFF");
  assert.equal(classFor("WORKING", "P/HL"), "WORKED_HOLIDAY");
  assert.equal(classFor("HOLIDAY", "P/HL"), "WORKED_HOLIDAY");
  assert.equal(classFor("HOLIDAY", "A/HL"), "OFF");
  assert.equal(classFor("WEEKLY_OFF", "P/WO"), "WORKED_WEEKLY_OFF");
  // Absent on a weekly off is still a day the yard did not work.
  assert.equal(classFor("WEEKLY_OFF", "A"), "OFF");
  assert.equal(classFor("WORKING", "UNKNOWN"), "UNVERIFIED");
});

test("presence precedence: a present row outranks an absent one for the same man-day", () => {
  assert.ok(presenceRank("P/HL") > presenceRank("P/WO"));
  assert.ok(presenceRank("P/WO") > presenceRank("P"));
  assert.ok(presenceRank("P") > presenceRank("A/HL"));
  assert.ok(presenceRank("A/HL") > presenceRank("A"));
  assert.ok(presenceRank("A") > presenceRank("UNKNOWN"));
});

test("a split day sums its records but reports the other aggregation too", () => {
  // The live-observed shape: 09:03-12:18 = 3.15h and 18:04-08:59 = 14.55h for one worker-day.
  const facts = aggregateRegisterRows([
    row({ acceptedManHours: 3.15, rawManHours: 3.15, records: 1 }),
    row({ acceptedManHours: 14.55, rawManHours: 14.55, records: 1 }),
  ]);
  assert.equal(facts.length, 1);
  const fact = facts[0];
  assert.equal(fact.acceptedManHours, 17.7, "SUM is the default policy");
  assert.equal(fact.acceptedManHoursSum, 17.7);
  assert.equal(fact.acceptedManHoursMax, 14.55);
  assert.equal(fact.distinctHourValues, 2);
  assert.equal(fact.records, 2);

  // The other possible source shape: the day total repeated on each punch row -> MAX would be right.
  const repeated = aggregateRegisterRows(
    [row({ acceptedManHours: 8 }), row({ acceptedManHours: 8 })],
    "MAX"
  );
  assert.equal(repeated[0].acceptedManHours, 8);
  assert.equal(repeated[0].acceptedManHoursSum, 16);
});

test("a present man with zero accepted hours is PRESENT, not absent (regularisation pending)", () => {
  const facts = aggregateRegisterRows([row({ acceptedManHours: 0 })]);
  const fact = facts[0];
  assert.equal(fact.status, "P");
  assert.equal(fact.attendanceClass, "WORKED");
  assert.equal(fact.acceptedManHours, 0);
  assert.equal(clockedHoursOf(fact), 0);
});

test("a NULL accepted figure stays NULL rather than becoming a confident zero", () => {
  const facts = aggregateRegisterRows([row({ acceptedManHours: null })]);
  assert.equal(facts[0].acceptedManHours, null);
  assert.equal(clockedHoursOf(facts[0]), 0);
});

test("hours on an off day take OT first and never add both columns", () => {
  const fact = aggregateRegisterRows([
    row({ isWeeklyOff: 1, originalStatus: "P/WO", acceptedManHours: 6, acceptedOt: 6 }),
  ])[0];
  assert.equal(fact.dayType, "WEEKLY_OFF");
  assert.equal(fact.attendanceClass, "WORKED_WEEKLY_OFF");
  assert.equal(workedHoursOnOffDay(fact), 6, "the same hours in both columns must not double");

  const holidayWithOt = aggregateRegisterRows([
    row({ originalStatus: "P/HL", acceptedManHours: 10.5, acceptedOt: 10.5 }),
  ])[0];
  assert.equal(workedHoursOnOffDay(holidayWithOt), 10.5);

  const holidayNoOt = aggregateRegisterRows([
    row({ originalStatus: "P/HL", acceptedManHours: 4, acceptedOt: null }),
  ])[0];
  assert.equal(workedHoursOnOffDay(holidayNoOt), 4, "falls back to man-hours when OT is empty");

  const absurd = aggregateRegisterRows([
    row({ originalStatus: "P/HL", acceptedManHours: 30, acceptedOt: 30 }),
  ])[0];
  assert.equal(workedHoursOnOffDay(absurd), 24, "a day cannot hold more than 24h");
});

test("a status that contradicts its day type is flagged, not silently resolved", () => {
  const facts = aggregateRegisterRows([row({ isWeeklyOff: 0, originalStatus: "P/WO" })]);
  const fact = facts[0];
  assert.equal(fact.dayType, "WORKING");
  assert.equal(fact.attendanceClass, "WORKED_WEEKLY_OFF");
  assert.equal(fact.statusDayTypeConflict, true);
});

test("the same rows in any order produce the same facts", () => {
  const rows = [
    row({ idNo: "B", acceptedManHours: 8 }),
    row({ idNo: "A", acceptedManHours: 4 }),
    row({ idNo: "A", acceptedManHours: 2 }),
  ];
  const forward = aggregateRegisterRows(rows);
  const reversed = aggregateRegisterRows([...rows].reverse());
  assert.deepEqual(forward, reversed);
  assert.deepEqual(
    forward.map((fact) => fact.idNo),
    ["A", "B"]
  );
});

test("every status has a sentence a report can print", () => {
  for (const status of ["P", "P/WO", "P/HL", "A", "A/HL", "UNKNOWN"] as const) {
    assert.ok(registerStatusLabel(status).length > 0);
  }
});

test("the view's own holiday flag decides the day type, before any status is read", () => {
  // The register carries isHoliday. A declared holiday with a full crew marked 'P' is still a holiday —
  // the flag is the fact, and it is the only signal knowable before the day.
  const facts = aggregateRegisterRows([
    row({ originalStatus: "P", isHoliday: 1, acceptedManHours: 8 }),
    row({ idNo: "BAPL9999", originalStatus: "A", isHoliday: 1, acceptedManHours: 0 }),
  ]);
  assert.equal(facts[0].isHoliday, true);
  assert.equal(facts[0].dayType, "HOLIDAY");
  assert.equal(facts[0].attendanceClass, "WORKED_HOLIDAY");
  assert.equal(facts[1].attendanceClass, "OFF");

  // Without the flag, the same rows are ordinary work.
  const ordinary = aggregateRegisterRows([row({ originalStatus: "P", isHoliday: 0 })]);
  assert.equal(ordinary[0].dayType, "WORKING");
  assert.equal(ordinary[0].attendanceClass, "WORKED");
});

test("HD is a present half day and A/WO is a day he owed nothing", () => {
  // Measured on live data: 146 HD and 16 A/WO man-days in 33 days were being thrown into UNVERIFIED.
  const facts = aggregateRegisterRows([
    row({ originalStatus: "HD", acceptedManHours: 4 }),
    row({ idNo: "BAPL0002", originalStatus: "A/WO", acceptedManHours: 0, rawManHours: 0 }),
  ]);
  const half = facts.find((fact) => fact.idNo === "BAPL0123");
  const weeklyOff = facts.find((fact) => fact.idNo === "BAPL0002");
  assert.equal(half?.status, "HD");
  assert.equal(half?.attendanceClass, "WORKED", "a half day is still a day he was here");
  assert.equal(weeklyOff?.status, "A/WO");
  assert.equal(weeklyOff?.dayType, "WEEKLY_OFF", "his own weekly off, whatever the date-level rule says");
  assert.equal(weeklyOff?.attendanceClass, "OFF");

  // A blank status with NO hours is not a code and not evidence: it stays UNVERIFIED.
  const blank = aggregateRegisterRows([row({ originalStatus: "", acceptedManHours: 0, rawManHours: 0 })]);
  assert.equal(blank[0].status, "UNKNOWN");
  assert.equal(blank[0].attendanceClass, "UNVERIFIED");
});

test("an empty status with accepted hours is present, and says it was inferred", () => {
  // Owner's rule, 2026-10-24: the view sometimes carries no status; a man with accepted hours on such a
  // day was plainly at work. 1,067 real man-days in a 33-day window looked like this.
  const facts = aggregateRegisterRows([
    row({ originalStatus: "", acceptedManHours: 8, rawManHours: 8 }),
    row({ idNo: "BAPL0002", originalStatus: "", acceptedManHours: 0, acceptedOt: 0, rawManHours: 0 }),
    row({ idNo: "BAPL0003", originalStatus: "", acceptedManHours: 0, acceptedOt: 3, rawManHours: 0 }),
  ]);

  const inferred = facts.find((fact) => fact.idNo === "BAPL0123");
  assert.equal(inferred?.status, "P/HRS", "present, but labelled as inferred rather than as a P the source never sent");
  assert.equal(inferred?.attendanceClass, "WORKED");
  assert.equal(isPresentStatus("P/HRS"), true);

  const silent = facts.find((fact) => fact.idNo === "BAPL0002");
  assert.equal(silent?.status, "UNKNOWN", "no status and no hours is still unknown");
  assert.equal(silent?.attendanceClass, "UNVERIFIED");

  const overtime = facts.find((fact) => fact.idNo === "BAPL0003");
  assert.equal(overtime?.status, "P/HRS", "clocked overtime is the same evidence as accepted hours");
});
