import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson, payloadHash, summaryColumns } from "./reviewSnapshot";
import type { ReviewPayload } from "./reviewPayload";

test("canonical JSON sorts keys at every level, so the same payload always hashes the same", () => {
  const a = { b: 1, a: { d: [3, 1], c: "x" } };
  const b = { a: { c: "x", d: [3, 1] }, b: 1 };
  assert.equal(canonicalJson(a), canonicalJson(b), "key order must not change the hash");
  assert.equal(payloadHash(a), payloadHash(b));
  // Arrays keep their order: reordering a series IS a different payload.
  assert.notEqual(payloadHash({ v: [1, 2] }), payloadHash({ v: [2, 1] }));
});

test("the hash is stable across calls and changes when a number changes", () => {
  const payload = { planned: [0, 50, 100], actual: [0, 40] };
  assert.equal(payloadHash(payload), payloadHash({ ...payload }));
  assert.notEqual(payloadHash(payload), payloadHash({ ...payload, actual: [0, 41] }));
});

test("the summary columns come from the payload, never from a second calculation", () => {
  const payload = {
    pulse: {
      jobOrders: 12,
      budgetHours: 950.5,
      actualHours: 210.25,
      burnPct: 0.2212,
      delayed: 3,
      openEscalations: 2,
      escalationsOver30: 1,
      actionsOpen: 5,
      actionsOverdue: 2,
      headcountPeak: 19,
    },
    jobOrderIndex: [
      { id: 1, scheduled: true },
      { id: 2, scheduled: false },
      { id: 3, scheduled: true },
    ],
  } as unknown as ReviewPayload;

  const summary = summaryColumns(payload);
  assert.equal(summary.jobOrders, 12);
  assert.equal(summary.budgetHours, 950.5);
  assert.equal(summary.scheduledCount, 2, "counted from the index the screen uses");
  assert.equal(summary.delayedCount, 3);
  assert.equal(summary.escalationsOver30, 1);
  assert.equal(summary.headcountPeak, 19);
});

test("a Date hashes as the ISO string it is stored as, not as an empty object", () => {
  // The bug this pins: Dates have no own keys, so a plain-object walk turned them into `{}` at write time
  // while the stored JSON held a string — the hash then never matched on read, and every snapshot looked
  // corrupt.
  const withDate = { plannedEndDate: new Date("2026-08-31T00:00:00.000Z") };
  const asStored = JSON.parse(JSON.stringify(withDate));
  assert.equal(canonicalJson(withDate), canonicalJson(asStored));
  assert.equal(payloadHash(withDate), payloadHash(asStored));
});

test("a float that jsonb cannot round-trip still hashes the same on read", () => {
  // Postgres stores JSON numbers as numeric, so 3.1857142857142855 comes back as 3.185714285714285.
  const written = { burnPct: 3.1857142857142855 };
  const readBack = { burnPct: 3.185714285714285 };
  assert.equal(payloadHash(written), payloadHash(readBack));
  // Integers are untouched, and a real difference is still a difference.
  assert.equal(canonicalJson({ n: 3 }), '{"n":3}');
  assert.notEqual(payloadHash({ n: 3.1 }), payloadHash({ n: 3.2 }));
});
