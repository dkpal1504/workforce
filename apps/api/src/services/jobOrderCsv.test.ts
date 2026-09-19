/**
 * Job Order CSV import rules. Every test injects the master-data snapshot, so the
 * suite needs no database and no server.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  JOB_ORDER_CSV_HEADERS,
  PENDING_MASTER_ID,
  checkJobOrderHeader,
  normalizeDepartmentKey,
  parseJobOrderStatus,
  parseNonNegativeNumber,
  planJobOrderImport,
  projectScopedKey,
  resolveNetworkForRow,
  resolveWbsForRow,
  type JobOrderCsvHeader,
  type JobOrderImportMasters,
  type JobOrderImportOptions,
  type JobOrderRowIssue,
  type PendingNetworkScope,
  type WbsRef,
} from "./jobOrderCsv";

/**
 * A fully valid row. Master data. A Network belongs to ONE WBS of its project, so
 * the snapshot carries each Network's `wbsId`:
 *   PRJ-A  Project A      WBS A.HULL.0010.100 (NET-A1, NET-A2) / A.HULL.0011.100 (NET-A3)
 *   PRJ-B  Project B      WBS B.HULL.0020.150,                   network NET-B1
 *   PRJ-N  Non Project    WBS N.GEN.0000.000,                    network STANDING
 *   BuName - Workmen Division : Hull Production, Pipe Shop
 *   Fabrication - EOU         : Fabrication Shop
 */
const VALID_ROW: Record<JobOrderCsvHeader, string> = {
  Project_ID: "PRJ-A",
  Project_Name: "Project A",
  WBS_NO: "A.HULL.0010.100",
  Network_ID: "NET-A1",
  Job_Order: "1900000107",
  Job_Description: "Pipe Spool Installation",
  UoM: "NOS",
  Qty: "120",
  Budgeted_hours: "3500",
  Department: "BuName - Workmen Division",
  Section: "Hull Production",
  Job_Order_Status: "Active",
};

const MASTERS: JobOrderImportMasters = {
  departments: [
    { id: 1, name: "BuName - Workmen Division", active: true },
    { id: 2, name: "Fabrication - EOU", active: true },
    { id: 3, name: "Closed Division", active: false },
  ],
  sections: [
    { id: 10, departmentId: 1, name: "Hull Production", active: true },
    { id: 11, departmentId: 1, name: "Pipe Shop", active: true },
    { id: 12, departmentId: 2, name: "Fabrication Shop", active: true },
    { id: 13, departmentId: 2, name: "Retired Shop", active: false },
  ],
  projects: [
    { id: 1, code: "PRJ-A", name: "Project A", isNonProject: false, active: true },
    { id: 2, code: "PRJ-B", name: "Project B", isNonProject: false, active: true },
    { id: 9, code: "PRJ-N", name: "Non Project", isNonProject: true, active: true },
  ],
  wbsRows: [
    { id: 100, projectId: 1, wbsCode: "A.HULL.0010.100", active: true },
    { id: 101, projectId: 1, wbsCode: "A.HULL.0011.100", active: true },
    { id: 102, projectId: 2, wbsCode: "B.HULL.0020.150", active: true },
    { id: 900, projectId: 9, wbsCode: "N.GEN.0000.000", active: true },
  ],
  networks: [
    // A Network is scoped to a WBS of its project, never to the project alone.
    { id: 200, projectId: 1, wbsId: 100, code: "NET-A1", active: true },
    { id: 202, projectId: 1, wbsId: 100, code: "NET-A2", active: false },
    { id: 203, projectId: 1, wbsId: 101, code: "NET-A3", active: true },
    { id: 201, projectId: 2, wbsId: 102, code: "NET-B1", active: true },
    { id: 900, projectId: 9, wbsId: 900, code: "STANDING", active: true },
  ],
  uoms: [
    { id: 300, code: "NOS", active: true },
    { id: 301, code: "MTR", active: true },
    { id: 302, code: "KGS", active: false },
  ],
  existingJobOrders: [
    // The exact Project + WBS + Job Order triple (the duplicate rule).
    { id: 400, projectId: 1, code: "1900000107", wbsCode: "A.HULL.0010.100" },
    // The same Job Order number in the project under a DIFFERENT WBS (the skip case).
    { id: 401, projectId: 1, code: "1900000110", wbsCode: "A.HULL.0011.100" },
  ],
};

/**
 * The strict behaviour the module had before master auto-creation existed: a row
 * naming a missing WBS or Network is refused, with the old message. It is what
 * `{ createMissingMasters: false }` on an upload restores, and the tests that pin
 * those messages pass it explicitly.
 */
const STRICT: JobOrderImportOptions = { createMissingMasters: false };

function rowCells(overrides: Partial<Record<JobOrderCsvHeader, string>> = {}): string[] {
  const values = { ...VALID_ROW, ...overrides };
  return JOB_ORDER_CSV_HEADERS.map((header) => values[header]);
}

function file(...dataRows: string[][]): string[][] {
  return [[...JOB_ORDER_CSV_HEADERS], ...dataRows];
}

function rowOf(issues: JobOrderRowIssue[], rowNumber: number): JobOrderRowIssue[] {
  return issues.filter((issue) => issue.row === rowNumber);
}

// ------------------------------------------------------------------ header

test("the header must match the contract order exactly", () => {
  assert.equal(checkJobOrderHeader([...JOB_ORDER_CSV_HEADERS]).ok, true);
  assert.equal(
    checkJobOrderHeader([" project_id ", "PROJECT_NAME", "wbs_no", "network_id", "job_order", "job_description", "uom", "qty", "budgeted_hours", "department", "section", "job_order_status"]).ok,
    true,
    "case and surrounding whitespace are tolerated"
  );
  assert.equal(JOB_ORDER_CSV_HEADERS.join(","), "Project_ID,Project_Name,WBS_NO,Network_ID,Job_Order,Job_Description,UoM,Qty,Budgeted_hours,Department,Section,Job_Order_Status");
});

test("a reordered, renamed, missing or extra header column is rejected with the expected list", () => {
  const swapped: string[] = [...JOB_ORDER_CSV_HEADERS];
  swapped[2] = "WBS";
  const renamed = checkJobOrderHeader(swapped);
  assert.equal(renamed.ok, false);
  if (renamed.ok) return;
  assert.match(renamed.error, /column 3 is 'WBS'; 'WBS_NO' was expected/);
  assert.match(renamed.error, /Expected, in this order: Project_ID, Project_Name, WBS_NO, Network_ID, Job_Order, Job_Description, UoM, Qty, Budgeted_hours, Department, Section, Job_Order_Status\./);

  const reordered = checkJobOrderHeader(["Project_Name", ...JOB_ORDER_CSV_HEADERS.filter((header) => header !== "Project_Name")]);
  assert.equal(reordered.ok, false, "Project_Name first is a different order, not a different column set");

  const short = checkJobOrderHeader(JOB_ORDER_CSV_HEADERS.slice(0, 6));
  assert.equal(short.ok, false);
  if (!short.ok) assert.match(short.error, /column\(s\) missing at the end: UoM, Qty, Budgeted_hours, Department, Section, Job_Order_Status\./);

  const extra = checkJobOrderHeader([...JOB_ORDER_CSV_HEADERS, "Remarks"]);
  assert.equal(extra.ok, false);
  if (!extra.ok) assert.match(extra.error, /1 extra column\(s\) after 'Job_Order_Status'\./);
});

// ------------------------------------------------------- master resolution

test("a fully valid multi-row file is planned completely", () => {
  const plan = planJobOrderImport(file(
    rowCells({ Job_Order: "1900000200" }),
    rowCells({ Project_ID: "PRJ-B", Project_Name: "Project B", WBS_NO: "B.HULL.0020.150", Network_ID: "NET-B1", Job_Order: "1900000200", UoM: "MTR", Qty: "45.5", Budgeted_hours: "0" }),
    rowCells({ Project_ID: "PRJ-N", Project_Name: "Non Project", WBS_NO: "N.GEN.0000.000", Network_ID: "STANDING", Job_Order: "1900000401", Job_Description: "Standing / Idle hours", Section: "", Job_Order_Status: "In-Active" })
  ), MASTERS);

  assert.deepEqual({ total: plan.total, created: plan.created, skipped: plan.skipped, rejected: plan.rejected }, { total: 3, created: 3, skipped: 0, rejected: 0 });
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.skippedRows, []);
  assert.deepEqual(plan.create[0], {
    row: 2,
    projectId: 1,
    projectCode: "PRJ-A",
    projectName: "Project A",
    projectWbsId: 100,
    wbsCode: "A.HULL.0010.100",
    networkId: 200,
    networkCode: "NET-A1",
    code: "1900000200",
    name: "Pipe Spool Installation",
    uomId: 300,
    uomCode: "NOS",
    budgetedQuantity: 120,
    budgetedHours: 3500,
    departmentId: 1,
    departmentName: "BuName - Workmen Division",
    sectionId: 10,
    sectionName: "Hull Production",
    status: "active",
  });
  // The same Job Order number in another project is legal.
  assert.equal(plan.create[1].code, "1900000200");
  assert.equal(plan.create[1].projectId, 2);
  assert.equal(plan.create[1].uomId, 301);
  assert.equal(plan.create[1].budgetedQuantity, 45.5);
  // The standing row carries no section and stores the In-Active status.
  assert.equal(plan.create[2].projectWbsId, 900);
  assert.equal(plan.create[2].sectionId, null);
  assert.equal(plan.create[2].sectionName, null);
  assert.equal(plan.create[2].status, "inactive");
});

test("an unknown Project is rejected and never created", () => {
  const plan = planJobOrderImport(file(rowCells({ Project_ID: "PRJ-Z", Project_Name: "Project Z" })), MASTERS);
  assert.equal(plan.rejected, 1);
  assert.equal(plan.created, 0);
  const [issue] = rowOf(plan.errors, 2);
  assert.equal(issue.column, "Project_ID");
  assert.match(issue.message, /unknown Project_ID 'PRJ-Z'/);
  assert.match(issue.message, /never creates a Project/);
  assert.match(issue.message, /colour key/, "the message says why a Project cannot be created from the upload");
  assert.deepEqual(plan.wbsToCreate, [], "a Project that cannot be resolved creates nothing");
  assert.deepEqual(plan.networksToCreate, []);
});

test("Project_Name must match the Project_ID that was given", () => {
  const plan = planJobOrderImport(file(rowCells({ Project_Name: "Project B" })), MASTERS);
  assert.equal(plan.rejected, 1);
  const [issue] = rowOf(plan.errors, 2);
  assert.equal(issue.column, "Project_Name");
  assert.match(issue.message, /Project_Name 'Project B' does not match Project_ID 'PRJ-A' \(master name 'Project A'\)/);
});

test("with auto-creation off, an unknown WBS is rejected, and a WBS of another project counts as unknown", () => {
  const unknown = planJobOrderImport(file(rowCells({ WBS_NO: "Z.ZZZ.9999.999" })), MASTERS, STRICT);
  assert.equal(unknown.rejected, 1);
  const [issue] = rowOf(unknown.errors, 2);
  assert.equal(issue.column, "WBS_NO");
  assert.match(issue.message, /unknown WBS_NO 'Z.ZZZ.9999.999' under Project_ID 'PRJ-A'/);
  assert.match(issue.message, /never creates a WBS/);
  assert.deepEqual(unknown.wbsToCreate, [], "the switch is off, so nothing may be created");

  const otherProject = planJobOrderImport(file(rowCells({ WBS_NO: "B.HULL.0020.150" })), MASTERS, STRICT);
  assert.equal(otherProject.rejected, 1);
  assert.match(rowOf(otherProject.errors, 2)[0].message, /unknown WBS_NO 'B.HULL.0020.150' under Project_ID 'PRJ-A'/);
});

test("a Network scoped to another project is rejected when auto-creation is off, and an inactive one always is", () => {
  const plan = planJobOrderImport(file(rowCells({ Network_ID: "NET-B1" })), MASTERS, STRICT);
  assert.equal(plan.rejected, 1);
  const [issue] = rowOf(plan.errors, 2);
  assert.equal(issue.column, "Network_ID");
  // The message names the WBS the Network would have to belong to, because that is
  // now what an unknown Network is unknown FOR.
  assert.match(issue.message, /unknown Network_ID 'NET-B1' for WBS_NO 'A.HULL.0010.100' in Project_ID 'PRJ-A'; a Network belongs to one WBS of a project/);
  assert.match(issue.message, /An upload never creates a Network/);

  // An inactive Network is refused even with auto-creation ON: the code exists, so
  // it is not a missing master, and the row must not revive it.
  const inactive = planJobOrderImport(file(rowCells({ Network_ID: "NET-A2" })), MASTERS);
  assert.equal(inactive.rejected, 1);
  assert.deepEqual(inactive.networksToCreate, []);
  assert.match(rowOf(inactive.errors, 2)[0].message, /Network_ID 'NET-A2' is inactive under WBS_NO 'A.HULL.0010.100' in Project_ID 'PRJ-A'/);
});

test("an unknown or inactive UoM is rejected", () => {
  const unknown = planJobOrderImport(file(rowCells({ UoM: "CBM" })), MASTERS);
  assert.equal(unknown.rejected, 1);
  const [issue] = rowOf(unknown.errors, 2);
  assert.equal(issue.column, "UoM");
  assert.match(issue.message, /unknown UoM 'CBM'/);

  const inactive = planJobOrderImport(file(rowCells({ UoM: "KGS" })), MASTERS);
  assert.equal(inactive.rejected, 1);
  assert.match(rowOf(inactive.errors, 2)[0].message, /UoM 'KGS' is inactive/);
});

test("Qty and Budgeted_hours must be numbers >= 0, and a blank budget means 0", () => {
  const negative = planJobOrderImport(file(rowCells({ Qty: "-5" })), MASTERS);
  assert.equal(negative.rejected, 1);
  const [issue] = rowOf(negative.errors, 2);
  assert.equal(issue.column, "Qty");
  assert.equal(issue.message, "'-5' must be 0 or greater.");

  const negativeHours = planJobOrderImport(file(rowCells({ Budgeted_hours: "-0.5" })), MASTERS);
  assert.equal(negativeHours.rejected, 1);
  assert.equal(rowOf(negativeHours.errors, 2)[0].column, "Budgeted_hours");

  const notANumber = planJobOrderImport(file(rowCells({ Qty: "12 pcs", Budgeted_hours: "many" })), MASTERS);
  assert.equal(notANumber.rejected, 1);
  assert.deepEqual(rowOf(notANumber.errors, 2).map((e) => [e.column, e.message]), [
    ["Qty", "'12 pcs' is not a number."],
    ["Budgeted_hours", "'many' is not a number."],
  ]);

  const blank = planJobOrderImport(file(rowCells({ Job_Order: "1900000300", Qty: "", Budgeted_hours: "" })), MASTERS);
  assert.equal(blank.created, 1);
  assert.equal(blank.create[0].budgetedQuantity, 0);
  assert.equal(blank.create[0].budgetedHours, 0);
  assert.equal(parseNonNegativeNumber("2,5").ok, false, "a thousands separator is not a number in a CSV cell");
});

test("Section is required on a project Job Order and must exist under the Department", () => {
  const missing = planJobOrderImport(file(rowCells({ Section: "" })), MASTERS);
  assert.equal(missing.rejected, 1);
  const [issue] = rowOf(missing.errors, 2);
  assert.equal(issue.column, "Section");
  assert.match(issue.message, /Section is required for a Job Order on a project/);

  const otherDepartment = planJobOrderImport(file(rowCells({ Section: "Fabrication Shop" })), MASTERS);
  assert.equal(otherDepartment.rejected, 1);
  assert.match(rowOf(otherDepartment.errors, 2)[0].message, /unknown Section 'Fabrication Shop' under Department 'BuName - Workmen Division'/);

  const inactive = planJobOrderImport(file(rowCells({ Department: "Fabrication - EOU", Section: "Retired Shop" })), MASTERS);
  assert.equal(inactive.rejected, 1);
  assert.match(rowOf(inactive.errors, 2)[0].message, /Section 'Retired Shop' is inactive/);
});

test("Section is optional on the non-project row, and a standing Job Order is stored without one", () => {
  const blank = planJobOrderImport(file(rowCells({
    Project_ID: "PRJ-N", Project_Name: "Non Project", WBS_NO: "N.GEN.0000.000", Network_ID: "STANDING",
    Job_Order: "1900000401", Job_Description: "Standing / Idle hours", Section: "",
  })), MASTERS);
  assert.equal(blank.rejected, 0);
  assert.equal(blank.created, 1);
  assert.equal(blank.create[0].sectionId, null);

  // A Section supplied on a standing row is validated (a typo must still surface)
  // but never stored: the Job Order must stay bookable from any section.
  const supplied = planJobOrderImport(file(rowCells({
    Project_ID: "PRJ-N", Project_Name: "Non Project", WBS_NO: "N.GEN.0000.000", Network_ID: "STANDING",
    Job_Order: "1900000401", Job_Description: "Standing / Idle hours", Section: "Pipe Shop",
  })), MASTERS);
  assert.equal(supplied.rejected, 0);
  assert.equal(supplied.create[0].sectionId, null);
  assert.equal(supplied.create[0].sectionName, null);

  const typo = planJobOrderImport(file(rowCells({
    Project_ID: "PRJ-N", Project_Name: "Non Project", WBS_NO: "N.GEN.0000.000", Network_ID: "STANDING",
    Job_Order: "1900000401", Job_Description: "Standing / Idle hours", Section: "Pipe Shoppe",
  })), MASTERS);
  assert.equal(typo.rejected, 1);
  assert.equal(rowOf(typo.errors, 2)[0].column, "Section");
});

// ---------------------------------------------------------- duplicate rule

test("the duplicate rule is Project_ID + WBS_NO + Job_Order", () => {
  const duplicate = planJobOrderImport(file(rowCells()), MASTERS);
  assert.deepEqual({ created: duplicate.created, skipped: duplicate.skipped, rejected: duplicate.rejected }, { created: 0, skipped: 0, rejected: 1 });
  const [issue] = rowOf(duplicate.errors, 2);
  assert.equal(issue.column, "Job_Order");
  assert.match(issue.message, /Job Order '1900000107' already exists in Project_ID 'PRJ-A' under WBS_NO 'A.HULL.0010.100'/);
  assert.match(issue.message, /Project_ID \+ WBS_NO \+ Job_Order combination is a duplicate/);

  // The same number in another project is a different triple and is created.
  const otherProject = planJobOrderImport(file(rowCells({ Project_ID: "PRJ-B", Project_Name: "Project B", WBS_NO: "B.HULL.0020.150", Network_ID: "NET-B1" })), MASTERS);
  assert.equal(otherProject.created, 1);
  assert.equal(otherProject.rejected, 0);
});

test("an existing Job Order under another WBS is skipped and reported, never overwritten", () => {
  const plan = planJobOrderImport(file(rowCells({ Job_Order: "1900000110", WBS_NO: "A.HULL.0010.100" })), MASTERS);
  assert.deepEqual({ created: plan.created, skipped: plan.skipped, rejected: plan.rejected }, { created: 0, skipped: 1, rejected: 0 });
  assert.deepEqual(plan.errors, [], "a skipped row is not an error");
  const [skip] = plan.skippedRows;
  assert.equal(skip.row, 2);
  assert.equal(skip.column, "Job_Order");
  assert.match(skip.message, /already exists in Project_ID 'PRJ-A' under WBS_NO 'A.HULL.0011.100'/);
  assert.match(skip.message, /skipped, the existing Job Order and its budget were left untouched/);
});

test("a Job Order number repeated inside one file is rejected on the later row", () => {
  const plan = planJobOrderImport(file(
    rowCells({ Job_Order: "1900000901" }),
    rowCells({ Job_Order: "1900000901", WBS_NO: "A.HULL.0011.100", Network_ID: "NET-A3" })
  ), MASTERS);
  assert.deepEqual({ created: plan.created, rejected: plan.rejected }, { created: 1, rejected: 1 });
  const [issue] = rowOf(plan.errors, 3);
  assert.equal(issue.column, "Job_Order");
  assert.match(issue.message, /already appears in this file for Project_ID 'PRJ-A' \(row 2\)/);
});

// ------------------------------------------------------------- department

test("Department matching tolerates case, whitespace and a hyphen typed without spaces", () => {
  assert.equal(normalizeDepartmentKey("  BuName - Workmen Division "), "buname-workmen division");
  assert.equal(normalizeDepartmentKey("BuName-Workmen   Division"), "buname-workmen division");
  assert.equal(normalizeDepartmentKey("buname - workmen division"), "buname-workmen division");

  for (const typed of ["BuName-Workmen Division", "  buname  -  workmen   division ", "BUNAME-WORKMEN DIVISION"]) {
    const plan = planJobOrderImport(file(rowCells({ Department: typed, Job_Order: "1900000902" })), MASTERS);
    assert.equal(plan.rejected, 0, `'${typed}' should resolve to the master Department`);
    assert.equal(plan.create[0].departmentId, 1);
    assert.equal(plan.create[0].departmentName, "BuName - Workmen Division", "the master name is stored, not the typed value");
  }

  const unknown = planJobOrderImport(file(rowCells({ Department: "Workmen Division" })), MASTERS);
  assert.equal(unknown.rejected, 1);
  const [issue] = rowOf(unknown.errors, 2);
  assert.equal(issue.column, "Department");
  assert.match(issue.message, /unknown Department 'Workmen Division'/);

  const inactive = planJobOrderImport(file(rowCells({ Department: "Closed Division" })), MASTERS);
  assert.equal(inactive.rejected, 1);
  assert.match(rowOf(inactive.errors, 2)[0].message, /Department 'Closed Division' is inactive/);
});

// -------------------------------------------------------------- status etc.

test("Job_Order_Status maps Active -> active and In-Active -> inactive", () => {
  assert.equal(parseJobOrderStatus("Active"), "active");
  assert.equal(parseJobOrderStatus("In-Active"), "inactive");
  assert.equal(parseJobOrderStatus("in active"), "inactive");
  assert.equal(parseJobOrderStatus("INACTIVE"), "inactive");
  assert.equal(parseJobOrderStatus("closed"), null);
  assert.equal(parseJobOrderStatus("on_hold"), null, "closed and on_hold are gone from the model");

  const inactive = planJobOrderImport(file(rowCells({ Job_Order: "1900000301", Job_Order_Status: "In-Active" })), MASTERS);
  assert.equal(inactive.create[0].status, "inactive");

  const bad = planJobOrderImport(file(rowCells({ Job_Order_Status: "closed" })), MASTERS);
  assert.equal(bad.rejected, 1);
  assert.match(rowOf(bad.errors, 2)[0].message, /unknown Job_Order_Status 'closed'; use Active or In-Active/);

  const blank = planJobOrderImport(file(rowCells({ Job_Order_Status: "" })), MASTERS);
  assert.equal(blank.rejected, 1);
  assert.equal(rowOf(blank.errors, 2)[0].column, "Job_Order_Status");
});

test("a formula-injection cell is rejected, but a signed number stays data", () => {
  const injected = planJobOrderImport(file(rowCells({ Job_Description: "=SUM(A1:A9)" })), MASTERS);
  assert.equal(injected.rejected, 1);
  const [issue] = rowOf(injected.errors, 2);
  assert.equal(issue.column, "Job_Description");
  assert.match(issue.message, /possible CSV injection/);

  // '-5' in Qty is a negative quantity, not an injection attempt.
  const negative = planJobOrderImport(file(rowCells({ Qty: "-5" })), MASTERS);
  assert.match(rowOf(negative.errors, 2)[0].message, /must be 0 or greater/);
});

test("every rejected row is reported with its row number, column and message", () => {
  const plan = planJobOrderImport(file(
    rowCells({ Project_ID: "PRJ-Z", Project_Name: "Project Z" }),
    rowCells({ UoM: "CBM" }),
    rowCells({ Job_Order: "1900000107" })
  ), MASTERS);
  assert.deepEqual({ total: plan.total, created: plan.created, rejected: plan.rejected }, { total: 3, created: 0, rejected: 3 });
  assert.deepEqual(plan.errors.map((issue) => issue.row), [2, 3, 4], "errors are sorted by row");
  assert.equal(plan.errors.length, 3);
  assert.ok(plan.errors.every((issue) => issue.column !== "" && issue.message.length > 0));
});

// ------------------------------------------- master auto-creation (WBS / Network)

test("a missing WBS is created and its row is imported", () => {
  // The row's Network must belong to the WBS the row names, so a WBS this file
  // creates gets its Network created under it in the same run.
  const plan = planJobOrderImport(file(rowCells({ WBS_NO: "A.HULL.0042.900", Network_ID: "NET-A9", Job_Order: "1900000500" })), MASTERS);

  assert.deepEqual({ total: plan.total, created: plan.created, skipped: plan.skipped, rejected: plan.rejected }, { total: 1, created: 1, skipped: 0, rejected: 0 });
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.wbsToCreate, [{ row: 2, projectId: 1, projectCode: "PRJ-A", wbsCode: "A.HULL.0042.900" }]);
  assert.deepEqual(plan.networksToCreate, [{
    row: 2, projectId: 1, projectCode: "PRJ-A", wbsId: PENDING_MASTER_ID, wbsCode: "A.HULL.0042.900", networkCode: "NET-A9",
  }], "the new Network is created UNDER the WBS this same row creates");
  // Neither master has an id until the route inserts it, so the row carries the
  // placeholder in both id columns (the route resolves the Network's WBS first).
  assert.equal(plan.create[0].projectWbsId, PENDING_MASTER_ID);
  assert.equal(plan.create[0].wbsCode, "A.HULL.0042.900");
  assert.equal(plan.create[0].networkId, PENDING_MASTER_ID);
  assert.equal(plan.create[0].networkCode, "NET-A9");
});

test("a missing Network is created and its row is imported", () => {
  const plan = planJobOrderImport(file(rowCells({ Network_ID: "NET-A7", Job_Order: "1900000501" })), MASTERS);

  assert.deepEqual({ created: plan.created, rejected: plan.rejected }, { created: 1, rejected: 0 });
  assert.deepEqual(plan.wbsToCreate, [], "the WBS exists, so nothing is created for it");
  // The new Network carries the WBS resolved from WBS_NO on that same row.
  assert.deepEqual(plan.networksToCreate, [{
    row: 2, projectId: 1, projectCode: "PRJ-A", wbsId: 100, wbsCode: "A.HULL.0010.100", networkCode: "NET-A7",
  }]);
  assert.equal(plan.create[0].networkId, PENDING_MASTER_ID);
  assert.equal(plan.create[0].networkCode, "NET-A7");
  assert.equal(plan.create[0].projectWbsId, 100, "the WBS exists, so its real id is kept");
});

test("one new WBS named by three rows is created once, in the first row's spelling", () => {
  const plan = planJobOrderImport(file(
    rowCells({ WBS_NO: "a.hull.0077.100", Network_ID: "NET-A9", Job_Order: "1900000601" }),
    rowCells({ WBS_NO: "A.HULL.0077.100", Network_ID: "NET-A9", Job_Order: "1900000602" }),
    rowCells({ WBS_NO: " A.HULL.0077.100 ", Network_ID: "NET-A9", Job_Order: "1900000603" })
  ), MASTERS);

  assert.deepEqual({ created: plan.created, rejected: plan.rejected }, { created: 3, rejected: 0 });
  // Deduped on the same case- and whitespace-insensitive key the module uses
  // everywhere else, so the three spellings are one master, introduced by row 2.
  assert.deepEqual(plan.wbsToCreate, [{ row: 2, projectId: 1, projectCode: "PRJ-A", wbsCode: "a.hull.0077.100" }]);
  // The Network they share is deduped the same way and stays scoped to that WBS.
  assert.deepEqual(plan.networksToCreate, [{
    row: 2, projectId: 1, projectCode: "PRJ-A", wbsId: PENDING_MASTER_ID, wbsCode: "a.hull.0077.100", networkCode: "NET-A9",
  }]);
  assert.deepEqual(plan.create.map((item) => item.projectWbsId), [PENDING_MASTER_ID, PENDING_MASTER_ID, PENDING_MASTER_ID]);
});

test("the created-master report names the row that introduced each master", () => {
  const plan = planJobOrderImport(file(
    rowCells({ WBS_NO: "A.HULL.0110.100", Network_ID: "NET-A9", Job_Order: "1900001001" }),
    rowCells({ WBS_NO: "A.HULL.0110.100", Network_ID: "NET-A9", Job_Order: "1900001002" }),
    rowCells({ WBS_NO: "A.HULL.0111.100", Network_ID: "NET-A10", Job_Order: "1900001003" })
  ), MASTERS);

  assert.equal(plan.created, 3);
  assert.deepEqual(plan.wbsToCreate, [
    { row: 2, projectId: 1, projectCode: "PRJ-A", wbsCode: "A.HULL.0110.100" },
    { row: 4, projectId: 1, projectCode: "PRJ-A", wbsCode: "A.HULL.0111.100" },
  ]);
  // Each new Network is reported with the WBS it was created under.
  assert.deepEqual(plan.networksToCreate, [
    { row: 2, projectId: 1, projectCode: "PRJ-A", wbsId: PENDING_MASTER_ID, wbsCode: "A.HULL.0110.100", networkCode: "NET-A9" },
    { row: 4, projectId: 1, projectCode: "PRJ-A", wbsId: PENDING_MASTER_ID, wbsCode: "A.HULL.0111.100", networkCode: "NET-A10" },
  ]);
});

test("auto-creation off (createMissingMasters: false) rejects the rows with the old messages", () => {
  const plan = planJobOrderImport(file(
    rowCells({ WBS_NO: "A.HULL.0042.900", Job_Order: "1900000500" }),
    rowCells({ Network_ID: "NET-A7", Job_Order: "1900000501" })
  ), MASTERS, STRICT);

  assert.deepEqual({ total: plan.total, created: plan.created, rejected: plan.rejected }, { total: 2, created: 0, rejected: 2 });
  assert.deepEqual(plan.create, []);
  assert.deepEqual(plan.wbsToCreate, []);
  assert.deepEqual(plan.networksToCreate, []);
  assert.deepEqual(rowOf(plan.errors, 2).map((issue) => [issue.column, issue.message]), [
    ["WBS_NO", "unknown WBS_NO 'A.HULL.0042.900' under Project_ID 'PRJ-A'. An upload never creates a WBS."],
  ]);
  assert.deepEqual(rowOf(plan.errors, 3).map((issue) => [issue.column, issue.message]), [
    ["Network_ID", "unknown Network_ID 'NET-A7' for WBS_NO 'A.HULL.0010.100' in Project_ID 'PRJ-A'; a Network belongs to one WBS of a project. An upload never creates a Network."],
  ]);
});

test("an unknown Project rejects even with auto-creation on: it cannot be created from the template", () => {
  const plan = planJobOrderImport(file(rowCells({
    Project_ID: "PRJ-Z", Project_Name: "Project Z", WBS_NO: "Z.ZZZ.0001.000", Network_ID: "NET-Z1",
  })), MASTERS);

  assert.deepEqual({ created: plan.created, rejected: plan.rejected }, { created: 0, rejected: 1 });
  const issues = rowOf(plan.errors, 2);
  assert.deepEqual(issues.map((issue) => issue.column), ["Project_ID"], "a WBS or Network cannot resolve without the Project");
  assert.match(issues[0].message, /colour key/);
  assert.deepEqual(plan.wbsToCreate, []);
  assert.deepEqual(plan.networksToCreate, []);
});

test("an unknown UoM, Department or Section still rejects, and creates no master", () => {
  const cases: Array<Partial<Record<JobOrderCsvHeader, string>>> = [
    { UoM: "CBM" },
    { Department: "Workmen Division" },
    { Section: "Hull Productionn" },
  ];
  for (const override of cases) {
    const plan = planJobOrderImport(file(rowCells({
      ...override, WBS_NO: "A.HULL.0042.900", Network_ID: "NET-A7", Job_Order: "1900000500",
    })), MASTERS);
    assert.equal(plan.rejected, 1, `${Object.keys(override)[0]} must still reject`);
    assert.equal(plan.created, 0);
    // The row named a new WBS and a new Network, but it was refused, so neither is
    // created: a master is never written without the Job Order that asked for it.
    assert.deepEqual(plan.wbsToCreate, []);
    assert.deepEqual(plan.networksToCreate, []);
  }
});

test("a master is created by the accepted row only, never by a rejected one", () => {
  const plan = planJobOrderImport(file(
    rowCells({ WBS_NO: "A.HULL.0088.100", Network_ID: "NET-A8", UoM: "CBM", Job_Order: "1900000701" }),
    rowCells({ WBS_NO: "A.HULL.0088.100", Network_ID: "NET-A8", Job_Order: "1900000702" })
  ), MASTERS);

  assert.deepEqual({ created: plan.created, rejected: plan.rejected }, { created: 1, rejected: 1 });
  assert.deepEqual(plan.wbsToCreate, [{ row: 3, projectId: 1, projectCode: "PRJ-A", wbsCode: "A.HULL.0088.100" }]);
  assert.deepEqual(plan.networksToCreate, [{
    row: 3, projectId: 1, projectCode: "PRJ-A", wbsId: PENDING_MASTER_ID, wbsCode: "A.HULL.0088.100", networkCode: "NET-A8",
  }]);
});

test("the duplicate rule is unchanged when a master is created", () => {
  // The Job Order already exists in the project under another WBS: the row is
  // still a skip, and a skip creates no master (for the WBS or for its Network).
  const skipped = planJobOrderImport(file(rowCells({ Job_Order: "1900000110", WBS_NO: "A.HULL.0099.100", Network_ID: "NET-A9" })), MASTERS);
  assert.deepEqual({ created: skipped.created, skipped: skipped.skipped, rejected: skipped.rejected }, { created: 0, skipped: 1, rejected: 0 });
  assert.deepEqual(skipped.errors, [], "a skip is not an error, even though its WBS is new");
  assert.deepEqual(skipped.wbsToCreate, []);
  assert.deepEqual(skipped.networksToCreate, []);

  // The same Project + WBS_NO + Job_Order triple is still a rejection.
  const duplicate = planJobOrderImport(file(rowCells({ WBS_NO: "A.HULL.0010.100" })), MASTERS);
  assert.equal(duplicate.rejected, 1);
  assert.equal(duplicate.wbsToCreate.length, 0);

  // Inside one file: the second row repeating the number is rejected, and the WBS
  // and the Network they share are still created exactly once.
  const inFile = planJobOrderImport(file(
    rowCells({ WBS_NO: "A.HULL.0090.100", Network_ID: "NET-A9", Job_Order: "1900000901" }),
    rowCells({ WBS_NO: "A.HULL.0090.100", Network_ID: "NET-A9", Job_Order: "1900000901" })
  ), MASTERS);
  assert.deepEqual({ created: inFile.created, rejected: inFile.rejected }, { created: 1, rejected: 1 });
  assert.equal(inFile.wbsToCreate.length, 1);
  assert.equal(inFile.networksToCreate.length, 1);
  assert.match(rowOf(inFile.errors, 3)[0].message, /already appears in this file/);
});

test("a WBS is scoped to its project, so the same code in another project is a second master", () => {
  const plan = planJobOrderImport(file(
    rowCells({ WBS_NO: "B.HULL.0020.150", Network_ID: "NET-A9", Job_Order: "1900000802" }),
    rowCells({ Project_ID: "PRJ-B", Project_Name: "Project B", WBS_NO: "B.HULL.0020.150", Network_ID: "NET-B1", UoM: "MTR", Job_Order: "1900000803" })
  ), MASTERS);

  assert.deepEqual({ created: plan.created, rejected: plan.rejected }, { created: 2, rejected: 0 });
  assert.deepEqual(plan.wbsToCreate, [{ row: 2, projectId: 1, projectCode: "PRJ-A", wbsCode: "B.HULL.0020.150" }]);
  // The new Network belongs to PRJ-A's copy of that WBS row, not to PRJ-B's.
  assert.deepEqual(plan.networksToCreate, [{
    row: 2, projectId: 1, projectCode: "PRJ-A", wbsId: PENDING_MASTER_ID, wbsCode: "B.HULL.0020.150", networkCode: "NET-A9",
  }]);
});

test("the resolution seams answer resolved / create / reject for one row", () => {
  const project = { id: 1, code: "PRJ-A", name: "Project A", isNonProject: false, active: true };
  const wbsByProject = new Map(MASTERS.wbsRows.filter((wbs) => wbs.projectId === 1).map((wbs) => [projectScopedKey(wbs.projectId, wbs.wbsCode), wbs]));
  const networkByProject = new Map(MASTERS.networks.filter((network) => network.projectId === 1).map((network) => [projectScopedKey(network.projectId, network.code), network]));
  const noPending: ReadonlySet<string> = new Set<string>();

  const existing = resolveWbsForRow({ project, wbsCode: "a.hull.0010.100", wbsByProject, pendingKeys: noPending, createMissingMasters: true });
  assert.deepEqual(existing, { outcome: "resolved", pending: false, master: { id: 100, projectId: 1, wbsCode: "A.HULL.0010.100", active: true } });

  const created = resolveWbsForRow({ project, wbsCode: " A.HULL.0042.900 ", wbsByProject, pendingKeys: noPending, createMissingMasters: true });
  assert.deepEqual(created, { outcome: "create", code: "A.HULL.0042.900" });

  const strict = resolveWbsForRow({ project, wbsCode: "A.HULL.0042.900", wbsByProject, pendingKeys: noPending, createMissingMasters: false });
  assert.equal(strict.outcome, "reject");

  const pendingKey = projectScopedKey(1, "A.HULL.0042.900");
  const alreadyPlanned = resolveWbsForRow({ project, wbsCode: "A.HULL.0042.900", wbsByProject, pendingKeys: new Set([pendingKey]), createMissingMasters: true });
  assert.deepEqual(alreadyPlanned, { outcome: "resolved", pending: true, master: { id: PENDING_MASTER_ID, projectId: 1, wbsCode: "A.HULL.0042.900", active: true } });

  // The Network seam is WBS-scoped: it answers one question only - does the master
  // found for the project sit under the WBS THIS ROW resolved?
  const wbsById = new Map(MASTERS.wbsRows.filter((wbs) => wbs.projectId === 1).map((wbs) => [wbs.id, wbs]));
  const noPendingNetworks: ReadonlyMap<string, PendingNetworkScope> = new Map<string, PendingNetworkScope>();
  const wbs100: WbsRef = { id: 100, projectId: 1, wbsCode: "A.HULL.0010.100", active: true };
  const wbs101: WbsRef = { id: 101, projectId: 1, wbsCode: "A.HULL.0011.100", active: true };

  const ownWbs = resolveNetworkForRow({ project, wbs: wbs100, networkCode: "net-a1", networkByProject, wbsById, pendingNetworks: noPendingNetworks, createMissingMasters: true });
  assert.deepEqual(ownWbs, { outcome: "resolved", pending: false, master: { id: 200, projectId: 1, wbsId: 100, code: "NET-A1", active: true } });

  const otherWbs = resolveNetworkForRow({ project, wbs: wbs100, networkCode: "NET-A3", networkByProject, wbsById, pendingNetworks: noPendingNetworks, createMissingMasters: true });
  assert.deepEqual(otherWbs, { outcome: "reject", message: 'Network "NET-A3" belongs to WBS "A.HULL.0011.100", not "A.HULL.0010.100".' });

  // A code the project does not have at all is still a master to create - under the
  // row's WBS. NET-B1 belongs to ANOTHER PROJECT, so under PRJ-A it is unknown.
  const otherProject = resolveNetworkForRow({ project, wbs: wbs101, networkCode: "NET-B1", networkByProject, wbsById, pendingNetworks: noPendingNetworks, createMissingMasters: true });
  assert.deepEqual(otherProject, { outcome: "create", code: "NET-B1" });

  const strictNetwork = resolveNetworkForRow({ project, wbs: wbs100, networkCode: "NET-A7", networkByProject, wbsById, pendingNetworks: noPendingNetworks, createMissingMasters: false });
  assert.deepEqual(strictNetwork, {
    outcome: "reject",
    message: "unknown Network_ID 'NET-A7' for WBS_NO 'A.HULL.0010.100' in Project_ID 'PRJ-A'; a Network belongs to one WBS of a project. An upload never creates a Network.",
  });

  // A Network this plan already creates resolves for ITS OWN WBS, and is a mismatch
  // for another WBS of the same project: one code, one WBS.
  const pendingNetworks = new Map<string, PendingNetworkScope>([
    [projectScopedKey(1, "NET-A9"), { wbsId: PENDING_MASTER_ID, wbsCode: "A.HULL.0011.100", row: 2 }],
  ]);
  const planned = resolveNetworkForRow({ project, wbs: wbs101, networkCode: "NET-A9", networkByProject, wbsById, pendingNetworks, createMissingMasters: true });
  assert.deepEqual(planned, { outcome: "resolved", pending: true, master: { id: PENDING_MASTER_ID, projectId: 1, wbsId: 101, code: "NET-A9", active: true } });
  const plannedOtherWbs = resolveNetworkForRow({ project, wbs: wbs100, networkCode: "NET-A9", networkByProject, wbsById, pendingNetworks, createMissingMasters: true });
  assert.deepEqual(plannedOtherWbs, { outcome: "reject", message: 'Network "NET-A9" belongs to WBS "A.HULL.0011.100", not "A.HULL.0010.100".' });

  // An INACTIVE master of the row's own WBS is refused and never offered for
  // creation, because the code already exists and the row must not revive it.
  const inactive = resolveNetworkForRow({ project, wbs: wbs100, networkCode: "NET-A2", networkByProject, wbsById, pendingNetworks: noPendingNetworks, createMissingMasters: true });
  assert.deepEqual(inactive, { outcome: "reject", message: "Network_ID 'NET-A2' is inactive under WBS_NO 'A.HULL.0010.100' in Project_ID 'PRJ-A'." });

  // A WBS this file creates cannot take over an EXISTING Network: that would move
  // the master to another WBS, which never happens.
  const pendingWbs = resolveNetworkForRow({
    project,
    wbs: { id: PENDING_MASTER_ID, projectId: 1, wbsCode: "A.HULL.0042.900", active: true },
    networkCode: "NET-A1",
    networkByProject,
    wbsById,
    pendingNetworks: noPendingNetworks,
    createMissingMasters: true,
  });
  assert.deepEqual(pendingWbs, { outcome: "reject", message: 'Network "NET-A1" belongs to WBS "A.HULL.0010.100", not "A.HULL.0042.900".' });

  const blank = resolveNetworkForRow({ project, wbs: wbs100, networkCode: "   ", networkByProject, wbsById, pendingNetworks: noPendingNetworks, createMissingMasters: true });
  assert.deepEqual(blank, { outcome: "reject", message: "Network_ID is required." });
});

// -------------------------------- a Network belongs to ONE WBS of its project

test("a Network of another WBS of the same project is rejected, naming both WBS codes", () => {
  // NET-A3 is a real master of PRJ-A, but of A.HULL.0011.100. The row names
  // A.HULL.0010.100, so the line is refused with the naming message: one Network
  // never spans two WBS of a project. Both modes refuse it - the code already
  // exists in the project, so it cannot be created for this WBS either, and the
  // upload never moves a master to another WBS.
  for (const options of [undefined, STRICT]) {
    const plan = planJobOrderImport(
      file(rowCells({ WBS_NO: "A.HULL.0010.100", Network_ID: "NET-A3", Job_Order: "1900001100" })),
      MASTERS,
      options
    );
    assert.deepEqual({ created: plan.created, skipped: plan.skipped, rejected: plan.rejected }, { created: 0, skipped: 0, rejected: 1 });
    assert.deepEqual(plan.create, []);
    assert.deepEqual(plan.networksToCreate, []);
    assert.deepEqual(plan.errors, [{
      row: 2,
      column: "Network_ID",
      message: 'Network "NET-A3" belongs to WBS "A.HULL.0011.100", not "A.HULL.0010.100".',
    }]);
  }

  // The reverse direction is the same rule.
  const reverse = planJobOrderImport(file(rowCells({ WBS_NO: "A.HULL.0011.100", Network_ID: "NET-A1", Job_Order: "1900001101" })), MASTERS);
  assert.deepEqual(reverse.errors, [{
    row: 2,
    column: "Network_ID",
    message: 'Network "NET-A1" belongs to WBS "A.HULL.0010.100", not "A.HULL.0011.100".',
  }]);
});

test("a Network of the SAME WBS as the row is accepted", () => {
  const sameWbs = planJobOrderImport(file(rowCells({ WBS_NO: "A.HULL.0011.100", Network_ID: "NET-A3", Job_Order: "1900001102" })), MASTERS);

  assert.deepEqual({ created: sameWbs.created, skipped: sameWbs.skipped, rejected: sameWbs.rejected }, { created: 1, skipped: 0, rejected: 0 });
  assert.deepEqual(sameWbs.errors, []);
  assert.deepEqual(sameWbs.networksToCreate, [], "the Network exists for this WBS, so nothing is created");
  assert.equal(sameWbs.create[0].projectWbsId, 101);
  assert.equal(sameWbs.create[0].networkId, 203, "an existing master keeps its real id");
  assert.equal(sameWbs.create[0].networkCode, "NET-A3");
});

test("a missing Network is created for the row's WBS, carrying its wbsId", () => {
  // Two rows of DIFFERENT WBS of one project, each naming a Network code the project
  // does not have: each code is created under the WBS of its own row.
  const plan = planJobOrderImport(file(
    rowCells({ WBS_NO: "A.HULL.0010.100", Network_ID: "NET-A5", Job_Order: "1900001103" }),
    rowCells({ WBS_NO: "A.HULL.0011.100", Network_ID: "NET-A6", Job_Order: "1900001104" })
  ), MASTERS);

  assert.deepEqual({ created: plan.created, rejected: plan.rejected }, { created: 2, rejected: 0 });
  assert.deepEqual(plan.wbsToCreate, [], "both WBS masters exist");
  assert.deepEqual(plan.networksToCreate, [
    { row: 2, projectId: 1, projectCode: "PRJ-A", wbsId: 100, wbsCode: "A.HULL.0010.100", networkCode: "NET-A5" },
    { row: 3, projectId: 1, projectCode: "PRJ-A", wbsId: 101, wbsCode: "A.HULL.0011.100", networkCode: "NET-A6" },
  ], "each new Network carries the WBS of the row that asked for it");
  assert.deepEqual(plan.create.map((item) => [item.projectWbsId, item.networkId]), [
    [100, PENDING_MASTER_ID],
    [101, PENDING_MASTER_ID],
  ]);
});

test("two rows naming the same new Network under ONE WBS create it once, under that WBS", () => {
  const plan = planJobOrderImport(file(
    rowCells({ WBS_NO: "A.HULL.0011.100", Network_ID: "NET-A5", Job_Order: "1900001105" }),
    rowCells({ WBS_NO: "A.HULL.0011.100", Network_ID: "net-a5", Job_Order: "1900001106" })
  ), MASTERS);

  assert.deepEqual({ created: plan.created, rejected: plan.rejected }, { created: 2, rejected: 0 });
  // Deduped per (WBS, Network_ID), on the same case-insensitive key the module uses
  // everywhere else: one master, in the first row's spelling, for the rows' WBS.
  assert.deepEqual(plan.networksToCreate, [{
    row: 2, projectId: 1, projectCode: "PRJ-A", wbsId: 101, wbsCode: "A.HULL.0011.100", networkCode: "NET-A5",
  }]);
  assert.deepEqual(plan.create.map((item) => item.networkId), [PENDING_MASTER_ID, PENDING_MASTER_ID]);
});

test("one new Network code named by two WBS of one file is created once, and the second WBS is rejected", () => {
  // `networks` stays unique on (projectId, code), so the second WBS cannot open a
  // second master for the same code. The row is refused with the same naming
  // message, and the file never reaches the database with a duplicate.
  const plan = planJobOrderImport(file(
    rowCells({ WBS_NO: "A.HULL.0110.100", Network_ID: "NET-A9", Job_Order: "1900001107" }),
    rowCells({ WBS_NO: "A.HULL.0111.100", Network_ID: "NET-A9", Job_Order: "1900001108" })
  ), MASTERS);

  assert.deepEqual({ created: plan.created, rejected: plan.rejected }, { created: 1, rejected: 1 });
  assert.deepEqual(plan.networksToCreate, [{
    row: 2, projectId: 1, projectCode: "PRJ-A", wbsId: PENDING_MASTER_ID, wbsCode: "A.HULL.0110.100", networkCode: "NET-A9",
  }]);
  assert.deepEqual(plan.wbsToCreate, [{ row: 2, projectId: 1, projectCode: "PRJ-A", wbsCode: "A.HULL.0110.100" }], "the rejected row introduces no WBS either");
  assert.deepEqual(rowOf(plan.errors, 3), [{
    row: 3,
    column: "Network_ID",
    message: 'Network "NET-A9" belongs to WBS "A.HULL.0110.100", not "A.HULL.0111.100".',
  }]);
});
