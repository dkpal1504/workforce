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
