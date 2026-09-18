-- Quantity progress: keep EVERY remark, not just the latest one.
--
-- Until now the single `job_order_progress.remarks` column was overwritten when the
-- PM rejected or sent an entry back, so the HOD's punched remark survived only in the
-- audit log, which is not reportable. This table records every remark in order, with
-- its author, the author's role and the stage it belongs to, so any report can show
-- the full conversation around a quantity entry.
--
-- The progress row keeps `remarks` as the LATEST message for convenience; this table
-- is the history. A superseded revision keeps its own rows, so an amendment never
-- loses what was said about the revision it replaced.

CREATE TABLE "job_order_progress_remarks" (
    "id" SERIAL NOT NULL,
    "progress_id" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "remark" TEXT NOT NULL,
    "author_id" INTEGER,
    "author_role" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "job_order_progress_remarks_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "job_order_progress_remarks_progress_id_created_at_idx"
  ON "job_order_progress_remarks"("progress_id", "created_at");

ALTER TABLE "job_order_progress_remarks"
  ADD CONSTRAINT "job_order_progress_remarks_progress_id_fkey"
    FOREIGN KEY ("progress_id") REFERENCES "job_order_progress"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "job_order_progress_remarks_author_id_fkey"
    FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "job_order_progress_remarks_kind_check"
    CHECK ("kind" IN ('PUNCH', 'AMEND', 'APPROVE', 'REJECT', 'SEND_BACK'));

-- Backfill the remarks that already exist. A row that is REJECTED or SENT_BACK
-- carries the PM's decision remark; any other row carries the punched remark.
INSERT INTO "job_order_progress_remarks" ("progress_id", "kind", "remark", "author_id", "author_role", "created_at")
SELECT p."id",
       CASE WHEN p."status" IN ('REJECTED', 'SENT_BACK') THEN p."status" ELSE 'PUNCH' END,
       p."remarks",
       CASE WHEN p."status" IN ('REJECTED', 'SENT_BACK') THEN p."approved_by" ELSE p."punched_by" END,
       CASE WHEN p."status" IN ('REJECTED', 'SENT_BACK') THEN 'PM' ELSE 'HOD' END,
       COALESCE(p."approved_at", p."updated_at")
  FROM "job_order_progress" p
 WHERE p."remarks" IS NOT NULL AND p."remarks" <> '';
