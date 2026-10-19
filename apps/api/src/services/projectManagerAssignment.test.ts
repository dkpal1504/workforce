import test from "node:test";
import assert from "node:assert/strict";
import { planAssignment, planRevocation } from "./projectManagerAssignment";

const project = { id: 1, code: "CSR.013", name: "MV AINA", active: true };
const inactiveProject = { ...project, active: false };
const manager = { id: 42, name: "A. Manager", role: "PROJECT_MANAGER", active: true };

test("a fresh pair is created, and a revoked pair is REUSED rather than duplicated", () => {
  assert.deepEqual(
    planAssignment({ project, user: manager, existing: null }),
    { ok: true, action: "create", projectId: 1, userId: 42 }
  );
  assert.deepEqual(
    planAssignment({ project, user: manager, existing: { id: 7, status: "revoked" } }),
    { ok: true, action: "reactivate", projectId: 1, userId: 42 },
    "the unique pair IS the history line: re-assigning rewrites its status"
  );
});

test("an active assignment is a conflict, never a silent second row", () => {
  const plan = planAssignment({ project, user: manager, existing: { id: 7, status: "active" } });
  assert.equal(plan.ok, false);
  if (plan.ok) return;
  assert.equal(plan.code, "ALREADY_ASSIGNED");
  assert.match(plan.error, /already manages/);
});

test("the target project must exist and be active", () => {
  const missing = planAssignment({ project: null, user: manager, existing: null });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.code, "PROJECT_NOT_FOUND");

  const inactive = planAssignment({ project: inactiveProject, user: manager, existing: null });
  assert.equal(inactive.ok, false);
  if (!inactive.ok) {
    assert.equal(inactive.code, "PROJECT_INACTIVE");
    // The refusal has to say WHY it matters: the row would read as access and grant an empty screen.
    assert.match(inactive.error, /inactive/);
  }
});

test("the account must exist, be active, and actually hold the PROJECT_MANAGER role", () => {
  const missing = planAssignment({ project, user: null, existing: null });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.code, "USER_NOT_FOUND");

  const inactive = planAssignment({ project, user: { ...manager, active: false }, existing: null });
  assert.equal(inactive.ok, false);
  if (!inactive.ok) assert.equal(inactive.code, "ACCOUNT_INACTIVE");

  const wrongRole = planAssignment({ project, user: { ...manager, role: "HOD" }, existing: null });
  assert.equal(wrongRole.ok, false);
  if (!wrongRole.ok) {
    assert.equal(wrongRole.code, "ROLE_NOT_PROJECT_MANAGER");
    // An assignment on an HOD is inert (the scope rule consults it only for PROJECT_MANAGER), so
    // the refusal names the step that would actually grant the access.
    assert.match(wrongRole.error, /Role Assignment/);
    assert.match(wrongRole.error, /HOD/);
  }
});

test("revocation is planned, and a double revoke gets a sentence not a second audit row", () => {
  assert.deepEqual(planRevocation({ id: 7, status: "active" }), { ok: true });
  const already = planRevocation({ id: 7, status: "revoked" });
  assert.equal(already.ok, false);
  if (!already.ok) assert.equal(already.code, "ALREADY_REVOKED");
  const missing = planRevocation(null);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.code, "ASSIGNMENT_NOT_FOUND");
});
