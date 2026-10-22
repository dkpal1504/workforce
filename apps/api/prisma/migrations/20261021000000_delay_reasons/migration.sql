-- The eight causes of delay, as codes.
--
-- Codes, not free text, because the only question this table exists to answer is "40% of delays this
-- quarter were material-related". A label can be reworded later; a code cannot, or last quarter's
-- report stops meaning the same thing. Seeded here so production and a fresh restore agree.

CREATE TABLE "delay_reasons" (
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "delay_reasons_pkey" PRIMARY KEY ("code")
);

INSERT INTO "delay_reasons" ("code", "label", "sort_order") VALUES
  ('MANPOWER',    'Manpower shortage',       1),
  ('MATERIAL',    'Material not available',  2),
  ('DRAWING',     'Drawing / design hold',   3),
  ('PERMIT',      'Permit or access',        4),
  ('EQUIPMENT',   'Equipment',               5),
  ('WEATHER',     'Weather',                 6),
  ('CLIENT_HOLD', 'Client hold',             7),
  ('REWORK',      'Rework',                  8)
ON CONFLICT ("code") DO NOTHING;
