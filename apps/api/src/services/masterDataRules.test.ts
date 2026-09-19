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
  jobOrderNetworkWbsError,
  jobOrderSectionError,
  jobOrderWbsMoveError,
  networkCodeConflictMessage,
  networkSourceForWrite,
  normalizeCode,
  prismaConflictMessage,
  projectCodeConflictMessage,
  referencedDeleteMessage,
  resolveNetworkWbs,
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
  { id: 10, projectId: 1, wbsCode: "A.HULL.0010.100", name: "Hull structure", active: true },
  { id: 11, projectId: 1, wbsCode: "A.OUTF.0020.100", name: "Outfit", active: true },
  { id: 12, projectId: 2, wbsCode: "A.HULL.0010.100", name: "Block 223", active: true },
  { id: 13, projectId: 1, wbsCode: "A.OUTF.0030.100", name: "Retired outfit", active: false },
  { id: 14, projectId: 2, wbsCode: "B.OUTF.0020.150", name: "Block 224", active: true },
];

const uomRows = [
  { id: 1, code: "NOS", name: "Numbers", example: "Count of pieces, e.g. 12 spools" },
  { id: 2, code: "MT", name: "Metric Tonne", example: "Weight in tonnes, e.g. 4.5" },
];

const networks = [
  { id: 20, projectId: 1, code: "SAP-NW-91001", name: "Hull networks", wbsId: 10 },
  { id: 21, projectId: 2, code: "SAP-NW-91001", name: "Block 223 networks", wbsId: 12 },
  { id: 22, projectId: 1, code: "SAP-NW-91002", name: "Outfit networks", wbsId: 11 },
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
  const result = validateNetworkInput({ wbsId: 10, code: " sap-nw-91001 ", name: "Hull networks", source: "SAP" });
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.data.source, NETWORK_SOURCE);
  assert.equal(result.ok && result.data.code, "SAP-NW-91001");
  assert.equal(result.ok && result.data.wbsId, 10);
  assert.equal(networkSourceForWrite("SAP"), NETWORK_SOURCE);
  assert.equal(networkSourceForWrite(undefined), "MANUAL");
});

/* --- a Network belongs to ONE WBS element --------------------------------- */

test("a Network payload requires a WBS row", () => {
  for (const missing of [undefined, null, "", "abc", 0, -3]) {
    const result = validateNetworkInput({ wbsId: missing, code: "NET-A1", name: "Hull networks" });
    assert.equal(result.ok, false, `${String(missing)} should be refused`);
    assert.deepEqual(result.ok ? [] : result.errors.map((error) => error.field), ["wbsId"]);
    assert.match(result.ok ? "" : result.errors[0].message, /WBS row is required/);
  }
  const result = validateNetworkInput({ wbsId: "11", code: "NET-A2" });
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.data.wbsId, 11, "a numeric string is accepted");
});

test("a Network WBS must belong to the same project", () => {
  const other = resolveNetworkWbs(wbsRows, projects[0], 14);
  assert.equal(other.ok, false);
  assert.equal(other.ok ? "" : other.error.field, "wbsId");
  assert.match(other.ok ? "" : other.error.message, /B\.OUTF\.0020\.150/);
  assert.match(other.ok ? "" : other.error.message, /belongs to project #2, not to project "Project A" \(PRJ-A\)/);

  // With the owning project's code on the row, the refusal names that project too.
  const named = resolveNetworkWbs([{ ...wbsRows[4], projectCode: "PRJ-B", projectName: "Project B" }], projects[0], 14);
  assert.equal(named.ok, false);
  assert.match(named.ok ? "" : named.error.message, /belongs to project "Project B" \(PRJ-B\)/);
  assert.match(named.ok ? "" : named.error.message, /pick a WBS of PRJ-A/);
});

test("a WBS of the project and active is accepted as the parent of a Network", () => {
  const ok = resolveNetworkWbs(wbsRows, projects[0], 11);
  assert.equal(ok.ok, true);
  assert.equal(ok.ok && ok.wbs.wbsCode, "A.OUTF.0020.100");
});

test("a missing WBS row is refused and named", () => {
  const missing = resolveNetworkWbs(wbsRows, projects[0], 999);
  assert.equal(missing.ok, false);
  assert.match(missing.ok ? "" : missing.error.message, /WBS row #999 was not found/);
});

test("an inactive WBS row cannot own a Network", () => {
  const inactive = resolveNetworkWbs(wbsRows, projects[0], 13);
  assert.equal(inactive.ok, false);
  assert.match(inactive.ok ? "" : inactive.error.message, /A\.OUTF\.0030\.100.*is inactive/);
  assert.match(inactive.ok ? "" : inactive.error.message, /Pick an active WBS row/);
});

test("a Job Order Network must belong to the WBS the Job Order is mapped to", () => {
  const sameWbs = jobOrderNetworkWbsError({
    jobOrderCode: "1900000107", networkCode: "SAP-NW-91001",
    networkWbsId: 10, networkWbsCode: "A.HULL.0010.100",
    targetWbsId: 10, targetWbsCode: "A.HULL.0010.100",
  });
  assert.equal(sameWbs, null, "a Network on the Job Order's own WBS is fine");

  const mismatch = jobOrderNetworkWbsError({
    jobOrderCode: "1900000107", networkCode: "SAP-NW-91002",
    networkWbsId: 11, networkWbsCode: "A.OUTF.0020.100",
    targetWbsId: 10, targetWbsCode: "A.HULL.0010.100",
  });
  assert.match(String(mismatch), /SAP-NW-91002/);
  assert.match(String(mismatch), /belongs to WBS "A\.OUTF\.0020\.100"/, "names the WBS the Network belongs to");
  assert.match(String(mismatch), /1900000107" is on \(or would move to\) WBS "A\.HULL\.0010\.100"/, "names the WBS the Job Order is on, or would move to");
  assert.match(String(mismatch), /Pick another Network/);
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
