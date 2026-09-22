import test from "node:test";
import assert from "node:assert/strict";
import {
  attendanceSql,
  explainSourceError,
  bookedHoursForEntries,
  dateRange,
  parseClockedHoursFixture,
  parseManHours,
  planInOutHoursUpdate,
  readingsByEcNo,
  scheduledRefreshWindow,
  type ClockedHoursForDate,
  type SheetForRefresh,
  type AttendanceSourceConfig,
} from "./attendanceHours";

/** The shipped defaults, so the tests read like the deployment. */
function config(overrides: Partial<AttendanceSourceConfig> = {}): AttendanceSourceConfig {
  return {
    view: "dbo.Report_Attendance_Intermediate",
    idColumn: "IDNo",
    hoursColumn: "ManHours",
    dateColumn: "Date",
    queryOverride: null,
    server: "10.5.1.106",
    port: 1433,
    database: "LabourWorks",
    user: "it",
    fixturePath: null,
    ...overrides,
  };
}

test("ManHours parses numbers, strings, comma decimals and rejects junk", () => {
  assert.equal(parseManHours(8.58), 8.58);
  assert.equal(parseManHours("8.58"), 8.58);
  assert.equal(parseManHours(" 8,58 "), 8.58);
  assert.equal(parseManHours("0.00"), 0);
  assert.equal(parseManHours(""), null);
  assert.equal(parseManHours(null), null);
  assert.equal(parseManHours(undefined), null);
  assert.equal(parseManHours("--"), null);
  assert.equal(parseManHours("abc"), null);
});

test("readings are keyed by the EC number the timesheet uses", () => {
  const map = readingsByEcNo([
    { IdNo: "frnegj018", ManHours: 8.58 },
    { IdNo: "  BAPL0178 ", ManHours: "9.05" },
    { IdNo: "BAPL0132", ManHours: 0 },
  ]);
  assert.equal(map.get("FRNEGJ018")?.manHours, 8.58);
  assert.equal(map.get("BAPL0178")?.manHours, 9.05);
  assert.equal(map.get("BAPL0132")?.manHours, 0);
  // The source spelling is kept for the report, the key is normalised.
  assert.equal(map.get("BAPL0178")?.idNo, "BAPL0178");
});

test("two records on one day ADD UP, because the view holds one row per check-in/out pair", () => {
  // Real shape observed 2026-09-21: BAPL0158 clocked 09:03-12:18 (3.15h) and
  // 18:04-08:59 (14.55h) on the same date.
  const map = readingsByEcNo([
    { IdNo: "BAPL0158", ManHours: 3.15 },
    { IdNo: "BAPL0158", ManHours: 14.55 },
  ]);
  assert.equal(map.get("BAPL0158")?.manHours, 17.7);
  assert.equal(map.get("BAPL0158")?.records, 2);
});

test("a record without ManHours does not destroy the sum of the others", () => {
  const map = readingsByEcNo([
    { IdNo: "BAPL0178", ManHours: 9.05 },
    { IdNo: "BAPL0178", ManHours: null },
  ]);
  assert.equal(map.get("BAPL0178")?.manHours, 9.05);
  assert.equal(map.get("BAPL0178")?.records, 2);
});

test("a single record reports one record", () => {
  const map = readingsByEcNo([{ IdNo: "BAPL0178", ManHours: 9.05 }]);
  assert.equal(map.get("BAPL0178")?.records, 1);
});

test("rows without an id are ignored", () => {
  const map = readingsByEcNo([{ IdNo: "  ", ManHours: 8 }, { IdNo: null, ManHours: 8 }]);
  assert.equal(map.size, 0);
});

test("the generated SQL targets the configured view and date", () => {
  assert.equal(
    attendanceSql(config()),
    'SELECT [IDNo] AS IdNo, [ManHours] AS ManHours FROM [dbo].[Report_Attendance_Intermediate] WHERE CAST([Date] AS date) = CAST(@workDate AS date)'
  );
  assert.equal(
    attendanceSql(config({ view: "Report_Attendance_Intermediate" })),
    'SELECT [IDNo] AS IdNo, [ManHours] AS ManHours FROM [Report_Attendance_Intermediate] WHERE CAST([Date] AS date) = CAST(@workDate AS date)'
  );
  // An operator-supplied query wins, because the source belongs to another team.
  assert.equal(attendanceSql(config({ queryOverride: "SELECT IDNo, ManHours FROM x WHERE d = @workDate" })), "SELECT IDNo, ManHours FROM x WHERE d = @workDate");
});

test("an injected view or column name is refused", () => {
  assert.throws(() => attendanceSql(config({ view: "dbo.v; DROP TABLE x" })), /ATTENDANCE_DB_VIEW/);
  assert.throws(() => attendanceSql(config({ dateColumn: "AttDate; --" })), /ATTENDANCE_DB_DATE_COLUMN/);
});

test("the fixture reads the JSON shape", () => {
  const text = JSON.stringify({ "2026-09-21": { FRNEGJ018: 8.58, BAPL0132: 0 }, "2026-09-22": { FRNEGJ018: 4 } });
  const forDate = parseClockedHoursFixture(text, "2026-09-21");
  assert.equal(forDate.get("FRNEGJ018")?.manHours, 8.58);
  assert.equal(forDate.get("BAPL0132")?.manHours, 0);
  assert.equal(parseClockedHoursFixture(text, "2026-09-23").size, 0);
});

test("the fixture reads the CSV shape the sample query returns", () => {
  const text = "date,IDNo,ManHours\n2026-09-21,FRNEGJ018,8.58\n2026-09-21,BAPL0178,9.05\n2026-09-22,FRNEGJ018,4\n";
  const forDate = parseClockedHoursFixture(text, "2026-09-21");
  assert.equal(forDate.size, 2);
  assert.equal(forDate.get("FRNEGJ018")?.manHours, 8.58);
  assert.equal(forDate.get("BAPL0178")?.manHours, 9.05);
});

test("a fixture CSV without the ID/hour columns is refused", () => {
  assert.throws(() => parseClockedHoursFixture("date,name\n2026-09-21,x", "2026-09-21"), /IDNo, ManHours/);
});

test("booked hours count shift slots as 2h, legacy slots as 1h, plus OT", () => {
  assert.equal(bookedHoursForEntries([{ hourSlot: null, shiftSlot: "am1", otHours: null }]), 2);
  assert.equal(bookedHoursForEntries([
    { hourSlot: null, shiftSlot: "am1", otHours: null },
    { hourSlot: null, shiftSlot: "am2", otHours: null },
    { hourSlot: 5, shiftSlot: null, otHours: null },
  ]), 5);
  assert.equal(bookedHoursForEntries([{ hourSlot: null, shiftSlot: null, otHours: 3 }]), 3);
  assert.equal(bookedHoursForEntries([]), 0);
});

function sheet(overrides: Partial<SheetForRefresh> = {}): SheetForRefresh {
  return {
    dayId: 1,
    employeeId: 10,
    employeeName: "AAHIR LALJIBHAI KATHADBHAI",
    ecNo: "FRNEGJ018",
    workDate: "2026-09-21",
    status: "SUBMITTED",
    bookedHours: 6,
    previousInOutHours: null,
    ...overrides,
  };
}

function readings(entries: Record<string, number | null>): ClockedHoursForDate {
  return readingsByEcNo(Object.entries(entries).map(([IdNo, ManHours]) => ({ IdNo, ManHours })));
}

test("a matched sheet carries the clocked hours and the difference", () => {
  const plan = planInOutHoursUpdate([sheet()], new Map([["2026-09-21", readings({ FRNEGJ018: 8.58 })]]));
  assert.equal(plan[0].outcome, "matched");
  assert.equal(plan[0].clockedHours, 8.58);
  assert.equal(plan[0].difference, 2.58);
  assert.equal(plan[0].sourceRecords, 1);
});

test("a multi-record day reports how many records built the total", () => {
  const reading = readingsByEcNo([
    { IdNo: "BAPL0158", ManHours: 3.15 },
    { IdNo: "BAPL0158", ManHours: 14.55 },
  ]);
  const plan = planInOutHoursUpdate([sheet({ ecNo: "BAPL0158", bookedHours: 8 })], new Map([["2026-09-21", reading]]));
  assert.equal(plan[0].clockedHours, 17.7);
  assert.equal(plan[0].sourceRecords, 2);
  assert.equal(plan[0].difference, 9.7);
});

test("a sheet with no attendance row is reported, not cleared", () => {
  const plan = planInOutHoursUpdate([sheet({ previousInOutHours: 7.5 })], new Map([["2026-09-21", readings({ OTHER: 8 })]]));
  assert.equal(plan[0].outcome, "not-in-source");
  assert.equal(plan[0].clockedHours, null);
  assert.equal(plan[0].previousInOutHours, 7.5);
});

test("an attendance row without ManHours is distinguished from a missing row", () => {
  const plan = planInOutHoursUpdate([sheet()], new Map([["2026-09-21", readings({ FRNEGJ018: null })]]));
  assert.equal(plan[0].outcome, "no-hours-in-source");
  assert.equal(plan[0].clockedHours, null);
});

test("a difference can be negative (booked more than clocked) and is rounded to 2dp", () => {
  const plan = planInOutHoursUpdate([sheet({ bookedHours: 8 })], new Map([["2026-09-21", readings({ FRNEGJ018: 7.999 })]]));
  assert.equal(plan[0].difference, 0);
  const plan2 = planInOutHoursUpdate([sheet({ bookedHours: 10 })], new Map([["2026-09-21", readings({ FRNEGJ018: 8.58 })]]));
  assert.equal(plan2[0].difference, -1.42);
});

test("the EC number match ignores case and padding on both sides", () => {
  const plan = planInOutHoursUpdate([sheet({ ecNo: " frnegj018 " })], new Map([["2026-09-21", readings({ FRNEGJ018: 8.58 })]]));
  assert.equal(plan[0].outcome, "matched");
});

test("the date range is inclusive and refuses a reversed or oversized range", () => {
  assert.deepEqual(dateRange("2026-09-19", "2026-09-21"), ["2026-09-19", "2026-09-20", "2026-09-21"]);
  assert.deepEqual(dateRange("2026-09-21", "2026-09-21"), ["2026-09-21"]);
  assert.throws(() => dateRange("2026-09-22", "2026-09-21"), /not be after/);
  assert.throws(() => dateRange("2026-09-21", "2027-01-01"), /longer than 62 days/);
});

test("the scheduled window looks back ATTENDANCE_HOURS_LOOKBACK_DAYS from today", () => {
  const previous = process.env.ATTENDANCE_HOURS_LOOKBACK_DAYS;
  try {
    process.env.ATTENDANCE_HOURS_LOOKBACK_DAYS = "2";
    assert.deepEqual(scheduledRefreshWindow(new Date("2026-09-21T21:00:00.000Z")), { dateFrom: "2026-09-19", dateTo: "2026-09-21" });
    delete process.env.ATTENDANCE_HOURS_LOOKBACK_DAYS;
    assert.deepEqual(scheduledRefreshWindow(new Date("2026-09-21T09:00:00.000Z")), { dateFrom: "2026-09-18", dateTo: "2026-09-21" });
  } finally {
    if (previous === undefined) delete process.env.ATTENDANCE_HOURS_LOOKBACK_DAYS;
    else process.env.ATTENDANCE_HOURS_LOOKBACK_DAYS = previous;
  }
});

test("a permission denial names the login and the fix", () => {
  const message = explainSourceError(new Error("The SELECT permission was denied on the object 'Report_Attendance_Intermediate', database 'LabourWorks', schema 'dbo'."), config());
  assert.match(message, /needs SELECT on dbo\.Report_Attendance_Intermediate/);
  assert.match(message, /the login "it"/);
  assert.match(message, /ATTENDANCE_DB_USER/);
});

test("a wrong column name points at the configured columns", () => {
  const message = explainSourceError(new Error("Invalid column name 'AttDate'."), config());
  assert.match(message, /ATTENDANCE_DB_DATE_COLUMN \("Date"\)/);
  assert.match(message, /ATTENDANCE_DB_QUERY/);
});

test("any other driver error is passed through unchanged", () => {
  assert.equal(explainSourceError(new Error("Connection lost"), config()), "Connection lost");
});
