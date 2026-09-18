import test from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_ATTRIBUTION_SNAPSHOT,
  resolveAttributionSnapshot,
  snapshotForBooking,
  snapshotsFromJobOrders,
} from "./attributionSnapshot";

const pipeJobOrder = {
  id: 7,
  projectId: 2,
  projectWbsId: 11,
  departmentId: 3,
  sectionId: 8,
};

test("a booking takes all four buckets from the chosen Job Order", () => {
  assert.deepEqual(resolveAttributionSnapshot(pipeJobOrder), {
    projectId: 2,
    projectWbsId: 11,
    departmentId: 3,
    sectionId: 8,
  });
});

test("a standing Job Order freezes a null Section", () => {
  const snapshot = resolveAttributionSnapshot({
    projectId: 5,
    projectWbsId: 20,
    departmentId: 3,
    sectionId: null,
  });
  assert.deepEqual(snapshot, { projectId: 5, projectWbsId: 20, departmentId: 3, sectionId: null });
});

test("a chosen Job Order wins over the fallback buckets", () => {
  const snapshot = resolveAttributionSnapshot(pipeJobOrder, {
    projectId: 99,
    departmentId: 99,
    sectionId: 99,
  });
  assert.deepEqual(snapshot, { projectId: 2, projectWbsId: 11, departmentId: 3, sectionId: 8 });
});

test("no Job Order falls back to the screen project and the employee organisation", () => {
  assert.deepEqual(resolveAttributionSnapshot(null, { projectId: 4, departmentId: 3, sectionId: 9 }), {
    projectId: 4,
    projectWbsId: null,
    departmentId: 3,
    sectionId: 9,
  });
});

test("no Job Order and no fallback records empty buckets", () => {
  assert.deepEqual(resolveAttributionSnapshot(undefined), EMPTY_ATTRIBUTION_SNAPSHOT);
  assert.deepEqual(resolveAttributionSnapshot(null, {}), EMPTY_ATTRIBUTION_SNAPSHOT);
});

test("the shared empty snapshot cannot be mutated by a caller", () => {
  assert.equal(Object.isFrozen(EMPTY_ATTRIBUTION_SNAPSHOT), true);
});

test("a batch is keyed by Job Order id", () => {
  const snapshots = snapshotsFromJobOrders([
    pipeJobOrder,
    { id: 9, projectId: 5, projectWbsId: 20, departmentId: 3, sectionId: null },
  ]);
  assert.equal(snapshots.size, 2);
  assert.equal(snapshots.get(7)?.projectWbsId, 11);
  assert.deepEqual(snapshots.get(9), {
    projectId: 5,
    projectWbsId: 20,
    departmentId: 3,
    sectionId: null,
  });
});

test("an unknown or absent Job Order id fails closed", () => {
  const snapshots = snapshotsFromJobOrders([pipeJobOrder]);
  assert.deepEqual(snapshotForBooking(snapshots, 404), EMPTY_ATTRIBUTION_SNAPSHOT);
  assert.deepEqual(snapshotForBooking(snapshots, null, { projectId: 4, departmentId: 3, sectionId: 9 }), {
    projectId: 4,
    projectWbsId: null,
    departmentId: 3,
    sectionId: 9,
  });
  assert.equal(snapshotForBooking(snapshots, 7)?.projectId, 2);
});

test("a later master-data remap does not rewrite an existing snapshot", () => {
  const booked = resolveAttributionSnapshot(pipeJobOrder);
  const remapped = resolveAttributionSnapshot({ ...pipeJobOrder, projectId: 6, projectWbsId: 42, sectionId: 12 });
  // The booking keeps its frozen buckets; only a NEW booking sees the remap.
  assert.deepEqual(booked, { projectId: 2, projectWbsId: 11, departmentId: 3, sectionId: 8 });
  assert.deepEqual(remapped, { projectId: 6, projectWbsId: 42, departmentId: 3, sectionId: 12 });
});
