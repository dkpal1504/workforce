import assert from "node:assert/strict";
import test from "node:test";
import { actionCounts, carryForwardPlan, closeWarning, daysOverdue, isOverdue, type ReviewItemLike } from "./reviewActions";

const today = new Date("2026-10-24T09:00:00+05:30");
const day = (value: string) => new Date(`${value}T00:00:00.000Z`);

function item(overrides: Partial<ReviewItemLike> & { id: number }): ReviewItemLike {
  return {
    kind: "ACTION",
    status: "OPEN",
    dueOn: null,
    carriedFromId: null,
    carriedToId: null,
    carryCount: 0,
    ownerUserId: null,
    ownerEmail: "owner@example.com",
    ownerName: "Owner",
    projectWbsId: null,
    jobOrderId: null,
    body: `item ${overrides.id}`,
    ...overrides,
  };
}

test("an action due today is not overdue until tomorrow", () => {
  assert.equal(isOverdue({ status: "OPEN", dueOn: day("2026-10-24") }, today), false, "today is not late");
  assert.equal(isOverdue({ status: "OPEN", dueOn: day("2026-10-23") }, today), true, "yesterday is late");
  assert.equal(daysOverdue({ status: "OPEN", dueOn: day("2026-10-23") }, today), 1);
  assert.equal(daysOverdue({ status: "OPEN", dueOn: day("2026-10-24") }, today), 0);
  assert.equal(isOverdue({ status: "DONE", dueOn: day("2026-01-01") }, today), false, "a closed item is never late");
  assert.equal(isOverdue({ status: "OPEN", dueOn: null }, today), false, "no due date, no lateness");
});

test("only open, un-carried ACTIONS and NOTES carry; a decision stays in its own review", () => {
  const plan = carryForwardPlan([
    item({ id: 1, dueOn: day("2026-10-01") }),
    item({ id: 2, kind: "DECISION", body: "approve the rate" }),
    item({ id: 3, status: "DONE" }),
    item({ id: 4, status: "CANCELLED" }),
    item({ id: 5, carriedToId: 99 }),
    item({ id: 6, kind: "NOTE" }),
  ]);
  assert.deepEqual(plan.copies.map((copy) => copy.sourceId), [1, 6]);
  assert.deepEqual(plan.skipped, [
    { id: 2, reason: "DECISION_IS_MINUTES" },
    { id: 3, reason: "DONE" },
    { id: 4, reason: "CANCELLED" },
    { id: 5, reason: "ALREADY_CARRIED" },
  ]);
});

test("carrying is idempotent and the chain increments, so a re-run cannot duplicate the register", () => {
  const first = carryForwardPlan([item({ id: 7, carryCount: 0 })]);
  assert.equal(first.copies.length, 1);
  assert.equal(first.copies[0].carryCount, 1);
  assert.equal(first.copies[0].carriedFromId, 7);

  // The same previous list, now that the copy exists on the far side, carries nothing new.
  const second = carryForwardPlan([item({ id: 7, carryCount: 1, carriedToId: 8 })]);
  assert.equal(second.copies.length, 0);
  assert.deepEqual(second.skipped, [{ id: 7, reason: "ALREADY_CARRIED" }]);
});

test("counts separate open, overdue and the zombies that keep coming back", () => {
  const counts = actionCounts(
    [
      item({ id: 1, dueOn: day("2026-10-01") }),
      item({ id: 2, carryCount: 2 }),
      item({ id: 3, carryCount: 1 }),
      item({ id: 4, status: "DONE" }),
      item({ id: 5, status: "CANCELLED" }),
      item({ id: 6, kind: "DECISION" }),
      item({ id: 7, ownerEmail: null }),
    ],
    today
  );
  assert.equal(counts.open, 4, "items 1, 2, 3, 7");
  assert.equal(counts.overdue, 1);
  assert.equal(counts.done, 1);
  assert.equal(counts.cancelled, 1);
  assert.equal(counts.carriedTwiceOrMore, 1, "only id 2 has been carried twice");
  assert.equal(counts.unowned, 1, "an action with no e-mail cannot be chased by anything");
});

test("the close dialog says in words what will carry", () => {
  assert.equal(closeWarning([item({ id: 1 }), item({ id: 2 })]), "2 open action(s) will carry to the next review.");
  assert.equal(closeWarning([item({ id: 1, status: "DONE" })]), "No open actions carry to the next review.");
});
