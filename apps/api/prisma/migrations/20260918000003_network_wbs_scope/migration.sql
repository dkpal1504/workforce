-- A Network belongs to a WBS element, not to the whole project.
--
-- Confirmed by the user: one Network number cannot span two WBS elements of the same
-- project. Until now `networks` was scoped to the project, so a Job Order could point
-- at a Network that belonged to a different WBS of the same project. The Job Order
-- upload now validates Network_ID against the WBS_NO on its own line, which the
-- template already carries.
--
-- Existing rows are backfilled onto their project's FIRST WBS row (lowest sort_order,
-- then lowest wbs_code). The backfill does NOT filter on `active`, so a project whose
-- first row happens to be inactive still gets a valid parent. A Network whose project has no WBS row at all
-- cannot be placed, so the guard below stops the migration and names it: add a WBS row
-- to that project (or delete the Network) and re-run. Nothing is invented silently.

ALTER TABLE "networks" ADD COLUMN "wbs_id" INTEGER;

UPDATE "networks" n
   SET "wbs_id" = pick."id"
  FROM (
    SELECT DISTINCT ON (w."project_id") w."project_id", w."id"
      FROM "project_wbs" w
     ORDER BY w."project_id", w."sort_order", w."wbs_code"
  ) AS pick
 WHERE pick."project_id" = n."project_id";

DO $$
DECLARE orphans text;
BEGIN
  SELECT string_agg(format('"%s" in project #%s', n."code", n."project_id"), ', ')
    INTO orphans
    FROM "networks" n
   WHERE n."wbs_id" IS NULL;
  IF orphans IS NOT NULL THEN
    RAISE EXCEPTION 'networks that cannot be placed on a WBS (their project has no WBS row): %. Add a WBS row to that project, or delete the Network, then re-run.', orphans;
  END IF;
END $$;

ALTER TABLE "networks"
  ALTER COLUMN "wbs_id" SET NOT NULL,
  ADD CONSTRAINT "networks_wbs_id_fkey"
    FOREIGN KEY ("wbs_id") REFERENCES "project_wbs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "networks_wbs_id_active_idx" ON "networks"("wbs_id", "active");
