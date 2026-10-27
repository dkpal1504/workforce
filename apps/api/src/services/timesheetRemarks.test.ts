import assert from "node:assert/strict";
import test from "node:test";
import { formatRemarks, REMARK_CELL_MAX_CHARS, REMARKS_PER_JOB_ORDER } from "./timesheetRemarks";

test("a remark reaches the cell with its date, because the date is half the meaning", () => {
  assert.equal(
    formatRemarks([{ date: "2026-10-12", text: "waiting for plate" }]),
    "12-10 — waiting for plate"
  );
});

test("several remarks are joined newest-first, in the order they were given", () => {
  const cell = formatRemarks([
    { date: "2026-10-14", text: "crane breakdown" },
    { date: "2026-10-12", text: "waiting for plate" },
  ]);
  assert.equal(cell, "14-10 — crane breakdown | 12-10 — waiting for plate");
});

test("the same sentence on nine days is one fact, not nine copies", () => {
  // Otherwise the one different remark is buried under eight repetitions of the same complaint.
  const cell = formatRemarks([
    { date: "2026-10-14", text: "waiting for material" },
    { date: "2026-10-13", text: "waiting for material" },
    { date: "2026-10-12", text: "waiting for material" },
    { date: "2026-10-11", text: "painter on leave" },
  ]);
  assert.equal(cell, "14-10 — waiting for material | 11-10 — painter on leave");
});

test("a Job Order with a hundred remarks does not fill the cell", () => {
  const many = Array.from({ length: 20 }, (_, index) => ({
    date: `2026-10-${String(20 - index).padStart(2, "0")}`,
    text: `remark number ${index}`,
  }));
  const cell = formatRemarks(many);
  assert.ok(cell.includes("…and 14 more"), cell);
  assert.equal(cell.split(" | ").length, REMARKS_PER_JOB_ORDER + 1);
});

test("an extremely long remark is cut, and says so", () => {
  const cell = formatRemarks([{ date: "2026-10-12", text: "x".repeat(2000) }]);
  assert.ok(cell.length <= REMARK_CELL_MAX_CHARS, `length ${cell.length}`);
  assert.ok(cell.endsWith("…"));
});

test("blank remarks are not remarks", () => {
  assert.equal(formatRemarks([]), "");
  assert.equal(formatRemarks([{ date: "2026-10-12", text: "   " }]), "");
  assert.equal(formatRemarks([{ date: "2026-10-12", text: "\n\t " }]), "");
});

test("a remark's own line breaks are flattened, so the cell stays one line", () => {
  assert.equal(
    formatRemarks([{ date: "2026-10-12", text: "no plate\ncrane down\tagain" }]),
    "12-10 — no plate crane down again"
  );
});
