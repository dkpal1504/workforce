import { z } from "zod";

export const UserRole = {
  SUPERVISOR: "SUPERVISOR",
  HOD: "HOD",
  PM: "PM",
  HR: "HR",
  FINANCE: "FINANCE",
  ADMIN: "ADMIN",
} as const;
export type UserRole = (typeof UserRole)[keyof typeof UserRole];

export const EmployeeCategory = {
  ASSOCIATE: "ASSOCIATE",
  CONTRACTOR: "CONTRACTOR",
  ON_ROLL: "ON_ROLL",
} as const;
export type EmployeeCategory = (typeof EmployeeCategory)[keyof typeof EmployeeCategory];

export const TeamSource = {
  CARRIED_OVER: "CARRIED_OVER",
  ADDED: "ADDED",
  REMOVED: "REMOVED",
} as const;
export type TeamSource = (typeof TeamSource)[keyof typeof TeamSource];

export const TimesheetStatus = {
  DRAFT: "DRAFT",
  SUBMITTED: "SUBMITTED",
  SUP_APPROVED: "SUP_APPROVED",
  HOD_APPROVED: "HOD_APPROVED",
  /** Project Head (PM) final approval */
  PM_APPROVED: "PM_APPROVED",
  /** Project Head returned the sheet to HOD for correction */
  PLANNING_RETURNED: "PLANNING_RETURNED",
  REJECTED: "REJECTED",
} as const;
export type TimesheetStatus = (typeof TimesheetStatus)[keyof typeof TimesheetStatus];

/** PM role is shown in the UI as Project Head */
export const ROLE_DISPLAY_LABEL: Record<string, string> = {
  SUPERVISOR: "Supervisor",
  HOD: "HOD",
  PM: "Project Head",
  HR: "HR",
  FINANCE: "Finance",
  ADMIN: "Admin",
};

export const PRIMARY_PROJECT_KEYS = ["A", "B", "C"] as const;
export type PrimaryProjectKey = (typeof PRIMARY_PROJECT_KEYS)[number];

/** Project color keys used across the app (colorKey column on Project / ProjectWbs). */
export const PROJECT_COLOR_KEYS = ["A", "B", "C", "D", "E", "F", "N"] as const;
export type ProjectColorKey = (typeof PROJECT_COLOR_KEYS)[number];

/**
 * 4-shift per-day model per the Daily Timesheet Entry v0.3 spec:
 * 1st Half = 9a-11a (am1) + 11a-1p (am2); 2nd Half = 2p-4p (pm1) + 4p-6p (pm2).
 * Each shift slot is one row in timesheet_entries (replaces the legacy 13-hour grid).
 */
export const SHIFT_SLOTS = ["am1", "am2", "pm1", "pm2"] as const;
export type ShiftSlot = (typeof SHIFT_SLOTS)[number];

export const SHIFT_LABELS: Record<ShiftSlot, { short: string; long: string; half: "1st" | "2nd" }> = {
  am1: { short: "9a–11a", long: "1st Half · 9:00 AM – 11:00 AM", half: "1st" },
  am2: { short: "11a–1p", long: "1st Half · 11:00 AM – 1:00 PM", half: "1st" },
  pm1: { short: "2p–4p", long: "2nd Half · 2:00 PM – 4:00 PM", half: "2nd" },
  pm2: { short: "4p–6p", long: "2nd Half · 4:00 PM – 6:00 PM", half: "2nd" },
};

/** All 4 shift slots; each represents 1 hour-equivalent for OT/daily-cap math. */
export const SHIFTS_PER_DAY = 4;

export const HOUR_SLOTS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;
export type HourSlot = (typeof HOUR_SLOTS)[number];

export const HOUR_LABELS: Record<HourSlot, string> = {
  0: "8a",
  1: "9a",
  2: "10a",
  3: "11a",
  4: "12p",
  5: "1p",
  6: "2p",
  7: "3p",
  8: "4p",
  9: "5p",
  10: "6p",
  11: "7p",
  12: "8p",
};

export const PROJECT_COLORS = ["A", "B", "C", "D", "E", "F"] as const;

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const teamTodaySchema = z.object({
  supervisorId: z.number().int().positive(),
  departmentId: z.number().int().positive(),
  workDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  employeeIds: z.array(z.number().int().positive()),
});

export const hourAssignmentSchema = z.object({
  hourSlot: z.number().int().min(0).max(12),
  projectWbsId: z.number().int().positive().nullable(),
});

/** One row of one shift slot in the 4-slot per-day model. */
export const shiftAssignmentSchema = z.object({
  shiftSlot: z.enum(SHIFT_SLOTS),
  jobOrderId: z.number().int().positive().nullable(),
});

/**
 * Timesheet day payload — 4 shift slots per employee (1st Half × 2 + 2nd Half × 2).
 * Replaces the legacy 13-hour grid for new Timesheet Entry writes; existing
 * hour-slot rows in the DB stay read-only until they're touched.
 */
export const timesheetDaySchema = z.object({
  supervisorId: z.number().int().positive(),
  workDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  rows: z.array(
    z.object({
      employeeId: z.number().int().positive(),
      remarks: z.string().optional().nullable(),
      slots: z.array(shiftAssignmentSchema).length(SHIFTS_PER_DAY),
    })
  ),
});

/**
 * Bulk Assignment block payload (Daily Timesheet Entry, Bulk-First workflow).
 * Applies a single (projectId, jobOrderId) to a set of (employeeId, shiftSlot) pairs
 * across one supervisor-day.
 */
export const bulkAssignSchema = z.object({
  supervisorId: z.number().int().positive(),
  workDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  projectId: z.number().int().positive(),
  jobOrderId: z.number().int().positive(),
  slots: z
    .array(
      z.object({
        employeeId: z.number().int().positive(),
        shiftSlot: z.enum(SHIFT_SLOTS),
      })
    )
    .min(1),
});

/**
 * Per-row single-slot edit (used by the per-row Allocation cell Assign button).
 * Mutates one (employeeId, shiftSlot) row to point at the given JobOrder, or
 * clears it (jobOrderId = null).
 */
export const setSlotJobOrderSchema = z.object({
  supervisorId: z.number().int().positive(),
  workDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  employeeId: z.number().int().positive(),
  shiftSlot: z.enum(SHIFT_SLOTS),
  jobOrderId: z.number().int().positive().nullable(),
});

export const summaryQuerySchema = z.object({
  frequency: z.enum(["daily", "weekly", "monthly"]).default("daily"),
  groupBy: z.enum(["employee", "supervisor", "department", "totals"]).default("supervisor"),
  view: z.enum(["hours", "cost"]).default("hours"),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  projectIds: z.array(z.number().int().positive()).optional(),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type TeamTodayInput = z.infer<typeof teamTodaySchema>;
export type TimesheetDayInput = z.infer<typeof timesheetDaySchema>;
export type ShiftAssignmentInput = z.infer<typeof shiftAssignmentSchema>;
export type BulkAssignInput = z.infer<typeof bulkAssignSchema>;
export type SetSlotJobOrderInput = z.infer<typeof setSlotJobOrderSchema>;
export type SummaryQuery = z.infer<typeof summaryQuerySchema>;
