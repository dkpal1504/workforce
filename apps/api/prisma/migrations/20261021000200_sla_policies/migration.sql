-- How long a reply is expected to take, and when to nudge and escalate.
--
-- Rows, not constants: a department that negotiates a different clock adds its own row without a deploy.
-- The null-department row is the default for everybody. Seeded here so production and a fresh restore
-- agree on what "on time" means from day one.

CREATE TABLE "sla_policies" (
    "id" SERIAL NOT NULL,
    "kind" TEXT NOT NULL,
    "department_id" INTEGER,
    "response_hours" INTEGER NOT NULL,
    "remind_hours" INTEGER NOT NULL,
    "escalate_hours" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "sla_policies_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sla_policies_kind_department_id_key" ON "sla_policies"("kind", "department_id");

ALTER TABLE "sla_policies" ADD CONSTRAINT "sla_policies_department_id_fkey"
  FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "sla_policies" ("kind", "department_id", "response_hours", "remind_hours", "escalate_hours") VALUES
  ('ESCALATION', NULL,  4,  8, 24),
  ('RECOVERY',   NULL, 24, 48, 72)
ON CONFLICT ("kind", "department_id") DO NOTHING;
