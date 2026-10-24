import assert from "node:assert/strict";
import test from "node:test";
import { aggregateRegisterRows, type RawRegisterRow } from "./attendanceRegister";
import { dateTypesFrom } from "./holidayRecon";
import { planSettlement } from "./attendanceSettlement";

function row(overrides: Partial<RawRegisterRow> & { workDate: string; idNo: string }): RawRegisterRow {
  return {
    isWeeklyOff: 0,
    originalStatus: "P",
    acceptedManHours: 8,
    acceptedOt: 0,
    rawManHours: 8,
    records: 1,
    ...overrides,
  };
}

test("a settled working day becomes one row per man and one calendar row", () => {
  const facts = aggregateRegisterRows([
    row({ workDate: "2026-10-05", idNo: "BAPL0053", acceptedManHours: 8 }),
    row({ workDate: "2026-10-05", idNo: "FRNEGJ007", originalStatus: "A", acceptedManHours: 0, rawManHours: 0 }),
  ]);
  const plan = planSettlement({
    facts,
    dateTypes: new Map([["2026-10-05", "WORKING"]]),
    employeeIdByRegisterId: new Map([
      ["BAPL0053", 11],
      ["FRNEGJ007", 12],
    ]),
  });

  assert.equal(plan.days.length, 2);
  assert.deepEqual(plan.days[0], {
    registerId: "BAPL0053",
    employeeId: 11,
    workDate: "2026-10-05",
    dayType: "WORKING",
    attendanceClass: "WORKED",
    status: "P",
    acceptedHours: 8,
    acceptedOtHours: 0,
    registerRows: 1,
    statusVariants: 1,
  });
  assert.equal(plan.days[1].attendanceClass, "ABSENT");

  assert.deepEqual(plan.calendar, [
    {
      workDate: "2026-10-05",
      dayType: "WORKING",
      source: "REGISTER",
      employeeRows: 2,
      presentRows: 1,
      absentRows: 1,
      weeklyOffRows: 0,
      holidayFlagRows: 0,
      holidayStatusRows: 0,
    },
  ]);
  assert.deepEqual(plan.anomalies, {
    unmatchedRegisterIds: [],
    missingDates: [],
    emptyDates: [],
    mixedStatusManDays: 0,
    statusDayTypeConflicts: 0,
    presentWithZeroHours: 0,
  });
});

test("an id with no Employee row is stored with a null employee and named as an anomaly", () => {
  const facts = aggregateRegisterRows([row({ workDate: "2026-10-05", idNo: "GHOST001" })]);
  const plan = planSettlement({
    facts,
    dateTypes: new Map([["2026-10-05", "WORKING"]]),
    employeeIdByRegisterId: new Map([["BAPL0053", 11]]),
  });
  assert.equal(plan.days[0].employeeId, null);
  assert.deepEqual(plan.anomalies.unmatchedRegisterIds, ["GHOST001"]);
});

test("a date the register never answered for is a hole, not a working day with zero attendance", () => {
  const facts = aggregateRegisterRows([row({ workDate: "2026-10-05", idNo: "BAPL0053" })]);
  const plan = planSettlement({
    facts,
    dateTypes: new Map([
      ["2026-10-05", "WORKING"],
      ["2026-10-06", "WORKING"],
    ]),
    employeeIdByRegisterId: new Map([["BAPL0053", 11]]),
  });
  assert.deepEqual(plan.anomalies.missingDates, ["2026-10-06"]);
  assert.equal(plan.calendar.length, 1, "no calendar row is invented for a date with no evidence");
});

test("a human override decides the date, and the calendar row says so", () => {
  // 4 Sep 2026: the register calls it a holiday; the yard says it worked it.
  const facts = aggregateRegisterRows([
    row({ workDate: "2026-09-04", idNo: "BAPL0053", originalStatus: "P/HL", acceptedManHours: 8, acceptedOt: 8 }),
  ]);
  const registerTypes = dateTypesFrom(facts);
  assert.equal(registerTypes.get("2026-09-04"), "HOLIDAY");

  const overridden = new Map(registerTypes).set("2026-09-04", "WORKING");
  const plan = planSettlement({
    facts,
    dateTypes: overridden,
    employeeIdByRegisterId: new Map([["BAPL0053", 11]]),
    overrides: new Map([["2026-09-04", "WORKING"]]),
  });

  assert.equal(plan.calendar[0].dayType, "WORKING");
  assert.equal(plan.calendar[0].source, "OVERRIDE");
  assert.equal(plan.days[0].dayType, "WORKING", "the man-day carries the overridden type too");
});

test("the output is deterministic, so a re-settlement writes nothing new", () => {
  const facts = aggregateRegisterRows([
    row({ workDate: "2026-10-06", idNo: "BAPL0053" }),
    row({ workDate: "2026-10-05", idNo: "FRNEGJ007" }),
    row({ workDate: "2026-10-05", idNo: "BAPL0053" }),
  ]);
  const input = {
    facts,
    dateTypes: new Map([
      ["2026-10-05", "WORKING" as const],
      ["2026-10-06", "WORKING" as const],
    ]),
    employeeIdByRegisterId: new Map([
      ["BAPL0053", 11],
      ["FRNEGJ007", 12],
    ]),
  };
  const first = planSettlement(input);
  const second = planSettlement(input);
  assert.deepEqual(first, second);
  assert.deepEqual(
    first.days.map((day) => `${day.workDate}|${day.registerId}`),
    ["2026-10-05|BAPL0053", "2026-10-05|FRNEGJ007", "2026-10-06|BAPL0053"]
  );
});

test("anomalies are counted, not swallowed", () => {
  const facts = aggregateRegisterRows([
    // present with zero hours
    row({ workDate: "2026-10-05", idNo: "BAPL0053", acceptedManHours: 0, rawManHours: 0 }),
    // a status that contradicts a working day
    row({ workDate: "2026-10-05", idNo: "FRNEGJ007", originalStatus: "P/WO", acceptedManHours: 4, acceptedOt: 4 }),
    // an EMPTY status WITH hours is present by inference (P/HRS); with no hours it stays unknown.
    row({ workDate: "2026-10-05", idNo: "BAPL9999", originalStatus: "", acceptedManHours: 0, rawManHours: 0 }),
  ]);
  const plan = planSettlement({
    facts,
    dateTypes: new Map([["2026-10-05", "WORKING"]]),
    employeeIdByRegisterId: new Map([
      ["BAPL0053", 11],
      ["FRNEGJ007", 12],
      ["BAPL9999", 13],
    ]),
  });
  assert.equal(plan.anomalies.presentWithZeroHours, 1);
  assert.equal(plan.anomalies.statusDayTypeConflicts, 1);
  const unknown = plan.days.find((day) => day.registerId === "BAPL9999");
  assert.equal(unknown?.attendanceClass, "UNVERIFIED");
  assert.equal(unknown?.status, "UNKNOWN");
});

test("a date the register answered for but left empty is named, not silently missing", () => {
  const facts = aggregateRegisterRows([row({ workDate: "2026-10-05", idNo: "BAPL0053" })]);
  const plan = planSettlement({
    facts,
    dateTypes: new Map([["2026-10-05", "WORKING"]]),
    employeeIdByRegisterId: new Map([["BAPL0053", 11]]),
    // The register answered for the 6th and had nothing in it — a shutdown, or a feed that dropped a day.
    datesRead: ["2026-10-05", "2026-10-06"],
  });
  assert.deepEqual(plan.anomalies.emptyDates, ["2026-10-06"]);
  assert.equal(plan.calendar.length, 1, "no verdict is invented for a date with no rows");
});
