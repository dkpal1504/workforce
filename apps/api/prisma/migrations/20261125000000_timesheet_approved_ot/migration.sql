-- Approved overtime, read from CLMS LabourWorks.
--
-- A supervisor's OT booking records what was WORKED; CLMS decides what is APPROVED and
-- paid. `[LabourWorks].[dbo].[Report_Attendance_View].[AcceptedOT]` is that approved
-- figure for one `IDNo` and `Date`, and the whole application reports it — the punch is
-- kept only as the captured reference, never as the OT number.
--
--   approved_ot_hours      the approved figure; 0 is a real answer ("CLMS approved no OT
--                          for this day") and is written explicitly. NULL means "never
--                          fetched" and no report may read it as 0.
--   approved_ot_source     null = never fetched, LABOURWORKS = from the view, MANUAL = an
--                          Admin decision no refresh may overwrite.
--   approved_ot_checked_at when CLMS was last consulted for this day.
--
-- No backfill: the value comes from an external system, so every day is stamped by the
-- first refresh that covers it (sync completion, the 06:00 settlement, or the Admin
-- button). Existing rows start NULL, which is honest — they have not been fetched yet.

ALTER TABLE "timesheet_days" ADD COLUMN "approved_ot_hours" DOUBLE PRECISION;
ALTER TABLE "timesheet_days" ADD COLUMN "approved_ot_source" TEXT;
ALTER TABLE "timesheet_days" ADD COLUMN "approved_ot_checked_at" TIMESTAMP(3);
