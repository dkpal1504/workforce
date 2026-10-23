import test from "node:test";
import assert from "node:assert/strict";
import {
  missingRequiredColumns,
  parseRegisterFixture,
  splitViewName,
  suggestColumnNames,
} from "./attendanceRegisterSource";

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

test("the four required columns are named, and their absence is what sends us looking elsewhere", () => {
  // The real view as inspected on 2026-10-23: an attendance log with hours, but none of the day-type or
  // accepted-hours columns. This must be reported as "wrong object", not "wrong mapping".
  const realView = [
    "Contractor", "Workmen", "WorkorderNo", "IDNo", "Barcode", "Workskill", "BusinessUnit", "Section",
    "CardType", "Division", "NOW", "Date", "CheckinDateTime", "CheckoutDateTime", "ManHours", "ManHrsMin",
    "Plant", "PlantName",
  ];
  assert.deepEqual(missingRequiredColumns(realView), [
    "isWeeklyOff",
    "OriginalStatus",
    "AcceptedManHrs",
    "AcceptedOT",
  ]);
  // Case-insensitively complete -> nothing missing.
  assert.deepEqual(
    missingRequiredColumns(["isweeklyoff", "ORIGINALSTATUS", "acceptedmanhrs", "AcceptedOT"]),
    []
  );
  // Partially complete: only the absent ones are reported.
  assert.deepEqual(
    missingRequiredColumns(["isWeeklyOff", "OriginalStatus", "AcceptedManHrs"]),
    ["AcceptedOT"]
  );
});

test("the population filter targets the associates, and cannot be injected through", async () => {
  const { registerCardTypeFilter, registerCardTypes } = await import("./attendanceRegisterSource");
  const original = process.env.ATTENDANCE_REGISTER_CARD_TYPES;
  try {
    delete process.env.ATTENDANCE_REGISTER_CARD_TYPES;
    assert.deepEqual(registerCardTypes(), ["Associates", "ASSOCIATE SEZ"]);
    const filter = registerCardTypeFilter();
    assert.match(filter, /UPPER\(LTRIM\(RTRIM\(\[CardType\]\)\)\) IN \('ASSOCIATES', 'ASSOCIATE SEZ'\)/);

    // ALL disables the filter; it is never the fall-through of an empty value.
    process.env.ATTENDANCE_REGISTER_CARD_TYPES = "ALL";
    assert.deepEqual(registerCardTypes(), []);
    assert.equal(registerCardTypeFilter(), "");

    // A value that could break out of the literal is refused outright.
    process.env.ATTENDANCE_REGISTER_CARD_TYPES = "Associates') OR 1=1 --";
    assert.throws(() => registerCardTypes(), /unsupported value/);
  } finally {
    if (original === undefined) delete process.env.ATTENDANCE_REGISTER_CARD_TYPES;
    else process.env.ATTENDANCE_REGISTER_CARD_TYPES = original;
  }
});
