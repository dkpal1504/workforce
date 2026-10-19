-- Project Manager scope: the assignment of an account to the Projects it manages.
--
-- ADDITIVE ONLY. One new table, its indexes and its foreign keys; no existing table is altered,
-- no column is added to one, and no row is rewritten or backfilled. Existing dashboards and
-- reports read the same columns they read before this migration, which is why there is nothing
-- to unwind beyond dropping this table.
--
-- Rows are NEVER deleted by the application: revoking an assignment sets `status = 'revoked'` and
-- stamps `revoked_at`, so the history of who managed a project stays answerable. The unique pair
-- is what makes a re-assignment reuse the row instead of adding a second history line.

-- CreateTable
CREATE TABLE "project_manager_assignments" (
    "id" SERIAL NOT NULL,
    "project_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "assigned_by" INTEGER,
    "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),
    "note" TEXT,

    CONSTRAINT "project_manager_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_manager_assignments_user_id_status_idx" ON "project_manager_assignments"("user_id", "status");

-- CreateIndex
CREATE INDEX "project_manager_assignments_project_id_status_idx" ON "project_manager_assignments"("project_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "project_manager_assignments_project_id_user_id_key" ON "project_manager_assignments"("project_id", "user_id");

-- AddForeignKey
ALTER TABLE "project_manager_assignments" ADD CONSTRAINT "project_manager_assignments_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_manager_assignments" ADD CONSTRAINT "project_manager_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_manager_assignments" ADD CONSTRAINT "project_manager_assignments_assigned_by_fkey" FOREIGN KEY ("assigned_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
