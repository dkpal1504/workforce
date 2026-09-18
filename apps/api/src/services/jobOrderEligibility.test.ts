import test from "node:test";
import assert from "node:assert/strict";
import {
  eligibleSlotJobOrders,
  isAssignableJobOrder,
  jobOrderMatchesSection,
  jobOrderOptionLabel,
  toSlotJobOrderOption,
  type SlotJobOrderSource,
} from "./jobOrderEligibility";

/** A bookable project Job Order, overridable per test. */
function jobOrder(overrides: Partial<SlotJobOrderSource> = {}): SlotJobOrderSource {
  return {
    id: 1,
    code: "1900000107",
    name: "Pipe Spool Installation",
    status: "active",
    projectId: 2,
    departmentId: 3,
    sectionId: 8,
    project: { active: true, name: "Project A", colorKey: "A" },
    department: { active: true },
    projectWbs: { wbsCode: "A.HULL.0010.100" },
    ...overrides,
  };
}

const selection = { departmentId: 3, projectId: 2, sectionId: 8 };

test("the picker label is Job_Order-Job_Description", () => {
  assert.equal(jobOrderOptionLabel({ code: "1900000107", name: "Pipe Spool Installation" }), "1900000107-Pipe Spool Installation");
});

test("assignability requires an active Job Order, Project and Department", () => {
  assert.equal(isAssignableJobOrder(jobOrder()), true);
  assert.equal(isAssignableJobOrder(jobOrder({ status: "inactive" })), false, "inactive Job Order");
  assert.equal(isAssignableJobOrder(jobOrder({ project: { active: false, name: "Project A", colorKey: "A" } })), false, "inactive Project");
  assert.equal(isAssignableJobOrder(jobOrder({ department: { active: false } })), false, "inactive Department");
  assert.equal(isAssignableJobOrder(jobOrder({ department: null })), false, "unmapped Department");
  assert.equal(isAssignableJobOrder(jobOrder({ project: null })), false, "missing Project");
});

test("a standing Job Order is offered for any section of its department", () => {
  assert.equal(jobOrderMatchesSection(null, 8), true);
  assert.equal(jobOrderMatchesSection(8, 8), true);
  assert.equal(jobOrderMatchesSection(9, 8), false, "another section of the same department");
});

test("the picker offers the department's own project Job Order", () => {
  const options = eligibleSlotJobOrders([jobOrder()], selection);
  assert.equal(options.length, 1);
  assert.deepEqual(options[0], {
    id: 1,
    code: "1900000107",
    name: "Pipe Spool Installation",
    label: "1900000107-Pipe Spool Installation",
    wbsNo: "A.HULL.0010.100",
    colorKey: "A",
    projectId: 2,
    projectName: "Project A",
    sectionId: 8,
    standing: false,
  });
});

test("a standing Job Order is offered for the selected section", () => {
  const standing = jobOrder({ id: 2, code: "1900000200", name: "Idle Hours", sectionId: null, projectWbs: null });
  const options = eligibleSlotJobOrders([standing], { ...selection, sectionId: 12 });
  assert.equal(options.length, 1);
  assert.equal(options[0].standing, true);
  assert.equal(options[0].sectionId, null);
  assert.equal(options[0].wbsNo, null);
  assert.equal(options[0].label, "1900000200-Idle Hours");
});

test("a project Job Order of another section of the same department is not offered", () => {
  assert.deepEqual(eligibleSlotJobOrders([jobOrder({ sectionId: 9 })], selection), []);
  assert.equal(eligibleSlotJobOrders([jobOrder({ sectionId: 9 })], { ...selection, sectionId: 9 }).length, 1);
});

test("another department and another project are never offered", () => {
  assert.deepEqual(eligibleSlotJobOrders([jobOrder({ departmentId: 4 })], selection), []);
  assert.deepEqual(eligibleSlotJobOrders([jobOrder({ projectId: 5, project: { active: true, name: "B", colorKey: "B" } })], selection), []);
});

test("inactive Job Orders, Projects and Departments are filtered out of the picker", () => {
  const rows = [
    jobOrder({ id: 1, code: "A" }),
    jobOrder({ id: 2, code: "B", status: "inactive" }),
    jobOrder({ id: 3, code: "C", project: { active: false, name: "Project A", colorKey: "A" } }),
    jobOrder({ id: 4, code: "D", department: { active: false } }),
  ];
  assert.deepEqual(eligibleSlotJobOrders(rows, selection).map((option) => option.code), ["A"]);
});

test("the picker is ordered by Job Order code", () => {
  const rows = [
    jobOrder({ id: 1, code: "1900000200" }),
    jobOrder({ id: 2, code: "1900000107" }),
    jobOrder({ id: 3, code: "1900000150" }),
  ];
  assert.deepEqual(eligibleSlotJobOrders(rows, selection).map((option) => option.code), [
    "1900000107",
    "1900000150",
    "1900000200",
  ]);
});

test("the WBS number is returned but the option never carries a Section for a standing row", () => {
  const option = toSlotJobOrderOption(jobOrder({ sectionId: null, projectWbs: { wbsCode: "A.GENERAL" } }));
  assert.equal(option.wbsNo, "A.GENERAL");
  assert.equal(option.standing, true);
});
