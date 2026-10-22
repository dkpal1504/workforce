import test from "node:test";
import assert from "node:assert/strict";
import { delayExportRows, hindranceExportRows } from "./reportInsights";

/**
 * The rows the workbook and the PDF carry.
 *
 * A file that states "41% of 68" is a claim somebody will forward, so the shaping is pure and pinned: the
 * order in which rows appear, and the fact that a missing owner or closure does NOT become the string
 * "undefined" in a cell.
 */

test("cause rows keep the screen's order and carry the share the summary computed", () => {
  const rows = delayExportRows({
    total: 68,
    uncoded: 3,
    byReason: [
      { code: "MATERIAL", label: "Material not available", count: 28, share: 41, averageOpenDays: 9 },
      { code: "MANPOWER", label: "Manpower shortage", count: 15, share: 22, averageOpenDays: 4.1 },
    ],
  });
  assert.deepEqual(rows, [
    { cause: "Material not available", count: 28, sharePct: 41, averageOpenDays: 9 },
    { cause: "Manpower shortage", count: 15, sharePct: 22, averageOpenDays: 4.1 },
  ]);
});

test("an empty summary produces no rows, not a placeholder row", () => {
  assert.deepEqual(delayExportRows({ total: 0, uncoded: 0, byReason: [] }), []);
});

test("hindrance rows lead with the oldest, because that is what a meeting reads first", () => {
  const rows = hindranceExportRows([
    {
      wbsCode: "1.4.2", jobOrderCode: "B1049", jobOrderName: "Spools", category: "MATERIAL",
      description: "Vendor late", ownerEmail: "v@swan.co.in", raisedByEmail: "hod@swan.co.in",
      raisedAt: new Date("2026-10-18T00:00:00Z"), state: "OPEN", closedByName: null, closedAt: null,
      closureNote: null, age: { days: 4, stale: false },
    },
    {
      wbsCode: "1.4.3", jobOrderCode: "B1050", jobOrderName: "Permits", category: "PERMIT",
      description: "Permit pending", ownerEmail: null, raisedByEmail: "pm@swan.co.in",
      raisedAt: new Date("2026-10-01T00:00:00Z"), state: "OPEN", closedByName: null, closedAt: null,
      closureNote: null, age: { days: 21, stale: true },
    },
  ]);
  assert.equal(rows[0].wbsCode, "1.4.3", "21 days first");
  assert.equal(rows[0].stale, true);
  assert.equal(rows[0].ownerEmail, "", "a missing owner is blank, never the word undefined");
  assert.equal(rows[1].raisedOn, "2026-10-18");
});

test("a closed hindrance carries who closed it and when, and a blank closure note stays blank", () => {
  const rows = hindranceExportRows([
    {
      wbsCode: "1.4.2", jobOrderCode: "B1049", jobOrderName: "Spools", category: "DRAWING",
      description: "Isometric revision B", ownerEmail: "design@swan.co.in", raisedByEmail: "hod@swan.co.in",
      raisedAt: new Date("2026-10-12T00:00:00Z"), state: "CLOSED", closedByName: "R. Vaniya",
      closedAt: new Date("2026-10-16T00:00:00Z"), closureNote: null, age: { days: 4, stale: false },
    },
  ]);
  assert.equal(rows[0].state, "CLOSED");
  assert.equal(rows[0].closedByName, "R. Vaniya");
  assert.equal(rows[0].closedOn, "2026-10-16");
  assert.equal(rows[0].closureNote, "");
  assert.equal(rows[0].stale, false, "a closed item is never stale in a file either");
});
