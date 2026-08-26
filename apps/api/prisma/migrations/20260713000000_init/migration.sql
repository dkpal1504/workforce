-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('SUPERVISOR', 'HOD', 'PM', 'HR', 'FINANCE', 'ADMIN');
CREATE TYPE "EmployeeCategory" AS ENUM ('ASSOCIATE', 'CONTRACTOR', 'ON_ROLL');
CREATE TYPE "TeamSource" AS ENUM ('CARRIED_OVER', 'ADDED', 'REMOVED');
CREATE TYPE "TimesheetStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'SUP_APPROVED', 'HOD_APPROVED', 'PM_APPROVED', 'REJECTED');
CREATE TYPE "ConflictStatus" AS ENUM ('OPEN', 'RESOLVED');
CREATE TYPE "ApprovalAction" AS ENUM ('APPROVE', 'REJECT');

-- CreateTable
CREATE TABLE "departments" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "departments_name_key" ON "departments"("name");
CREATE UNIQUE INDEX "departments_code_key" ON "departments"("code");

CREATE TABLE "employees" (
    "id" SERIAL NOT NULL,
    "ec_no" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "department_id" INTEGER NOT NULL,
    "designation" TEXT NOT NULL,
    "category" "EmployeeCategory" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "employees_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "employees_ec_no_key" ON "employees"("ec_no");

CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "employee_id" INTEGER,
    "department_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
CREATE UNIQUE INDEX "users_employee_id_key" ON "users"("employee_id");

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
CREATE UNIQUE INDEX "projects_wbs_code_key" ON "projects_wbs"("code");

CREATE TABLE "daily_team_selection" (
    "id" SERIAL NOT NULL,
    "supervisor_id" INTEGER NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "work_date" DATE NOT NULL,
    "source" "TeamSource" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_at" TIMESTAMP(3),
    CONSTRAINT "daily_team_selection_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "daily_team_selection_supervisor_id_work_date_idx" ON "daily_team_selection"("supervisor_id", "work_date");
CREATE INDEX "daily_team_selection_employee_id_work_date_idx" ON "daily_team_selection"("employee_id", "work_date");

CREATE TABLE "timesheet_days" (
    "id" SERIAL NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "work_date" DATE NOT NULL,
    "tagged_by" INTEGER NOT NULL,
    "status" "TimesheetStatus" NOT NULL DEFAULT 'DRAFT',
    "remarks" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "timesheet_days_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "timesheet_days_employee_id_work_date_tagged_by_key" ON "timesheet_days"("employee_id", "work_date", "tagged_by");

CREATE TABLE "timesheet_entries" (
    "id" SERIAL NOT NULL,
    "timesheet_day_id" INTEGER NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "work_date" DATE NOT NULL,
    "hour_slot" INTEGER NOT NULL,
    "project_wbs_id" INTEGER,
    "tagged_by" INTEGER NOT NULL,
    "status" "TimesheetStatus" NOT NULL DEFAULT 'DRAFT',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "timesheet_entries_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "timesheet_entries_employee_id_work_date_hour_slot_tagged_by_key" ON "timesheet_entries"("employee_id", "work_date", "hour_slot", "tagged_by");
CREATE INDEX "timesheet_entries_work_date_tagged_by_idx" ON "timesheet_entries"("work_date", "tagged_by");

CREATE TABLE "approvals" (
    "id" SERIAL NOT NULL,
    "timesheet_day_id" INTEGER NOT NULL,
    "approver_id" INTEGER NOT NULL,
    "action" "ApprovalAction" NOT NULL,
    "comment" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "approvals_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "conflicts" (
    "id" SERIAL NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "work_date" DATE NOT NULL,
    "supervisor_id_1" INTEGER NOT NULL,
    "supervisor_id_2" INTEGER NOT NULL,
    "status" "ConflictStatus" NOT NULL DEFAULT 'OPEN',
    "resolved_by" INTEGER,
    "resolved_at" TIMESTAMP(3),
    "detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "conflicts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "manpower_requests" (
    "id" SERIAL NOT NULL,
    "requesting_dept_id" INTEGER NOT NULL,
    "requested_by" INTEGER NOT NULL,
    "headcount" INTEGER NOT NULL,
    "work_date" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "assigned_employee_id" INTEGER,
    "assigned_by" INTEGER,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "manpower_requests_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "attendance_feed" (
    "id" SERIAL NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "work_date" DATE NOT NULL,
    "present" BOOLEAN NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'CLMS',
    "imported_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "attendance_feed_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "attendance_feed_employee_id_work_date_key" ON "attendance_feed"("employee_id", "work_date");

CREATE TABLE "cost_rates" (
    "id" SERIAL NOT NULL,
    "category" "EmployeeCategory" NOT NULL,
    "rate_per_hour" DECIMAL(10,2) NOT NULL,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "cost_rates_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "cost_rates_category_effective_from_idx" ON "cost_rates"("category", "effective_from");

CREATE TABLE "audit_log" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "audit_log_entity_type_entity_id_idx" ON "audit_log"("entity_type", "entity_id");

-- ForeignKeys
ALTER TABLE "employees" ADD CONSTRAINT "employees_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "users" ADD CONSTRAINT "users_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "users" ADD CONSTRAINT "users_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "daily_team_selection" ADD CONSTRAINT "daily_team_selection_supervisor_id_fkey" FOREIGN KEY ("supervisor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "daily_team_selection" ADD CONSTRAINT "daily_team_selection_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "timesheet_days" ADD CONSTRAINT "timesheet_days_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "timesheet_days" ADD CONSTRAINT "timesheet_days_tagged_by_fkey" FOREIGN KEY ("tagged_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "timesheet_entries" ADD CONSTRAINT "timesheet_entries_timesheet_day_id_fkey" FOREIGN KEY ("timesheet_day_id") REFERENCES "timesheet_days"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "timesheet_entries" ADD CONSTRAINT "timesheet_entries_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "timesheet_entries" ADD CONSTRAINT "timesheet_entries_project_wbs_id_fkey" FOREIGN KEY ("project_wbs_id") REFERENCES "projects_wbs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "timesheet_entries" ADD CONSTRAINT "timesheet_entries_tagged_by_fkey" FOREIGN KEY ("tagged_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_timesheet_day_id_fkey" FOREIGN KEY ("timesheet_day_id") REFERENCES "timesheet_days"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_approver_id_fkey" FOREIGN KEY ("approver_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "conflicts" ADD CONSTRAINT "conflicts_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "conflicts" ADD CONSTRAINT "conflicts_supervisor_id_1_fkey" FOREIGN KEY ("supervisor_id_1") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "conflicts" ADD CONSTRAINT "conflicts_supervisor_id_2_fkey" FOREIGN KEY ("supervisor_id_2") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "conflicts" ADD CONSTRAINT "conflicts_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "manpower_requests" ADD CONSTRAINT "manpower_requests_requesting_dept_id_fkey" FOREIGN KEY ("requesting_dept_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "manpower_requests" ADD CONSTRAINT "manpower_requests_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "manpower_requests" ADD CONSTRAINT "manpower_requests_assigned_employee_id_fkey" FOREIGN KEY ("assigned_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "manpower_requests" ADD CONSTRAINT "manpower_requests_assigned_by_fkey" FOREIGN KEY ("assigned_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "attendance_feed" ADD CONSTRAINT "attendance_feed_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
