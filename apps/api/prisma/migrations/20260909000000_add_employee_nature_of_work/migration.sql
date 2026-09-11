-- Store the raw LabourWorks BadgeView [Nature Of Work] value separately
-- from application-facing grade/designation fields.
ALTER TABLE "employees" ADD COLUMN "nature_of_work" TEXT;
