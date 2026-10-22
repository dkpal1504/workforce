-- The constraint register: what is holding a WBS node up, who owns it, and when it closed.
--
-- ADDITIVE, scalars only (no cascade): a hindrance is evidence. Deleting a thread must not erase the
-- record that a vendor was three weeks late, which is exactly what somebody will look for later.

CREATE TABLE "wbs_hindrances" (
    "id" SERIAL NOT NULL,
    "project_wbs_id" INTEGER NOT NULL,
    "job_order_id" INTEGER,
    "thread_id" INTEGER,
    "message_id" INTEGER,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "raised_by_user_id" INTEGER,
    "raised_by_email" TEXT NOT NULL,
    "raised_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "owner_user_id" INTEGER,
    "owner_email" TEXT,
    "target_date" TIMESTAMP(3),
    "impact_days" INTEGER,
    "state" TEXT NOT NULL DEFAULT 'OPEN',
    "closed_by_user_id" INTEGER,
    "closed_by_name" TEXT,
    "closed_at" TIMESTAMP(3),
    "closure_note" TEXT,
    CONSTRAINT "wbs_hindrances_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "wbs_hindrances_project_wbs_id_state_idx" ON "wbs_hindrances"("project_wbs_id", "state");
CREATE INDEX "wbs_hindrances_state_raised_at_idx" ON "wbs_hindrances"("state", "raised_at");
