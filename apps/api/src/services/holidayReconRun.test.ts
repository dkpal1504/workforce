import test from "node:test";
import assert from "node:assert/strict";
import { reconCsvFiles, renderReconSummary, type ReconResult } from "./holidayReconRun";
import { splitHoursByClass } from "./holidayHours";

function result(overrides: Partial<ReconResult> = {}): ReconResult {
  return {
    from: "2026-07-19",
    to: "2026-10-16",
    requestedTo: "2026-10-16",
    clampedToToday: false,
    skippedFutureDates: 0,
    source: "SQL",
    aggregate: "SUM",
    registerRows: 56318,
    datesRead: 90,
    readErrors: [],
    people: 601,
    sheets: 1224,
    bookings: 4214,
    maxDailyHours: 8,
    dates: [
      {
        workDate: "2026-07-19",
        dayType: "WEEKLY_OFF",
        isWeeklyOff: true,
        employeesWithRow: 601,
        present: 0,
        absent: 0,
        off: 601,
        unknown: 0,
        statusCounts: { A: 601 },
        bookedHours: 0,
        clockedHours: 0,
        presentZeroHours: 0,
        holidayFlagRows: 0,
        holidayStatusRows: 0,
        conflicts: 0,
      },
    ],
    employeeDays: [
      {
        workDate: "2026-10-02",
        ecNo: "FRNEGJ062",
        employeeName: "NAME",
        dayType: "HOLIDAY",
        registerStatus: "P/HL",
        attendanceClass: "WORKED_HOLIDAY",
        bookedHours: 8,
        clockedHours: 8,
        acceptedOt: 8,
        variance: 0,
        statuses: "SUBMITTED",
        jobOrders: "H0001",
      },
    ],
    jobOrders: [
      {
        jobOrderId: 132,
        jobOrderCode: "H0001",
        projectCode: "ISN.001",
        wbsCode: "ISN.001.003.001",
        bookedHours: 1110,
        regularHours: 782,
        holidayHours: 136,
        unverifiedHours: 192,
        provisionalHours: 0,
        rows: 495,
        holidayRows: 17,
        unverifiedRows: 95,
      },
    ],
    surfaces: {
      range: { from: "2026-07-19", to: "2026-10-16", calendarDays: 90, workingDays: 75, weeklyOffDays: 13, holidayDays: 2, uncoveredDays: 0 },
      coverage: {
        before: { expectedEmployeeDays: 54090, filledEmployeeDays: 1186, notFilledEmployeeDays: 52904, filledPct: 0.0219 },
        after: { expectedEmployeeDays: 45075, filledEmployeeDays: 1091, notFilledEmployeeDays: 43984, filledPct: 0.0242 },
        removedEmployeeDays: 9015,
      },
      notBooked: {
        before: { notBookedDays: 52904, idleHours: 423232, idleCost: 42323200 },
        after: {
          expectedWorkingDays: 45075,
          bookedDays: 1091,
          presentUnbookedDays: 41119,
          absentDays: 2865,
          offDays: 0,
          notCoveredDays: 0,
          idleHours: 328952,
          idleCost: 32895200,
        },
      },
      hours: {
        beforeTotalHours: 9238,
        after: splitHoursByClass([
          { attendanceClass: "WORKED", hours: 7849 },
          { attendanceClass: "WORKED_HOLIDAY", hours: 643 },
          { attendanceClass: "ABSENT", hours: 746 },
        ]),
        removedFromRegular: 1389,
      },
    },
    anomalies: {
      unmatchedIdNos: [],
      statusContradictsDayType: 0,
      mixedStatusRows: 0,
      presentZeroHours: 2281,
      sumMaxDisagreements: 2228,
      bookedWithoutRegisterRow: 0,
    },
    ...overrides,
  };
}

test("the CSV bundle is the five files, each internally consistent", () => {
  const files = reconCsvFiles(result());
  assert.deepEqual(
    files.map((file) => file.name),
    ["01-dates.csv", "02-employee-days.csv", "03-job-orders.csv", "04-surfaces.csv", "05-anomalies.csv"]
  );
  for (const file of files) {
    assert.ok(file.rows.length >= 2, `${file.name} must have a header and at least one row`);
    const width = file.rows[0].length;
    for (const row of file.rows) {
      assert.equal(row.length, width, `${file.name} has a row with ${row.length} columns, header has ${width}`);
    }
  }
});

test("the date row prints the register's own status vocabulary", () => {
  const dates = reconCsvFiles(result()).find((file) => file.name === "01-dates.csv")!;
  const row = dates.rows[1];
  assert.equal(row[0], "2026-07-19");
  assert.equal(row[1], "WEEKLY_OFF");
  assert.equal(row[11], 601, "status_A count is carried through");
});

test("a booking with no register day is labelled PROVISIONAL, never blank", () => {
  const withProvisional = result({
    employeeDays: [
      {
        workDate: "2026-10-05",
        ecNo: "X1",
        employeeName: "Someone",
        dayType: null,
        registerStatus: null,
        attendanceClass: null,
        bookedHours: 8,
        clockedHours: null,
        acceptedOt: null,
        variance: null,
        statuses: "PM_APPROVED",
        jobOrders: "H0002",
      },
    ],
  });
  const rows = reconCsvFiles(withProvisional).find((file) => file.name === "02-employee-days.csv")!.rows;
  assert.equal(rows[1][3], "NO_REGISTER");
  assert.equal(rows[1][5], "PROVISIONAL");
});

test("the summary names the source, the numbers and the anomalies", () => {
  const text = renderReconSummary(result()).join("\n");
  assert.match(text, /2026-07-19 \.\. 2026-10-16/);
  assert.match(text, /attendance source {2}SQL/);
  assert.match(text, /expected days {6}54,090 -> 45,075/);
  assert.match(text, /regular 7,849 h \+ holiday 643 h \+ unverified 746 h = 9,238 h/);
  assert.match(text, /removed from regular 1,389 h/);
  assert.match(text, /present with 0 accepted hours {8}2,281/);
  assert.doesNotMatch(text, /NaN|undefined/);
});

test("a fixture run says so, loudly, so nobody mistakes it for the yard's data", () => {
  const text = renderReconSummary(result({ source: "FIXTURE" })).join("\n");
  assert.match(text, /SYNTHETIC — not the yard's data/);
});

test("a zero idle cost explains itself instead of reading as a real zero", () => {
  const zeroCost = result();
  zeroCost.surfaces = {
    ...zeroCost.surfaces,
    notBooked: {
      before: { notBookedDays: 10, idleHours: 80, idleCost: 0 },
      after: { ...zeroCost.surfaces.notBooked.after, idleCost: 0 },
    },
  };
  const text = renderReconSummary(zeroCost).join("\n");
  assert.match(text, /no cost rate configured/);
});

test("read errors are surfaced, never swallowed", () => {
  const text = renderReconSummary(
    result({ readErrors: [{ date: "2026-10-01", message: "Login failed for user 'it'." }] })
  ).join("\n");
  assert.match(text, /READ ERRORS {8}1 date\(s\): Login failed/);
});
