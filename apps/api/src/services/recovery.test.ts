import test from "node:test";
import assert from "node:assert/strict";
import {
  STALE_AFTER_DAYS,
  canCloseHindrance,
  canDecideRecovery,
  canProposeRecovery,
  hindranceAge,
  isOpenForDecision,
  planHasMoved,
  slipDays,
  validateManpowerPlan,
} from "./recovery";

/**
 * The two rules that protect a commitment: who may accept it, and when it is no longer the plan it was
 * measured against. Plus the register's ageing, which Central Planning reads as "what is stale".
 */

const DAY = 86_400_000;
const d = (iso: string) => new Date(`${iso}T00:00:00Z`);

test("an owner and a PM may propose; a supervisor may not", () => {
  assert.equal(canProposeRecovery({ role: "HOD", isOwner: true }), true);
  assert.equal(canProposeRecovery({ role: "PM", isOwner: false }), true);
  assert.equal(canProposeRecovery({ role: "SUPERVISOR", isOwner: false }), false);
  assert.equal(canProposeRecovery({ role: "HOD", isOwner: false }), false);
});

test("only a PM or an administrator decides, and a PM cannot accept his own offer", () => {
  assert.equal(canDecideRecovery({ role: "PM", proposerUserId: 7, actorUserId: 9 }), true);
  assert.equal(canDecideRecovery({ role: "PM", proposerUserId: 9, actorUserId: 9 }), false, "no self-approval");
  assert.equal(canDecideRecovery({ role: "ADMIN", proposerUserId: 9, actorUserId: 9 }), true, "an admin may correct it");
  assert.equal(canDecideRecovery({ role: "HOD", proposerUserId: 7, actorUserId: 9 }), false);
  // The role this application actually assigns. Checking only "PM" left the real project managers unable
  // to decide anything they had not proposed themselves.
  assert.equal(canDecideRecovery({ role: "PROJECT_MANAGER", proposerUserId: 7, actorUserId: 9 }), true);
  assert.equal(canDecideRecovery({ role: "PROJECT_MANAGER", proposerUserId: 9, actorUserId: 9 }), false);
});

test("only a PROPOSED offer can be decided, so one proposal cannot be accepted twice", () => {
  assert.equal(isOpenForDecision("PROPOSED"), true);
  for (const state of ["ACCEPTED", "REJECTED", "SUPERSEDED"]) {
    assert.equal(isOpenForDecision(state), false, `${state} must not be decided again`);
  }
});

test("a manpower plan is trimmed, rounded and bounded", () => {
  const good = validateManpowerPlan([{ trade: " Fitters ", headcount: "6", hoursPerDay: "8.25", fromDate: "2026-10-22", toDate: "2026-12-05" }]);
  assert.equal(good.ok, true);
  if (good.ok) {
    assert.deepEqual(good.plan[0], {
      trade: "Fitters",
      headcount: 6,
      hoursPerDay: 8.3,
      fromDate: "2026-10-22",
      toDate: "2026-12-05",
    });
  }
});

test("a plan that says nothing is a valid empty plan, not an error", () => {
  const empty = validateManpowerPlan(null);
  assert.equal(empty.ok, true);
  if (empty.ok) assert.deepEqual(empty.plan, []);
});

test("bad manpower lines are refused with the line number, so the form can point at it", () => {
  const noTrade = validateManpowerPlan([{ trade: "  ", headcount: 2 }]);
  assert.equal(noTrade.ok, false);
  if (!noTrade.ok) assert.match(noTrade.error, /Line 1.*trade/);

  const silly = validateManpowerPlan([{ trade: "Riggers", headcount: 0 }]);
  assert.equal(silly.ok, false);
  if (!silly.ok) assert.match(silly.error, /headcount/);

  const tooMany = validateManpowerPlan(Array.from({ length: 9 }, () => ({ trade: "Fitters", headcount: 1 })));
  assert.equal(tooMany.ok, false);
});

test("the slip is signed and in days", () => {
  assert.equal(slipDays(d("2026-11-30"), d("2026-12-12")), 12);
  assert.equal(slipDays(d("2026-12-12"), d("2026-11-30")), -12);
  assert.equal(slipDays(null, d("2026-12-12")), null, "no plan means no slip to state");
});

test("the plan is 'moved' only when it differs from what the commitment replaced", () => {
  assert.equal(planHasMoved({ plannedEndDate: d("2026-11-30"), appliedFrom: d("2026-11-30") }), false);
  assert.equal(planHasMoved({ plannedEndDate: d("2026-12-20"), appliedFrom: d("2026-11-30") }), true);
  assert.equal(planHasMoved({ plannedEndDate: null, appliedFrom: d("2026-11-30") }), false);
});

test("a hindrance ages to closure where there is one, and to now where there is not", () => {
  const raised = new Date(Date.now() - 20 * DAY);
  const open = hindranceAge(raised, null, new Date());
  assert.equal(open.days, 20);
  assert.equal(open.stale, true, `>= ${STALE_AFTER_DAYS} days is stale`);

  const closed = hindranceAge(raised, new Date(raised.getTime() + 4 * DAY), new Date());
  assert.equal(closed.days, 4);
  assert.equal(closed.stale, false, "a closed item is never stale");
});

test("a hindrance closes for its raiser or a PM; anyone else is refused", () => {
  assert.equal(canCloseHindrance({ role: "HOD", raisedByUserId: 5, actorUserId: 5 }), true);
  assert.equal(canCloseHindrance({ role: "HOD", raisedByUserId: 5, actorUserId: 6 }), false);
  assert.equal(canCloseHindrance({ role: "PM", raisedByUserId: 5, actorUserId: 6 }), true);
  assert.equal(canCloseHindrance({ role: "ADMIN", raisedByUserId: null, actorUserId: 1 }), true);
  assert.equal(canCloseHindrance({ role: "SUPERVISOR", raisedByUserId: 5, actorUserId: 6 }), false);
});
