-- Spot orders by size, as the trade actually books them.
--
-- A customer ringing for tomorrow says "200 Large and 50 Medium", not "250
-- boxes" - Amino's spot orders were per size from the start. The per-size
-- columns become the entry; `boxes` stays as the total the calendar sums,
-- maintained by the service. Existing total-only rows are carried as Large,
-- the grade nearly every box on the farm is.
ALTER TABLE "egg_spot_orders"
  ADD COLUMN IF NOT EXISTS "small"  integer NOT NULL DEFAULT 0 CHECK ("small" >= 0),
  ADD COLUMN IF NOT EXISTS "medium" integer NOT NULL DEFAULT 0 CHECK ("medium" >= 0),
  ADD COLUMN IF NOT EXISTS "large"  integer NOT NULL DEFAULT 0 CHECK ("large" >= 0),
  ADD COLUMN IF NOT EXISTS "xl"     integer NOT NULL DEFAULT 0 CHECK ("xl" >= 0),
  ADD COLUMN IF NOT EXISTS "jumbo"  integer NOT NULL DEFAULT 0 CHECK ("jumbo" >= 0),
  ADD COLUMN IF NOT EXISTS "dirty"  integer NOT NULL DEFAULT 0 CHECK ("dirty" >= 0);
--> statement-breakpoint
UPDATE "egg_spot_orders" SET "large" = "boxes"
WHERE "small" + "medium" + "large" + "xl" + "jumbo" + "dirty" = 0;
