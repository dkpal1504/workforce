-- HOD Department+Section scope and durable PM/Admin organisation transfers.
ALTER TABLE "users" ADD COLUMN "section_id" INTEGER;

CREATE TABLE "employee_organisation_overrides" (
    "id" SERIAL NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "department_id" INTEGER NOT NULL,
    "section_id" INTEGER NOT NULL,
    "created_by" INTEGER,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "employee_organisation_overrides_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "users_section_id_idx" ON "users"("section_id");
CREATE UNIQUE INDEX "employee_organisation_overrides_employee_id_key" ON "employee_organisation_overrides"("employee_id");
CREATE INDEX "employee_organisation_overrides_department_id_section_id_idx" ON "employee_organisation_overrides"("department_id", "section_id");
ALTER TABLE "users" ADD CONSTRAINT "users_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "sections"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "employee_organisation_overrides" ADD CONSTRAINT "employee_organisation_overrides_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "employee_organisation_overrides" ADD CONSTRAINT "employee_organisation_overrides_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "employee_organisation_overrides" ADD CONSTRAINT "employee_organisation_overrides_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "sections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "employee_organisation_overrides" ADD CONSTRAINT "employee_organisation_overrides_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill only unambiguous HOD mappings from an already-linked Employee.
UPDATE "users" AS u
SET "section_id" = esa."section_id"
FROM "employee_section_assignments" AS esa
JOIN "sections" AS s ON s."id" = esa."section_id"
WHERE u."role" = 'HOD' AND u."section_id" IS NULL
  AND u."employee_id" = esa."employee_id" AND u."department_id" = s."department_id";
