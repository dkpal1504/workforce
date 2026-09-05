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
 *
 * Totals are returned in TRUE HOURS: a legacy hourSlot is 1h, a shift slot (am1/am2/pm1/pm2)
 * is 2h. This keeps day totals, the daily-max gate, and OT-excess consistent with
 * MAX_DAILY_HOURS=8 (a fully-allocated 4-shift-slot day = 8h). `otherSlots` still carries the
 * raw slot keys for legacy client-side union math.
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
      OR: [{ projectWbsId: { not: null } }, { jobOrderId: { not: null } }],
    },
    select: { employeeId: true, hourSlot: true, shiftSlot: true, taggedById: true },
  });

  const byEmp = new Map<number, { hourSlots: Set<number>; shiftSlots: Set<string>; bySup: Map<number, { hourSlots: Set<number>; shiftSlots: Set<string> }> }>();
  for (const e of entries) {
    let bag = byEmp.get(e.employeeId);
    if (!bag) {
      bag = { hourSlots: new Set(), shiftSlots: new Set(), bySup: new Map() };
      byEmp.set(e.employeeId, bag);
    }
    // Bucket by taggedById; counts are per-slot kind (hour vs shift).
    if (e.hourSlot != null) bag.hourSlots.add(e.hourSlot);
    if (e.shiftSlot != null) bag.shiftSlots.add(e.shiftSlot);
    let supBag = bag.bySup.get(e.taggedById);
    if (!supBag) {
      supBag = { hourSlots: new Set(), shiftSlots: new Set() };
      bag.bySup.set(e.taggedById, supBag);
    }
    if (e.hourSlot != null) supBag.hourSlots.add(e.hourSlot);
    if (e.shiftSlot != null) supBag.shiftSlots.add(e.shiftSlot);
  }

  for (const id of employeeIds) {
    const bag = byEmp.get(id);
    if (!bag) {
      result.set(id, { totalHours: 0, otherHours: 0, otherSlots: [], bySupervisor: [] });
      continue;
    }

    // TRUE-HOUR conversion: legacy hourSlot = 1h, shift slot = 2h.
    const allSlotCount = bag.hourSlots.size + bag.shiftSlots.size * 2;

    const otherHourSlots = new Set<number>();
    let otherShiftSlotCount = 0;
    let otherHourSlotCount = 0;
    for (const [supervisorId, supBag] of bag.bySup) {
      if (excludeSupervisorId != null && supervisorId === excludeSupervisorId) continue;
      for (const h of supBag.hourSlots) otherHourSlots.add(h);
      otherShiftSlotCount += supBag.shiftSlots.size;
    }
    otherHourSlotCount = otherHourSlots.size;
    const otherSlotsCount = otherHourSlotCount + otherShiftSlotCount * 2;

    result.set(id, {
      totalHours: allSlotCount,
      otherHours: otherSlotsCount,
      otherSlots: Array.from(otherHourSlots).sort((a, b) => a - b),
      bySupervisor: Array.from(bag.bySup.entries()).map(([supervisorId, supBag]) => ({
        supervisorId,
        hours: supBag.hourSlots.size + supBag.shiftSlots.size * 2,
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
