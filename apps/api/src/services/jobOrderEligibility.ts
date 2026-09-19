import { prisma } from "../db";

/**
 * Job Order assignability and the booking picker
 * (MASTER_DATA_BUILD_CONTRACT sections 1 and 4).
 *
 * A Job Order is bookable only when the Job Order itself, its Project and its
 * Department are all active. `section_id` is NULL only for standing /
 * Non-Project Job Orders: those are matched on Department alone, so any section
 * of the Department may book them. A project Job Order is bookable only by its
 * own section.
 */

/** The live master-data columns assignability reads. */
export type JobOrderEligibilitySource = {
  status: string;
  project: { active: boolean } | null;
  department: { active: boolean } | null;
};

/** The full row the picker maps into an option. */
export type SlotJobOrderSource = JobOrderEligibilitySource & {
  id: number;
  code: string;
  name: string;
  projectId: number;
  departmentId: number;
  sectionId: number | null;
  project: { active: boolean; name: string; colorKey: string } | null;
  projectWbs: { wbsCode: string } | null;
};

/** The Department + Section + Project the supervisor has selected for one slot. */
export type SlotJobOrderSelection = {
  departmentId: number;
  projectId: number;
  /** Optional: narrows the list to one section (the My Hours picker sends it). The
   *  Timesheet Entry screen omits it, so the whole department's Job Orders for that
   *  project are offered. */
  sectionId?: number;
};

/** Picker row for one Job Order. `label` is the exact display text. */
export type SlotJobOrderOption = {
  id: number;
  code: string;
  name: string;
  /** `Job_Order-Job_Description`, e.g. `1900000107-Pipe Spool Installation`. */
  label: string;
  /** WBS number, returned so the caller can disambiguate without showing it. */
  wbsNo: string | null;
  /** The live Project display token (A/B/C/D). */
  colorKey: string | null;
  projectId: number;
  projectName: string;
  sectionId: number | null;
  /** True for a standing / Non-Project Job Order with no section. */
  standing: boolean;
};

/** Active Job Order + active Project + active Department. */
export function isAssignableJobOrder(row: JobOrderEligibilitySource): boolean {
  return row.status === "active" && row.project?.active === true && row.department?.active === true;
}

/**
 * A standing Job Order (`section_id IS NULL`) is offered for any section of its
 * Department; a project Job Order only for its own section.
 */
/** A section-scoped list also accepts a standing Job Order (no section of its own). */
export function jobOrderMatchesSection(
  jobOrderSectionId: number | null,
  selectedSectionId: number
): boolean {
  return jobOrderSectionId == null || jobOrderSectionId === selectedSectionId;
}

/** The required picker text: `Job_Order-Job_Description`. */
export function jobOrderOptionLabel(jobOrder: { code: string; name: string }): string {
  return `${jobOrder.code}-${jobOrder.name}`;
}

/** Project one Job Order row into the picker option shape. */
export function toSlotJobOrderOption(row: SlotJobOrderSource): SlotJobOrderOption {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    label: jobOrderOptionLabel(row),
    wbsNo: row.projectWbs?.wbsCode ?? null,
    colorKey: row.project?.colorKey ?? null,
    projectId: row.projectId,
    projectName: row.project?.name ?? "",
    sectionId: row.sectionId,
    standing: row.sectionId == null,
  };
}

/**
 * The Job Orders offered for one Department + Section + Project, in display
 * order. Pure so the rules are unit-testable without a database.
 */
export function eligibleSlotJobOrders(
  rows: SlotJobOrderSource[],
  selection: SlotJobOrderSelection
): SlotJobOrderOption[] {
  return rows
    .filter((row) => row.departmentId === selection.departmentId)
    .filter((row) => row.projectId === selection.projectId)
    // No section given means "the whole department's Job Orders for this project".
    .filter((row) =>
      selection.sectionId === undefined ? true : jobOrderMatchesSection(row.sectionId, selection.sectionId)
    )
    .filter((row) => isAssignableJobOrder(row))
    .sort((left, right) => left.code.localeCompare(right.code) || left.id - right.id)
    .map(toSlotJobOrderOption);
}

/** Active sections of one Department, in display order. */
export async function loadDepartmentSections(departmentId: number) {
  return prisma.section.findMany({
    where: { departmentId, active: true },
    select: { id: true, code: true, name: true },
    orderBy: { name: "asc" },
  });
}

/** Read the Job Orders offered for a Department + Section + Project selection. */
export async function loadSlotJobOrders(
  selection: SlotJobOrderSelection
): Promise<SlotJobOrderOption[]> {
  const rows = await prisma.jobOrder.findMany({
    where: {
      departmentId: selection.departmentId,
      projectId: selection.projectId,
      status: "active",
      project: { active: true },
      department: { active: true },
      // A section is an OPTIONAL extra filter. The Timesheet Entry screen sends only the
      // project, because a supervisor belongs to one department and the Project alone
      // decides what they may book: every active Job Order of that project inside their
      // department (a standing Job Order with no section included). The My Hours picker
      // still sends a section, so its list stays narrowed.
      ...(Number.isInteger(selection.sectionId) && (selection.sectionId ?? 0) > 0
        ? { OR: [{ sectionId: null }, { sectionId: selection.sectionId }] }
        : {}),
    },
    select: {
      id: true,
      code: true,
      name: true,
      status: true,
      projectId: true,
      departmentId: true,
      sectionId: true,
      project: { select: { active: true, name: true, colorKey: true } },
      projectWbs: { select: { wbsCode: true } },
      // The relations are read here so `isAssignableJobOrder` can re-check the
      // same rule the query expressed, in one place.
      department: { select: { active: true } },
    },
    orderBy: { code: "asc" },
  });
  return eligibleSlotJobOrders(rows, selection);
}

/**
 * Jobs Orders that may be written on a booking, keyed by id.
 *
 * The returned Map keeps the historical shape used by the write paths: the full
 * Job Order row with its Project and Department relations.
 */
export async function assignableJobOrders(ids: number[]) {
  const uniqueIds = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))];
  const rows = uniqueIds.length ? await prisma.jobOrder.findMany({
    where: { id: { in: uniqueIds } },
    include: { project: true, department: true },
  }) : [];
  return new Map(rows.filter(isAssignableJobOrder).map((row) => [row.id, row]));
}

export function invalidJobOrderPayload() {
  return {
    error: "Work Order is not assignable: the Job Order, its Project and its Department must all be active.",
    code: "JOB_ORDER_NOT_ASSIGNABLE",
  };
}
