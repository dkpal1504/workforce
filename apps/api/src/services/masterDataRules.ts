/**
 * Pure validation and duplicate rules for the Project / WBS / UoM / Network
 * masters. Nothing in this module touches the database: the route layer supplies
 * the existing rows, so every rule is unit-testable without a database.
 *
 * The rules themselves are fixed by docs/MASTER_DATA_BUILD_CONTRACT.md:
 *
 *   projects      code unique; color_key 1-4 characters, uppercase, unique across
 *                 all projects; name required.
 *   project_wbs   wbs_code unique PER PROJECT; project_id must exist.
 *   uom           code uppercase unique; name required; `example` is the on-screen
 *                 help string shown next to the field.
 *   networks      code unique PER PROJECT; a Network belongs to ONE WBS element of
 *                 that project (one Network number never spans two WBS rows);
 *                 the parent WBS must be active; source stays 'MANUAL'.
 */

export type FieldError = { field: string; message: string };
export type Validation<T> = { ok: true; data: T } | { ok: false; errors: FieldError[] };

/** A row shape that is enough to detect a conflicting master row. */
export type ProjectRow = { id: number; code: string; name: string; colorKey: string };
/**
 * `active` is only read to refuse an inactive WBS as a Network's parent; an omitted flag
 * means active, so an older caller that does not select it still works. `projectCode` and
 * `projectName` are optional and only make a refusal name the WBS's own project.
 */
export type WbsRow = {
  id: number;
  projectId: number;
  wbsCode: string;
  name?: string | null;
  active?: boolean;
  projectCode?: string | null;
  projectName?: string | null;
};
export type UomRow = { id: number; code: string; name: string; example?: string | null };
export type NetworkRow = { id: number; projectId: number; code: string; name?: string | null; wbsId?: number | null };

/** The one source a manually maintained Network row ever carries. */
export const NETWORK_SOURCE = "MANUAL";

/** Colour key: the short token shown on Timesheet Entry and Project Summary. */
export const COLOR_KEY_PATTERN = /^[A-Z0-9]{1,4}$/;
export const COLOR_KEY_HINT = 'Use 1-4 characters, uppercase letters or digits, for example "A" or "B2".';

/** Codes are stored uppercase; these patterns only reject characters that would
 *  make a code unreadable or unsafe in a CSV round-trip. */
const CODE_PATTERN = /^[A-Z0-9][A-Z0-9._/-]*$/;
const WBS_CODE_PATTERN = /^[A-Z0-9][A-Z0-9._-]*$/;

/** Literal examples for the maintenance screen help text. */
export const PROJECT_CODE_EXAMPLE = "PRJ-A";
export const PROJECT_NAME_EXAMPLE = "Project A";
export const PROJECT_COLOR_KEY_EXAMPLE = "A";
export const WBS_CODE_EXAMPLE = "A.HULL.0010.100";
export const WBS_NAME_EXAMPLE = "Hull structure";
export const UOM_CODE_EXAMPLE = "NOS";
export const UOM_NAME_EXAMPLE = "Numbers";
export const UOM_EXAMPLE_PLACEHOLDER = "Count of pieces, e.g. 12 spools";
export const NETWORK_CODE_EXAMPLE = "SAP-NW-91001";
export const NETWORK_NAME_EXAMPLE = "Hull networks";

const MAX_CODE_LENGTH = 40;
const MAX_WBS_CODE_LENGTH = 60;
const MAX_NAME_LENGTH = 120;

export function normalizeCode(raw: unknown): string {
  return String(raw ?? "").trim().toUpperCase();
}

/** Free text (names, help strings): trimmed, inner whitespace collapsed. */
export function normalizeText(raw: unknown): string {
  return String(raw ?? "").trim().replace(/\s+/g, " ");
}

export function normalizeColorKey(raw: unknown): string {
  return String(raw ?? "").trim().toUpperCase();
}

export function isValidColorKey(raw: unknown): boolean {
  return COLOR_KEY_PATTERN.test(normalizeColorKey(raw));
}

export function colorKeyError(raw: unknown): FieldError | null {
  const value = normalizeColorKey(raw);
  if (!value) return { field: "colorKey", message: `Colour key is required. ${COLOR_KEY_HINT}` };
  if (!COLOR_KEY_PATTERN.test(value)) {
    return { field: "colorKey", message: `Colour key "${value}" is invalid. ${COLOR_KEY_HINT}` };
  }
  return null;
}

function optionalBoolean(raw: unknown, fallback: boolean): boolean | FieldError {
  if (raw === undefined || raw === null || raw === "") return fallback;
  if (typeof raw === "boolean") return raw;
  if (raw === "true") return true;
  if (raw === "false") return false;
  return { field: "isNonProject", message: "Non-project must be true or false." };
}

function optionalSortOrder(raw: unknown, fallback: number): number | FieldError {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    return { field: "sortOrder", message: "Sort order must be a whole number of 0 or more, for example 1." };
  }
  return value;
}

function codeError(field: string, value: string, label: string, maxLength: number, example: string, pattern: RegExp): FieldError | null {
  if (!value) return { field, message: `${label} is required, for example "${example}".` };
  if (value.length > maxLength) return { field, message: `${label} must be ${maxLength} characters or fewer.` };
  if (!pattern.test(value)) {
    return { field, message: `${label} may use letters, digits, dot, underscore and hyphen only, for example "${example}".` };
  }
  return null;
}

function nameError(field: string, value: string, label: string, example: string): FieldError | null {
  if (!value) return { field, message: `${label} is required, for example "${example}".` };
  if (value.length > MAX_NAME_LENGTH) return { field, message: `${label} must be ${MAX_NAME_LENGTH} characters or fewer.` };
  return null;
}

export type ProjectInput = {
  code: string;
  name: string;
  colorKey: string;
  isNonProject: boolean;
  sortOrder: number;
};

/**
 * Validate a Project payload. The caller merges missing fields with the stored
 * row before calling this, so an update never has to resend every field.
 */
export function validateProjectInput(payload: Record<string, unknown>): Validation<ProjectInput> {
  const code = normalizeCode(payload.code);
  const name = normalizeText(payload.name);
  const colorKey = normalizeColorKey(payload.colorKey);
  const errors: FieldError[] = [];

  const codeIssue = codeError("code", code, "Project code", MAX_CODE_LENGTH, PROJECT_CODE_EXAMPLE, CODE_PATTERN);
  if (codeIssue) errors.push(codeIssue);
  const nameIssue = nameError("name", name, "Project name", PROJECT_NAME_EXAMPLE);
  if (nameIssue) errors.push(nameIssue);
  const keyIssue = colorKeyError(colorKey);
  if (keyIssue) errors.push(keyIssue);

  const nonProject = optionalBoolean(payload.isNonProject, false);
  if (typeof nonProject === "boolean") {
    // fine
  } else {
    errors.push(nonProject);
  }
  const sortOrder = optionalSortOrder(payload.sortOrder, 0);
  if (typeof sortOrder !== "number") errors.push(sortOrder);

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    data: {
      code,
      name,
      colorKey,
      isNonProject: nonProject as boolean,
      sortOrder: sortOrder as number,
    },
  };
}

export type WbsInput = { wbsCode: string; name: string | null; sortOrder: number };

export function validateWbsInput(payload: Record<string, unknown>): Validation<WbsInput> {
  const wbsCode = normalizeCode(payload.wbsCode);
  const name = normalizeText(payload.name);
  const errors: FieldError[] = [];

  const codeIssue = codeError("wbsCode", wbsCode, "WBS code", MAX_WBS_CODE_LENGTH, WBS_CODE_EXAMPLE, WBS_CODE_PATTERN);
  if (codeIssue) errors.push(codeIssue);
  if (name.length > MAX_NAME_LENGTH) {
    errors.push({ field: "name", message: `WBS name must be ${MAX_NAME_LENGTH} characters or fewer.` });
  }
  const sortOrder = optionalSortOrder(payload.sortOrder, 0);
  if (typeof sortOrder !== "number") errors.push(sortOrder);

  if (errors.length) return { ok: false, errors };
  return { ok: true, data: { wbsCode, name: name || null, sortOrder: sortOrder as number } };
}

export type UomInput = { code: string; name: string; example: string | null };

export function validateUomInput(payload: Record<string, unknown>): Validation<UomInput> {
  const code = normalizeCode(payload.code);
  const name = normalizeText(payload.name);
  const example = normalizeText(payload.example);
  const errors: FieldError[] = [];

  const codeIssue = codeError("code", code, "UoM code", MAX_CODE_LENGTH, UOM_CODE_EXAMPLE, CODE_PATTERN);
  if (codeIssue) errors.push(codeIssue);
  const nameIssue = nameError("name", name, "UoM name", UOM_NAME_EXAMPLE);
  if (nameIssue) errors.push(nameIssue);
  if (example.length > 160) {
    errors.push({ field: "example", message: "The example must be 160 characters or fewer." });
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, data: { code, name, example: example || null } };
}

export type NetworkInput = { wbsId: number; code: string; name: string | null; source: typeof NETWORK_SOURCE };

/**
 * A Network payload. `wbsId` is REQUIRED: one Network number never spans two WBS
 * elements of a project, so every Network row points at exactly one WBS row. The
 * WBS is only checked for shape here; `resolveNetworkWbs` decides whether that WBS
 * exists, belongs to the right project and is still active.
 */
export function validateNetworkInput(payload: Record<string, unknown>): Validation<NetworkInput> {
  const wbsId = payload.wbsId === undefined || payload.wbsId === null || payload.wbsId === "" ? NaN : Number(payload.wbsId);
  const code = normalizeCode(payload.code);
  const name = normalizeText(payload.name);
  const errors: FieldError[] = [];

  if (!Number.isInteger(wbsId) || wbsId <= 0) {
    errors.push({ field: "wbsId", message: networkWbsRequiredMessage() });
  }
  const codeIssue = codeError("code", code, "Network code", MAX_CODE_LENGTH, NETWORK_CODE_EXAMPLE, CODE_PATTERN);
  if (codeIssue) errors.push(codeIssue);
  if (name.length > MAX_NAME_LENGTH) {
    errors.push({ field: "name", message: `Network name must be ${MAX_NAME_LENGTH} characters or fewer.` });
  }

  if (errors.length) return { ok: false, errors };
  // A manually maintained row is always MANUAL: SAP-sourced rows are written by
  // the ERP feed, never by this screen, so a client value is ignored.
  return { ok: true, data: { wbsId, code, name: name || null, source: NETWORK_SOURCE } };
}

/** The source a Network row is written with, whatever the client asked for. */
export function networkSourceForWrite(_requested?: unknown): typeof NETWORK_SOURCE {
  return NETWORK_SOURCE;
}

/* ---------------------------------------------------------------------------
   A Network belongs to ONE WBS element.

   Confirmed by the user: one Network number cannot span two WBS elements of the
   same project. The WBS decides which project the Network lives in, so a WBS from
   another project is a client error (the URL project and the WBS disagree), not a
   missing row.
   --------------------------------------------------------------------------- */

/** The parent project of a WBS, reduced to what the messages need. */
export type ProjectRef = { id: number; code: string; name: string };

export function networkWbsRequiredMessage(): string {
  return "A WBS row is required. One Network number cannot span two WBS elements of a project, so every Network belongs to exactly one WBS.";
}

export function networkWbsNotFoundMessage(wbsId: number): string {
  return `WBS row #${wbsId} was not found. Pick one of the WBS rows of this project.`;
}

export function networkWbsOtherProjectMessage(wbs: WbsRow, project: ProjectRef): string {
  // Name the other project by code when the caller supplied it; fall back to its id.
  const owner = wbs.projectCode
    ? `project "${wbs.projectName ?? wbs.projectCode}" (${wbs.projectCode})`
    : `project #${wbs.projectId}`;
  return `WBS "${wbs.wbsCode}" belongs to ${owner}, not to project "${project.name}" (${project.code}). The WBS decides the project, so pick a WBS of ${project.code}.`;
}

export function networkWbsInactiveMessage(wbs: WbsRow): string {
  return `WBS "${wbs.wbsCode}" is inactive, so it cannot own a Network. Pick an active WBS row, or activate this one on the WBS tab.`;
}

export type NetworkWbsResolution = { ok: true; wbs: WbsRow } | { ok: false; error: FieldError };

/**
 * Decide whether `rawWbsId` may be the parent of a Network of `project`.
 * `rows` holds every WBS row (not only the project's), so a WBS of another
 * project is reported as exactly that instead of being called missing.
 */
export function resolveNetworkWbs(rows: WbsRow[], project: ProjectRef, rawWbsId: unknown): NetworkWbsResolution {
  const wbsId = rawWbsId === undefined || rawWbsId === null || rawWbsId === "" ? NaN : Number(rawWbsId);
  if (!Number.isInteger(wbsId) || wbsId <= 0) {
    return { ok: false, error: { field: "wbsId", message: networkWbsRequiredMessage() } };
  }
  const wbs = rows.find((row) => row.id === wbsId);
  if (!wbs) return { ok: false, error: { field: "wbsId", message: networkWbsNotFoundMessage(wbsId) } };
  if (wbs.projectId !== project.id) {
    return { ok: false, error: { field: "wbsId", message: networkWbsOtherProjectMessage(wbs, project) } };
  }
  if (wbs.active === false) return { ok: false, error: { field: "wbsId", message: networkWbsInactiveMessage(wbs) } };
  return { ok: true, wbs };
}

/* ---------------------------------------------------------------------------
   Duplicate detection
   --------------------------------------------------------------------------- */

function sameCode(left: string, right: string): boolean {
  return normalizeCode(left) === normalizeCode(right);
}

function isSameRow(rowId: number, excludeId?: number | null): boolean {
  return excludeId != null && rowId === excludeId;
}

/** A project with the same code, ignoring the row being edited. */
export function findProjectCodeConflict(rows: ProjectRow[], code: string, excludeId?: number | null): ProjectRow | null {
  return rows.find((row) => !isSameRow(row.id, excludeId) && sameCode(row.code, code)) ?? null;
}

/** A project that already owns the colour key, ignoring the row being edited. */
export function findColorKeyConflict(rows: ProjectRow[], colorKey: string, excludeId?: number | null): ProjectRow | null {
  return rows.find((row) => !isSameRow(row.id, excludeId) && sameCode(row.colorKey, colorKey)) ?? null;
}

/** A WBS row with the same code INSIDE the same project. */
export function findWbsCodeConflict(rows: WbsRow[], projectId: number, wbsCode: string, excludeId?: number | null): WbsRow | null {
  return rows.find((row) => !isSameRow(row.id, excludeId) && row.projectId === projectId && sameCode(row.wbsCode, wbsCode)) ?? null;
}

export function findUomCodeConflict(rows: UomRow[], code: string, excludeId?: number | null): UomRow | null {
  return rows.find((row) => !isSameRow(row.id, excludeId) && sameCode(row.code, code)) ?? null;
}

/** A Network row with the same code INSIDE the same project. */
export function findNetworkCodeConflict(rows: NetworkRow[], projectId: number, code: string, excludeId?: number | null): NetworkRow | null {
  return rows.find((row) => !isSameRow(row.id, excludeId) && row.projectId === projectId && sameCode(row.code, code)) ?? null;
}

/* ---------------------------------------------------------------------------
   Conflict messages. Every one of them NAMES the row it collided with, so the
   screen can show the user exactly which record to look at.
   --------------------------------------------------------------------------- */

export function projectLabel(project: { code: string; name: string }): string {
  return `project "${project.name}" (${project.code})`;
}

export function projectCodeConflictMessage(conflict: ProjectRow): string {
  return `Project code "${conflict.code}" is already used by project "${conflict.name}" (project #${conflict.id}). Project codes are unique.`;
}

export function colorKeyConflictMessage(conflict: ProjectRow): string {
  return `Colour key "${conflict.colorKey}" is already used by project "${conflict.name}" (${conflict.code}, project #${conflict.id}). Colour keys are unique across all projects.`;
}

export function wbsCodeConflictMessage(conflict: WbsRow, project: { code: string; name: string }): string {
  return `WBS code "${conflict.wbsCode}" already exists in project "${project.name}" (${project.code}, WBS #${conflict.id}). WBS codes are unique inside one project.`;
}

export function uomCodeConflictMessage(conflict: UomRow): string {
  return `UoM code "${conflict.code}" is already used by "${conflict.name}" (uom #${conflict.id}). UoM codes are unique.`;
}

export function networkCodeConflictMessage(conflict: NetworkRow, project: { code: string; name: string }): string {
  return `Network code "${conflict.code}" already exists in project "${project.name}" (${project.code}, network #${conflict.id}). Network codes are unique inside one project.`;
}

/** A delete is refused while other rows point at the master row. */
/**
 * Retiring a Project is a two-step decision: every Job Order of that project must be
 * In-Active FIRST.
 *
 * Why: a Job Order is what hours are booked against, and the booking picker offers the
 * ACTIVE Job Orders of the chosen project. Deactivating the project while one of its Job
 * Orders is still Active would leave a bookable Job Order behind a project that no screen
 * offers any more - the hours would be unreachable for reporting and impossible to correct
 * through the pickers. Ordering the two steps keeps `active` a fact rather than a hint.
 *
 * The refusal names the offending Job Order codes (capped, with a remainder count) and the
 * screen that changes them, so it is actionable without opening the database.
 */
export const PROJECT_HAS_ACTIVE_JOB_ORDERS = "PROJECT_HAS_ACTIVE_JOB_ORDERS";

/** How many Job Order codes a refusal names before it summarises the rest. */
export const PROJECT_DEACTIVATION_MAX_CODES = 6;

/** The active Job Orders of a project, as the refusal needs them. */
export type ActiveJobOrderRef = { code: string; wbsCode?: string | null };

/**
 * The refusal message, or null when the project may be deactivated.
 * Pure: the route passes the active Job Orders it counted.
 */
export function projectDeactivationError(
  project: { code: string; name: string },
  activeJobOrders: ActiveJobOrderRef[]
): { code: typeof PROJECT_HAS_ACTIVE_JOB_ORDERS; message: string } | null {
  if (activeJobOrders.length === 0) return null;
  const codes = activeJobOrders
    .slice(0, PROJECT_DEACTIVATION_MAX_CODES)
    .map((jobOrder) => (jobOrder.wbsCode ? `${jobOrder.code} (WBS ${jobOrder.wbsCode})` : jobOrder.code));
  const remaining = activeJobOrders.length - codes.length;
  const list = `${codes.join(", ")}${remaining > 0 ? `, and ${remaining} more` : ""}`;
  const count = activeJobOrders.length;
  return {
    code: PROJECT_HAS_ACTIVE_JOB_ORDERS,
    message:
      `Cannot deactivate ${projectLabel(project)}: it still has ${count} active Job Order${count === 1 ? "" : "s"} - ${list}. ` +
      'Set every Job Order of this project to In-Active first (Project Master Data → Job Order → status), then deactivate the project.',
  };
}

export function referencedDeleteMessage(label: string, references: Array<{ what: string; count: number }>): string {
  const parts = references.filter((reference) => reference.count > 0).map((reference) => `${reference.count} ${reference.what}`);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts.join("");
  return `${label} is referenced by ${list}. Deactivate it instead of deleting it.`;
}

/* ---------------------------------------------------------------------------
   Prisma unique-constraint fallback.

   The route layer pre-checks for duplicates and reports the conflicting row. If
   two writers race, the database still raises P2002; this turns that into the
   same family of message instead of leaking a raw Prisma error.
   --------------------------------------------------------------------------- */

export type MasterEntity = "project" | "project_wbs" | "uom" | "network" | "job_order";

export function isUniqueConstraintError(error: unknown): boolean {
  return Boolean(error) && typeof error === "object" && (error as { code?: unknown }).code === "P2002";
}

/** Normalized unique-target field names from a P2002 error (array or string). */
export function uniqueConstraintFields(error: unknown): string[] {
  const target = (error as { meta?: { target?: unknown } } | null)?.meta?.target;
  if (!target) return [];
  const raw = Array.isArray(target) ? target.join(",") : String(target);
  return raw
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter(Boolean);
}

export function prismaConflictMessage(error: unknown, entity: MasterEntity): string | null {
  if (!isUniqueConstraintError(error)) return null;
  const fields = uniqueConstraintFields(error);
  const hasColorKey = fields.some((field) => field === "color_key" || field === "colorkey");
  if (entity === "project") {
    return hasColorKey
      ? "That colour key is already used by another project. Colour keys are unique across all projects."
      : "That project code already exists. Project codes are unique.";
  }
  if (entity === "project_wbs") {
    return "That WBS code already exists in this project. WBS codes are unique inside one project.";
  }
  if (entity === "uom") {
    return "That UoM code already exists. UoM codes are unique.";
  }
  if (entity === "job_order") {
    return "That Job Order number already exists in this project. Job Order numbers are unique inside one project.";
  }
  return "That network code already exists in this project. Network codes are unique inside one project.";
}

/* ---------------------------------------------------------------------------
   Job Order placement rules (used by the ADMIN remap endpoint).
   --------------------------------------------------------------------------- */

export type WbsMoveCheck = {
  jobOrderCode: string;
  currentWbsId: number;
  targetWbsId: number;
  bookedTimesheetEntries: number;
  bookedAllocationSlots: number;
};

/**
 * A Job Order may be moved to another WBS only while it has no booked history.
 * The attribution snapshot on every booked row is frozen, so a later WBS move
 * would silently re-point live work at a different WBS.
 */
export function jobOrderWbsMoveError(check: WbsMoveCheck): string | null {
  if (check.currentWbsId === check.targetWbsId) return null;
  const booked = check.bookedTimesheetEntries + check.bookedAllocationSlots;
  if (booked === 0) return null;
  return `Job Order "${check.jobOrderCode}" already has booked hours (${check.bookedTimesheetEntries} timesheet rows, ${check.bookedAllocationSlots} allocation hours), so it cannot move to another WBS. Deactivate it and create a new Job Order instead.`;
}

/**
 * A Job Order's Network must belong to the Job Order's own WBS, not merely to its
 * project. When the request changes the WBS, the Network has to be valid for the
 * NEW WBS; otherwise the message names BOTH WBS rows, so the operator knows which
 * Network to pick instead.
 */
export type NetworkWbsMatch = {
  jobOrderCode: string;
  networkCode: string;
  networkWbsId: number;
  networkWbsCode: string;
  targetWbsId: number;
  targetWbsCode: string;
};

export function jobOrderNetworkWbsError(check: NetworkWbsMatch): string | null {
  if (check.networkWbsId === check.targetWbsId) return null;
  // "is on (or would move to)": the WBS may be the Job Order's current one (a Network-only
  // change) or the one the request would move it to. Both WBS rows are named either way.
  return `Network "${check.networkCode}" belongs to WBS "${check.networkWbsCode}", but Job Order "${check.jobOrderCode}" is on (or would move to) WBS "${check.targetWbsCode}". Pick another Network: only the Networks of WBS "${check.targetWbsCode}" are valid for this Job Order.`;
}

/** section_id is NULL only for a standing / Non-Project Job Order. */
export function jobOrderSectionError(input: { isNonProject: boolean; sectionId: number | null }): string | null {
  if (input.sectionId === null && !input.isNonProject) {
    return "A Section is required for a project Job Order. Only a standing / Non-Project Job Order may have no Section.";
  }
  return null;
}

/* ---------------------------------------------------------------------------
   Help text for the maintenance screen.
   --------------------------------------------------------------------------- */

/** The on-screen help string of a UoM code, taken from the UoM master itself. */
export function exampleForUomCode(rows: UomRow[], code: string): string | null {
  const row = rows.find((candidate) => sameCode(candidate.code, code));
  const example = normalizeText(row?.example);
  return example || null;
}

export function uomHelpText(rows: UomRow[], code: string): string {
  const example = exampleForUomCode(rows, code);
  return example ? `Example: ${normalizeCode(code)} — ${example}` : `Example: ${normalizeCode(code)}`;
}

/* ---------------------------------------------------------------------------
   Job Order budget revision (the PM revises Budget hours and Quantity).
   --------------------------------------------------------------------------- */

export type JobOrderBudgetInput = {
  budgetedHours: number;
  budgetedQuantity: number;
  reason: string | null;
};

/**
 * A revised budget must be a number of hours and a quantity, both zero or more. The two
 * figures are in the Job Order's own unit of measure and are independent: hours and
 * quantity are never blended.
 */
export function validateJobOrderBudgetInput(payload: Record<string, unknown>): Validation<JobOrderBudgetInput> {
  const errors: FieldError[] = [];
  const readNumber = (field: "budgetedHours" | "budgetedQuantity", label: string): number | null => {
    const raw = payload[field];
    if (raw === undefined || raw === null || String(raw).trim() === "") {
      errors.push({ field, message: `${label} is required.` });
      return null;
    }
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      errors.push({ field, message: `${label} must be a number.` });
      return null;
    }
    if (value < 0) {
      errors.push({ field, message: `${label} must be zero or greater.` });
      return null;
    }
    // Keep the stored value clean: two decimals is plenty for hours or a quantity.
    return Math.round(value * 100) / 100;
  };

  const budgetedHours = readNumber("budgetedHours", "Budget hours");
  const budgetedQuantity = readNumber("budgetedQuantity", "Budget quantity");
  const reason = normalizeText(payload.reason);

  if (reason.length > 240) {
    errors.push({ field: "reason", message: "The reason must be 240 characters or fewer." });
  }
  if (errors.length || budgetedHours === null || budgetedQuantity === null) {
    return { ok: false, errors: errors.length ? errors : [{ field: "budgetedHours", message: "Invalid budget." }] };
  }
  return { ok: true, data: { budgetedHours, budgetedQuantity, reason: reason || null } };
}

/**
 * The next revision number for a Job Order: one more than its highest, so the first revision
 * a PM saves after the opening budget (revision 1) is revision 2 and nothing is overwritten.
 */
export function nextBudgetRevisionNo(revisions: { revisionNo: number }[]): number {
  return revisions.reduce((highest, row) => Math.max(highest, row.revisionNo), 0) + 1;
}

/** True when a revised budget is identical to the current one, so no revision is worth writing. */
export function isUnchangedBudget(
  current: { budgetedHours: number | null; budgetedQuantity: number | null },
  next: { budgetedHours: number; budgetedQuantity: number }
): boolean {
  const round = (value: number | null | undefined) => Math.round(Number(value ?? 0) * 100) / 100;
  return round(current.budgetedHours) === round(next.budgetedHours)
    && round(current.budgetedQuantity) === round(next.budgetedQuantity);
}
