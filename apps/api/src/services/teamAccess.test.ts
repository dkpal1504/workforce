import assert from "node:assert/strict";
import test from "node:test";
import { teamAccessSatisfied } from "./teamAccess";

const OWN = 48;

test("the team count is measured against the team ids, so own + colleague satisfies", () => {
  // THE REGRESSION. One team row and one self row: `teamMatchedCount` is 1, and the payload
  // has 2 ids. Comparing against 2 (the old code) is false by construction and refused the
  // save; comparing against the 1 team id is the correct reading.
  assert.equal(
    teamAccessSatisfied({ ownEmployeeId: OWN, employeeIds: [OWN, 12], ownMatched: true, teamMatchedCount: 1 }),
    true
  );
  // Reversed order, and with the self row repeated, must behave identically.
  assert.equal(
    teamAccessSatisfied({ ownEmployeeId: OWN, employeeIds: [12, OWN, OWN], ownMatched: true, teamMatchedCount: 1 }),
    true
  );
});

test("the self row alone needs no team row at all", () => {
  assert.equal(
    teamAccessSatisfied({ ownEmployeeId: OWN, employeeIds: [OWN], ownMatched: true, teamMatchedCount: 0 }),
    true
  );
  // ...but it still has to be in this Department and active.
  assert.equal(
    teamAccessSatisfied({ ownEmployeeId: OWN, employeeIds: [OWN], ownMatched: false, teamMatchedCount: 0 }),
    false
  );
});

test("every colleague must have a live team row", () => {
  // Two colleagues, one team row -> refused.
  assert.equal(
    teamAccessSatisfied({ ownEmployeeId: OWN, employeeIds: [12, 13], ownMatched: false, teamMatchedCount: 1 }),
    false
  );
  // Two colleagues, two team rows -> allowed.
  assert.equal(
    teamAccessSatisfied({ ownEmployeeId: OWN, employeeIds: [12, 13], ownMatched: false, teamMatchedCount: 2 }),
    true
  );
  // The same employee twice is ONE person, so one team row authorises both mentions.
  assert.equal(
    teamAccessSatisfied({ ownEmployeeId: OWN, employeeIds: [12, 12], ownMatched: false, teamMatchedCount: 1 }),
    true
  );
});

test("a supervisor with no linked Employee row has no self path", () => {
  assert.equal(
    teamAccessSatisfied({ ownEmployeeId: null, employeeIds: [12], ownMatched: false, teamMatchedCount: 1 }),
    true
  );
  // With no linked row, HIS OWN id is just an ordinary teammate and needs a team row like anyone else.
  assert.equal(
    teamAccessSatisfied({ ownEmployeeId: null, employeeIds: [48], ownMatched: false, teamMatchedCount: 0 }),
    false
  );
});

test("an empty payload is never authorised", () => {
  assert.equal(
    teamAccessSatisfied({ ownEmployeeId: OWN, employeeIds: [], ownMatched: true, teamMatchedCount: 0 }),
    false
  );
});

test("a colleague who is not in the team cannot ride along on the self row", () => {
  assert.equal(
    teamAccessSatisfied({ ownEmployeeId: OWN, employeeIds: [OWN, 999], ownMatched: true, teamMatchedCount: 0 }),
    false
  );
});
