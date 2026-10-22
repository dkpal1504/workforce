-- A recovery offer, and the date the application commits to when one is accepted.
--
-- ADDITIVE. `committed_finish_date` is deliberately separate from `planned_end_date`: the Job Order CSV
-- upload owns the plan and would silently undo an accepted commitment on its next run.

CREATE TABLE "job_order_recoveries" (
    "id" SERIAL NOT NULL,
    "thread_id" INTEGER NOT NULL,
    "message_id" INTEGER NOT NULL,
    "job_order_id" INTEGER NOT NULL,
    "project_wbs_id" INTEGER,
    "proposed_by_user_id" INTEGER,
    "proposed_by_name" TEXT NOT NULL,
    "proposed_by_email" TEXT NOT NULL,
    "revised_finish_date" TIMESTAMP(3) NOT NULL,
    "manpower_plan_json" TEXT,
    "note" TEXT,
    "state" TEXT NOT NULL DEFAULT 'PROPOSED',
    "decided_by_user_id" INTEGER,
    "decided_by_name" TEXT,
    "decided_at" TIMESTAMP(3),
    "decision_note" TEXT,
    "applied_from" TIMESTAMP(3),
    "applied_to" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "job_order_recoveries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "job_order_recoveries_message_id_key" ON "job_order_recoveries"("message_id");
CREATE INDEX "job_order_recoveries_job_order_id_state_idx" ON "job_order_recoveries"("job_order_id", "state");

ALTER TABLE "job_orders" ADD COLUMN "committed_finish_date" TIMESTAMP(3),
ADD COLUMN "committed_set_at" TIMESTAMP(3),
ADD COLUMN "committed_recovery_id" INTEGER;
