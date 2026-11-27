import test from "node:test";
import assert from "node:assert/strict";
import { departmentIdentity, departmentIdentityColumns, departmentSortKey } from "./departmentIdentity";

/**
 * WHY THESE TESTS EXIST: the plant/function split is derived from a NAME that the BadgeView sync
 * generates, and every future report groups by it. A parser that quietly treats "Production - Hull and
 * Febrication - SEZ" as function "Production" would merge five different production departments into one
 * line, and nothing on the screen would look wrong.
 */

test("a trailing plant token is the facility, everything before it is the function", () => {
  assert.deepEqual(departmentIdentity("Yardservice - EOU"), { businessUnit: "EOU", functionGroup: "Yardservice" });
  assert.deepEqual(departmentIdentity("Yardservice - SEZ"), { businessUnit: "SEZ", functionGroup: "Yardservice" });
  assert.deepEqual(departmentIdentity("Safety - SEZ"), { businessUnit: "SEZ", functionGroup: "Safety" });
  assert.deepEqual(departmentIdentity("Civil - EOU"), { businessUnit: "EOU", functionGroup: "Civil" });
  assert.deepEqual(departmentIdentity("Health & Wellness - EOU"), { businessUnit: "EOU", functionGroup: "Health & Wellness" });
  assert.deepEqual(departmentIdentity("Administration - SEZ"), { businessUnit: "SEZ", functionGroup: "Administration" });
});

test("hyphens INSIDE the function are kept — only the last token is the facility", () => {
  assert.deepEqual(departmentIdentity("Training Center - BCS - SEZ"), {
    businessUnit: "SEZ",
    functionGroup: "Training Center - BCS",
  });
  assert.deepEqual(departmentIdentity("Production - Hull and Febrication - SEZ"), {
    businessUnit: "SEZ",
    functionGroup: "Production - Hull and Febrication",
  });
  assert.deepEqual(departmentIdentity("Shipwright - Blasting & Painting - EOU"), {
    businessUnit: "EOU",
    functionGroup: "Shipwright - Blasting & Painting",
  });
  // Two production departments must NOT collapse into one function.
  assert.notEqual(
    departmentIdentity("Production - Piping - EOU").functionGroup,
    departmentIdentity("Production - Mechanical - EOU").functionGroup
  );
});

test("a name with no plant suffix keeps the whole name as its function and has no plant", () => {
  assert.deepEqual(departmentIdentity("Fabrication Shop"), { businessUnit: null, functionGroup: "Fabrication Shop" });
  assert.deepEqual(departmentIdentity("Information and Technology - EOU"), {
    businessUnit: "EOU",
    functionGroup: "Information and Technology",
  });
});

test("whitespace and case are tolerated, and a bare suffix never yields an empty function", () => {
  assert.deepEqual(departmentIdentity("  yardservice   -   sez "), { businessUnit: "SEZ", functionGroup: "yardservice" });
  assert.deepEqual(departmentIdentity("Safety-EOU"), { businessUnit: "EOU", functionGroup: "Safety" });
  assert.deepEqual(departmentIdentity(" - EOU"), { businessUnit: "EOU", functionGroup: " - EOU".trim() });
  assert.deepEqual(departmentIdentity(""), { businessUnit: null, functionGroup: "" });
});

test("insert columns and the grouping sort key follow the same derivation", () => {
  assert.deepEqual(departmentIdentityColumns("QA/QC - SEZ"), { businessUnit: "SEZ", functionGroup: "QA/QC" });
  // EOU sorts before SEZ before "no plant" inside one function, so the two plants of a function are adjacent.
  const keys = [
    departmentSortKey({ functionGroup: "Safety", businessUnit: "SEZ" }),
    departmentSortKey({ functionGroup: "Safety", businessUnit: "EOU" }),
    departmentSortKey({ functionGroup: "Safety", businessUnit: null }),
    departmentSortKey({ functionGroup: "Administration", businessUnit: "EOU" }),
  ];
  assert.deepEqual(keys.slice().sort(), [keys[3], keys[1], keys[0], keys[2]]);
});
