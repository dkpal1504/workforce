import assert from "node:assert/strict";
import test from "node:test";
import { teamAccessSatisfied } from "./teamAccess";

const OWN = 48;

test("own row alongside a colleague is authorised by the team row", () => {
  // THE EARLIER REGRESSION, still pinned. One team row and one self row in a 2-id payload: the
  // count-based form compared the row count against the whole payload, which is false by
  // construction, and refused the save.
  assert.equal(
    teamAccessSatisfied({ ownEmployeeId: OWN, employeeIds: [OWN, 12], ownMatched: true, authorisedTeamIds: [12] }),
    true
  );
  // Order and duplicates must not matter.
  assert.equal(
    teamAccessSatisfied({ ownEmployeeId: OWN, employeeIds: [12, OWN, OWN], ownMatched: true, authorisedTeamIds: [12] }),
    true
  );
});

test("the self row alone needs no team row at all", () => {
  assert.equal(
    teamAccessSatisfied({ ownEmployeeId: OWN, employeeIds: [OWN], ownMatched: true, authorisedTeamIds: [] }),
    true
  );
  // ...but it still has to be in this Department and active.
  assert.equal(
    teamAccessSatisfied({ ownEmployeeId: OWN, employeeIds: [OWN], ownMatched: false, authorisedTeamIds: [] }),
    false
  );
});

test("a colleague is authorised by a live team row", () => {
  assert.equal(
    teamAccessSatisfied({ ownEmployeeId: OWN, employeeIds: [12, 13], ownMatched: false, authorisedTeamIds: [12, 13] }),
    true
  );
  // Two colleagues, only one authorised -> refused.
  assert.equal(
    teamAccessSatisfied({ ownEmployeeId: OWN, employeeIds: [12, 13], ownMatched: false, authorisedTeamIds: [12] }),
    false
  );
  // The same employee twice is ONE person.
  assert.equal(
    teamAccessSatisfied({ ownEmployeeId: OWN, employeeIds: [12, 12], ownMatched: false, authorisedTeamIds: [12] }),
    true
  );
});

test("the sheet's own record authorises a row whose team row is gone", () => {
  // THE REPORTED PRODUCTION FAILURE. The sheet is on a date the supervisor never had a team for
  // (the HOD's "Date mixup"), or the employee has since been converted or moved, so today's team
  // list no longer reaches him — but he is ON THE SHEET, which is where the authorisation was
  // recorded when it was first saved. `authorisedTeamIds` here holds the day rows only.
  assert.equal(
    teamAccessSatisfied({ ownEmployeeId: OWN, employeeIds: [12], ownMatched: false, authorisedTeamIds: [12] }),
    true
  );
  // Two stranded colleagues, both recorded on the sheet -> both correctable.
  assert.equal(
    teamAccessSatisfied({ ownEmployeeId: OWN, employeeIds: [12, 13], ownMatched: false, authorisedTeamIds: [12, 13] }),
    true
  );
});

test("NOTHING IS WIDENED: an employee neither on the sheet nor in the team is refused", () => {
  // The safety case for reading the sheet back. Adding a stranger to a date must still fail.
  assert.equal(
    teamAccessSatisfied({ ownEmployeeId: OWN, employeeIds: [12, 999], ownMatched: false, authorisedTeamIds: [12] }),
    false
  );
  // And a colleague cannot ride along on the self row.
  assert.equal(
    teamAccessSatisfied({ ownEmployeeId: OWN, employeeIds: [OWN, 999], ownMatched: true, authorisedTeamIds: [] }),
    false
  );
  // An employee recorded on ANOTHER date is not on THIS sheet, so the caller passes no id for him.
  assert.equal(
    teamAccessSatisfied({ ownEmployeeId: OWN, employeeIds: [777], ownMatched: false, authorisedTeamIds: [] }),
    false
  );
});

test("membership cannot be satisfied by another employee's authorisation", () => {
  // Why this is a SET and not a COUNT. Employee 12 is both in the team and on the sheet; employee
  // 13 is neither. A count of two matching records would have covered 13's absence; membership
  // cannot, because 13 is not in the set.
  assert.equal(
    teamAccessSatisfied({ ownEmployeeId: OWN, employeeIds: [12, 13], ownMatched: false, authorisedTeamIds: [12] }),
    false
  );
});

test("a supervisor with no linked Employee row has no self path", () => {
  assert.equal(
    teamAccessSatisfied({ ownEmployeeId: null, employeeIds: [12], ownMatched: false, authorisedTeamIds: [12] }),
    true
  );
  // With no linked row, HIS OWN id is just an ordinary teammate and needs authorising like anyone else.
  assert.equal(
    teamAccessSatisfied({ ownEmployeeId: null, employeeIds: [48], ownMatched: false, authorisedTeamIds: [] }),
    false
  );
});

test("an empty payload is never authorised", () => {
  assert.equal(
    teamAccessSatisfied({ ownEmployeeId: OWN, employeeIds: [], ownMatched: true, authorisedTeamIds: [] }),
    false
  );
});
