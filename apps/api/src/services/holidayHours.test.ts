import test from "node:test";
import assert from "node:assert/strict";
import { bookedHoursFromEntry, holidayHoursNote, isExhaustive, splitHoursByClass, type ClassedHoursRow } from "./holidayHours";

test("the split is EXHAUSTIVE: nothing is ever dropped, only reclassified", () => {
  const rows: ClassedHoursRow[] = [
    { attendanceClass: "WORKED", hours: 8 },
    { attendanceClass: "WORKED_WEEKLY_OFF", hours: 6 },
    { attendanceClass: "WORKED_HOLIDAY", hours: 10.5 },
    { attendanceClass: "OFF", hours: 4 },
    { attendanceClass: "ABSENT", hours: 2.5 },
    { attendanceClass: "UNVERIFIED", hours: 3 },
    { attendanceClass: null, hours: 1.5 },
  ];
  const split = splitHoursByClass(rows);
  assert.equal(split.totalHours, 35.5);
  assert.equal(split.regularHours, 8 + 3 + 1.5, "regular holds WORKED plus the provisional rows");
  assert.equal(split.holidayHours, 6 + 10.5 + 4);
  assert.equal(split.unverifiedHours, 2.5);
  assert.equal(split.provisionalHours, 3 + 1.5, "provisional is a SUBSET of regular, not a fourth bucket");
  assert.ok(isExhaustive(split));
  // And the subset really is inside regular:
  assert.ok(split.provisionalHours <= split.regularHours);
});

test("an unsettled day never removes hours from the regular figure", () => {
  const split = splitHoursByClass([{ attendanceClass: null, hours: 8 }]);
  assert.equal(split.regularHours, 8);
  assert.equal(split.holidayHours, 0);
  assert.equal(split.totalHours, 8);
  assert.equal(split.provisionalHours, 8);
  assert.equal(split.provisionalRowCount, 1);
});

test("holiday work leaves the regular figure and is counted, not deleted", () => {
  const split = splitHoursByClass([
    { attendanceClass: "WORKED", hours: 100 },
    { attendanceClass: "WORKED_HOLIDAY", hours: 12 },
  ]);
  assert.equal(split.regularHours, 100);
  assert.equal(split.holidayHours, 12);
  assert.equal(split.totalHours, 112);
  assert.equal(split.holidayRowCount, 1);
});

test("corrupt hours (NaN, negative) cannot poison a sum", () => {
  const split = splitHoursByClass([
    { attendanceClass: "WORKED", hours: Number.NaN },
    { attendanceClass: "WORKED", hours: -5 },
    { attendanceClass: "WORKED", hours: 8 },
  ]);
  assert.equal(split.regularHours, 8);
  assert.equal(split.totalHours, 8);
});

test("the printed note speaks only when there is something to disclose", () => {
  const clean = splitHoursByClass([{ attendanceClass: "WORKED", hours: 8 }]);
  assert.deepEqual(holidayHoursNote(clean), []);

  const dirty = splitHoursByClass([
    { attendanceClass: "WORKED_HOLIDAY", hours: 12 },
    { attendanceClass: "ABSENT", hours: 4 },
    { attendanceClass: null, hours: 2 },
  ]);
  const notes = holidayHoursNote(dirty, { maxDailyHours: 8 });
  assert.equal(notes.length, 4);
  assert.match(notes[0], /12\.00 h are booked on non-working days/);
  assert.match(notes[0], /overtime by definition/);
  assert.match(notes[1], /no attendance evidence/);
  assert.match(notes[2], /PROVISIONAL/);
});

test("booked hours per entry mirror the portfolio's hoursOf, per row", () => {
  // The dashboard's figure: OT hours PLUS slot hours (see portfolioReport.hoursOf).
  assert.equal(bookedHoursFromEntry({ otHours: 2, shiftSlot: null, hourSlot: null }), 2);
  assert.equal(bookedHoursFromEntry({ otHours: null, shiftSlot: "am1", hourSlot: null }), 2);
  assert.equal(bookedHoursFromEntry({ otHours: null, shiftSlot: null, hourSlot: 7 }), 1);
  // A row carrying both is ADDED, which is the shipped (documented) behaviour — not "fixed" here.
  assert.equal(bookedHoursFromEntry({ otHours: 3, shiftSlot: "pm1", hourSlot: null }), 5);
  assert.equal(bookedHoursFromEntry({ otHours: null, shiftSlot: null, hourSlot: null }), 0);
});
