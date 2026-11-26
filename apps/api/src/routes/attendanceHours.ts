import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { requireAuth, requireRoles } from "../middleware/auth";
import { writeAudit } from "../audit";
import {
  attendancePolicy,
  attendanceSourceConfig,
  readPendingInOutHours,
  refreshInOutHours,
  setManualInOutHours,
  sweepPendingInOutHours,
} from "../services/attendanceHours";
import {
  approvedOtSource,
  formatApprovedOtSummary,
  refreshApprovedOt,
  scheduledApprovedOtWindow,
  setManualApprovedOt,
} from "../services/approvedOt";

/**
 * Clocked attendance hours (in/out) for submitted timesheets - ADMIN only.
 *
 * A supervisor books shift slots; LabourWorks knows how long the worker actually
 * clocked in and out. This router is the ONLY writer of `timesheet_days.in_out_hours`
 * besides the daily job and the weekly sweep: it reads the LabourWorks attendance view
 * for the requested dates and stamps the matching submitted sheets.
 *
 *   GET  /api/attendance-hours/config   what the refresh will read (no secrets)
 *   GET  /api/attendance-hours/pending  days that still have no usable figure
 *   POST /api/attendance-hours/refresh  { dateFrom, dateTo, dryRun?, includeDraft?, onlyPending?, overwritePolicy?, ignoreAgeCutoff? }
 *   POST /api/attendance-hours/sweep    { dryRun? } - the whole regularization horizon, pending days only
 *   POST /api/attendance-hours/manual   { dayId, hours } - an Admin decision for a day the yard will never regularize
 *
 * `dryRun: true` reports exactly what would change and writes nothing, which is what
 * the Admin screen shows before the button is pressed. Running it twice with the same
 * source data changes nothing (the write skips values that already match), so the
 * daily job, the sweep and the button can run back to back.
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
  const policy = attendancePolicy();
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
      lookbackDays: Number(process.env.ATTENDANCE_HOURS_LOOKBACK_DAYS || 7),
      sweep: {
        enabled: String(process.env.ATTENDANCE_HOURS_SWEEP_ENABLED || "true").toLowerCase() === "true",
        cron: process.env.ATTENDANCE_HOURS_SWEEP_CRON || "0 4 * * 0",
      },
    },
    // The backfill rules in force: what a difference means and how long a period keeps
    // being re-checked.
    policy: { overwrite: policy.overwrite, maxAgeDays: policy.maxAgeDays },
  });
});

/**
 * The "still pending" report. Reads the database only - never LabourWorks - so it is
 * cheap enough to load with the screen, which is the point: this is the daily list of
 * days whose regularization has not happened yet.
 */
attendanceHoursRouter.get("/pending", async (_req, res) => {
  try {
    const policy = attendancePolicy();
    const rows = await readPendingInOutHours({ maxAgeDays: policy.maxAgeDays });
    res.json({
      ok: true,
      maxAgeDays: policy.maxAgeDays,
      pending: rows.length,
      /** Never checked at all (a run has not reached this day yet). */
      neverChecked: rows.filter((row) => row.inOutAttempts === 0).length,
      /** Checked at least once and still nothing usable: outstanding regularization. */
      checkedAndStillEmpty: rows.filter((row) => row.inOutAttempts > 0).length,
      rows,
    });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Could not read the pending days." });
  }
});

const refreshSchema = z.object({
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "dateFrom must be YYYY-MM-DD"),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "dateTo must be YYYY-MM-DD"),
  dryRun: z.boolean().optional(),
  /** Also stamp DRAFT sheets. Off by default: a draft is still being written. */
  includeDraft: z.boolean().optional(),
  /** Only days with nothing usable (what the sweep and the "pending" button use). */
  onlyPending: z.boolean().optional(),
  overwritePolicy: z.enum(["any", "improve"]).optional(),
  /** Re-check days older than ATTENDANCE_HOURS_MAX_AGE_DAYS as well. */
  ignoreAgeCutoff: z.boolean().optional(),
});

attendanceHoursRouter.post("/refresh", async (req, res) => {
  const parsed = refreshSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid request." });
  }
  const { dateFrom, dateTo, dryRun, includeDraft, onlyPending, overwritePolicy, ignoreAgeCutoff } = parsed.data;

  try {
    const result = await refreshInOutHours({
      dateFrom,
      dateTo,
      dryRun,
      includeDraft,
      onlyPending,
      overwritePolicy,
      ignoreAgeCutoff,
    });

    // Every requested date failing is a source outage or a permission problem, not a
    // result: answer 502 with the source message so the screen shows what to fix. One
    // bad date out of several still returns 200 with the partial result plus `errors`.
    if (result.errors.length && result.datesFetched === 0) {
      return res.status(502).json({
        error: `Could not read the attendance source. ${result.errors[0].message}`,
        dateFrom: result.dateFrom,
        dateTo: result.dateTo,
        errors: result.errors,
      });
    }

    if (!result.dryRun && result.updated > 0) {
      // The trail: which run moved which day, from what to what. Enough to answer
      // "who turned this 0 into an 8" without a second table.
      const changes = result.rows
        .filter((row) => row.wouldChange)
        .slice(0, 200)
        .map((row) => ({ dayId: row.dayId, ecNo: row.ecNo, workDate: row.workDate, from: row.previousInOutHours, to: row.clockedHours, records: row.sourceRecords }));
      await writeAudit(req.user!.id, "ATTENDANCE_HOURS_REFRESH", "timesheet_day", `${result.dateFrom}..${result.dateTo}`, {
        dateFrom: result.dateFrom,
        dateTo: result.dateTo,
        sheets: result.sheets,
        matched: result.matched,
        unmatched: result.unmatched,
        updated: result.updated,
        pending: result.pending,
        skipped: result.skipped,
        overwritePolicy: result.overwritePolicy,
        onlyPending: result.onlyPending,
        includeDraft: result.includeDraft,
        changes,
        changesTruncated: result.updated > changes.length,
      });
    }

    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Attendance refresh failed." });
  }
});

/** The weekly sweep over the whole regularization horizon, pending days only. */
attendanceHoursRouter.post("/sweep", async (req, res) => {
  const dryRun = req.body?.dryRun === true;
  try {
    const result = await sweepPendingInOutHours({ dryRun });
    if (result.errors.length && result.datesFetched === 0) {
      return res.status(502).json({
        error: `Could not read the attendance source. ${result.errors[0].message}`,
        errors: result.errors,
      });
    }
    if (!dryRun && result.updated > 0) {
      await writeAudit(req.user!.id, "ATTENDANCE_HOURS_SWEEP", "timesheet_day", `${result.dateFrom}..${result.dateTo}`, {
        dateFrom: result.dateFrom,
        dateTo: result.dateTo,
        pendingBefore: result.pendingBefore,
        sheets: result.sheets,
        updated: result.updated,
        pendingAfter: result.pending,
      });
    }
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Attendance sweep failed." });
  }
});

const manualSchema = z.object({
  dayId: z.number().int().positive(),
  /** null clears the value and hands the day back to the source. */
  hours: z.number().min(0).max(24).nullable(),
  reason: z.string().max(500).optional(),
});

/**
 * A day HR has confirmed will never be regularized can be settled by hand. The value
 * is flagged MANUAL, so no refresh (daily job, sweep or button) overwrites it, and the
 * action is audited with the reason.
 */
attendanceHoursRouter.post("/manual", async (req, res) => {
  const parsed = manualSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid request." });
  }
  const { dayId, hours, reason } = parsed.data;
  try {
    const before = await readDaySnapshot(dayId);
    const after = await setManualInOutHours(dayId, hours);
    await writeAudit(req.user!.id, "ATTENDANCE_HOURS_MANUAL", "timesheet_day", String(dayId), {
      dayId,
      from: before?.inOutHours ?? null,
      fromSource: before?.inOutSource ?? null,
      to: after.inOutHours,
      toSource: after.inOutSource,
      reason: reason ?? null,
    });
    res.json({ ok: true, ...after });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Could not save the manual figure." });
  }
});

/* --------------------------------------------------------------------------- *
 * Approved overtime (CLMS `[AcceptedOT]`)
 *
 * The OT a supervisor punches is only what was worked; CLMS decides what is approved and
 * paid. These endpoints read the approved figure into `timesheet_days.approved_ot_hours`,
 * which every screen and report uses. The sync and the 06:00 settlement already refresh it
 * on their own; these exist so an operator can backfill a period or correct a day without
 * waiting for either.
 * --------------------------------------------------------------------------- */

attendanceHoursRouter.get("/approved-ot/config", (_req, res) => {
  const source = approvedOtSource();
  const window = scheduledApprovedOtWindow();
  res.json({
    ok: true,
    source: {
      view: source.view,
      idColumn: source.idColumn,
      otColumn: source.otColumn,
      dateColumn: source.dateColumn,
      aggregate: source.aggregate,
      server: attendanceSourceConfig().server,
      database: attendanceSourceConfig().database,
    },
    triggers: {
      afterSync: String(process.env.APPROVED_OT_SYNC_ON_COMPLETE ?? "true").toLowerCase() !== "false",
      afterSettlement: String(process.env.APPROVED_OT_AFTER_SETTLEMENT ?? "true").toLowerCase() !== "false",
      lookbackDays: Number(process.env.APPROVED_OT_LOOKBACK_DAYS || 21),
    },
    /**
     * The nightly backfill. CLMS approves overtime 2–15 days after the work, so this is the guarantee
     * that a late approval is stamped without anybody pressing a button.
     */
    schedule: {
      enabled: String(process.env.APPROVED_OT_SCHEDULE_ENABLED ?? "true").toLowerCase() !== "false",
      cron: process.env.APPROVED_OT_CRON || "0 2 * * *",
      backfillDays: Number(process.env.APPROVED_OT_BACKFILL_DAYS || 30),
      /**
       * The self-healing half: dates OLDER than the window that still hold a non-draft sheet with no
       * stamp at all. A month that closed before this feature was switched on is never inside a
       * backwards-looking window, so without this it stays NULL ("never fetched") for ever.
       */
      catchUpDays: Number(process.env.APPROVED_OT_CATCHUP_DAYS || 120),
      catchUpDatesPerNight: Number(process.env.APPROVED_OT_CATCHUP_DATES || 90),
      window,
    },
    /** The window the automatic triggers cover on the next pass. */
    window,
  });
});

const approvedOtRefreshSchema = z.object({
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "dateFrom must be YYYY-MM-DD"),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "dateTo must be YYYY-MM-DD"),
  dryRun: z.boolean().optional(),
  includeDraft: z.boolean().optional(),
});

attendanceHoursRouter.post("/approved-ot/refresh", async (req, res) => {
  const parsed = approvedOtRefreshSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid request." });
  }
  try {
    const result = await refreshApprovedOt(parsed.data);
    if (result.errors.length && result.datesRead.length === 0 && result.sheets > 0) {
      return res.status(502).json({
        error: `Could not read the approved overtime. ${result.errors[0].message}`,
        dateFrom: result.dateFrom,
        dateTo: result.dateTo,
        errors: result.errors,
      });
    }
    if (!result.dryRun && result.updated > 0) {
      const changes = result.rows
        .filter((row) => row.wouldChange)
        .slice(0, 200)
        .map((row) => ({
          dayId: row.dayId,
          ecNo: row.ecNo,
          workDate: row.workDate,
          punched: row.punchedOtHours,
          from: row.previousHours,
          to: row.approvedHours,
        }));
      await writeAudit(req.user!.id, "APPROVED_OT_REFRESH", "timesheet_day", `${result.dateFrom}..${result.dateTo}`, {
        dateFrom: result.dateFrom,
        dateTo: result.dateTo,
        source: result.source,
        sheets: result.sheets,
        withApprovedOt: result.withApprovedOt,
        updated: result.updated,
        changes,
        changesTruncated: result.updated > changes.length,
      });
    }
    res.json({ ok: true, summary: formatApprovedOtSummary(result), ...result });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Approved overtime refresh failed." });
  }
});

const approvedOtManualSchema = z.object({
  dayId: z.number().int().positive(),
  /** null clears the value and hands the day back to CLMS on the next refresh. */
  hours: z.number().min(0).max(24).nullable(),
  reason: z.string().max(500).optional(),
});

attendanceHoursRouter.post("/approved-ot/manual", async (req, res) => {
  const parsed = approvedOtManualSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid request." });
  }
  const { dayId, hours, reason } = parsed.data;
  try {
    const before = await prisma.timesheetDay.findUnique({
      where: { id: dayId },
      select: { approvedOtHours: true, approvedOtSource: true },
    });
    const after = await setManualApprovedOt(dayId, hours);
    await writeAudit(req.user!.id, "APPROVED_OT_MANUAL", "timesheet_day", String(dayId), {
      dayId,
      from: before?.approvedOtHours ?? null,
      fromSource: before?.approvedOtSource ?? null,
      to: after.approvedOtHours,
      toSource: after.approvedOtSource,
      reason: reason ?? null,
    });
    res.json({ ok: true, ...after });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Could not save the approved overtime." });
  }
});

/** The day's current values, for the audit trail. */
function readDaySnapshot(dayId: number) {
  return prisma.timesheetDay.findUnique({ where: { id: dayId }, select: { inOutHours: true, inOutSource: true } });
}
