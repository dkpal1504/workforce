import test from "node:test";
import assert from "node:assert/strict";
import {
  balanceOf,
  latestApprovedProgress,
  percentOf,
  pickRevisionInForce,
  resolveBudgetInForce,
  type BudgetRevisionLike,
} from "./budgetLookup";

const jo = (hours: number, quantity: number) => ({
  budgetedHours: hours,
  budgetedQuantity: quantity,
  uomId: 9,
});

// Revision 1 opens the budget, revision 2 raises it, revision 3 raises it again.
const revisions: BudgetRevisionLike[] = [
  { revisionNo: 1, budgetedHours: 1000, budgetedQuantity: 100, uomId: 2, effectiveFrom: "2026-01-01" },
  { revisionNo: 2, budgetedHours: 1400, budgetedQuantity: 180, uomId: 2, effectiveFrom: "2026-02-01" },
  { revisionNo: 3, budgetedHours: 2000, budgetedQuantity: 260, uomId: 3, effectiveFrom: "2026-03-15" },
];

test("budget before the first revision falls back to the Job Order's current budget", () => {
  const picked = pickRevisionInForce(revisions, "2025-12-31");
  assert.equal(picked, null, "nothing was effective yet");

  const resolved = resolveBudgetInForce(revisions, "2025-12-31", jo(1500, 210));
  assert.deepEqual(resolved, {
    budgetedHours: 1500,
    budgetedQuantity: 210,
    uomId: 9,
    revisionNo: null,
    effectiveFrom: null,
    source: "current",
  });
});

test("the work date exactly on an effective date uses that revision", () => {
  const resolved = resolveBudgetInForce(revisions, "2026-02-01", jo(1, 1));
  assert.equal(resolved.source, "revision");
  assert.equal(resolved.revisionNo, 2);
  assert.equal(resolved.budgetedHours, 1400);
  assert.equal(resolved.budgetedQuantity, 180);
  assert.equal(resolved.uomId, 2);
  assert.equal(resolved.effectiveFrom?.toISOString(), "2026-02-01T00:00:00.000Z");
});

test("a work date between two revisions keeps the earlier revision", () => {
  const resolved = resolveBudgetInForce(revisions, "2026-03-14", jo(1, 1));
  assert.equal(resolved.revisionNo, 2, "revision 3 starts on 2026-03-15");
  assert.equal(resolved.budgetedHours, 1400);
});

test("a work date after the last revision keeps the last revision", () => {
  const resolved = resolveBudgetInForce(revisions, "2027-06-30", jo(1, 1));
  assert.equal(resolved.revisionNo, 3);
  assert.equal(resolved.budgetedHours, 2000);
  assert.equal(resolved.budgetedQuantity, 260);
  assert.equal(resolved.uomId, 3);
});

test("a Job Order with no revision row at all uses its own current budget", () => {
  const resolved = resolveBudgetInForce([], "2026-05-05", jo(800, 55));
  assert.equal(resolved.source, "current");
  assert.equal(resolved.budgetedHours, 800);
  assert.equal(resolved.budgetedQuantity, 55);
});

test("a missing budget reads as zero, never as NaN", () => {
  const resolved = resolveBudgetInForce([], "2026-05-05", { budgetedHours: null, budgetedQuantity: null });
  assert.equal(resolved.budgetedHours, 0);
  assert.equal(resolved.budgetedQuantity, 0);
});

test("two revisions effective the same day: the higher revision number wins", () => {
  const sameDay: BudgetRevisionLike[] = [
    { revisionNo: 1, budgetedHours: 100, budgetedQuantity: 10, effectiveFrom: "2026-01-01" },
    { revisionNo: 2, budgetedHours: 250, budgetedQuantity: 25, effectiveFrom: "2026-01-01" },
  ];
  const resolved = resolveBudgetInForce(sameDay, "2026-01-01", jo(0, 0));
  assert.equal(resolved.revisionNo, 2);
  assert.equal(resolved.budgetedHours, 250);
  // The picker must not depend on the order the rows arrive in.
  assert.equal(pickRevisionInForce([...sameDay].reverse(), "2026-01-01")?.revisionNo, 2);
});

test("a percentage clamps at 0 when the budget is 0 and keeps over-budget values", () => {
  assert.equal(percentOf(50, 200), 25);
  assert.equal(percentOf(200, 200), 100);
  assert.equal(percentOf(250, 200), 125, "over budget is a real number, not a cap");
  assert.equal(percentOf(12, 0), 0);
  assert.equal(percentOf(12, -5), 0);
  assert.equal(percentOf(0, 0), 0);
});

test("balance is budget minus achieved, and goes negative when over budget", () => {
  assert.equal(balanceOf(1200, 300), 900);
  assert.equal(balanceOf(1200, 1500), -300);
  assert.equal(balanceOf(0, 0), 0);
});

test("achieved quantity is the cumulative quantity of the latest APPROVED entry", () => {
  const achieved = latestApprovedProgress([
    { id: 1, status: "SUBMITTED", progressDate: "2026-09-12", cumulativeQuantity: 300 },
    { id: 2, status: "APPROVED", progressDate: "2026-09-08", cumulativeQuantity: 40 },
    { id: 3, status: "APPROVED", progressDate: "2026-09-10", cumulativeQuantity: 95 },
    { id: 4, status: "REJECTED", progressDate: "2026-09-11", cumulativeQuantity: 120 },
    { id: 5, status: "SENT_BACK", progressDate: "2026-09-13", cumulativeQuantity: 500 },
  ]);
  assert.equal(achieved?.cumulativeQuantity, 95, "a later submitted or rejected row does not count");
});

test("an amended progress row supersedes the rejected one on the same date", () => {
  const achieved = latestApprovedProgress([
    { id: 1, status: "REJECTED", progressDate: "2026-09-11", cumulativeQuantity: 120, revisionNo: 1 },
    { id: 2, status: "APPROVED", progressDate: "2026-09-11", cumulativeQuantity: 96, revisionNo: 2 },
  ]);
  assert.equal(achieved?.cumulativeQuantity, 96);
  assert.equal(achieved?.revisionNo, 2);
});

test("no approved progress means not reported, not zero", () => {
  assert.equal(latestApprovedProgress([]), null);
  assert.equal(
    latestApprovedProgress([{ status: "SUBMITTED", progressDate: "2026-09-12", cumulativeQuantity: 300 }]),
    null
  );
});
