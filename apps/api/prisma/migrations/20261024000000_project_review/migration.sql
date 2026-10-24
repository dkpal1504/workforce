-- Project review suite: extend the existing frozen-payload store and add the review ledger.
--
-- ADDITIVE except for one index swap on report_snapshot, which is safe by construction: the table has
-- zero rows (nothing reads it yet) and the old uniqueness (kind, periodStart, periodEnd) cannot express
-- "revision n+1 of the same period", which is the whole point of the freeze contract.
--
-- schema.postgresql.prisma is NOT to be updated: it is stale and missing models that already ship.

-- ---------- report_snapshot: subject, revision, provenance, summary columns ----------
ALTER TABLE "report_snapshot" ADD COLUMN "project_id" INTEGER;
ALTER TABLE "report_snapshot" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "report_snapshot" ADD COLUMN "capture_trigger" TEXT NOT NULL DEFAULT 'ON_DEMAND';
ALTER TABLE "report_snapshot" ADD COLUMN "provisional" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "report_snapshot" ADD COLUMN "payload_bytes" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "report_snapshot" ADD COLUMN "schema_version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "report_snapshot" ADD COLUMN "job_orders" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "report_snapshot" ADD COLUMN "budget_hours" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "report_snapshot" ADD COLUMN "actual_hours" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "report_snapshot" ADD COLUMN "burn_pct" DOUBLE PRECISION;
ALTER TABLE "report_snapshot" ADD COLUMN "scheduled_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "report_snapshot" ADD COLUMN "delayed_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "report_snapshot" ADD COLUMN "open_escalations" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "report_snapshot" ADD COLUMN "escalations_over_30d" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "report_snapshot" ADD COLUMN "actions_open" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "report_snapshot" ADD COLUMN "actions_overdue" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "report_snapshot" ADD COLUMN "headcount_peak" INTEGER NOT NULL DEFAULT 0;

DROP INDEX "report_snapshot_kind_period_from_period_to_key";
CREATE UNIQUE INDEX "report_snapshot_project_id_kind_period_from_period_to_revision_key"
  ON "report_snapshot"("project_id", "kind", "period_from", "period_to", "revision");
CREATE INDEX "report_snapshot_project_id_period_from_idx"
  ON "report_snapshot"("project_id", "period_from");

ALTER TABLE "report_snapshot" ADD CONSTRAINT "report_snapshot_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "report_snapshot" ADD CONSTRAINT "report_snapshot_frozen_by_fkey"
  FOREIGN KEY ("frozen_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------- review_sessions ----------
CREATE TABLE "review_sessions" (
    "id" SERIAL NOT NULL,
    "project_id" INTEGER NOT NULL,
    "period_kind" TEXT NOT NULL,
    "period_start" TIMESTAMP(3) NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'IN_PROGRESS',
    "snapshot_id" INTEGER,
    "opened_by" INTEGER NOT NULL,
    "opened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_by" INTEGER,
    "closed_at" TIMESTAMP(3),
    "last_wbs_id" INTEGER,
    "attendees_json" TEXT,
    "notes" TEXT,

    CONSTRAINT "review_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "review_sessions_project_id_period_kind_period_start_key"
  ON "review_sessions"("project_id", "period_kind", "period_start");
CREATE INDEX "review_sessions_project_id_status_idx" ON "review_sessions"("project_id", "status");

ALTER TABLE "review_sessions" ADD CONSTRAINT "review_sessions_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "review_sessions" ADD CONSTRAINT "review_sessions_snapshot_id_fkey"
  FOREIGN KEY ("snapshot_id") REFERENCES "report_snapshot"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "review_sessions" ADD CONSTRAINT "review_sessions_opened_by_fkey"
  FOREIGN KEY ("opened_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "review_sessions" ADD CONSTRAINT "review_sessions_closed_by_fkey"
  FOREIGN KEY ("closed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------- review_items ----------
CREATE TABLE "review_items" (
    "id" SERIAL NOT NULL,
    "session_id" INTEGER NOT NULL,
    "project_id" INTEGER NOT NULL,
    "project_wbs_id" INTEGER,
    "job_order_id" INTEGER,
    "kind" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "decision_outcome" TEXT,
    "owner_user_id" INTEGER,
    "owner_email" TEXT,
    "owner_name" TEXT,
    "due_on" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "carried_from_id" INTEGER,
    "carry_count" INTEGER NOT NULL DEFAULT 0,
    "source_message_id" INTEGER,
    "created_by" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "closed_at" TIMESTAMP(3),
    "closed_by" INTEGER,
    "closed_note" TEXT,

    CONSTRAINT "review_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "review_items_carried_from_id_key" ON "review_items"("carried_from_id");
CREATE INDEX "review_items_project_id_status_due_on_idx" ON "review_items"("project_id", "status", "due_on");
CREATE INDEX "review_items_session_id_kind_idx" ON "review_items"("session_id", "kind");
CREATE INDEX "review_items_job_order_id_idx" ON "review_items"("job_order_id");

ALTER TABLE "review_items" ADD CONSTRAINT "review_items_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "review_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_job_order_id_fkey"
  FOREIGN KEY ("job_order_id") REFERENCES "job_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_owner_user_id_fkey"
  FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_carried_from_id_fkey"
  FOREIGN KEY ("carried_from_id") REFERENCES "review_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_closed_by_fkey"
  FOREIGN KEY ("closed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------- review_item_events ----------
CREATE TABLE "review_item_events" (
    "id" SERIAL NOT NULL,
    "item_id" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "from_value" TEXT,
    "to_value" TEXT,
    "note" TEXT,
    "actor_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_item_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "review_item_events_item_id_created_at_idx" ON "review_item_events"("item_id", "created_at");

ALTER TABLE "review_item_events" ADD CONSTRAINT "review_item_events_item_id_fkey"
  FOREIGN KEY ("item_id") REFERENCES "review_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "review_item_events" ADD CONSTRAINT "review_item_events_actor_id_fkey"
  FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
