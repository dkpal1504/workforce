import test from "node:test";
import assert from "node:assert/strict";
import { parseRegisterFixture, splitViewName, suggestColumnNames } from "./attendanceRegisterSource";

test("the confirmed column names map cleanly", () => {
  const mapping = suggestColumnNames([
    "Date",
    "IDNo",
    "isWeeklyOff",
    "OriginalStatus",
    "AcceptedManHrs",
    "AcceptedOT",
    "ManHours",
  ]);
  assert.equal(mapping.id, "IDNo");
  assert.equal(mapping.date, "Date");
  assert.equal(mapping.weeklyOff, "isWeeklyOff");
  assert.equal(mapping.status, "OriginalStatus");
  assert.equal(mapping.acceptedHours, "AcceptedManHrs");
  assert.equal(mapping.acceptedOt, "AcceptedOT");
  assert.equal(mapping.rawHours, "ManHours");
});

test("a differently spelled overtime column is still suggested, from most to least specific", () => {
  const mapping = suggestColumnNames(["IDNo", "Date", "AcceptedManHrs", "AcceptedOTHrs"]);
  assert.equal(mapping.acceptedOt, "AcceptedOTHrs");
  assert.equal(mapping.acceptedHours, "AcceptedManHrs");
});

test("an unrecognisable column list yields nulls, never a wrong guess", () => {
  const mapping = suggestColumnNames(["Widget", "Gizmo"]);
  assert.equal(mapping.weeklyOff, null);
  assert.equal(mapping.status, null);
  assert.equal(mapping.acceptedHours, null);
  assert.equal(mapping.acceptedOt, null);
  assert.equal(mapping.rawHours, null);
});

test("the view name splits into schema and table, with dbo as the default", () => {
  assert.deepEqual(splitViewName("dbo.Report_Attendance_Intermediate"), {
    schema: "dbo",
    table: "Report_Attendance_Intermediate",
  });
  assert.deepEqual(splitViewName("[dbo].[Report_Attendance_Intermediate]"), {
    schema: "dbo",
    table: "Report_Attendance_Intermediate",
  });
  assert.deepEqual(splitViewName("Report_Attendance_Intermediate"), {
    schema: "dbo",
    table: "Report_Attendance_Intermediate",
  });
});

test("a fixture whose column names do not match fails loudly instead of parsing to nothing", () => {
  // The real defect this guard exists for: the view says `IDNo`, a mapper read `IdNo`, and 56k rows
  // became zero while every downstream figure stayed a confident zero.
  assert.throws(
    () => parseRegisterFixture(JSON.stringify({ "2026-10-01": [{ WrongId: "A1", ManHours: 8 }] })),
    /produced NO rows/
  );
});

test("a well-formed fixture parses, with the view's own column spelling", () => {
  const parsed = parseRegisterFixture(
    JSON.stringify({
      "2026-10-01": [
        {
          IDNo: "A1",
          isWeeklyOff: 0,
          OriginalStatus: "P",
          AcceptedManHrs: 8.5,
          AcceptedOT: 0,
          ManHours: 8.5,
        },
      ],
    })
  );
  const rows = parsed.get("2026-10-01") ?? [];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].idNo, "A1");
  assert.equal(rows[0].originalStatus, "P");
});
