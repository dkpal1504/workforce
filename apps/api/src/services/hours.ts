import { prisma } from "../db";

export type DayHourTotals = {
  /** Distinct clock-hour slots tagged for this employee today (all supervisors). */
  totalHours: number;
  /** Distinct slots tagged by supervisors other than `excludeSupervisorId` (if provided). */
  otherHours: number;
  /** Hour slots occupied by other supervisors (for client-side union math). */
  otherSlots: number[];
  bySupervisor: { supervisorId: number; hours: number }[];
};

/**
 * Distinct clock-hour slots tagged for employees on a work date (all supervisors/projects).
 * Pass `excludeSupervisorId` so callers can recompute totals as the current supervisor edits locally.
 */
export async function getEmployeeDayHourTotals(
  employeeIds: number[],
  workDate: Date,
  excludeSupervisorId?: number
): Promise<Map<number, DayHourTotals>> {
  const result = new Map<number, DayHourTotals>();

  if (!employeeIds.length) return result;

  const entries = await prisma.timesheetEntry.findMany({
    where: {
      employeeId: { in: employeeIds },
      workDate,
      projectWbsId: { not: null },
    },
    select: { employeeId: true, hourSlot: true, taggedById: true },
  });

  const byEmp = new Map<number, { slots: Set<number>; bySup: Map<number, Set<number>> }>();
  for (const e of entries) {
    let bag = byEmp.get(e.employeeId);
    if (!bag) {
      bag = { slots: new Set(), bySup: new Map() };
      byEmp.set(e.employeeId, bag);
    }
    bag.slots.add(e.hourSlot);
    let supSlots = bag.bySup.get(e.taggedById);
    if (!supSlots) {
      supSlots = new Set();
      bag.bySup.set(e.taggedById, supSlots);
    }
    supSlots.add(e.hourSlot);
  }

  for (const id of employeeIds) {
    const bag = byEmp.get(id);
    if (!bag) {
      result.set(id, { totalHours: 0, otherHours: 0, otherSlots: [], bySupervisor: [] });
      continue;
    }

    const otherSlots = new Set<number>();
    for (const [supervisorId, slots] of bag.bySup) {
      if (excludeSupervisorId != null && supervisorId === excludeSupervisorId) continue;
      for (const slot of slots) otherSlots.add(slot);
    }

    result.set(id, {
      totalHours: bag.slots.size,
      otherHours: otherSlots.size,
      otherSlots: Array.from(otherSlots).sort((a, b) => a - b),
      bySupervisor: Array.from(bag.bySup.entries()).map(([supervisorId, slots]) => ({
        supervisorId,
        hours: slots.size,
      })),
    });
  }

  return result;
}

/** Union size of other supervisors' slots + this supervisor's local filled slots. */
export function dayTotalWithLocalHours(otherSlots: number[], localSlots: number[]): number {
  const union = new Set(otherSlots);
  for (const s of localSlots) union.add(s);
  return union.size;
}
