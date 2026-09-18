/**
 * Job Order CSV import: header mapping, per-row validation and the duplicate rule.
 *
 * The build contract (docs/MASTER_DATA_BUILD_CONTRACT.md, section 5) fixes the
 * header order and the rules implemented here. Everything in this module is a pure
 * function over the parsed rows plus an injected master-data snapshot, so every
 * rule is unit-testable without a database. The route loads the snapshot from
 * Prisma and persists the plan.
 *
 * Two invariants:
 *  - An upload never creates master data. An unknown Project, WBS, Network, UoM,
 *    Department or Section rejects the row and names what is missing.
 *  - An upload never overwrites a budget. A Job Order that already exists in the
 *    project is reported (rejected when it is the same Project + WBS + Job Order,
 *    skipped otherwise) instead of being written over.
 */

import { findCsvInjectionIndex } from "./csvParser";

/** Header order is fixed by the contract. The file must match it exactly. */
export const JOB_ORDER_CSV_HEADERS = [
  "Project_ID",
  "Project_Name",
  "WBS_NO",
  "Network_ID",
  "Job_Order",
  "Job_Description",
  "UoM",
  "Qty",
  "Budgeted_hours",
  "Department",
  "Section",
  "Job_Order_Status",
] as const;

export type JobOrderCsvHeader = (typeof JOB_ORDER_CSV_HEADERS)[number];

/** Comma-joined header line, used by the template download. */
export const JOB_ORDER_CSV_HEADER_LINE = JOB_ORDER_CSV_HEADERS.join(",");

/** Column positions. Fixed, so the planner reads a row by index once the header matches. */
const COLUMN = {
  projectId: 0,
  projectName: 1,
  wbsNo: 2,
  networkId: 3,
  jobOrder: 4,
  jobDescription: 5,
  uom: 6,
  qty: 7,
  budgetedHours: 8,
  department: 9,
  section: 10,
  status: 11,
} as const;

export type JobOrderStatus = "active" | "inactive";

export type DepartmentRef = { id: number; name: string; active: boolean };
export type SectionRef = { id: number; departmentId: number; name: string; active: boolean };
export type ProjectRef = { id: number; code: string; name: string; isNonProject: boolean; active: boolean };
export type WbsRef = { id: number; projectId: number; wbsCode: string; active: boolean };
export type NetworkRef = { id: number; projectId: number; code: string; active: boolean };
export type UomRef = { id: number; code: string; active: boolean };
export type ExistingJobOrderRef = { id: number; projectId: number; code: string; wbsCode: string };

/**
 * Master-data snapshot the planner needs.
 *
 * The route loads all of it in one pass, so validation costs no per-row query.
 * `existingJobOrders` must list every Job Order of the projects named in the file;
 * otherwise the duplicate rule cannot be enforced.
 */
export type JobOrderImportMasters = {
  departments: DepartmentRef[];
  sections: SectionRef[];
  projects: ProjectRef[];
  wbsRows: WbsRef[];
  networks: NetworkRef[];
  uoms: UomRef[];
  existingJobOrders: ExistingJobOrderRef[];
};

/** One reported problem, located by row number (1-based, counting the header) and column. */
export type JobOrderRowIssue = { row: number; column: string; message: string };

/** A validated row, ready to be inserted. Ids are resolved, never invented. */
export type PlannedJobOrder = {
  row: number;
  projectId: number;
  projectCode: string;
  projectName: string;
  projectWbsId: number;
  wbsCode: string;
  networkId: number;
  networkCode: string;
  code: string;
  name: string;
  uomId: number;
  uomCode: string;
  budgetedQuantity: number;
  budgetedHours: number;
  departmentId: number;
  departmentName: string;
  /** NULL for a standing / Non-Project Job Order, which any section of the department may book. */
  sectionId: number | null;
  sectionName: string | null;
  status: JobOrderStatus;
};

export type JobOrderImportPlan = {
  /** Data rows in the file (header excluded). */
  total: number;
  created: number;
  skipped: number;
  rejected: number;
  create: PlannedJobOrder[];
  /** Existing Job Orders that were left untouched, so no budget was overwritten. */
  skippedRows: JobOrderRowIssue[];
  /** Rejected rows. A rejected row contributes one issue per offending column. */
  errors: JobOrderRowIssue[];
};

/** Case- and whitespace-insensitive key for a code column (Project, WBS, Network, UoM, Job Order). */
export function codeKey(value: string): string {
  return value.trim().toLowerCase();
}

/** Case- and whitespace-insensitive key for a name (Project_Name, Section). */
export function nameKey(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Department key. The badge sync builds the master name as `BuName - Workmen
 * Division`, so the comparison tolerates surrounding and collapsed whitespace and
 * a hyphen typed without spaces, and ignores case.
 */
export function normalizeDepartmentKey(value: string): string {
  return value.trim().replace(/\s+/g, " ").replace(/\s*-\s*/g, "-").toLowerCase();
}

/** Resolve a Department cell to its master row (whitespace, hyphen spacing and case tolerant). */
export function resolveDepartment(departments: DepartmentRef[], cell: string): DepartmentRef | null {
  const key = normalizeDepartmentKey(cell);
  if (!key) return null;
  return departments.find((department) => normalizeDepartmentKey(department.name) === key) ?? null;
}

/** Map the CSV status label to the stored value. `Active` -> active, `In-Active` -> inactive. */
export function parseJobOrderStatus(value: string): JobOrderStatus | null {
  const key = value.trim().replace(/\s+/g, "").toLowerCase();
  if (key === "active") return "active";
  if (key === "in-active" || key === "inactive" || key === "in_active") return "inactive";
  return null;
}

export type NumberParse = { ok: true; value: number } | { ok: false; message: string };

/** Parse a non-negative CSV number. A blank cell is 0 (a Job Order may carry no budget yet). */
export function parseNonNegativeNumber(cell: string): NumberParse {
  const text = cell.trim();
  if (!text) return { ok: true, value: 0 };
  const value = Number(text);
  if (!Number.isFinite(value)) return { ok: false, message: `'${text}' is not a number.` };
  if (value < 0) return { ok: false, message: `'${text}' must be 0 or greater.` };
  return { ok: true, value };
}

export type HeaderCheck = { ok: true } | { ok: false; error: string };

/**
 * The file header must be the contract header, in order. Case and surrounding
 * whitespace are ignored; a missing, extra, duplicated or reordered column is not.
 * The error names the expected columns so the operator can fix the file.
 */
export function checkJobOrderHeader(header: string[]): HeaderCheck {
  const received = header.map((name) => name.trim());
  const expected = JOB_ORDER_CSV_HEADERS as readonly string[];
  const detail: string[] = [];
  const shared = Math.min(received.length, expected.length);
  for (let i = 0; i < shared; i++) {
    if (received[i].toLowerCase() !== expected[i].toLowerCase()) {
      detail.push(`column ${i + 1} is '${received[i] || "(empty)"}'; '${expected[i]}' was expected.`);
      break;
    }
  }
  if (!detail.length && received.length > expected.length) {
    detail.push(`${received.length - expected.length} extra column(s) after '${expected[expected.length - 1]}'.`);
  }
  if (!detail.length && received.length < expected.length) {
    const missing = expected.slice(received.length).join(", ");
    detail.push(`column(s) missing at the end: ${missing}.`);
  }
  if (detail.length) {
    return {
      ok: false,
      error: `CSV header does not match the Job Order template: ${detail.join(" ")} `
        + `Expected, in this order: ${expected.join(", ")}.`,
    };
  }
  return { ok: true };
}

type MasterIndex = {
  projectByCode: Map<string, ProjectRef>;
  wbsByProject: Map<string, WbsRef>;
  networkByProject: Map<string, NetworkRef>;
  uomByCode: Map<string, UomRef>;
  existingByProject: Map<string, ExistingJobOrderRef>;
  sectionsByDepartment: Map<number, SectionRef[]>;
};

function buildIndex(masters: JobOrderImportMasters): MasterIndex {
  const index: MasterIndex = {
    projectByCode: new Map(),
    wbsByProject: new Map(),
    networkByProject: new Map(),
    uomByCode: new Map(),
    existingByProject: new Map(),
    sectionsByDepartment: new Map(),
  };
  for (const project of masters.projects) index.projectByCode.set(codeKey(project.code), project);
  for (const wbs of masters.wbsRows) index.wbsByProject.set(`${wbs.projectId}:${codeKey(wbs.wbsCode)}`, wbs);
  for (const network of masters.networks) index.networkByProject.set(`${network.projectId}:${codeKey(network.code)}`, network);
  for (const uom of masters.uoms) index.uomByCode.set(codeKey(uom.code), uom);
  for (const jobOrder of masters.existingJobOrders) {
    index.existingByProject.set(`${jobOrder.projectId}:${codeKey(jobOrder.code)}`, jobOrder);
  }
  for (const section of masters.sections) {
    const rows = index.sectionsByDepartment.get(section.departmentId);
    if (rows) rows.push(section);
    else index.sectionsByDepartment.set(section.departmentId, [section]);
  }
  return index;
}

/** Project_ID cell of a data row. Exported so the route can scope its Job Order lookup without hard-coding the position. */
export function projectCodeOfRow(row: string[]): string {
  return (row[COLUMN.projectId] ?? "").trim();
}

export function jobOrderCodeOfRow(row: string[]): string {
  return (row[COLUMN.jobOrder] ?? "").trim();
}

/**
 * Validate every data row against the master snapshot and return the plan.
 *
 * `rows` includes the header at index 0. Row numbers in the report are 1-based and
 * count the header, so they line up with the file the operator is looking at.
 *
 * Rejected rows carry one issue per offending column (the caller must see every
 * rejected row). A row that resolves but collides with an existing Job Order is
 * either rejected (same Project + WBS + Job Order) or skipped (same Job Order
 * number in the project under a different WBS, whose budget is never overwritten).
 */
export function planJobOrderImport(rows: string[][], masters: JobOrderImportMasters): JobOrderImportPlan {
  const index = buildIndex(masters);
  const plan: JobOrderImportPlan = { total: 0, created: 0, skipped: 0, rejected: 0, create: [], skippedRows: [], errors: [] };
  /** Job Order already accepted earlier in THIS file: `${projectId}:${code}` -> row number. */
  const seenInFile = new Map<string, number>();

  for (let i = 1; i < rows.length; i++) {
    const rowNumber = i + 1;
    const row = rows[i];
    plan.total += 1;
    const cell = (position: number) => (row[position] ?? "").trim();
    const issues: JobOrderRowIssue[] = [];
    const reject = (column: JobOrderCsvHeader, message: string) => { issues.push({ row: rowNumber, column, message }); };

    // Formula injection: a cell starting with =, +, - or @ that is not a plain
    // number. A signed number stays data so `-5` is reported as a negative Qty.
    const injected = findCsvInjectionIndex(row);
    if (injected >= 0) {
      plan.rejected += 1;
      plan.errors.push({
        row: rowNumber,
        column: JOB_ORDER_CSV_HEADERS[injected] ?? "",
        message: `cell '${(row[injected] ?? "").trim()}' starts with =, +, -, or @ (possible CSV injection); row rejected.`,
      });
      continue;
    }

    const projectCode = cell(COLUMN.projectId);
    const projectName = cell(COLUMN.projectName);
    const wbsCode = cell(COLUMN.wbsNo);
    const networkCode = cell(COLUMN.networkId);
    const jobOrderCode = cell(COLUMN.jobOrder);
    const description = cell(COLUMN.jobDescription);
    const uomCode = cell(COLUMN.uom);
    const departmentCell = cell(COLUMN.department);
    const sectionCell = cell(COLUMN.section);
    const statusCell = cell(COLUMN.status);

    // --- Project: the code must exist and the row must name it correctly ---
    const project = projectCode ? index.projectByCode.get(codeKey(projectCode)) ?? null : null;
    if (!projectCode) reject("Project_ID", "Project_ID is required.");
    else if (!project) reject("Project_ID", `unknown Project_ID '${projectCode}'; the Project master has no such code. An upload never creates a Project.`);
    if (!projectName) reject("Project_Name", "Project_Name is required.");
    else if (project && nameKey(project.name) !== nameKey(projectName)) {
      reject("Project_Name", `Project_Name '${projectName}' does not match Project_ID '${project.code}' (master name '${project.name}').`);
    }

    // --- WBS_NO: scoped to that project, never created by the upload ---
    const wbs = project && wbsCode ? index.wbsByProject.get(`${project.id}:${codeKey(wbsCode)}`) ?? null : null;
    if (!wbsCode) reject("WBS_NO", "WBS_NO is required.");
    else if (project && !wbs) reject("WBS_NO", `unknown WBS_NO '${wbsCode}' under Project_ID '${project.code}'. An upload never creates a WBS.`);

    // --- Network_ID: scoped to that project, never created by the upload ---
    const network = project && networkCode ? index.networkByProject.get(`${project.id}:${codeKey(networkCode)}`) ?? null : null;
    if (!networkCode) reject("Network_ID", "Network_ID is required.");
    else if (project && !network) reject("Network_ID", `unknown Network_ID '${networkCode}' in Project_ID '${project.code}'; a Network belongs to one project only. An upload never creates a Network.`);
    else if (project && network && !network.active) reject("Network_ID", `Network_ID '${network.code}' is inactive in Project_ID '${project.code}'.`);

    // --- UoM master ---
    const uom = uomCode ? index.uomByCode.get(codeKey(uomCode)) ?? null : null;
    if (!uomCode) reject("UoM", "UoM is required.");
    else if (!uom) reject("UoM", `unknown UoM '${uomCode}'; the UoM master has no such code.`);
    else if (!uom.active) reject("UoM", `UoM '${uom.code}' is inactive.`);

    if (!jobOrderCode) reject("Job_Order", "Job_Order is required.");
    if (!description) reject("Job_Description", "Job_Description is required.");

    // --- Department (full master name, whitespace and hyphen tolerant) ---
    const department = departmentCell ? resolveDepartment(masters.departments, departmentCell) : null;
    if (!departmentCell) reject("Department", "Department is required; use the full master name, for example 'BuName - Workmen Division'.");
    else if (!department) reject("Department", `unknown Department '${departmentCell}'. Use the full master name as the master holds it, for example 'BuName - Workmen Division'.`);
    else if (!department.active) reject("Department", `Department '${department.name}' is inactive.`);

    // --- Section: under that department, required unless the project is the non-project row ---
    const section = department && sectionCell
      ? index.sectionsByDepartment.get(department.id)?.find((candidate) => nameKey(candidate.name) === nameKey(sectionCell)) ?? null
      : null;
    if (sectionCell) {
      if (department && !section) reject("Section", `unknown Section '${sectionCell}' under Department '${department.name}'.`);
      else if (section && !section.active) reject("Section", `Section '${section.name}' is inactive.`);
    } else if (project && !project.isNonProject) {
      reject("Section", "Section is required for a Job Order on a project; only the non-project Project may omit it.");
    }

    // --- Job_Order_Status: Active | In-Active ---
    const status = parseJobOrderStatus(statusCell);
    if (!statusCell) reject("Job_Order_Status", "Job_Order_Status is required; use Active or In-Active.");
    else if (!status) reject("Job_Order_Status", `unknown Job_Order_Status '${statusCell}'; use Active or In-Active.`);

    // --- Qty and Budgeted_hours: numbers >= 0 (a blank cell means no budget yet) ---
    const qty = parseNonNegativeNumber(cell(COLUMN.qty));
    if (!qty.ok) reject("Qty", qty.message);
    const budgetedHours = parseNonNegativeNumber(cell(COLUMN.budgetedHours));
    if (!budgetedHours.ok) reject("Budgeted_hours", budgetedHours.message);

    if (!project || !wbs || !network || !uom || !department || !status || !qty.ok || !budgetedHours.ok) {
      // Every unresolvable value above already pushed an issue; the fallback keeps the
      // promise that a rejected row is always reported.
      if (!issues.length) {
        issues.push({ row: rowNumber, column: "", message: "row could not be validated against the master data." });
      }
      plan.rejected += 1;
      plan.errors.push(...issues);
      continue;
    }
    if (issues.length) {
      plan.rejected += 1;
      plan.errors.push(...issues);
      continue;
    }

    // --- Duplicate rule: Project_ID + WBS_NO + Job_Order must not already exist ---
    const duplicateKey = `${project.id}:${codeKey(jobOrderCode)}`;
    const existing = index.existingByProject.get(duplicateKey) ?? null;
    if (existing && codeKey(existing.wbsCode) === codeKey(wbs.wbsCode)) {
      plan.rejected += 1;
      plan.errors.push({
        row: rowNumber,
        column: "Job_Order",
        message: `Job Order '${jobOrderCode}' already exists in Project_ID '${project.code}' under WBS_NO '${existing.wbsCode}'; `
          + "the Project_ID + WBS_NO + Job_Order combination is a duplicate.",
      });
      continue;
    }
    // Same Job Order number in the project under a DIFFERENT WBS: the row is not a
    // duplicate of that triple, and creating it would break the per-project
    // uniqueness, so it is skipped and reported. Its budget is never overwritten.
    if (existing) {
      plan.skipped += 1;
      plan.skippedRows.push({
        row: rowNumber,
        column: "Job_Order",
        message: `Job Order '${jobOrderCode}' already exists in Project_ID '${project.code}' under WBS_NO '${existing.wbsCode}'; `
          + "skipped, the existing Job Order and its budget were left untouched.",
      });
      continue;
    }
    const earlierRow = seenInFile.get(duplicateKey);
    if (earlierRow !== undefined) {
      plan.rejected += 1;
      plan.errors.push({
        row: rowNumber,
        column: "Job_Order",
        message: `Job Order '${jobOrderCode}' already appears in this file for Project_ID '${project.code}' (row ${earlierRow}); `
          + "a Job Order number may appear only once per project.",
      });
      continue;
    }

    // A standing / Non-Project Job Order is matched on department alone, so it is
    // stored WITHOUT a section (any section of the department may book it). A
    // Section supplied on such a row is still validated above and echoed back as
    // null, never stored silently.
    const storedSection = project.isNonProject ? null : section;

    plan.create.push({
      row: rowNumber,
      projectId: project.id,
      projectCode: project.code,
      projectName: project.name,
      projectWbsId: wbs.id,
      wbsCode: wbs.wbsCode,
      networkId: network.id,
      networkCode: network.code,
      code: jobOrderCode,
      name: description,
      uomId: uom.id,
      uomCode: uom.code,
      budgetedQuantity: qty.value,
      budgetedHours: budgetedHours.value,
      departmentId: department.id,
      departmentName: department.name,
      sectionId: storedSection?.id ?? null,
      sectionName: storedSection?.name ?? null,
      status,
    });
    plan.created += 1;
    seenInFile.set(duplicateKey, rowNumber);
  }

  plan.errors.sort((a, b) => a.row - b.row);
  plan.skippedRows.sort((a, b) => a.row - b.row);
  return plan;
}
