-- One HOD heading more than one Department (e.g. Yardservice - EOU + Yardservice - SEZ).
--
-- ADDITIVE ONLY: one new join table, no column changes, no data migration. An account with no rows
-- here keeps today's meaning — the whole Department of its `department_id` — so every existing HOD
-- behaves identically the moment this deploys, and a rollback to the previous image is safe.

CREATE TABLE "user_scope_departments" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "department_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "user_scope_departments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_scope_departments_user_id_department_id_key" ON "user_scope_departments"("user_id", "department_id");
CREATE INDEX "user_scope_departments_department_id_idx" ON "user_scope_departments"("department_id");

ALTER TABLE "user_scope_departments" ADD CONSTRAINT "user_scope_departments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_scope_departments" ADD CONSTRAINT "user_scope_departments_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
