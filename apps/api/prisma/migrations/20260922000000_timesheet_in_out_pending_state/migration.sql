-- Pending state and provenance for the clocked in/out hours.
--
-- Attendance regularization in LabourWorks can take days: a day can answer "no row" or
-- "0.00" on the first fetch and be corrected to 8.00 later. The column alone therefore
-- cannot say whether a zero is final or still pending, so the day row also records WHO
-- supplied the value and HOW OFTEN the source has been consulted:
--
--   in_out_source      null = never fetched, LABOURWORKS = from the view, MANUAL = an
--                      Admin decision (never overwritten by a later refresh)
--   in_out_checked_at  when a refresh last consulted the source for this day
--   in_out_attempts    how many times it has been consulted
--
-- A day that is still 0 after N checks is regularization work outstanding in
-- LabourWorks, which is exactly what the "still pending" report lists. Defaults are
-- safe for existing rows: source null, checked_at null, attempts 0.

ALTER TABLE "timesheet_days" ADD COLUMN "in_out_source" TEXT;
ALTER TABLE "timesheet_days" ADD COLUMN "in_out_checked_at" TIMESTAMP(3);
ALTER TABLE "timesheet_days" ADD COLUMN "in_out_attempts" INTEGER NOT NULL DEFAULT 0;
