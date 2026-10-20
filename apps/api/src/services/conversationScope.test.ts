import test from "node:test";
import assert from "node:assert/strict";
import { jobOrderScopeWhere, mayPostKind, maySeeJobOrder, type ConversationScope } from "./conversationScope";

/**
 * Who may see a Job Order, and who may say what. Pure, and the pure part is the contract: the router
 * does nothing but call these and then read the database.
 */

const jobOrder = { projectId: 7, departmentId: 3, sectionId: 11 };

test("ORGANISATION sees every Job Order", () => {
  assert.equal(maySeeJobOrder({ kind: "ORGANISATION" }, jobOrder), true);
  assert.equal(maySeeJobOrder({ kind: "ORGANISATION" }, { ...jobOrder, departmentId: 99 }), true);
});

test("an unassigned Project Manager sees nothing", () => {
  const none: ConversationScope = { kind: "NONE" };
  assert.equal(maySeeJobOrder(none, jobOrder), false);
});

test("a Project Manager sees only its assigned projects", () => {
  const scope: ConversationScope = { kind: "PROJECTS", projectIds: [7, 8] };
  assert.equal(maySeeJobOrder(scope, jobOrder), true);
  assert.equal(maySeeJobOrder(scope, { ...jobOrder, projectId: 9 }), false);
});

test("a Department HOD is bounded by the department first", () => {
  const scope: ConversationScope = { kind: "DEPARTMENT", departmentId: 3, sectionIds: [] };
  assert.equal(maySeeJobOrder(scope, jobOrder), true);
  assert.equal(maySeeJobOrder(scope, { ...jobOrder, departmentId: 4 }), false);
});

test("a Section Head reads its own sections and standing work, not a sibling section", () => {
  const scope: ConversationScope = { kind: "DEPARTMENT", departmentId: 3, sectionIds: [11] };
  assert.equal(maySeeJobOrder(scope, jobOrder), true);
  assert.equal(maySeeJobOrder(scope, { ...jobOrder, sectionId: 12 }), false);
  // Standing work carries no section: every HOD of the department may read it.
  assert.equal(maySeeJobOrder(scope, { ...jobOrder, sectionId: null }), true);
});

test("the scope predicates fail closed", () => {
  assert.deepEqual(jobOrderScopeWhere({ kind: "NONE" }), { id: -1 });
  assert.deepEqual(jobOrderScopeWhere({ kind: "PROJECTS", projectIds: [1, 2] }), { projectId: { in: [1, 2] } });
  assert.deepEqual(jobOrderScopeWhere({ kind: "DEPARTMENT", departmentId: 3, sectionIds: [] }), { departmentId: 3 });
  assert.deepEqual(jobOrderScopeWhere({ kind: "ORGANISATION" }), {});
});

test("DECISION is limited to the two roles that may edit Project Master", () => {
  assert.equal(mayPostKind("PM", "DECISION"), true);
  assert.equal(mayPostKind("ADMIN", "DECISION"), true);
  assert.equal(mayPostKind("HOD", "DECISION"), false);
  assert.equal(mayPostKind("PROJECT_MANAGER", "DECISION"), false);
  assert.equal(mayPostKind("COO", "DECISION"), false);
});

test("every admitted role may follow up, instruct, escalate and reply", () => {
  for (const role of ["PROJECT_MANAGER", "PM", "HOD", "DEPT_HEAD", "COO", "ADMIN"]) {
    for (const kind of ["FOLLOW_UP", "INSTRUCTION", "ESCALATION", "REPLY"]) {
      assert.equal(mayPostKind(role, kind), true, `${role} ${kind}`);
    }
  }
});

test("a role outside the feature may post nothing, and SYSTEM is never a user kind", () => {
  for (const role of ["EMPLOYEE", "SUPERVISOR", "HR", "FINANCE"]) {
    assert.equal(mayPostKind(role, "REPLY"), false, role);
  }
  assert.equal(mayPostKind("PM", "SYSTEM"), false);
});
