import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRoles } from "../middleware/auth";
import { writeAudit } from "../audit";
import {
  attendanceSourceConfig,
  refreshInOutHours,
} from "../services/attendanceHours";

/**
 * Clocked attendance hours (in/out) for submitted timesheets — ADMIN only.
 *
 * A supervisor books shift slots; LabourWorks knows how long the worker actually
 * clocked in and out. This router is the ONLY writer of
 * `timesheet_days.in_out_hours` besides the 09:00 / 21:00 job: it reads the
 * LabourWorks attendance view for the requested dates and stamps the matching
 * submitted sheets.
 *
 *   GET  /api/attendance-hours/config   what the refresh will read (no secrets)
 *   POST /api/attendance-hours/refresh  { dateFrom, dateTo, dryRun?, includeDraft? }
 *
 * `dryRun: true` reports exactly what would change and writes nothing, which is what
 * the Admin screen shows before the button is pressed. Running it twice with the same
 * source data changes nothing (the write skips values that already match).
 *
 * Mounted in apps/api/src/index.ts:
 *   import { attendanceHoursRouter } from "./routes/attendanceHours";
 *   api.use("/attendance-hours", attendanceHoursRouter);
 */

export const attendanceHoursRouter = Router();

// The clocked hours are an audit figure over a whole department's submitted sheets,
// so nothing below ADMIN may read or refresh them.
attendanceHoursRouter.use(requireAuth, requireRoles("ADMIN"));

attendanceHoursRouter.get("/config", (_req, res) => {
  const config = attendanceSourceConfig();
  res.json({
    // Shown on the Admin screen so an operator can see WHICH view and columns the
    // button will read, without exposing the password.
    source: {
      view: config.view,
      idColumn: config.idColumn,
      hoursColumn: config.hoursColumn,
      dateColumn: config.dateColumn,
      queryOverride: config.queryOverride != null,
      server: config.server,
      port: config.port,
      database: config.database,
      user: config.user,
      fixture: config.fixturePath != null,
      fixturePath: config.fixturePath,
    },
    schedule: {
      enabled: String(process.env.ATTENDANCE_HOURS_ENABLED || "false").toLowerCase() === "true",
      cron: process.env.ATTENDANCE_HOURS_CRON || "0 9,21 * * *",
      lookbackDays: Number(process.env.ATTENDANCE_HOURS_LOOKBACK_DAYS || 3),
    },
  });
});

const refreshSchema = z.object({
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "dateFrom must be YYYY-MM-DD"),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "dateTo must be YYYY-MM-DD"),
  dryRun: z.boolean().optional(),
  /** Also stamp DRAFT sheets. Off by default: a draft is still being written. */
  includeDraft: z.boolean().optional(),
});

attendanceHoursRouter.post("/refresh", async (req, res) => {
  const parsed = refreshSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid request." });
  }
  const { dateFrom, dateTo, dryRun, includeDraft } = parsed.data;

  try {
    const result = await refreshInOutHours({ dateFrom, dateTo, dryRun, includeDraft });

    // Every requested date failing is a source outage or a permission problem, not a
    // result: answer 502 with the source message so the screen shows what to fix. One
    // bad date out of several still returns 200 with the partial result plus `errors`.
    if (result.errors.length && result.errors.length >= countDays(result.dateFrom, result.dateTo)) {
      return res.status(502).json({
        error: `Could not read the attendance source for any day. ${result.errors[0].message}`,
        dateFrom: result.dateFrom,
        dateTo: result.dateTo,
        errors: result.errors,
      });
    }

    if (!result.dryRun && result.updated > 0) {
      await writeAudit(req.user!.id, "ATTENDANCE_HOURS_REFRESH", "timesheet_day", `${result.dateFrom}..${result.dateTo}`, {
        dateFrom: result.dateFrom,
        dateTo: result.dateTo,
        sheets: result.sheets,
        matched: result.matched,
        unmatched: result.unmatched,
        updated: result.updated,
        includeDraft: result.includeDraft,
      });
    }

    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Attendance refresh failed." });
  }
});

/** Inclusive day count of the requested range, for the all-dates-failed check. */
function countDays(dateFrom: string, dateTo: string): number {
  const from = new Date(`${dateFrom}T00:00:00.000Z`).getTime();
  const to = new Date(`${dateTo}T00:00:00.000Z`).getTime();
  return Math.round((to - from) / 86400000) + 1;
}
