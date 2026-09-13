\set ON_ERROR_STOP on
-- Baseline PostgreSQL schema generated from apps/api/prisma/schema.prisma at the
-- 2026-09-13 baseline. Run while connected as the application role to an empty database.
--
-- !! THIS FILE IS FROZEN AT THE BASELINE AND IS NOT THE CURRENT SCHEMA !!
-- It does not contain later migrations, notably:
--   * users.section_id            (20260915000000_hod_section_and_org_transfer)
--   * employee_organisation_overrides (same migration)
--   * hod_delegations             (20260916000000_hod_approval_delegation)
-- After running this file you MUST apply the remaining migrations
-- (`npx prisma migrate deploy`), or HOD scoping and HOD approval cover will not work.
-- The authoritative schema is apps/api/prisma/migrations/ — see docs/PRODUCTION_DEPLOYMENT.md
-- (Schema option B and C).
BEGIN;
-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "employee_id" INTEGER,
    "department_id" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "must_change_password" BOOLEAN NOT NULL DEFAULT false,
    "token_version" INTEGER NOT NULL DEFAULT 0,
    "password_expires_at" TIMESTAMP(3),
    "credential_provisioned_at" TIMESTAMP(3),
    "credential_sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "departments" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employees" (
    "id" SERIAL NOT NULL,
    "ec_no" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "department_id" INTEGER NOT NULL,
    "designation" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "mobile" TEXT,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "employment_type" TEXT NOT NULL DEFAULT 'PAYROLL',
    "last_synced_at" TIMESTAMP(3),
    "terminated_at" TIMESTAMP(3),
    "nature_of_work" TEXT,
    "grade" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sections" (
    "id" SERIAL NOT NULL,
    "department_id" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cost_centers" (
    "id" SERIAL NOT NULL,
    "section_id" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cost_centers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_section_assignments" (
    "id" SERIAL NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "section_id" INTEGER NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_section_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supervisor_overrides" (
    "id" SERIAL NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "created_by" INTEGER,
    "reason" TEXT NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supervisor_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credential_deliveries" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "recipient" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "sent_at" TIMESTAMP(3),

    CONSTRAINT "credential_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_exceptions" (
    "id" SERIAL NOT NULL,
    "source_system" TEXT NOT NULL,
    "external_key" TEXT NOT NULL,
    "ec_no" TEXT,
    "mobile" TEXT,
    "error_code" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "sync_exceptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_allocation_days" (
    "id" SERIAL NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "work_date" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "remarks" TEXT,
    "submitted_at" TIMESTAMP(3),
    "approved_at" TIMESTAMP(3),
    "approver_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_allocation_days_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_allocations" (
    "id" SERIAL NOT NULL,
    "allocation_day_id" INTEGER NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "work_date" TIMESTAMP(3) NOT NULL,
    "shift_slot" TEXT NOT NULL,
    "project_id" INTEGER NOT NULL,
    "job_order_id" INTEGER,
    "allocated_by" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects_wbs" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "wbs_code" TEXT NOT NULL,
    "color_key" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "projects_wbs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color_key" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_orders" (
    "id" SERIAL NOT NULL,
    "project_id" INTEGER NOT NULL,
    "project_wbs_id" INTEGER,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "department_id" INTEGER,
    "budgeted_hours" DOUBLE PRECISION,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_team_selection" (
    "id" SERIAL NOT NULL,
    "supervisor_id" INTEGER NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "work_date" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_at" TIMESTAMP(3),

    CONSTRAINT "daily_team_selection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "timesheet_days" (
    "id" SERIAL NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "work_date" TIMESTAMP(3) NOT NULL,
    "tagged_by" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "remarks" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "timesheet_days_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "timesheet_entries" (
    "id" SERIAL NOT NULL,
    "timesheet_day_id" INTEGER NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "work_date" TIMESTAMP(3) NOT NULL,
    "hour_slot" INTEGER,
    "shift_slot" TEXT,
    "ot_hours" INTEGER,
    "project_wbs_id" INTEGER,
    "job_order_id" INTEGER,
    "tagged_by" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "timesheet_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approvals" (
    "id" SERIAL NOT NULL,
    "timesheet_day_id" INTEGER NOT NULL,
    "approver_id" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "comment" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conflicts" (
    "id" SERIAL NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "work_date" TIMESTAMP(3) NOT NULL,
    "supervisor_id_1" INTEGER NOT NULL,
    "supervisor_id_2" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "resolved_by" INTEGER,
    "resolved_at" TIMESTAMP(3),
    "detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conflicts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "manpower_requests" (
    "id" SERIAL NOT NULL,
    "requesting_dept_id" INTEGER NOT NULL,
    "requested_by" INTEGER NOT NULL,
    "headcount" INTEGER NOT NULL,
    "work_date" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "assigned_employee_id" INTEGER,
    "assigned_by" INTEGER,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "manpower_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_feed" (
    "id" SERIAL NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "work_date" TIMESTAMP(3) NOT NULL,
    "present" BOOLEAN NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'CLMS',
    "imported_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_feed_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cost_rates" (
    "id" SERIAL NOT NULL,
    "category" TEXT NOT NULL,
    "rate_per_hour" DOUBLE PRECISION NOT NULL,
    "effective_from" TIMESTAMP(3) NOT NULL,
    "effective_to" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cost_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "metadata" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_employee_id_key" ON "users"("employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "departments_name_key" ON "departments"("name");

-- CreateIndex
CREATE UNIQUE INDEX "departments_code_key" ON "departments"("code");

-- CreateIndex
CREATE UNIQUE INDEX "employees_ec_no_key" ON "employees"("ec_no");

-- CreateIndex
CREATE INDEX "employees_source_idx" ON "employees"("source");

-- CreateIndex
CREATE INDEX "employees_mobile_idx" ON "employees"("mobile");

-- CreateIndex
CREATE INDEX "employees_active_idx" ON "employees"("active");

-- CreateIndex
CREATE INDEX "sections_department_id_active_idx" ON "sections"("department_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "sections_department_id_code_key" ON "sections"("department_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "sections_department_id_name_key" ON "sections"("department_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "cost_centers_section_id_key" ON "cost_centers"("section_id");

-- CreateIndex
CREATE UNIQUE INDEX "cost_centers_code_key" ON "cost_centers"("code");

-- CreateIndex
CREATE INDEX "cost_centers_active_idx" ON "cost_centers"("active");

-- CreateIndex
CREATE UNIQUE INDEX "employee_section_assignments_employee_id_key" ON "employee_section_assignments"("employee_id");

-- CreateIndex
CREATE INDEX "employee_section_assignments_section_id_idx" ON "employee_section_assignments"("section_id");

-- CreateIndex
CREATE UNIQUE INDEX "supervisor_overrides_employee_id_key" ON "supervisor_overrides"("employee_id");

-- CreateIndex
CREATE INDEX "supervisor_overrides_revoked_at_idx" ON "supervisor_overrides"("revoked_at");

-- CreateIndex
CREATE INDEX "credential_deliveries_status_created_at_idx" ON "credential_deliveries"("status", "created_at");

-- CreateIndex
CREATE INDEX "sync_exceptions_status_last_seen_at_idx" ON "sync_exceptions"("status", "last_seen_at");

-- CreateIndex
CREATE UNIQUE INDEX "sync_exceptions_source_system_external_key_error_code_key" ON "sync_exceptions"("source_system", "external_key", "error_code");

-- CreateIndex
CREATE UNIQUE INDEX "employee_allocation_days_employee_id_work_date_key" ON "employee_allocation_days"("employee_id", "work_date");

-- CreateIndex
CREATE INDEX "employee_allocations_employee_id_work_date_idx" ON "employee_allocations"("employee_id", "work_date");

-- CreateIndex
CREATE UNIQUE INDEX "employee_allocations_allocation_day_id_shift_slot_key" ON "employee_allocations"("allocation_day_id", "shift_slot");

-- CreateIndex
CREATE UNIQUE INDEX "projects_wbs_code_key" ON "projects_wbs"("code");

-- CreateIndex
CREATE UNIQUE INDEX "projects_code_key" ON "projects"("code");

-- CreateIndex
CREATE UNIQUE INDEX "job_orders_code_key" ON "job_orders"("code");

-- CreateIndex
CREATE INDEX "job_orders_project_id_status_idx" ON "job_orders"("project_id", "status");

-- CreateIndex
CREATE INDEX "job_orders_department_id_idx" ON "job_orders"("department_id");

-- CreateIndex
CREATE INDEX "daily_team_selection_supervisor_id_work_date_idx" ON "daily_team_selection"("supervisor_id", "work_date");

-- CreateIndex
CREATE INDEX "daily_team_selection_employee_id_work_date_idx" ON "daily_team_selection"("employee_id", "work_date");

-- CreateIndex
CREATE UNIQUE INDEX "timesheet_days_employee_id_work_date_tagged_by_key" ON "timesheet_days"("employee_id", "work_date", "tagged_by");

-- CreateIndex
CREATE INDEX "timesheet_entries_work_date_tagged_by_idx" ON "timesheet_entries"("work_date", "tagged_by");

-- CreateIndex
CREATE INDEX "timesheet_entries_work_date_job_order_id_idx" ON "timesheet_entries"("work_date", "job_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "timesheet_entries_employee_id_work_date_hour_slot_tagged_by_key" ON "timesheet_entries"("employee_id", "work_date", "hour_slot", "tagged_by");

-- CreateIndex
CREATE UNIQUE INDEX "timesheet_entries_employee_id_work_date_shift_slot_tagged_b_key" ON "timesheet_entries"("employee_id", "work_date", "shift_slot", "tagged_by");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_feed_employee_id_work_date_key" ON "attendance_feed"("employee_id", "work_date");

-- CreateIndex
CREATE INDEX "cost_rates_category_effective_from_idx" ON "cost_rates"("category", "effective_from");

-- CreateIndex
CREATE INDEX "audit_log_entity_type_entity_id_idx" ON "audit_log"("entity_type", "entity_id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sections" ADD CONSTRAINT "sections_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_centers" ADD CONSTRAINT "cost_centers_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "sections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_section_assignments" ADD CONSTRAINT "employee_section_assignments_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_section_assignments" ADD CONSTRAINT "employee_section_assignments_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "sections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supervisor_overrides" ADD CONSTRAINT "supervisor_overrides_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supervisor_overrides" ADD CONSTRAINT "supervisor_overrides_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credential_deliveries" ADD CONSTRAINT "credential_deliveries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_allocation_days" ADD CONSTRAINT "employee_allocation_days_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_allocation_days" ADD CONSTRAINT "employee_allocation_days_approver_id_fkey" FOREIGN KEY ("approver_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_allocations" ADD CONSTRAINT "employee_allocations_allocation_day_id_fkey" FOREIGN KEY ("allocation_day_id") REFERENCES "employee_allocation_days"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_allocations" ADD CONSTRAINT "employee_allocations_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_allocations" ADD CONSTRAINT "employee_allocations_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_allocations" ADD CONSTRAINT "employee_allocations_job_order_id_fkey" FOREIGN KEY ("job_order_id") REFERENCES "job_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_allocations" ADD CONSTRAINT "employee_allocations_allocated_by_fkey" FOREIGN KEY ("allocated_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_orders" ADD CONSTRAINT "job_orders_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_orders" ADD CONSTRAINT "job_orders_project_wbs_id_fkey" FOREIGN KEY ("project_wbs_id") REFERENCES "projects_wbs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_orders" ADD CONSTRAINT "job_orders_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_team_selection" ADD CONSTRAINT "daily_team_selection_supervisor_id_fkey" FOREIGN KEY ("supervisor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_team_selection" ADD CONSTRAINT "daily_team_selection_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timesheet_days" ADD CONSTRAINT "timesheet_days_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timesheet_days" ADD CONSTRAINT "timesheet_days_tagged_by_fkey" FOREIGN KEY ("tagged_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timesheet_entries" ADD CONSTRAINT "timesheet_entries_timesheet_day_id_fkey" FOREIGN KEY ("timesheet_day_id") REFERENCES "timesheet_days"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timesheet_entries" ADD CONSTRAINT "timesheet_entries_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timesheet_entries" ADD CONSTRAINT "timesheet_entries_project_wbs_id_fkey" FOREIGN KEY ("project_wbs_id") REFERENCES "projects_wbs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timesheet_entries" ADD CONSTRAINT "timesheet_entries_job_order_id_fkey" FOREIGN KEY ("job_order_id") REFERENCES "job_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timesheet_entries" ADD CONSTRAINT "timesheet_entries_tagged_by_fkey" FOREIGN KEY ("tagged_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_timesheet_day_id_fkey" FOREIGN KEY ("timesheet_day_id") REFERENCES "timesheet_days"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_approver_id_fkey" FOREIGN KEY ("approver_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conflicts" ADD CONSTRAINT "conflicts_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conflicts" ADD CONSTRAINT "conflicts_supervisor_id_1_fkey" FOREIGN KEY ("supervisor_id_1") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conflicts" ADD CONSTRAINT "conflicts_supervisor_id_2_fkey" FOREIGN KEY ("supervisor_id_2") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conflicts" ADD CONSTRAINT "conflicts_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manpower_requests" ADD CONSTRAINT "manpower_requests_requesting_dept_id_fkey" FOREIGN KEY ("requesting_dept_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manpower_requests" ADD CONSTRAINT "manpower_requests_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manpower_requests" ADD CONSTRAINT "manpower_requests_assigned_employee_id_fkey" FOREIGN KEY ("assigned_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manpower_requests" ADD CONSTRAINT "manpower_requests_assigned_by_fkey" FOREIGN KEY ("assigned_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_feed" ADD CONSTRAINT "attendance_feed_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- PostgreSQL-only integrity rules for the nullable timesheet slot model.
ALTER TABLE "timesheet_entries"
  ADD CONSTRAINT "timesheet_entries_exactly_one_slot_check"
  CHECK (num_nonnulls("hour_slot", "shift_slot", "ot_hours") = 1);

CREATE UNIQUE INDEX "timesheet_entries_ot_unique"
  ON "timesheet_entries" ("employee_id", "work_date", "tagged_by")
  WHERE "ot_hours" IS NOT NULL;
-- Immutable decision history for payroll/My Hours approvals.
CREATE TABLE "employee_allocation_approvals" (
    "id" SERIAL NOT NULL,
    "allocation_day_id" INTEGER NOT NULL,
    "approver_id" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "comment" TEXT,
    "resulting_status" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "employee_allocation_approvals_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "employee_allocation_approvals_approver_id_created_at_idx"
    ON "employee_allocation_approvals"("approver_id", "created_at");
CREATE INDEX "employee_allocation_approvals_allocation_day_id_idx"
    ON "employee_allocation_approvals"("allocation_day_id");
ALTER TABLE "employee_allocation_approvals"
    ADD CONSTRAINT "employee_allocation_approvals_allocation_day_id_fkey"
    FOREIGN KEY ("allocation_day_id") REFERENCES "employee_allocation_days"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "employee_allocation_approvals"
    ADD CONSTRAINT "employee_allocation_approvals_approver_id_fkey"
    FOREIGN KEY ("approver_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- HOD Department+Section scope and durable PM/Admin organisation transfers.
ALTER TABLE "users" ADD COLUMN "section_id" INTEGER;

CREATE TABLE "employee_organisation_overrides" (
    "id" SERIAL NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "department_id" INTEGER NOT NULL,
    "section_id" INTEGER NOT NULL,
    "created_by" INTEGER,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "employee_organisation_overrides_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "users_section_id_idx" ON "users"("section_id");
CREATE UNIQUE INDEX "employee_organisation_overrides_employee_id_key" ON "employee_organisation_overrides"("employee_id");
CREATE INDEX "employee_organisation_overrides_department_id_section_id_idx" ON "employee_organisation_overrides"("department_id", "section_id");
ALTER TABLE "users" ADD CONSTRAINT "users_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "sections"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "employee_organisation_overrides" ADD CONSTRAINT "employee_organisation_overrides_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "employee_organisation_overrides" ADD CONSTRAINT "employee_organisation_overrides_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "employee_organisation_overrides" ADD CONSTRAINT "employee_organisation_overrides_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "sections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "employee_organisation_overrides" ADD CONSTRAINT "employee_organisation_overrides_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill only unambiguous HOD mappings from an already-linked Employee.
UPDATE "users" AS u
SET "section_id" = esa."section_id"
FROM "employee_section_assignments" AS esa
JOIN "sections" AS s ON s."id" = esa."section_id"
WHERE u."role" = 'HOD' AND u."section_id" IS NULL
  AND u."employee_id" = esa."employee_id" AND u."department_id" = s."department_id";
COMMIT;
