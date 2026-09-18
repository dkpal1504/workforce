import test from "node:test";
import assert from "node:assert/strict";

import {
  colorKeyError,
  colorKeyConflictMessage,
  exampleForUomCode,
  findColorKeyConflict,
  findNetworkCodeConflict,
  findProjectCodeConflict,
  findUomCodeConflict,
  findWbsCodeConflict,
  isUniqueConstraintError,
  isValidColorKey,
  jobOrderSectionError,
  jobOrderWbsMoveError,
  networkCodeConflictMessage,
  networkSourceForWrite,
  normalizeCode,
  prismaConflictMessage,
  projectCodeConflictMessage,
  referencedDeleteMessage,
  uomCodeConflictMessage,
  uomHelpText,
  uniqueConstraintFields,
  validateNetworkInput,
  validateProjectInput,
  validateUomInput,
  validateWbsInput,
  wbsCodeConflictMessage,
  NETWORK_SOURCE,
} from "./masterDataRules";

/* --- fixtures: the seed masters, without a database ---------------------- */

const projects = [
  { id: 1, code: "PRJ-A", name: "Project A", colorKey: "A" },
  { id: 2, code: "PRJ-B", name: "Project B", colorKey: "B" },
  { id: 5, code: "PRJ-N", name: "Non Project", colorKey: "N" },
];

const wbsRows = [
  { id: 10, projectId: 1, wbsCode: "A.HULL.0010.100", name: "Hull structure" },
  { id: 11, projectId: 1, wbsCode: "A.OUTF.0020.100", name: "Outfit" },
  { id: 12, projectId: 2, wbsCode: "A.HULL.0010.100", name: "Block 223" },
];

const uomRows = [
  { id: 1, code: "NOS", name: "Numbers", example: "Count of pieces, e.g. 12 spools" },
  { id: 2, code: "MT", name: "Metric Tonne", example: "Weight in tonnes, e.g. 4.5" },
];

const networks = [
  { id: 20, projectId: 1, code: "SAP-NW-91001", name: "Hull networks" },
  { id: 21, projectId: 2, code: "SAP-NW-91001", name: "Block 223 networks" },
];

/* --- colour key ---------------------------------------------------------- */

test("colour key accepts 1-4 uppercase alphanumeric characters", () => {
  for (const value of ["A", "B", "N", "B2", "AB", "ABCD"]) {
    assert.equal(isValidColorKey(value), true, `${value} should be valid`);
    assert.equal(colorKeyError(value), null);
  }
});

test("colour key is normalised to upper case before it is judged", () => {
  assert.equal(normalizeCode("a"), "A");
  assert.equal(isValidColorKey("  ab "), true);
  assert.equal(colorKeyError("  ab "), null);
});

test("colour key rejects more than four characters, spaces and symbols", () => {
  for (const value of ["ABCDE", "A-B", "A B", "A/B", "A.", "Ä", "1 2"]) {
    assert.equal(isValidColorKey(value), false, `${value} should be rejected`);
    assert.match(colorKeyError(value)!.message, /1-4 characters/);
  }
});

test("colour key is required", () => {
  const error = colorKeyError("");
  assert.equal(error?.field, "colorKey");
  assert.match(error!.message, /required/);
});

/* --- project payload ----------------------------------------------------- */

test("a valid project payload is normalised", () => {
  const result = validateProjectInput({ code: " prj-e ", name: "  Project   E ", colorKey: "e" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.data, {
    code: "PRJ-E",
    name: "Project E",
    colorKey: "E",
    isNonProject: false,
    sortOrder: 0,
  });
});

test("a project name is required", () => {
  const result = validateProjectInput({ code: "PRJ-E", name: "   ", colorKey: "E" });
  assert.equal(result.ok, false);
  assert.deepEqual(result.ok ? [] : result.errors.map((error) => error.field), ["name"]);
});

test("a project code may not contain a space", () => {
  const result = validateProjectInput({ code: "PRJ E", name: "Project E", colorKey: "E" });
  assert.equal(result.ok, false);
  assert.deepEqual(result.ok ? [] : result.errors.map((error) => error.field), ["code"]);
});

test("an invalid colour key fails project validation", () => {
  const result = validateProjectInput({ code: "PRJ-E", name: "Project E", colorKey: "ABCDE" });
  assert.equal(result.ok, false);
  assert.deepEqual(result.ok ? [] : result.errors.map((error) => error.field), ["colorKey"]);
});

test("sort order must be a whole number of 0 or more", () => {
  const negative = validateProjectInput({ code: "PRJ-E", name: "Project E", colorKey: "E", sortOrder: "-1" });
  assert.equal(negative.ok, false);
  assert.deepEqual(negative.ok ? [] : negative.errors.map((error) => error.field), ["sortOrder"]);

  const accepted = validateProjectInput({ code: "PRJ-E", name: "Project E", colorKey: "E", sortOrder: "7" });
  assert.equal(accepted.ok && accepted.data.sortOrder, 7);
});

test("the non-project flag must be a boolean", () => {
  const bad = validateProjectInput({ code: "PRJ-N", name: "Non Project", colorKey: "N", isNonProject: "yes" });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.ok ? [] : bad.errors.map((error) => error.field), ["isNonProject"]);

  const good = validateProjectInput({ code: "PRJ-N", name: "Non Project", colorKey: "N", isNonProject: "true" });
  assert.equal(good.ok && good.data.isNonProject, true);
});

/* --- duplicates ---------------------------------------------------------- */

test("project code duplicates are found case-insensitively and may exclude the edited row", () => {
  assert.equal(findProjectCodeConflict(projects, "prj-a")?.id, 1);
  assert.equal(findProjectCodeConflict(projects, "PRJ-Z"), null);
  assert.equal(findProjectCodeConflict(projects, "PRJ-A", 1), null, "editing project 1 keeps its own code");
});

test("colour keys are unique across all projects", () => {
  assert.equal(findColorKeyConflict(projects, "b")?.id, 2);
  assert.equal(findColorKeyConflict(projects, "N")?.id, 5);
  assert.equal(findColorKeyConflict(projects, "B", 2), null);
  assert.equal(findColorKeyConflict(projects, "Q"), null);
});

test("a WBS code is unique inside one project only", () => {
  assert.equal(findWbsCodeConflict(wbsRows, 1, "a.hull.0010.100")?.id, 10);
  assert.equal(findWbsCodeConflict(wbsRows, 2, "A.HULL.0010.100")?.id, 12, "the same code exists in project 2");
  assert.equal(findWbsCodeConflict(wbsRows, 1, "A.HULL.0010.100", 10), null);
  assert.equal(findWbsCodeConflict(wbsRows, 3, "A.HULL.0010.100"), null, "a third project is free");
});

test("UoM codes are unique globally", () => {
  assert.equal(findUomCodeConflict(uomRows, "nos")?.id, 1);
  assert.equal(findUomCodeConflict(uomRows, "NOS", 1), null);
  assert.equal(findUomCodeConflict(uomRows, "SQM"), null);
});

test("network codes are unique inside one project", () => {
  assert.equal(findNetworkCodeConflict(networks, 1, "sap-nw-91001")?.id, 20);
  assert.equal(findNetworkCodeConflict(networks, 1, "SAP-NW-91001", 20), null);
  assert.equal(findNetworkCodeConflict(networks, 3, "SAP-NW-91001"), null);
});

test("every conflict message names the row it collided with", () => {
  assert.match(projectCodeConflictMessage(projects[0]), /PRJ-A.*Project A.*#1/);
  assert.match(colorKeyConflictMessage(projects[1]), /"B".*Project B.*#2/);
  assert.match(wbsCodeConflictMessage(wbsRows[0], projects[0]), /A\.HULL\.0010\.100.*Project A.*PRJ-A.*#10/);
  assert.match(uomCodeConflictMessage(uomRows[0]), /NOS.*Numbers.*#1/);
  assert.match(networkCodeConflictMessage(networks[0], projects[0]), /SAP-NW-91001.*Project A.*PRJ-A.*#20/);
});

test("a referenced row may not be deleted", () => {
  const message = referencedDeleteMessage('Project "Project A" (PRJ-A)', [
    { what: "WBS rows", count: 2 },
    { what: "Job Orders", count: 0 },
    { what: "timesheet rows", count: 14 },
  ]);
  assert.match(message, /2 WBS rows and 14 timesheet rows/);
  assert.match(message, /Deactivate it instead/);
  assert.doesNotMatch(message, /Job Orders/);
});

/* --- WBS / UoM / Network payloads --------------------------------------- */

test("a WBS code is normalised and its name is optional", () => {
  const result = validateWbsInput({ wbsCode: " a.hull.0010.100 " });
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.data, { wbsCode: "A.HULL.0010.100", name: null, sortOrder: 0 });
});

test("a WBS code is required and may not contain a space", () => {
  assert.equal(validateWbsInput({ wbsCode: "" }).ok, false);
  assert.equal(validateWbsInput({ wbsCode: "A HULL" }).ok, false);
  assert.equal(validateWbsInput({ wbsCode: "A.HULL.0010.100", name: "Hull structure", sortOrder: 2 }).ok, true);
});

test("a UoM row carries its on-screen help string", () => {
  const result = validateUomInput({ code: " sqm ", name: "Square   Metre", example: " Painted area, e.g. 320 " });
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.data, { code: "SQM", name: "Square Metre", example: "Painted area, e.g. 320" });
});

test("a UoM code and name are required and the example is optional", () => {
  const missingName = validateUomInput({ code: "SQM" });
  assert.equal(missingName.ok, false);
  assert.deepEqual(missingName.ok ? [] : missingName.errors.map((error) => error.field), ["name"]);

  const noExample = validateUomInput({ code: "sqm", name: "Square Metre" });
  assert.equal(noExample.ok && noExample.data.example, null);
});

test("the UoM help text is taken from the example of the master row", () => {
  assert.equal(exampleForUomCode(uomRows, "nos"), "Count of pieces, e.g. 12 spools");
  assert.equal(uomHelpText(uomRows, "NOS"), "Example: NOS — Count of pieces, e.g. 12 spools");
  assert.equal(uomHelpText(uomRows, "SQM"), "Example: SQM", "a code without an example still shows its code");
});

test("a manually created network is always MANUAL", () => {
  const result = validateNetworkInput({ code: " sap-nw-91001 ", name: "Hull networks", source: "SAP" });
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.data.source, NETWORK_SOURCE);
  assert.equal(result.ok && result.data.code, "SAP-NW-91001");
  assert.equal(networkSourceForWrite("SAP"), NETWORK_SOURCE);
  assert.equal(networkSourceForWrite(undefined), "MANUAL");
});

/* --- the database races -------------------------------------------------- */

test("a P2002 error is recognised and its target fields are normalised", () => {
  const postgres = { code: "P2002", meta: { target: ["project_id", "wbs_code"] } };
  const sqlite = { code: "P2002", meta: { target: "fields: (`project_id`,`wbs_code`)" } };
  assert.equal(isUniqueConstraintError(postgres), true);
  assert.equal(isUniqueConstraintError(new Error("boom")), false);
  assert.deepEqual(uniqueConstraintFields(postgres), ["project_id", "wbs_code"]);
  assert.deepEqual(uniqueConstraintFields(sqlite), ["fields", "project_id", "wbs_code"]);
});

test("a raced duplicate becomes a friendly conflict message, never a raw Prisma error", () => {
  assert.match(String(prismaConflictMessage({ code: "P2002", meta: { target: ["project_id", "wbs_code"] } }, "project_wbs")), /unique inside one project/);
  assert.match(String(prismaConflictMessage({ code: "P2002", meta: { target: ["color_key"] } }, "project")), /colour key/i);
  assert.match(String(prismaConflictMessage({ code: "P2002", meta: { target: ["code"] } }, "project")), /project code/i);
  assert.match(String(prismaConflictMessage({ code: "P2002" }, "uom")), /UoM code/);
  assert.match(String(prismaConflictMessage({ code: "P2002" }, "network")), /Network code/);
  assert.equal(prismaConflictMessage(new Error("connection lost"), "project"), null, "an ordinary failure stays a 500");
});

/* --- Job Order placement ------------------------------------------------- */

test("a Job Order with booked hours may not move to another WBS", () => {
  const keepSame = jobOrderWbsMoveError({ jobOrderCode: "1900000107", currentWbsId: 10, targetWbsId: 10, bookedTimesheetEntries: 12, bookedAllocationSlots: 3 });
  assert.equal(keepSame, null);

  const cleanMove = jobOrderWbsMoveError({ jobOrderCode: "1900000107", currentWbsId: 10, targetWbsId: 11, bookedTimesheetEntries: 0, bookedAllocationSlots: 0 });
  assert.equal(cleanMove, null);

  const blocked = jobOrderWbsMoveError({ jobOrderCode: "1900000107", currentWbsId: 10, targetWbsId: 11, bookedTimesheetEntries: 2, bookedAllocationSlots: 1 });
  assert.match(String(blocked), /1900000107/);
  assert.match(String(blocked), /cannot move to another WBS/);
  assert.match(String(blocked), /2 timesheet rows, 1 allocation hours/);
});

test("only a standing / Non-Project Job Order may have no Section", () => {
  assert.equal(jobOrderSectionError({ isNonProject: false, sectionId: 4 }), null);
  assert.equal(jobOrderSectionError({ isNonProject: true, sectionId: null }), null);
  assert.match(String(jobOrderSectionError({ isNonProject: false, sectionId: null })), /Section is required/);
});
