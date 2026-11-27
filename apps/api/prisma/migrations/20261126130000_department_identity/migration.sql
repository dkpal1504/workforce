-- Department identity: the FACILITY (plant) and the FUNCTION each Department belongs to.
--
-- ADDITIVE AND NULLABLE on purpose. Existing rows keep NULL until the backfill script derives the two
-- values from the name (`apps/api/scripts/backfill-department-identity.mjs`) — no row is rewritten here,
-- no UPDATE runs in a migration, and older code that does not select the columns is unaffected.
--
-- Why it is needed: one function is two Department rows because the yard has two facilities
-- (Yardservice - EOU and Yardservice - SEZ, Safety - EOU / - SEZ, Civil, Health & Wellness, Administration).
-- Until now the split existed only in the name suffix, so nothing could report "Yardservice" as ONE
-- function across both plants, and a two-plant HOD grant looked like two unrelated departments.

ALTER TABLE "departments" ADD COLUMN "business_unit" TEXT;
ALTER TABLE "departments" ADD COLUMN "function_group" TEXT;

CREATE INDEX "departments_function_group_business_unit_idx" ON "departments" ("function_group", "business_unit");
