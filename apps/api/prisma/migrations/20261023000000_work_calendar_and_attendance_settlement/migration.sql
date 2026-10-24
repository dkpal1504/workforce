-- The work calendar, the settled attendance store, and the snapshot anchor.
--
-- Why these tables exist: every report in this application divided by CALENDAR days, so a six-day yard
-- expected seven days of attendance a week and every Sunday counted as 599 absences. The LabourWorks
-- register answers the question properly — it carries `isHoliday`, `isWeeklyOff` and `OriginalStatus` —
-- but asking it per report is both slow and unstable, because LabourWorks rewrites history. So the
-- register's answer is settled ONCE per man-day, stored here, and every report divides by the same facts.
--
-- Nothing in this migration changes a single existing number: no code path reads these tables yet.

-- ---------------------------------------------------------------------------------------------------
-- The plant calendar: one row per date, shared by every report.
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE "work_calendar_date" (
    "id" SERIAL NOT NULL,
    "work_date" TIMESTAMP(3) NOT NULL,
    "day_type" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'REGISTER',
    "employee_rows" INTEGER NOT NULL DEFAULT 0,
    "present_rows" INTEGER NOT NULL DEFAULT 0,
    "absent_rows" INTEGER NOT NULL DEFAULT 0,
    "weekly_off_rows" INTEGER NOT NULL DEFAULT 0,
    "holiday_flag_rows" INTEGER NOT NULL DEFAULT 0,
    "holiday_status_rows" INTEGER NOT NULL DEFAULT 0,
    "settled_at" TIMESTAMP(3),
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "work_calendar_date_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "work_calendar_date_work_date_key" ON "work_calendar_date"("work_date");
CREATE INDEX "work_calendar_date_day_type_work_date_idx" ON "work_calendar_date"("day_type", "work_date");

-- ---------------------------------------------------------------------------------------------------
-- A human decision about a date, which beats whatever the register inferred.
-- 'scope_id' defaults to 0, never NULL: PostgreSQL treats NULLs as distinct in a unique index, so a
-- nullable scope would let two conflicting PLANT decisions exist for the same date.
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE "calendar_exception" (
    "id" SERIAL NOT NULL,
    "work_date" TIMESTAMP(3) NOT NULL,
    "day_type" TEXT NOT NULL,
    "scope_type" TEXT NOT NULL DEFAULT 'PLANT',
    "scope_id" INTEGER NOT NULL DEFAULT 0,
    "reason" TEXT NOT NULL,
    "approved_by" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "calendar_exception_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "calendar_exception_work_date_scope_type_scope_id_key"
    ON "calendar_exception"("work_date", "scope_type", "scope_id");
CREATE INDEX "calendar_exception_work_date_idx" ON "calendar_exception"("work_date");

-- ---------------------------------------------------------------------------------------------------
-- One settlement pass. A FAILED or PARTIAL run is why a report may say "not settled" instead of 0.
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE "attendance_settlement_run" (
    "id" SERIAL NOT NULL,
    "scope_from" TIMESTAMP(3) NOT NULL,
    "scope_to" TIMESTAMP(3) NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "source" TEXT NOT NULL DEFAULT 'SQL',
    "dates_settled" INTEGER NOT NULL DEFAULT 0,
    "dates_failed" INTEGER NOT NULL DEFAULT 0,
    "rows_written" INTEGER NOT NULL DEFAULT 0,
    "anomalies" JSONB,
    "error" TEXT,

    CONSTRAINT "attendance_settlement_run_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "attendance_settlement_run_started_at_idx" ON "attendance_settlement_run"("started_at");

-- ---------------------------------------------------------------------------------------------------
-- One settled man-day. 'employee_id' is NULL when the register id has no Employee row: the pairing is
-- recorded as an anomaly rather than invented, and the evidence (register_id) survives.
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE "attendance_day" (
    "id" SERIAL NOT NULL,
    "register_id" TEXT NOT NULL,
    "employee_id" INTEGER,
    "work_date" TIMESTAMP(3) NOT NULL,
    "day_type" TEXT NOT NULL,
    "attendance_class" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "accepted_hours" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "accepted_ot_hours" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "clocked_hours" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "register_rows" INTEGER NOT NULL DEFAULT 1,
    "status_variants" INTEGER NOT NULL DEFAULT 1,
    "run_id" INTEGER,
    "settled_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_day_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "attendance_day_register_id_work_date_key" ON "attendance_day"("register_id", "work_date");
CREATE INDEX "attendance_day_work_date_attendance_class_idx" ON "attendance_day"("work_date", "attendance_class");
CREATE INDEX "attendance_day_employee_id_work_date_idx" ON "attendance_day"("employee_id", "work_date");

ALTER TABLE "attendance_day" ADD CONSTRAINT "attendance_day_employee_id_fkey"
    FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "attendance_day" ADD CONSTRAINT "attendance_day_run_id_fkey"
    FOREIGN KEY ("run_id") REFERENCES "attendance_settlement_run"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "calendar_exception" ADD CONSTRAINT "calendar_exception_approved_by_fkey"
    FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------------
-- A frozen review pack, so a number quoted in a meeting cannot change under it. Populated from Step 5.
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE "report_snapshot" (
    "id" SERIAL NOT NULL,
    "kind" TEXT NOT NULL,
    "period_from" TIMESTAMP(3) NOT NULL,
    "period_to" TIMESTAMP(3) NOT NULL,
    "frozen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "frozen_by" INTEGER,
    "payload" JSONB NOT NULL,
    "content_hash" TEXT NOT NULL,

    CONSTRAINT "report_snapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "report_snapshot_kind_period_from_period_to_key"
    ON "report_snapshot"("kind", "period_from", "period_to");
CREATE INDEX "report_snapshot_frozen_at_idx" ON "report_snapshot"("frozen_at");

-- ---------------------------------------------------------------------------------------------------
-- WBS weight for the planned S-curve. NULL = equal share, so weights can be introduced one project at a
-- time without a data migration, and a half-configured project still plots (the curve normalises by the
-- weights actually present rather than dividing by 100).
-- ---------------------------------------------------------------------------------------------------
ALTER TABLE "project_wbs" ADD COLUMN "planned_weight" DOUBLE PRECISION;
