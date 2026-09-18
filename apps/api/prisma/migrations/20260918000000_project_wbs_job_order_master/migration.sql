-- Project / WBS / Job Order master-data rebuild (CR: master data for production).
--
-- Target hierarchy: projects (1) -> project_wbs (many) -> job_orders (many),
-- with networks scoped per project and a UoM master. Design:
-- docs/MASTER_DATA_PROJECT_WBS_JOB_ORDER.md
--
-- `projects_wbs` is RENAMED to `project_wbs` and gains its parent `project_id`,
-- so existing rows and the two foreign keys that point at it survive. Every new
-- required column is added nullable, backfilled from data, then made NOT NULL.
-- The DO blocks raise a readable error instead of a bare constraint failure when
-- the data cannot be mapped, so a failed run tells the operator what to fix.

-- ---------------------------------------------------------------- 1. FKs off
ALTER TABLE "job_orders"        DROP CONSTRAINT "job_orders_project_wbs_id_fkey";
ALTER TABLE "timesheet_entries" DROP CONSTRAINT "timesheet_entries_project_wbs_id_fkey";
-- department_id becomes required, so its ON DELETE changes from SET NULL to RESTRICT.
ALTER TABLE "job_orders"        DROP CONSTRAINT "job_orders_department_id_fkey";

-- ---------------------------------------------------------------- 2. projects
ALTER TABLE "projects"
  ADD COLUMN "is_non_project" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "updated_at"     TIMESTAMP(3);

UPDATE "projects" SET "updated_at" = CURRENT_TIMESTAMP WHERE "updated_at" IS NULL;
ALTER TABLE "projects" ALTER COLUMN "updated_at" SET NOT NULL;

-- ------------------------------------------------- 3. projects_wbs -> project_wbs
ALTER TABLE "projects_wbs" RENAME TO "project_wbs";
ALTER INDEX "projects_wbs_pkey" RENAME TO "project_wbs_pkey";
DROP INDEX "projects_wbs_code_key";

ALTER TABLE "project_wbs"
  ADD COLUMN "project_id" INTEGER,
  ADD COLUMN "sort_order" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "updated_at" TIMESTAMP(3);

UPDATE "project_wbs" w
   SET "project_id" = p."id"
  FROM "projects" p
 WHERE p."code" = w."code";

DO $$
DECLARE orphan int;
BEGIN
  SELECT count(*) INTO orphan FROM "project_wbs" WHERE "project_id" IS NULL;
  IF orphan > 0 THEN
    RAISE EXCEPTION 'project_wbs rows whose legacy code matches no Project: %', orphan;
  END IF;
END $$;

-- A WBS row for the standing / idle-hours work of every project that holds
-- WBS-less Job Orders, so the new required links can be satisfied. Those
-- projects are marked as the non-project holder, derived from the data rather
-- than from a hard-coded code.
-- `code` and `color_key` are still NOT NULL at this point (both are dropped later),
-- so the new row carries placeholder values that the drop removes.
INSERT INTO "project_wbs" ("project_id", "code", "name", "wbs_code", "color_key", "sort_order", "updated_at")
SELECT DISTINCT jo."project_id", 'WBS-GENERAL-' || jo."project_id", 'General / Standing', 'GENERAL', 'N', 99, CURRENT_TIMESTAMP
  FROM "job_orders" jo
 WHERE jo."project_wbs_id" IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM "project_wbs" w
      WHERE w."project_id" = jo."project_id" AND w."wbs_code" = 'GENERAL');

UPDATE "projects" p SET "is_non_project" = true
 WHERE p."id" IN (SELECT DISTINCT jo."project_id" FROM "job_orders" jo WHERE jo."project_wbs_id" IS NULL);

UPDATE "project_wbs" SET "updated_at" = CURRENT_TIMESTAMP WHERE "updated_at" IS NULL;

-- Retire the legacy columns the new model does not carry. `name` stays, but the new
-- model makes it optional, so drop the old NOT NULL.
ALTER TABLE "project_wbs" DROP COLUMN "code", DROP COLUMN "color_key";
ALTER TABLE "project_wbs" ALTER COLUMN "name" DROP NOT NULL;

DO $$
DECLARE missing int;
BEGIN
  SELECT count(*) INTO missing FROM "project_wbs" WHERE "updated_at" IS NULL;
  IF missing > 0 THEN RAISE EXCEPTION 'project_wbs.updated_at not backfilled: %', missing; END IF;
END $$;

ALTER TABLE "project_wbs"
  ALTER COLUMN "project_id" SET NOT NULL,
  ALTER COLUMN "updated_at" SET NOT NULL;

ALTER TABLE "project_wbs"
  ADD CONSTRAINT "project_wbs_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX "project_wbs_project_id_wbs_code_key" ON "project_wbs"("project_id", "wbs_code");
CREATE INDEX "project_wbs_project_id_sort_order_idx"      ON "project_wbs"("project_id", "sort_order");
CREATE UNIQUE INDEX "projects_color_key_key"              ON "projects"("color_key");

ALTER TABLE "timesheet_entries"
  ADD CONSTRAINT "timesheet_entries_project_wbs_id_fkey"
    FOREIGN KEY ("project_wbs_id") REFERENCES "project_wbs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------- 4. uom + networks
CREATE TABLE "uom" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "example" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "uom_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "uom_code_key" ON "uom"("code");

CREATE TABLE "networks" (
    "id" SERIAL NOT NULL,
    "project_id" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "networks_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "networks_project_id_code_key" ON "networks"("project_id", "code");
CREATE INDEX "networks_project_id_active_idx"      ON "networks"("project_id", "active");
ALTER TABLE "networks" ADD CONSTRAINT "networks_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ------------------------------------------------------------- 5. job_orders
-- Attach the standing Job Orders to the GENERAL WBS row created above.
UPDATE "job_orders" jo
   SET "project_wbs_id" = w."id"
  FROM "project_wbs" w
 WHERE w."project_id" = jo."project_id" AND w."wbs_code" = 'GENERAL' AND jo."project_wbs_id" IS NULL;

DO $$
DECLARE bad int;
BEGIN
  SELECT count(*) INTO bad FROM "job_orders" WHERE "project_wbs_id" IS NULL;
  IF bad > 0 THEN RAISE EXCEPTION 'job_orders still without a WBS row: % - map them, then re-run', bad; END IF;
  SELECT count(*) INTO bad FROM "job_orders" WHERE "department_id" IS NULL;
  IF bad > 0 THEN RAISE EXCEPTION 'job_orders without a Department: % - map them, then re-run', bad; END IF;
END $$;

ALTER TABLE "job_orders"
  ADD COLUMN "budgeted_quantity" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "network_id"        INTEGER,
  ADD COLUMN "section_id"        INTEGER,
  ADD COLUMN "uom_id"            INTEGER;

UPDATE "job_orders" SET "budgeted_hours" = 0 WHERE "budgeted_hours" IS NULL;
ALTER TABLE "job_orders"
  ALTER COLUMN "project_wbs_id" SET NOT NULL,
  ALTER COLUMN "department_id"  SET NOT NULL,
  ALTER COLUMN "budgeted_hours" SET NOT NULL,
  ALTER COLUMN "budgeted_hours" SET DEFAULT 0;

-- Placeholder UoM and one dummy network per project, so existing rows satisfy the
-- new NOT NULL columns. Both are ordinary master rows the team can rename.
INSERT INTO "uom" ("code", "name", "example", "updated_at")
SELECT 'NOS', 'Numbers', 'Count of pieces (placeholder created by the migration)', CURRENT_TIMESTAMP
 WHERE EXISTS (SELECT 1 FROM "job_orders");

INSERT INTO "networks" ("project_id", "code", "name", "source", "updated_at")
SELECT DISTINCT jo."project_id", 'DUMMY', 'Placeholder network created by the migration', 'MANUAL', CURRENT_TIMESTAMP
  FROM "job_orders" jo
 WHERE NOT EXISTS (SELECT 1 FROM "networks" n WHERE n."project_id" = jo."project_id" AND n."code" = 'DUMMY');

UPDATE "job_orders" jo SET "uom_id" = (SELECT u."id" FROM "uom" u WHERE u."code" = 'NOS')
 WHERE jo."uom_id" IS NULL;

UPDATE "job_orders" jo SET "network_id" = n."id"
  FROM "networks" n
 WHERE n."project_id" = jo."project_id" AND n."code" = 'DUMMY' AND jo."network_id" IS NULL;

DO $$
DECLARE bad int;
BEGIN
  SELECT count(*) INTO bad FROM "job_orders" WHERE "uom_id" IS NULL OR "network_id" IS NULL;
  IF bad > 0 THEN RAISE EXCEPTION 'job_orders still missing uom_id or network_id: %', bad; END IF;
END $$;

ALTER TABLE "job_orders"
  ALTER COLUMN "uom_id"     SET NOT NULL,
  ALTER COLUMN "network_id" SET NOT NULL;

-- Status becomes two values only: active | inactive.
UPDATE "job_orders" SET "status" = 'inactive' WHERE "status" IN ('closed', 'on_hold');
UPDATE "job_orders" SET "status" = 'active'   WHERE "status" NOT IN ('active', 'inactive');

-- The Job Order number is unique per project, never globally.
DROP INDEX "job_orders_code_key";
DROP INDEX "job_orders_project_id_status_idx";
DROP INDEX "job_orders_department_id_idx";

ALTER TABLE "job_orders"
  ADD CONSTRAINT "job_orders_project_wbs_id_fkey"
    FOREIGN KEY ("project_wbs_id") REFERENCES "project_wbs"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "job_orders_network_id_fkey"
    FOREIGN KEY ("network_id") REFERENCES "networks"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "job_orders_uom_id_fkey"
    FOREIGN KEY ("uom_id") REFERENCES "uom"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "job_orders_department_id_fkey"
    FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "job_orders_section_id_fkey"
    FOREIGN KEY ("section_id") REFERENCES "sections"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "job_orders_status_check"
    CHECK ("status" IN ('active', 'inactive'));

CREATE INDEX "job_orders_project_wbs_id_status_idx"   ON "job_orders"("project_wbs_id", "status");
CREATE INDEX "job_orders_department_id_status_idx"    ON "job_orders"("department_id", "status");
CREATE INDEX "job_orders_section_id_idx"              ON "job_orders"("section_id");
CREATE INDEX "job_orders_network_id_idx"              ON "job_orders"("network_id");
CREATE UNIQUE INDEX "job_orders_project_id_code_key"  ON "job_orders"("project_id", "code");

-- ------------------------------- 6. budget revisions + quantity progress tables
CREATE TABLE "job_order_budget_revisions" (
    "id" SERIAL NOT NULL,
    "job_order_id" INTEGER NOT NULL,
    "revision_no" INTEGER NOT NULL,
    "budgeted_hours" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "budgeted_quantity" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "uom_id" INTEGER,
    "effective_from" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,
    "created_by" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "job_order_budget_revisions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "job_order_budget_revisions_job_order_id_revision_no_key"
  ON "job_order_budget_revisions"("job_order_id", "revision_no");
CREATE INDEX "job_order_budget_revisions_job_order_id_effective_from_idx"
  ON "job_order_budget_revisions"("job_order_id", "effective_from");
ALTER TABLE "job_order_budget_revisions"
  ADD CONSTRAINT "job_order_budget_revisions_job_order_id_fkey"
    FOREIGN KEY ("job_order_id") REFERENCES "job_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "job_order_budget_revisions_uom_id_fkey"
    FOREIGN KEY ("uom_id") REFERENCES "uom"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "job_order_budget_revisions_created_by_fkey"
    FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Revision 1 of every existing Job Order is its present budget, effective from
-- its creation date, so history starts consistent with the effective-dated model.
INSERT INTO "job_order_budget_revisions"
  ("job_order_id", "revision_no", "budgeted_hours", "budgeted_quantity", "uom_id", "effective_from", "reason")
SELECT jo."id", 1, jo."budgeted_hours", jo."budgeted_quantity", jo."uom_id", jo."created_at",
       'Opening budget carried over by the master-data migration'
  FROM "job_orders" jo;

CREATE TABLE "job_order_progress" (
    "id" SERIAL NOT NULL,
    "job_order_id" INTEGER NOT NULL,
    "progress_date" TIMESTAMP(3) NOT NULL,
    "cumulative_quantity" DOUBLE PRECISION NOT NULL,
    "revision_no" INTEGER NOT NULL DEFAULT 1,
    "section_id" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'SUBMITTED',
    "punched_by" INTEGER NOT NULL,
    "approved_by" INTEGER,
    "approved_at" TIMESTAMP(3),
    "remarks" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "job_order_progress_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "job_order_progress_job_order_id_progress_date_revision_no_key"
  ON "job_order_progress"("job_order_id", "progress_date", "revision_no");
CREATE INDEX "job_order_progress_status_progress_date_idx" ON "job_order_progress"("status", "progress_date");
CREATE INDEX "job_order_progress_job_order_id_status_idx"  ON "job_order_progress"("job_order_id", "status");
ALTER TABLE "job_order_progress"
  ADD CONSTRAINT "job_order_progress_job_order_id_fkey"
    FOREIGN KEY ("job_order_id") REFERENCES "job_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "job_order_progress_section_id_fkey"
    FOREIGN KEY ("section_id") REFERENCES "sections"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "job_order_progress_punched_by_fkey"
    FOREIGN KEY ("punched_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "job_order_progress_approved_by_fkey"
    FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "job_order_progress_status_check"
    CHECK ("status" IN ('SUBMITTED', 'APPROVED', 'REJECTED', 'SENT_BACK'));

-- ------------------------------------------------- 7. attribution snapshots
ALTER TABLE "timesheet_entries"
  ADD COLUMN "project_id"    INTEGER,
  ADD COLUMN "department_id" INTEGER,
  ADD COLUMN "section_id"    INTEGER;

UPDATE "timesheet_entries" te
   SET "project_id"    = jo."project_id",
       "department_id" = jo."department_id",
       "section_id"    = jo."section_id"
  FROM "job_orders" jo
 WHERE jo."id" = te."job_order_id";

-- Legacy hour-slot rows tagged through the WBS path keep their Project bucket.
UPDATE "timesheet_entries" te
   SET "project_id" = w."project_id"
  FROM "project_wbs" w
 WHERE w."id" = te."project_wbs_id" AND te."project_id" IS NULL;

ALTER TABLE "timesheet_entries"
  ADD CONSTRAINT "timesheet_entries_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "timesheet_entries_department_id_fkey"
    FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "timesheet_entries_section_id_fkey"
    FOREIGN KEY ("section_id") REFERENCES "sections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "employee_allocations"
  ADD COLUMN "project_wbs_id" INTEGER,
  ADD COLUMN "department_id"  INTEGER,
  ADD COLUMN "section_id"     INTEGER;

UPDATE "employee_allocations" ea
   SET "project_wbs_id" = jo."project_wbs_id",
       "department_id"  = jo."department_id",
       "section_id"     = jo."section_id"
  FROM "job_orders" jo
 WHERE jo."id" = ea."job_order_id";

ALTER TABLE "employee_allocations"
  ADD CONSTRAINT "employee_allocations_project_wbs_id_fkey"
    FOREIGN KEY ("project_wbs_id") REFERENCES "project_wbs"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "employee_allocations_department_id_fkey"
    FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "employee_allocations_section_id_fkey"
    FOREIGN KEY ("section_id") REFERENCES "sections"("id") ON DELETE SET NULL ON UPDATE CASCADE;
