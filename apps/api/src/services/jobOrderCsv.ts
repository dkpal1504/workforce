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
 *  - Auto-creation is narrow and explicit. A WBS_NO or Network_ID that is missing
 *    under the row's project is CREATED when `createMissingMasters` is on (the
 *    default) and the row is imported; with the flag off such a row is rejected
 *    with the old message. A missing PROJECT, UoM, Department or Section always
 *    rejects the row and names what is missing: a Project requires a unique colour
 *    key the template does not carry, the UoM master carries an example string used
 *    as on-screen help, and departments / sections come from the badge sync.
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

/**
 * Placeholder id for a master this plan creates. A `create` entry carries it in
 * `projectWbsId` / `networkId` until the route has inserted the master, then the
 * route replaces it with the real id (keyed on project + code). A real
 * autoincrement id is always >= 1, so the placeholder can never be stored by
 * accident.
 */
export const PENDING_MASTER_ID = -1;

/**
 * Index key for a project-scoped code (WBS_NO, Network_ID, Job Order). Codes are
 * compared case- and whitespace-insensitively, so the same WBS typed two ways is
 * one master.
 */
export function projectScopedKey(projectId: number, code: string): string {
  return `${projectId}:${codeKey(code)}`;
}

/** A WBS master this plan creates, reported with the file row that introduced it. */
export type PlannedWbsCreation = {
  /** 1-based file row (the header is row 1) of the FIRST row that named this WBS_NO. */
  row: number;
  projectId: number;
  projectCode: string;
  /** The WBS_NO as the row typed it (trimmed): the value the new master stores. */
  wbsCode: string;
};

/** A Network master this plan creates, reported with the file row that introduced it. */
export type PlannedNetworkCreation = {
  /** 1-based file row (the header is row 1) of the FIRST row that named this Network_ID. */
  row: number;
  projectId: number;
  projectCode: string;
  /** The Network_ID as the row typed it (trimmed): the value the new master stores. */
  networkCode: string;
};

/**
 * Import options.
 *
 * `createMissingMasters` defaults to TRUE, because the operator asked for a Job
 * Work upload to be able to create a missing WBS / Network master. Setting it to
 * false restores the strict behaviour: the row is rejected and the message names
 * the missing master. A Project, UoM, Department or Section is never created,
 * either way.
 */
export type JobOrderImportOptions = {
  createMissingMasters?: boolean;
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
  /**
   * Missing WBS rows to insert BEFORE the Job Orders, one entry per distinct
   * (project, WBS_NO) named by an accepted row, in file order, each carrying the
   * row that introduced it. Empty when `createMissingMasters` is false.
   */
  wbsToCreate: PlannedWbsCreation[];
  /** Missing Network rows to insert before the Job Orders, deduped the same way. */
  networksToCreate: PlannedNetworkCreation[];
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
  for (const wbs of masters.wbsRows) index.wbsByProject.set(projectScopedKey(wbs.projectId, wbs.wbsCode), wbs);
  for (const network of masters.networks) index.networkByProject.set(projectScopedKey(network.projectId, network.code), network);
  for (const uom of masters.uoms) index.uomByCode.set(codeKey(uom.code), uom);
  for (const jobOrder of masters.existingJobOrders) {
    index.existingByProject.set(projectScopedKey(jobOrder.projectId, jobOrder.code), jobOrder);
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
 * Result of resolving one master-data cell for one row.
 *
 *  - `resolved` the master exists (or this plan already decided to create it, in
 *    which case `pending` is true and `master.id` is PENDING_MASTER_ID).
 *  - `create`   the master does not exist and auto-creation is on, so the plan
 *    must create `code` and then import the row that asked for it.
 *  - `reject`   the row must be refused, with `message` as the reason.
 */
export type MasterResolution<T> =
  | { outcome: "resolved"; master: T; pending: boolean }
  | { outcome: "create"; code: string }
  | { outcome: "reject"; message: string };

/**
 * SEAM 1 of 2 - may this WBS_NO be used by this row, and if not what must be
 * created?
 *
 * A WBS is scoped to the PROJECT today: the master is unique on
 * (projectId, wbsCode), so the same code in another project is a different WBS.
 * This function is the ONLY place that rule lives, so re-scoping a WBS later
 * (for example also keying it on a network or on the row's project name) is a
 * contained edit here plus the index it is handed.
 */
export type WbsResolutionContext = {
  project: ProjectRef;
  /** The WBS_NO cell, as the row typed it. */
  wbsCode: string;
  /** Existing WBS masters, keyed by `projectScopedKey`. */
  wbsByProject: ReadonlyMap<string, WbsRef>;
  /** Masters this plan already decided to create, so a second row does not re-create one. */
  pendingKeys: ReadonlySet<string>;
  createMissingMasters: boolean;
};

export function resolveWbsForRow(context: WbsResolutionContext): MasterResolution<WbsRef> {
  const code = context.wbsCode.trim();
  if (!code) return { outcome: "reject", message: "WBS_NO is required." };
  const key = projectScopedKey(context.project.id, code);
  const existing = context.wbsByProject.get(key);
  if (existing) return { outcome: "resolved", master: existing, pending: false };
  if (context.pendingKeys.has(key)) {
    return {
      outcome: "resolved",
      pending: true,
      master: { id: PENDING_MASTER_ID, projectId: context.project.id, wbsCode: code, active: true },
    };
  }
  if (!context.createMissingMasters) {
    return {
      outcome: "reject",
      message: `unknown WBS_NO '${code}' under Project_ID '${context.project.code}'. An upload never creates a WBS.`,
    };
  }
  return { outcome: "create", code };
}

/**
 * SEAM 2 of 2 - may this Network_ID be used by this row, and if not what must be
 * created?
 *
 * A Network is scoped to the PROJECT today, exactly as before: the master is
 * unique on (projectId, code), so the same code in another project is a different
 * Network. The user has asked whether a Network should instead sit INSIDE a WBS
 * of the project. That is not decided, so the scope stays the project and this
 * function is the single place to change it: it already receives the `wbs` the
 * row resolved to, and `networkByProject` is the only look-up it performs, so a
 * WBS-scoped rule is a small, contained edit here.
 */
export type NetworkResolutionContext = {
  project: ProjectRef;
  /** The WBS the row resolved to when it is an existing master (null for a pending one). */
  wbs: WbsRef | null;
  /** The Network_ID cell, as the row typed it. */
  networkCode: string;
  /** Existing Network masters, keyed by `projectScopedKey`. */
  networkByProject: ReadonlyMap<string, NetworkRef>;
  /** Masters this plan already decided to create. */
  pendingKeys: ReadonlySet<string>;
  createMissingMasters: boolean;
};

export function resolveNetworkForRow(context: NetworkResolutionContext): MasterResolution<NetworkRef> {
  const code = context.networkCode.trim();
  if (!code) return { outcome: "reject", message: "Network_ID is required." };
  const key = projectScopedKey(context.project.id, code);
  const existing = context.networkByProject.get(key);
  if (existing) {
    if (!existing.active) {
      return {
        outcome: "reject",
        message: `Network_ID '${existing.code}' is inactive in Project_ID '${context.project.code}'.`,
      };
    }
    return { outcome: "resolved", master: existing, pending: false };
  }
  if (context.pendingKeys.has(key)) {
    return {
      outcome: "resolved",
      pending: true,
      master: { id: PENDING_MASTER_ID, projectId: context.project.id, code, active: true },
    };
  }
  if (!context.createMissingMasters) {
    return {
      outcome: "reject",
      message: `unknown Network_ID '${code}' in Project_ID '${context.project.code}'; a Network belongs to one project only. `
        + "An upload never creates a Network.",
    };
  }
  return { outcome: "create", code };
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
 *
 * A missing WBS / Network on an ACCEPTED row is not a rejection: with
 * `createMissingMasters` (default true) the master to insert is listed in
 * `wbsToCreate` / `networksToCreate` and the row carries PENDING_MASTER_ID in the
 * matching id column, so the route can create the master in the same transaction
 * as the Job Orders. Masters are deduped inside the plan, so two rows that name
 * the same new code produce one entry, carrying the first row's number.
 */
export function planJobOrderImport(
  rows: string[][],
  masters: JobOrderImportMasters,
  options: JobOrderImportOptions = {}
): JobOrderImportPlan {
  const createMissingMasters = options.createMissingMasters !== false;
  const index = buildIndex(masters);
  const plan: JobOrderImportPlan = {
    total: 0,
    created: 0,
    skipped: 0,
    rejected: 0,
    create: [],
    skippedRows: [],
    errors: [],
    wbsToCreate: [],
    networksToCreate: [],
  };
  /** Job Order already accepted earlier in THIS file: `${projectId}:${code}` -> row number. */
  const seenInFile = new Map<string, number>();
  /**
   * Masters this plan creates, keyed by `projectScopedKey`. A master two rows
   * introduce is created once: the first accepted row that names it registers the
   * key here, every later row resolves against it, and the report keeps the first
   * row's number.
   */
  const pendingWbsKeys = new Set<string>();
  const pendingNetworkKeys = new Set<string>();

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
    else if (!project) {
      reject("Project_ID", `unknown Project_ID '${projectCode}'; the Project master has no such code, and a Project can never be created from this file: `
        + "it requires a colour key (unique, and used as the on-screen token) that the template does not carry. An upload never creates a Project.");
    }
    if (!projectName) reject("Project_Name", "Project_Name is required.");
    else if (project && nameKey(project.name) !== nameKey(projectName)) {
      reject("Project_Name", `Project_Name '${projectName}' does not match Project_ID '${project.code}' (master name '${project.name}').`);
    }

    // --- WBS_NO: scoped to that project; a missing one is created when allowed ---
    let wbs: WbsRef | null = null;
    /** Set when this row introduces a WBS nobody in this file has named yet. */
    let wbsToIntroduce: PlannedWbsCreation | null = null;
    if (project) {
      const wbsResolution = resolveWbsForRow({
        project,
        wbsCode,
        wbsByProject: index.wbsByProject,
        pendingKeys: pendingWbsKeys,
        createMissingMasters,
      });
      if (wbsResolution.outcome === "reject") reject("WBS_NO", wbsResolution.message);
      else if (wbsResolution.outcome === "create") {
        // The id does not exist until the route inserts the master, so the row
        // carries PENDING_MASTER_ID and the code the route must create.
        wbs = { id: PENDING_MASTER_ID, projectId: project.id, wbsCode: wbsResolution.code, active: true };
        wbsToIntroduce = {
          row: rowNumber,
          projectId: project.id,
          projectCode: project.code,
          wbsCode: wbsResolution.code,
        };
      } else {
        wbs = wbsResolution.master;
      }
    } else if (!wbsCode) {
      // The unknown Project is already reported; without it a WBS cannot resolve.
      reject("WBS_NO", "WBS_NO is required.");
    }

    // --- Network_ID: scoped to that project; a missing one is created when allowed ---
    let network: NetworkRef | null = null;
    let networkToIntroduce: PlannedNetworkCreation | null = null;
    if (project) {
      const networkResolution = resolveNetworkForRow({
        project,
        wbs: wbs && wbs.id !== PENDING_MASTER_ID ? wbs : null,
        networkCode,
        networkByProject: index.networkByProject,
        pendingKeys: pendingNetworkKeys,
        createMissingMasters,
      });
      if (networkResolution.outcome === "reject") reject("Network_ID", networkResolution.message);
      else if (networkResolution.outcome === "create") {
        network = { id: PENDING_MASTER_ID, projectId: project.id, code: networkResolution.code, active: true };
        networkToIntroduce = {
          row: rowNumber,
          projectId: project.id,
          projectCode: project.code,
          networkCode: networkResolution.code,
        };
      } else {
        network = networkResolution.master;
      }
    } else if (!networkCode) {
      reject("Network_ID", "Network_ID is required.");
    }

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

    // The row is accepted, so the masters IT introduced are created with it. A
    // rejected or skipped row introduces nothing: no master is created for a row
    // that creates no Job Order. The first accepted row that names a new master
    // registers it; later rows resolve against `pendingKeys` and add no entry.
    if (wbsToIntroduce) {
      pendingWbsKeys.add(projectScopedKey(wbsToIntroduce.projectId, wbsToIntroduce.wbsCode));
      plan.wbsToCreate.push(wbsToIntroduce);
    }
    if (networkToIntroduce) {
      pendingNetworkKeys.add(projectScopedKey(networkToIntroduce.projectId, networkToIntroduce.networkCode));
      plan.networksToCreate.push(networkToIntroduce);
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
