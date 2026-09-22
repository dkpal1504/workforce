-- Clocked attendance hours for a submitted timesheet day.
--
-- The supervisor books shift slots; LabourWorks already knows how long the worker
-- actually clocked in and out (`[LabourWorks].[dbo].[Report_Attendance_Intermediate]`,
-- `ManHours` for `IDNo` = the employee ecNo the timesheet already carries). The Admin
-- needs both numbers side by side to validate contract attendance, so the day row
-- keeps the clocked figure next to the booked hours.
--
-- NULL is the normal state: the column is reset on every submit and is only filled by
-- an Admin refresh (POST /api/attendance-hours/refresh) or by the 09:00 / 21:00 job.
-- No backfill is possible or wanted - the value comes from an external system and is
-- deliberately absent until it is fetched for a day.

ALTER TABLE "timesheet_days" ADD COLUMN "in_out_hours" DOUBLE PRECISION;
