-- A rate per box, for the grades sold that way.
--
-- Niko is sold at a rate per box, set by hand, with nothing to do with the
-- benchmark, the size differentials or a customer's spread — the user on
-- 13 Sep 2026: "in sales niko has a direct box rate nothing to do with
-- benchmark". Effective-dated like the benchmark and the differentials: a new
-- rate never reaches back over an invoice already raised.
--
-- Keyed by size rather than being a Niko-only column, so a second grade sold
-- by the box is a row here and not another table.
CREATE TABLE IF NOT EXISTS "egg_box_rates" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "size"           varchar(10) NOT NULL,
  "effective_from" date NOT NULL,
  "rate_per_box"   numeric(12,2) NOT NULL CHECK ("rate_per_box" > 0),
  "note"           text,
  "created_by"     uuid REFERENCES "users"("id"),
  "created_at"     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "uq_egg_box_rates_size_day" UNIQUE ("size", "effective_from")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_egg_box_rates_size" ON "egg_box_rates" ("size", "effective_from");
