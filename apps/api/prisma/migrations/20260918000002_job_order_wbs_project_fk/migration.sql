-- Make "the Job Order's Project must be the Project that owns its WBS" a database
-- guarantee, not a convention.
--
-- A Job Order carries both `project_wbs_id` and `project_id`. Nothing stopped a writer
-- from pointing those at different Projects, which would make the same Job Order appear
-- under one Project on one screen and another Project elsewhere. The composite foreign
-- key below closes that hole: the pair (project_wbs_id, project_id) must exist as a
-- (id, project_id) pair on `project_wbs`, so a Job Order can only reference a WBS that
-- belongs to its own Project.
--
-- It is declared in the Prisma schema as a second relation on `job_orders`
-- (`projectWbsOfProject`, with the supporting `@@unique([id, projectId])` on
-- `project_wbs`), so Prisma owns the constraint and a later `migrate dev` will not try
-- to drop it. Never navigate through that relation in code.
--
-- The statement order is the one Prisma generates, so the constraint name and the index
-- name match the schema exactly and `prisma migrate diff` stays clean.

-- Guard first: refuse to add the constraint while the data violates it, so the operator
-- gets a readable message instead of a raw constraint failure.
DO $$
DECLARE bad int;
BEGIN
  SELECT count(*) INTO bad
    FROM "job_orders" jo
    JOIN "project_wbs" w ON w."id" = jo."project_wbs_id"
   WHERE w."project_id" <> jo."project_id";
  IF bad > 0 THEN
    RAISE EXCEPTION 'job_orders whose project_id is not their WBS''s own project: % - correct them, then re-run', bad;
  END IF;
END $$;

CREATE UNIQUE INDEX "project_wbs_id_project_id_key" ON "project_wbs"("id", "project_id");

ALTER TABLE "job_orders"
  ADD CONSTRAINT "job_orders_project_wbs_id_project_id_fkey"
    FOREIGN KEY ("project_wbs_id", "project_id") REFERENCES "project_wbs"("id", "project_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
