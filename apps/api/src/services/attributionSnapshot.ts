import { prisma } from "../db";

/**
 * Attribution snapshot (MASTER_DATA_BUILD_CONTRACT section 3).
 *
 * `timesheet_entries` and `employee_allocations` carry the four grouping
 * buckets `project_id`, `project_wbs_id`, `department_id` and `section_id`.
 * They are captured from the chosen Job Order when hours are booked and are
 * used as the grouping keys of every report.
 *
 * The snapshot is FROZEN: a later master-data change (a Job Order remap, a
 * Project/WBS edit) must never move approved history. Labels such as
 * `Project.name` and `Project.colorKey` stay live and are read through the
 * live relation instead.
 *
 * A snapshot may therefore legally differ from the live Job Order, and no
 * composite key ties the two together.
 */
export type AttributionSnapshot = {
  projectId: number | null;
  projectWbsId: number | null;
  departmentId: number | null;
  sectionId: number | null;
};

/** The four buckets of a booking that has no resolvable Job Order. */
export const EMPTY_ATTRIBUTION_SNAPSHOT: AttributionSnapshot = Object.freeze({
  projectId: null,
  projectWbsId: null,
  departmentId: null,
  sectionId: null,
});

/** The live master-data columns a snapshot is resolved from. */
export type JobOrderAttributionSource = {
  id: number;
  projectId: number;
  projectWbsId: number;
  departmentId: number;
  sectionId: number | null;
};

/**
 * Bucket values to use when the booking carries no Job Order (the payroll
 * "My Hours" path allows an optional Job Order). The Project comes from the
 * screen; the Department/Section come from the employee's own organisation,
 * because there is no Job Order to attribute the hours to.
 */
export type AttributionFallback = {
  projectId?: number | null;
  departmentId?: number | null;
  sectionId?: number | null;
};

/**
 * Resolve the frozen bucket values for one booking. When a Job Order is chosen
 * every bucket comes from it, including a deliberately `null` `section_id` for
 * a standing / Non-Project Job Order (which any section of its Department may
 * book). With no Job Order the fallback buckets are used and no WBS is recorded.
 */
export function resolveAttributionSnapshot(
  jobOrder: Omit<JobOrderAttributionSource, "id"> | null | undefined,
  fallback: AttributionFallback = {}
): AttributionSnapshot {
  if (jobOrder) {
    return {
      projectId: jobOrder.projectId,
      projectWbsId: jobOrder.projectWbsId,
      departmentId: jobOrder.departmentId,
      sectionId: jobOrder.sectionId,
    };
  }
  return {
    projectId: fallback.projectId ?? null,
    projectWbsId: null,
    departmentId: fallback.departmentId ?? null,
    sectionId: fallback.sectionId ?? null,
  };
}

/** Pure map builder for a batch of Job Orders, keyed by Job Order id. */
export function snapshotsFromJobOrders(
  jobOrders: JobOrderAttributionSource[]
): Map<number, AttributionSnapshot> {
  return new Map(jobOrders.map((row) => [row.id, resolveAttributionSnapshot(row)]));
}

/** Read the live Job Orders once and return their attribution buckets by id. */
export async function loadAttributionSnapshots(
  jobOrderIds: (number | null | undefined)[]
): Promise<Map<number, AttributionSnapshot>> {
  const ids = [...new Set(jobOrderIds.filter((id): id is number => Number.isInteger(id) && (id as number) > 0))];
  if (!ids.length) return new Map();
  const rows = await prisma.jobOrder.findMany({
    where: { id: { in: ids } },
    select: { id: true, projectId: true, projectWbsId: true, departmentId: true, sectionId: true },
  });
  return snapshotsFromJobOrders(rows);
}

/** The snapshot of one Job Order, resolved on its own. */
export async function attributionSnapshotFor(
  jobOrderId: number | null | undefined,
  fallback: AttributionFallback = {}
): Promise<AttributionSnapshot> {
  if (jobOrderId == null) return resolveAttributionSnapshot(null, fallback);
  const snapshots = await loadAttributionSnapshots([jobOrderId]);
  const snapshot = snapshots.get(jobOrderId);
  return snapshot ?? resolveAttributionSnapshot(null, fallback);
}

/**
 * The snapshot stored for a booking that was created or updated with the given
 * Job Order id, using an already-loaded batch. An unknown/deleted Job Order id
 * fails closed to the empty snapshot instead of silently inventing buckets.
 */
export function snapshotForBooking(
  snapshots: Map<number, AttributionSnapshot>,
  jobOrderId: number | null | undefined,
  fallback: AttributionFallback = {}
): AttributionSnapshot {
  if (jobOrderId == null) return resolveAttributionSnapshot(null, fallback);
  return snapshots.get(jobOrderId) ?? resolveAttributionSnapshot(null, fallback);
}
