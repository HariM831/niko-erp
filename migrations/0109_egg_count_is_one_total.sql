-- The closing count is one total per size, not per shed.
--
-- The user, 29 Sep 2026: "closing is one total per size". The packing room
-- counts what is on its shelves by grade; nobody counts eggs by the shed they
-- came from once they are boxed. egg_house_closing assumed an evening count in
-- each shed's room and was never filled — no row on staging or production —
-- so it is dropped rather than migrated, and the day's count takes its place.
CREATE TABLE IF NOT EXISTS "egg_stock_count" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "counted_on" date NOT NULL,
  "small" integer DEFAULT 0 NOT NULL CHECK ("small" >= 0),
  "medium" integer DEFAULT 0 NOT NULL CHECK ("medium" >= 0),
  "large" integer DEFAULT 0 NOT NULL CHECK ("large" >= 0),
  "xl" integer DEFAULT 0 NOT NULL CHECK ("xl" >= 0),
  "jumbo" integer DEFAULT 0 NOT NULL CHECK ("jumbo" >= 0),
  "brown" integer DEFAULT 0 NOT NULL CHECK ("brown" >= 0),
  "niko" integer DEFAULT 0 NOT NULL CHECK ("niko" >= 0),
  "dirty" integer DEFAULT 0 NOT NULL CHECK ("dirty" >= 0),
  "recorded_by" uuid NOT NULL REFERENCES "users"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_egg_stock_count_day" ON "egg_stock_count" ("counted_on");
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'egg_house_closing') THEN
    IF EXISTS (SELECT 1 FROM "egg_house_closing") THEN
      RAISE EXCEPTION 'egg_house_closing holds counts; sum them into egg_stock_count before dropping it';
    END IF;
    DROP TABLE "egg_house_closing";
  END IF;
END $$;
