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
    "isHoliday",
    "OriginalStatus",
    "AcceptedManHrs",
    "AcceptedOT",
    "IsTerminated",
  ]);
  // Case-insensitively complete -> nothing missing.
  assert.deepEqual(
    missingRequiredColumns([
      "isweeklyoff",
      "ISHOLIDAY",
      "ORIGINALSTATUS",
      "acceptedmanhrs",
      "AcceptedOT",
      "isterminated",
    ]),
    []
  );
  // Partially complete: only the absent ones are reported.
  assert.deepEqual(
    missingRequiredColumns(["isWeeklyOff", "isHoliday", "OriginalStatus", "AcceptedManHrs", "IsTerminated"]),
    ["AcceptedOT"]
  );
});

test("the population filter targets the associates, and cannot be injected through", async () => {
  const { registerPopulationFilter, registerCardTypes } = await import("./attendanceRegisterSource");
  const original = process.env.ATTENDANCE_REGISTER_CARD_TYPES;
  try {
    delete process.env.ATTENDANCE_REGISTER_CARD_TYPES;
    assert.deepEqual(registerCardTypes(), ["Associates", "ASSOCIATE SEZ"]);
    const filter = registerPopulationFilter();
    assert.match(filter, /UPPER\(LTRIM\(RTRIM\(\[CardType\]\)\)\) IN \('ASSOCIATES', 'ASSOCIATE SEZ'\)/);
    // Terminated workers are excluded, and NULL is NOT silently treated as terminated.
    assert.match(filter, /ISNULL\(\[IsTerminated\], 0\) = 0/);

    // ALL disables the CARD-TYPE clause only; termination still applies.
    process.env.ATTENDANCE_REGISTER_CARD_TYPES = "ALL";
    assert.deepEqual(registerCardTypes(), []);
    const wildcard = registerPopulationFilter();
    assert.doesNotMatch(wildcard, /CardType/);
    assert.match(wildcard, /ISNULL\(\[IsTerminated\], 0\) = 0/);

    // A value that could break out of the literal is refused outright.
    process.env.ATTENDANCE_REGISTER_CARD_TYPES = "Associates') OR 1=1 --";
    assert.throws(() => registerCardTypes(), /unsupported value/);
  } finally {
    if (original === undefined) delete process.env.ATTENDANCE_REGISTER_CARD_TYPES;
    else process.env.ATTENDANCE_REGISTER_CARD_TYPES = original;
  }
});

test("today is the IST date, not the UTC date", async () => {
  const { todayInAppZone } = await import("./attendanceRegisterSource");
  // 20:15Z on 22 Oct is already 01:45 on 23 Oct in IST — the case a 02:00 job hits.
  assert.equal(todayInAppZone(new Date("2026-10-22T20:15:00Z")), "2026-10-23");
  assert.equal(todayInAppZone(new Date("2026-10-23T18:29:00Z")), "2026-10-23");
  assert.equal(todayInAppZone(new Date("2026-10-23T18:31:00Z")), "2026-10-24");
});

test("a range is clamped to today, and says what was requested", async () => {
  const { clampRangeToToday } = await import("./attendanceRegisterSource");
  const clamped = clampRangeToToday({ from: "2026-09-01", to: "2026-12-31" }, "2026-10-23");
  assert.equal(clamped.to, "2026-10-23");
  assert.equal(clamped.requestedTo, "2026-12-31");
  assert.equal(clamped.clamped, true);

  const untouched = clampRangeToToday({ from: "2026-09-01", to: "2026-10-01" }, "2026-10-23");
  assert.equal(untouched.to, "2026-10-01");
  assert.equal(untouched.clamped, false);
});
