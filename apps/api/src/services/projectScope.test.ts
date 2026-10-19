import test from "node:test";
import assert from "node:assert/strict";
import { projectPickerWhere, scopesProjectsByAssignment } from "./projectScope";

/**
 * The role gate and the picker predicate. The database read (`assignedProjectIdsFor`) is exercised
 * by the live probe, not here — this repo's suite opens no database on purpose.
 */

test("only the Project Manager role is scoped by assignment", () => {
  assert.equal(scopesProjectsByAssignment("PROJECT_MANAGER"), true);
  // Every other role reads what it read before. The gate is what makes a stray assignment row inert.
  for (const role of ["PM", "ADMIN", "COO", "HOD", "DEPT_HEAD", "SUPERVISOR", "EMPLOYEE", "HR", "FINANCE", "UNKNOWN", ""]) {
    assert.equal(scopesProjectsByAssignment(role), false, `${role} must not be project-scoped`);
  }
});

test("the picker predicate narrows for a manager and is a no-op for everyone else", () => {
  // null = "this role is not project-scoped" -> NO narrowing at all (the pre-existing behaviour for
  // every role that can already open these pickers).
  assert.deepEqual(projectPickerWhere(null), {});
  // An EMPTY assignment is a real zero-row filter, never `{}`: an unassigned manager must not be
  // handed the whole portfolio in a dropdown.
  assert.deepEqual(projectPickerWhere([]), { id: { in: [] } });
  assert.deepEqual(projectPickerWhere([3, 7]), { id: { in: [3, 7] } });
});

test("the picker predicate does not alias the caller's array", () => {
  const ids = [3, 7];
  const where = projectPickerWhere(ids) as { id: { in: number[] } };
  ids.push(9);
  assert.deepEqual(where.id.in, [3, 7], "a later mutation of the assignment list must not widen a live query");
});
