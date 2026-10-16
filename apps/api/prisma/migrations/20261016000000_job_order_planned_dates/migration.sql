-- The OPTIONAL planned window of a Job Order: the template's Start_Date / End_Date columns.
--
-- NULL means "no plan" (continual / standing work) and is a first-class state: every report shows it
-- as NOT SCHEDULED and never as on-time. Both columns are nullable additions, so existing rows stay
-- valid, nothing is rewritten and no backfill is needed.
ALTER TABLE "job_orders" ADD COLUMN "planned_start_date" TIMESTAMP(3);
ALTER TABLE "job_orders" ADD COLUMN "planned_end_date" TIMESTAMP(3);

-- A window that ends before it starts is not a plan. The CSV upload and the edit route refuse it as
-- well; the constraint is here so that no writer can store an impossible one. Prisma cannot declare a
-- CHECK constraint, which is why it lives in raw SQL — the same reasoning as the composite foreign key
-- on job_orders, which is declared in the Prisma schema instead (see
-- docs/MASTER_DATA_PROJECT_WBS_JOB_ORDER.md).
ALTER TABLE "job_orders" ADD CONSTRAINT "job_orders_planned_window_check"
  CHECK ("planned_end_date" IS NULL OR "planned_start_date" IS NULL OR "planned_end_date" >= "planned_start_date");
