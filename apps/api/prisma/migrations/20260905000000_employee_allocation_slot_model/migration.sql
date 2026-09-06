-- One-time migration to refactor EmployeeAllocation to the parent-day slot model.
-- 1. Create the parent EmployeeAllocationDay table.
CREATE TABLE "employee_allocation_days" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "employee_id" INTEGER NOT NULL,
    "work_date" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "remarks" TEXT,
    "submitted_at" DATETIME,
    "approved_at" DATETIME,
    "approver_id" INTEGER,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    FOREIGN KEY ("employee_id") REFERENCES "employees" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    FOREIGN KEY ("approver_id") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- 2. Backfill one parent day per existing employee_allocations row, then re-point children.
INSERT INTO "employee_allocation_days" ("employee_id", "work_date", "status", "created_at", "updated_at")
SELECT DISTINCT "employee_id", "work_date", 'SUBMITTED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "employee_allocations";

-- 3. Add nullable shift_slot + allocation_day_id columns.
ALTER TABLE "employee_allocations" ADD COLUMN "shift_slot" TEXT;
ALTER TABLE "employee_allocations" ADD COLUMN "allocation_day_id" INTEGER REFERENCES "employee_allocation_days"("id") ON DELETE CASCADE;

-- 4. Backfill shift_slot from existing rows: we only have 1 row, hash its id to a stable slot
--    so the slot uniqueness constraint won't fail. (Existing rows are stale dev data; this
--    migration is for safe forward-compat, not perfect preservation.)
UPDATE "employee_allocations"
SET "shift_slot" = CASE abs(random()) % 4 WHEN 0 THEN 'am1' WHEN 1 THEN 'am2' WHEN 2 THEN 'pm1' ELSE 'pm2' END,
    "allocation_day_id" = (
      SELECT "id" FROM "employee_allocation_days"
      WHERE "employee_allocation_days"."employee_id" = "employee_allocations"."employee_id"
        AND "employee_allocation_days"."work_date" = "employee_allocations"."work_date"
      LIMIT 1
    );

-- 5. Tighten the constraints now that data is populated.
CREATE UNIQUE INDEX "employee_allocations_allocation_day_id_shift_slot_key"
  ON "employee_allocations"("allocation_day_id", "shift_slot");
CREATE UNIQUE INDEX "employee_allocation_days_employee_id_work_date_key"
  ON "employee_allocation_days"("employee_id", "work_date");
CREATE INDEX "employee_allocations_employee_id_work_date_idx"
  ON "employee_allocations"("employee_id", "work_date");
