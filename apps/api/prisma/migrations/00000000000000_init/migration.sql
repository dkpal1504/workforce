-- CreateTable
CREATE TABLE "users" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "id_card_no" TEXT,
    "employee_id" INTEGER,
    "department_id" INTEGER,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "users_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "users_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "departments" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "employees" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "ec_no" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "department_id" INTEGER NOT NULL,
    "designation" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "employees_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "contract_workers" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "workmen" TEXT NOT NULL,
    "id_card_no" TEXT NOT NULL,
    "bu_name" TEXT,
    "workmen_name" TEXT NOT NULL,
    "valid_from" DATETIME,
    "valid_upto" DATETIME,
    "bg_code" TEXT,
    "contractor" TEXT,
    "is_supervisor" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL DEFAULT 'SYNC',
    "last_synced_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "supervisor_pins" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "id_card_no" TEXT NOT NULL,
    "created_by" INTEGER,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "projects_wbs" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "wbs_code" TEXT NOT NULL,
    "color_key" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "projects" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color_key" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "job_orders" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "project_id" INTEGER NOT NULL,
    "project_wbs_id" INTEGER,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "department_id" INTEGER,
    "budgeted_hours" REAL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "job_orders_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "job_orders_project_wbs_id_fkey" FOREIGN KEY ("project_wbs_id") REFERENCES "projects_wbs" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "job_orders_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "daily_team_selection" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "supervisor_id" INTEGER NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "work_date" DATETIME NOT NULL,
    "source" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_at" DATETIME,
    CONSTRAINT "daily_team_selection_supervisor_id_fkey" FOREIGN KEY ("supervisor_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "daily_team_selection_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "timesheet_days" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "employee_id" INTEGER NOT NULL,
    "work_date" DATETIME NOT NULL,
    "tagged_by" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "remarks" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "timesheet_days_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "timesheet_days_tagged_by_fkey" FOREIGN KEY ("tagged_by") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "timesheet_entries" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "timesheet_day_id" INTEGER NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "work_date" DATETIME NOT NULL,
    "hour_slot" INTEGER,
    "shift_slot" TEXT,
    "ot_hours" INTEGER,
    "project_wbs_id" INTEGER,
    "job_order_id" INTEGER,
    "tagged_by" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "timesheet_entries_timesheet_day_id_fkey" FOREIGN KEY ("timesheet_day_id") REFERENCES "timesheet_days" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "timesheet_entries_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "timesheet_entries_project_wbs_id_fkey" FOREIGN KEY ("project_wbs_id") REFERENCES "projects_wbs" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "timesheet_entries_job_order_id_fkey" FOREIGN KEY ("job_order_id") REFERENCES "job_orders" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "timesheet_entries_tagged_by_fkey" FOREIGN KEY ("tagged_by") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "approvals" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "timesheet_day_id" INTEGER NOT NULL,
    "approver_id" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "comment" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "approvals_timesheet_day_id_fkey" FOREIGN KEY ("timesheet_day_id") REFERENCES "timesheet_days" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "approvals_approver_id_fkey" FOREIGN KEY ("approver_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "conflicts" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "employee_id" INTEGER NOT NULL,
    "work_date" DATETIME NOT NULL,
    "supervisor_id_1" INTEGER NOT NULL,
    "supervisor_id_2" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "resolved_by" INTEGER,
    "resolved_at" DATETIME,
    "detected_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "conflicts_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "conflicts_supervisor_id_1_fkey" FOREIGN KEY ("supervisor_id_1") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "conflicts_supervisor_id_2_fkey" FOREIGN KEY ("supervisor_id_2") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "conflicts_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "manpower_requests" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "requesting_dept_id" INTEGER NOT NULL,
    "requested_by" INTEGER NOT NULL,
    "headcount" INTEGER NOT NULL,
    "work_date" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "assigned_employee_id" INTEGER,
    "assigned_by" INTEGER,
    "notes" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "manpower_requests_requesting_dept_id_fkey" FOREIGN KEY ("requesting_dept_id") REFERENCES "departments" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "manpower_requests_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "manpower_requests_assigned_employee_id_fkey" FOREIGN KEY ("assigned_employee_id") REFERENCES "employees" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "manpower_requests_assigned_by_fkey" FOREIGN KEY ("assigned_by") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "attendance_feed" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "employee_id" INTEGER NOT NULL,
    "work_date" DATETIME NOT NULL,
    "present" BOOLEAN NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'CLMS',
    "imported_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "attendance_feed_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "cost_rates" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "category" TEXT NOT NULL,
    "rate_per_hour" REAL NOT NULL,
    "effective_from" DATETIME NOT NULL,
    "effective_to" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "metadata" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "audit_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_id_card_no_key" ON "users"("id_card_no");

-- CreateIndex
CREATE UNIQUE INDEX "users_employee_id_key" ON "users"("employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "departments_name_key" ON "departments"("name");

-- CreateIndex
CREATE UNIQUE INDEX "departments_code_key" ON "departments"("code");

-- CreateIndex
CREATE UNIQUE INDEX "employees_ec_no_key" ON "employees"("ec_no");

-- CreateIndex
CREATE UNIQUE INDEX "contract_workers_id_card_no_key" ON "contract_workers"("id_card_no");

-- CreateIndex
CREATE INDEX "contract_workers_source_idx" ON "contract_workers"("source");

-- CreateIndex
CREATE INDEX "contract_workers_is_supervisor_idx" ON "contract_workers"("is_supervisor");

-- CreateIndex
CREATE UNIQUE INDEX "supervisor_pins_id_card_no_key" ON "supervisor_pins"("id_card_no");

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
CREATE UNIQUE INDEX "timesheet_entries_employee_id_work_date_shift_slot_tagged_by_key" ON "timesheet_entries"("employee_id", "work_date", "shift_slot", "tagged_by");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_feed_employee_id_work_date_key" ON "attendance_feed"("employee_id", "work_date");

-- CreateIndex
CREATE INDEX "cost_rates_category_effective_from_idx" ON "cost_rates"("category", "effective_from");

-- CreateIndex
CREATE INDEX "audit_log_entity_type_entity_id_idx" ON "audit_log"("entity_type", "entity_id");

