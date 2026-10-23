import test from "node:test";
import assert from "node:assert/strict";
import { aggregateRegisterRows, type RawRegisterRow } from "./attendanceRegister";
import {
  dateTypesFrom,
  dayKey,
  fraction,
  nonWorkingDatesFrom,
  summariseDates,
  summariseEmployeeDays,
  summariseJobOrders,
  summariseSurfaces,
  surfaceCsvRows,
  workingDatesFrom,
  type ReconBooking,
  type ReconPerson,
} from "./holidayRecon";

/**
 * The fixture is a real week: Thu 1 Oct 2026 .. Wed 7 Oct 2026, with Sunday 4 Oct as the weekly off and
 * Fri 2 Oct declared a holiday. Two men, four bookings. Every expected number below is derived by hand in
 * the comments, because this is the arithmetic the customer will sign off.
 */
const PEOPLE: ReconPerson[] = [
  { employeeId: 1, ecNo: "E1", name: "One", department: "Hull", section: "Fab", category: "FITTER" },
  { employeeId: 2, ecNo: "E2", name: "Two", department: "Hull", section: "Fab", category: "FITTER" },
];

const DATES = ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07"];
const HOLIDAY = "2026-10-02"; // declared holiday
const SUNDAY = "2026-10-04"; // weekly off

function registerRows(): RawRegisterRow[] {
  const rows: RawRegisterRow[] = [];
  for (const ecNo of ["E1", "E2"]) {
    for (const workDate of DATES) {
      const isHoliday = workDate === HOLIDAY;
      const isWeeklyOff = workDate === SUNDAY;
      // E2 is absent on 6 Oct; everyone is off on the holiday and the Sunday.
      const absent = isHoliday || isWeeklyOff || (ecNo === "E2" && workDate === "2026-10-06");
      rows.push({
        workDate,
        idNo: ecNo,
        isWeeklyOff: isWeeklyOff ? 1 : 0,
        originalStatus: absent ? (isHoliday ? "A/HL" : "A") : "P",
        acceptedManHours: absent ? 0 : 8,
        acceptedOt: 0,
        rawManHours: absent ? 0 : 8,
        records: 1,
      });
    }
  }
  return rows;
}

const FACTS = aggregateRegisterRows(registerRows());

function booking(overrides: Partial<ReconBooking>): ReconBooking {
  return {
    entryId: 1,
    employeeId: 1,
    ecNo: "E1",
    employeeName: "One",
    workDate: "2026-10-01",
    status: "PM_APPROVED",
    hours: 8,
    jobOrderId: 10,
    jobOrderCode: "1900000107",
    projectCode: "P1",
    wbsCode: "W1",
    attendanceClass: "WORKED",
    dayType: "WORKING",
    registerStatus: "P",
    clockedHours: 8,
    acceptedOt: 0,
    ...overrides,
  };
}

/** Four bookings: 8h regular on the 1st, 4h on the holiday, 8h on the 5th, and 8h for an ABSENT man. */
const BOOKINGS: ReconBooking[] = [
  booking({ entryId: 1, workDate: "2026-10-01", hours: 8, attendanceClass: "WORKED" }),
  booking({ entryId: 2, workDate: HOLIDAY, hours: 4, attendanceClass: "WORKED_HOLIDAY", dayType: "HOLIDAY", registerStatus: "A/HL" }),
  booking({ entryId: 3, workDate: "2026-10-05", hours: 8, attendanceClass: "WORKED" }),
  booking({
    entryId: 4,
    employeeId: 2,
    ecNo: "E2",
    employeeName: "Two",
    workDate: "2026-10-06",
    hours: 8,
    attendanceClass: "ABSENT",
    registerStatus: "A",
  }),
];

const SHEET_DAYS = new Set<string>([
  dayKey(1, "2026-10-01"),
  dayKey(1, HOLIDAY),
  dayKey(1, "2026-10-05"),
  dayKey(2, "2026-10-06"),
]);

test("date-level day types: a holiday beats a weekly off beats working", () => {
  const types = dateTypesFrom(FACTS);
  assert.equal(types.get(HOLIDAY), "HOLIDAY");
  assert.equal(types.get(SUNDAY), "WEEKLY_OFF");
  assert.equal(types.get("2026-10-01"), "WORKING");
  assert.deepEqual(workingDatesFrom(FACTS), ["2026-10-01", "2026-10-03", "2026-10-05", "2026-10-06", "2026-10-07"]);
  assert.deepEqual(nonWorkingDatesFrom(FACTS).map((entry) => entry.workDate), [HOLIDAY, SUNDAY]);
});

test("a skeleton crew on a holiday does not turn it into a working day", () => {
  const facts = aggregateRegisterRows([
    { workDate: HOLIDAY, idNo: "E1", isWeeklyOff: 0, originalStatus: "P/HL", acceptedManHours: 6, acceptedOt: 6, rawManHours: 6, records: 1 },
    { workDate: HOLIDAY, idNo: "E2", isWeeklyOff: 0, originalStatus: "A/HL", acceptedManHours: 0, acceptedOt: 0, rawManHours: 0, records: 1 },
  ]);
  assert.equal(dateTypesFrom(facts).get(HOLIDAY), "HOLIDAY");
  assert.equal(facts.find((fact) => fact.idNo === "E1")?.attendanceClass, "WORKED_HOLIDAY");
  assert.equal(facts.find((fact) => fact.idNo === "E2")?.attendanceClass, "OFF");
});

test("per-date table carries the evidence behind each day type", () => {
  const bookedByDate = new Map<string, number>([
    ["2026-10-01", 8],
    [HOLIDAY, 4],
    ["2026-10-05", 8],
    ["2026-10-06", 8],
  ]);
  const dates = summariseDates(FACTS, bookedByDate);
  assert.equal(dates.length, 7);

  const holiday = dates.find((entry) => entry.workDate === HOLIDAY)!;
  assert.equal(holiday.dayType, "HOLIDAY");
  assert.equal(holiday.off, 2, "both men are OFF on the holiday");
  assert.equal(holiday.bookedHours, 4, "booked hours on a holiday are still visible on the date row");

  const sunday = dates.find((entry) => entry.workDate === SUNDAY)!;
  assert.equal(sunday.dayType, "WEEKLY_OFF");
  assert.equal(sunday.isWeeklyOff, true);

  const working = dates.find((entry) => entry.workDate === "2026-10-01")!;
  assert.equal(working.present, 2);
  assert.equal(working.clockedHours, 16);
});

test("coverage, Not booked and hours move the way the proposal says — by hand-checked arithmetic", () => {
  const surfaces = summariseSurfaces({
    from: "2026-10-01",
    to: "2026-10-07",
    facts: FACTS,
    bookings: BOOKINGS,
    people: PEOPLE,
    sheetDays: SHEET_DAYS,
    maxDailyHours: 8,
    rateFor: () => 100,
  });

  // Range: 7 calendar days, 5 working (1 weekly off + 1 holiday).
  assert.equal(surfaces.range.calendarDays, 7);
  assert.equal(surfaces.range.workingDays, 5);
  assert.equal(surfaces.range.weeklyOffDays, 1);
  assert.equal(surfaces.range.holidayDays, 1);
  assert.equal(surfaces.range.uncoveredDays, 0);

  // Coverage: before 2 x 7 = 14 expected, 4 filled; after 2 x 5 = 10 expected, 3 filled
  // (the holiday booking stops being a "filled day" because that date is no longer expected).
  assert.equal(surfaces.coverage.before.expectedEmployeeDays, 14);
  assert.equal(surfaces.coverage.before.filledEmployeeDays, 4);
  assert.equal(surfaces.coverage.before.notFilledEmployeeDays, 10);
  assert.equal(surfaces.coverage.after.expectedEmployeeDays, 10);
  assert.equal(surfaces.coverage.after.filledEmployeeDays, 3);
  assert.equal(surfaces.coverage.after.notFilledEmployeeDays, 7);
  assert.equal(surfaces.coverage.removedEmployeeDays, 4);

  // Not booked: before 14 - 4 = 10 unbooked days x 8h x 100 = 8,000.
  assert.equal(surfaces.notBooked.before.notBookedDays, 10);
  assert.equal(surfaces.notBooked.before.idleHours, 80);
  assert.equal(surfaces.notBooked.before.idleCost, 8000);

  // After: over the 5 working days — E1 books 2 (1st, 5th) and is present-unbooked 3 (3rd, 6th, 7th);
  // E2 books 1 (6th) and is present-unbooked 4. No absences are left in the working set here,
  // because the absent day (6th) is a day E2 DID have a sheet for.
  assert.equal(surfaces.notBooked.after.bookedDays, 3);
  assert.equal(surfaces.notBooked.after.presentUnbookedDays, 7);
  assert.equal(surfaces.notBooked.after.absentDays, 0);
  assert.equal(surfaces.notBooked.after.notCoveredDays, 0);
  assert.equal(surfaces.notBooked.after.idleHours, 56);
  assert.equal(surfaces.notBooked.after.idleCost, 5600);

  // Hours: 8 + 4 + 8 + 8 = 28 booked; the 4h holiday booking and the 8h absent-man booking leave
  // the regular figure, and the split still accounts for every hour.
  assert.equal(surfaces.hours.beforeTotalHours, 28);
  assert.equal(surfaces.hours.after.regularHours, 16);
  assert.equal(surfaces.hours.after.holidayHours, 4);
  assert.equal(surfaces.hours.after.unverifiedHours, 8);
  assert.equal(surfaces.hours.after.totalHours, 28);
  assert.equal(surfaces.hours.removedFromRegular, 12);
});

test("a man absent on a working day is an absence, not idle cost", () => {
  const surfaces = summariseSurfaces({
    from: "2026-10-01",
    to: "2026-10-07",
    facts: FACTS,
    // No bookings at all: the gap is entirely register-driven.
    bookings: [],
    people: PEOPLE,
    sheetDays: new Set<string>(),
    maxDailyHours: 8,
    rateFor: () => 100,
  });
  // 2 men x 5 working days = 10 unbooked working days: 9 present, 1 absent (E2 on 6 Oct).
  assert.equal(surfaces.notBooked.after.presentUnbookedDays, 9);
  assert.equal(surfaces.notBooked.after.absentDays, 1);
  assert.equal(surfaces.notBooked.after.idleHours, 72);
});

test("per-Job-Order split groups by job order and names what moves", () => {
  const rows = summariseJobOrders([
    ...BOOKINGS,
    booking({ entryId: 5, jobOrderId: 20, jobOrderCode: "1900000108", hours: 6, attendanceClass: "WORKED_HOLIDAY", dayType: "HOLIDAY" }),
  ]);
  const first = rows.find((row) => row.jobOrderId === 10)!;
  assert.equal(first.bookedHours, 28);
  assert.equal(first.holidayHours, 4);
  assert.equal(first.unverifiedHours, 8);
  assert.equal(first.regularHours, 16);
  const second = rows.find((row) => row.jobOrderId === 20)!;
  assert.equal(second.holidayHours, 6);
  // Sorted by holiday hours, so the worst offender is first.
  assert.equal(rows[0].jobOrderId, 20);
});

test("per-employee-day variance compares booked against clocked", () => {
  const rows = summariseEmployeeDays([
    booking({ entryId: 1, hours: 8, clockedHours: 8.5, acceptedOt: 0 }),
    booking({ entryId: 2, hours: 2, clockedHours: 8.5, acceptedOt: 0, attendanceClass: "WORKED" }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].bookedHours, 10);
  assert.equal(rows[0].clockedHours, 8.5);
  assert.equal(rows[0].variance, 1.5);
});

test("a booking with no register row stays provisional rather than being excluded", () => {
  const surfaces = summariseSurfaces({
    from: "2026-10-01",
    to: "2026-10-07",
    facts: FACTS,
    bookings: [booking({ attendanceClass: null, dayType: null, registerStatus: null, clockedHours: null })],
    people: PEOPLE,
    sheetDays: SHEET_DAYS,
    maxDailyHours: 8,
    rateFor: () => 100,
  });
  assert.equal(surfaces.hours.after.regularHours, 8);
  assert.equal(surfaces.hours.after.provisionalHours, 8);
  assert.equal(surfaces.hours.after.totalHours, 8);
});

test("the summary CSV always has a header and a row per measure", () => {
  const surfaces = summariseSurfaces({
    from: "2026-10-01",
    to: "2026-10-07",
    facts: FACTS,
    bookings: BOOKINGS,
    people: PEOPLE,
    sheetDays: SHEET_DAYS,
    maxDailyHours: 8,
    rateFor: () => 100,
  });
  const csv = surfaceCsvRows(surfaces);
  assert.deepEqual(csv[0], ["section", "measure", "before", "after", "delta"]);
  assert.ok(csv.length > 10);
  for (const row of csv) assert.equal(row.length, 5, `row must keep its 5 columns: ${row.join(",")}`);
});

test("fractions never divide by zero", () => {
  assert.equal(fraction(0, 0), 0);
  assert.equal(fraction(1, 0), 0);
  assert.equal(fraction(1, 3), 0.3333);
});
