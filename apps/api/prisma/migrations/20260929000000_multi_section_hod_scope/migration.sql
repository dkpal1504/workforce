-- Multi-Section Section Head: the section scope a user may act within.
--
-- WHY THIS IS DATA-DRIVEN: production is NOT the dev database. It has its own
-- Departments and Sections, and new ones may exist by the time this runs. Nothing
-- in this migration names an id, a code or a department — it copies whatever is
-- there. A Section created after this migration simply has no scope rows until an
-- Admin ticks it, which is the correct default.

-- CreateTable
CREATE TABLE "user_scope_sections" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "section_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_scope_sections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_scope_sections_section_id_idx" ON "user_scope_sections"("section_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_scope_sections_user_id_section_id_key" ON "user_scope_sections"("user_id", "section_id");

-- AddForeignKey
ALTER TABLE "user_scope_sections" ADD CONSTRAINT "user_scope_sections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_scope_sections" ADD CONSTRAINT "user_scope_sections_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "sections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- BACKFILL — the load-bearing statement of this migration.
--
-- Every account that already holds a single-Section scope gets exactly one row,
-- so "HOD of Section X" keeps meaning precisely that. WITHOUT THIS, every existing
-- Section Head silently becomes DEPARTMENT-WIDE (an empty set means all Sections),
-- which is a privilege escalation, not a cosmetic bug.
--
-- A user with section_id NULL is deliberately NOT inserted: an empty set already
-- means the whole Department, which is what NULL means today, so skipping them
-- preserves their current authority exactly.
--
-- ON CONFLICT DO NOTHING (no named target) because the unique index contains no
-- nullable column here, but naming a target would couple this to index naming.
-- ============================================================================
INSERT INTO "user_scope_sections" ("user_id", "section_id", "created_at")
SELECT u."id", u."section_id", NOW()
FROM "users" u
WHERE u."section_id" IS NOT NULL
ON CONFLICT DO NOTHING;
