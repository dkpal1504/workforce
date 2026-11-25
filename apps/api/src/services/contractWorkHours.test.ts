import test from "node:test";
import assert from "node:assert/strict";
import {
  contractOverheadHours,
  OT_NOT_BOOKED_COLOR_KEY,
  projectHoursFromEntries,
  slotsFromEntries,
  type BookingEntryLike,
} from "./contractWorkHours";

test("OT-only holiday attendance has zero overhead", () => {
  assert.equal(contractOverheadHours(8, 0, 8), 0);
  assert.equal(contractOverheadHours(8, 0, 4), 0);
});

test("regular contract attendance keeps unused shift capacity as overhead", () => {
  assert.equal(contractOverheadHours(8, 6, 0), 2);
  assert.equal(contractOverheadHours(8, 6, 2), 2);
  assert.equal(contractOverheadHours(8, 8, 4), 0);
});

/* ---- per-slot bookings: what the approval queue now shows ------------------------------------ */

function entry(over: Partial<BookingEntryLike>): BookingEntryLike {
  return {
    projectWbsId: null,
    jobOrderId: 233,
    status: "SUBMITTED",
    shiftSlot: null,
    hourSlot: null,
    otHours: null,
    project: { colorKey: "b", name: "MV AINA" },
    projectWbs: null,
    jobOrder: { code: "1900000204", name: "Block Transfer (Block 223)", project: { colorKey: "b", name: "MV AINA" } },
    ...over,
  };
}

test("slots print am1 → am2 → pm1 → pm2 and OT last, whatever order the rows arrive in", () => {
  const slots = slotsFromEntries([
    entry({ shiftSlot: "pm2", jobOrder: { code: "1900000205", name: "Second", project: { colorKey: "b", name: "MV AINA" } } }),
    entry({ shiftSlot: "am1" }),
    entry({ otHours: 2, shiftSlot: null }),
    entry({ shiftSlot: "am2" }),
    entry({ shiftSlot: "pm1", project: { colorKey: "c", name: "MV FALCON" }, jobOrder: { code: "1900000110", name: "Piping", project: { colorKey: "c", name: "MV FALCON" } } }),
  ]);
  assert.deepEqual(
    slots.map((s) => [s.shiftSlot, s.isOt, s.hours, s.jobOrderCode]),
    [
      ["am1", false, 2, "1900000204"],
      ["am2", false, 2, "1900000204"],
      ["pm1", false, 2, "1900000110"],
      ["pm2", false, 2, "1900000205"],
      [null, true, 2, "1900000204"],
    ]
  );
  // The project token is what colours the chip; it must be upper-cased the way the columns key it.
  assert.equal(slots[2].projectKey, "C");
  // The Job Order description travels with the number, because the tooltip prints both.
  assert.equal(slots[0].jobOrderName, "Block Transfer (Block 223)");
});

test("a row tagged to neither a WBS nor a Job Order is not a booking", () => {
  const slots = slotsFromEntries([
    entry({ jobOrderId: null, projectWbsId: null }),
    entry({ shiftSlot: "am1" }),
  ]);
  assert.equal(slots.length, 1);
  assert.equal(slots[0].shiftSlot, "am1");
});

test("a legacy hourly row is 1h and takes its code from the WBS", () => {
  const slots = slotsFromEntries([
    entry({
      jobOrderId: null,
      projectWbsId: 9,
      hourSlot: 1,
      project: null,
      jobOrder: null,
      projectWbs: { wbsCode: "WBS-9", name: "Hull block" },
    }),
  ]);
  assert.equal(slots.length, 1);
  assert.equal(slots[0].hours, 1);
  assert.equal(slots[0].jobOrderCode, "WBS-9");
  assert.equal(slots[0].jobOrderName, "Hull block");
  assert.equal(slots[0].projectKey, null);
});

test("two supervisors on the same slot yield two rows — the conflict must be explainable", () => {
  const slots = slotsFromEntries([entry({ shiftSlot: "am1" }), entry({ shiftSlot: "am1" })]);
  assert.equal(slots.length, 2);
  assert.deepEqual(slots.map((s) => s.shiftSlot), ["am1", "am1"]);
});


/* ---- approved overtime: CLMS is the figure, the punch is only attribution -------------------- */

test("the approved figure is reported, not the punch, and it lands on the OT booking's project", () => {
  const result = projectHoursFromEntries(
    [
      entry({ shiftSlot: "am1" }),
      entry({ shiftSlot: "am2" }),
      entry({ otHours: 4, project: { colorKey: "b" } }),
    ],
    8,
    { hours: 2, fetched: true }
  );
  assert.deepEqual(result.projectHours, { B: 4 });
  assert.deepEqual(result.projectOtHours, { B: 2 }, "2 approved, not the 4 punched");
  assert.equal(result.punchedOtHours, 4, "the punch is still readable as a reference");
  assert.equal(result.totalOtHours, 2);
  assert.equal(result.totalAlloc, 6);
});

test("CLMS approving no OT reports zero overtime however many hours were punched", () => {
  const result = projectHoursFromEntries(
    [entry({ shiftSlot: "am1" }), entry({ otHours: 5, project: { colorKey: "b" } })],
    8,
    { hours: 0, fetched: true }
  );
  assert.deepEqual(result.projectOtHours, {});
  assert.equal(result.punchedOtHours, 5);
  assert.equal(result.totalOtHours, 0);
});

test("approved OT nobody booked is reported in its own bucket, never dropped", () => {
  const result = projectHoursFromEntries([entry({ shiftSlot: "am1" })], 8, { hours: 3, fetched: true });
  assert.deepEqual(result.projectOtHours, { [OT_NOT_BOOKED_COLOR_KEY]: 3 });
  assert.equal(result.otNotBookedHours, 3);
  assert.equal(result.totalOtHours, 3);
});

test("a never-fetched day reports zero OT and says so", () => {
  const result = projectHoursFromEntries([entry({ otHours: 2, project: { colorKey: "b" } })], 8, {
    hours: 0,
    fetched: false,
  });
  assert.equal(result.otFetched, false);
  assert.equal(result.totalOtHours, 0);
  assert.equal(result.punchedOtHours, 2);
});

test("an OT-only day keeps zero overhead against the approved figure", () => {
  const result = projectHoursFromEntries([entry({ otHours: 8, project: { colorKey: "b" } })], 8, {
    hours: 8,
    fetched: true,
  });
  assert.equal(result.overhead, 0);
  assert.equal(result.totalAlloc, 8);
});
