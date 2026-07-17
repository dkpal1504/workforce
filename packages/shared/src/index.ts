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

export const timesheetDaySchema = z.object({
  supervisorId: z.number().int().positive(),
  workDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  rows: z.array(
    z.object({
      employeeId: z.number().int().positive(),
      remarks: z.string().optional().nullable(),
      hours: z.array(hourAssignmentSchema),
    })
  ),
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
export type SummaryQuery = z.infer<typeof summaryQuerySchema>;
