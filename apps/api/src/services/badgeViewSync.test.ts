import test from "node:test";
import assert from "node:assert/strict";
import { activeWorkersOnly, type BadgeViewRow } from "./badgeViewSync";

function row(overrides: Partial<BadgeViewRow>): BadgeViewRow {
  return {
    EcNo: "EC1",
    BuName: "Production",
    Department: "Production - EOU",
    Section: "Piping",
    Division: "EOU",
    WorkmenName: "Test Worker",
    NatureOfWork: "Fitter",
    mobile: null,
    IsTerminated: false,
    ...overrides,
  };
}

test("only active workers are imported; terminated rows are dropped", () => {
  const rows = [
    row({ EcNo: "A1", IsTerminated: false }),
    row({ EcNo: "A2", IsTerminated: true }),
    row({ EcNo: "A3", IsTerminated: null }),
    row({ EcNo: "A4", IsTerminated: 1 }),
    row({ EcNo: "A5", IsTerminated: "1" }),
    row({ EcNo: "A6", IsTerminated: "true" }),
    row({ EcNo: "A7", IsTerminated: "YES" }),
    row({ EcNo: "A8", IsTerminated: 0 }),
    row({ EcNo: "A9", IsTerminated: "false" }),
    row({ EcNo: "A10", IsTerminated: undefined }),
  ];

  const { rows: kept, skippedTerminated } = activeWorkersOnly(rows);

  assert.deepEqual(
    kept.map((r) => r.EcNo),
    ["A1", "A3", "A8", "A9", "A10"],
    "false, null, 0, 'false' and undefined all mean active"
  );
  assert.equal(skippedTerminated, 5);
});

test("an all-active snapshot is returned untouched", () => {
  const rows = [row({ EcNo: "A1" }), row({ EcNo: "A2" })];
  const { rows: kept, skippedTerminated } = activeWorkersOnly(rows);
  assert.equal(kept.length, 2);
  assert.equal(skippedTerminated, 0);
});

test("a fully terminated snapshot leaves nothing to sync", () => {
  const { rows: kept, skippedTerminated } = activeWorkersOnly([row({ IsTerminated: true }), row({ IsTerminated: "1" })]);
  assert.equal(kept.length, 0);
  assert.equal(skippedTerminated, 2);
});
