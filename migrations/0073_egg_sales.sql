-- Egg sales: agreements, spot orders, dispatches — and no slots.
--
-- A day's order book is DERIVED, never materialised: standing agreements whose
-- schedule covers the day, minus that day's exceptions, plus the day's spot
-- orders. What gets stored is only what somebody stated — the rule, the
-- exception, the one-off, and the loading that actually happened. Amino's
-- generated-slot system died of drift between the copies and the rule; there
-- are deliberately no copies here.
--
-- Price is never stored on an order. Every invoice line prices at
--   (benchmark on the day) + (size differential) + (customer's spread)
-- per egg — the benchmark being the same egg_benchmark_prices table owner
-- billing already reads, so there is one egg rate in the whole system.

-- The standing rule: N boxes on a schedule, priced at benchmark + spread.
CREATE TABLE IF NOT EXISTS "egg_agreements" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "customer_id"    uuid NOT NULL REFERENCES "contacts"("id"),
  -- 'daily', or 'weekdays' with the days named (0=Sunday .. 6=Saturday).
  "schedule"       varchar(10) NOT NULL DEFAULT 'daily',
  "days_of_week"   integer[],
  "boxes"          integer NOT NULL CHECK ("boxes" > 0),
  -- Rupees per EGG over (or under) the benchmark. The agreement's one price term.
  "spread_per_egg" numeric(10,4) NOT NULL DEFAULT 0,
  "start_date"     date NOT NULL,
  -- Null while open. Ending an agreement is setting this, never deleting the
  -- row — past invoices were priced off its spread and must stay explainable.
  "end_date"       date,
  "status"         varchar(10) NOT NULL DEFAULT 'active',
  "notes"          text,
  "created_by"     uuid NOT NULL REFERENCES "users"("id"),
  "created_at"     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "ck_egg_agreements_schedule" CHECK ("schedule" IN ('daily', 'weekdays')),
  CONSTRAINT "ck_egg_agreements_status" CHECK ("status" IN ('active', 'paused', 'ended'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_egg_agreements_customer" ON "egg_agreements" ("customer_id");
--> statement-breakpoint

-- One day where the rule does not apply: skipped outright, or a different
-- quantity. This is how a standing order is "voided" for a day without
-- touching the agreement or any other day.
CREATE TABLE IF NOT EXISTS "egg_agreement_exceptions" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "agreement_id" uuid NOT NULL REFERENCES "egg_agreements"("id") ON DELETE CASCADE,
  "on_date"      date NOT NULL,
  "kind"         varchar(12) NOT NULL,
  -- The boxes for a qty_override; meaningless on a skip.
  "boxes"        integer,
  "reason"       text,
  "created_by"   uuid NOT NULL REFERENCES "users"("id"),
  "created_at"   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "ck_egg_exceptions_kind" CHECK ("kind" IN ('skip', 'qty_override')),
  CONSTRAINT "uq_egg_exceptions_day" UNIQUE ("agreement_id", "on_date")
);
--> statement-breakpoint

-- A one-off booking for a date. Voiding sets status and keeps the row: the
-- calendar still shows what was booked and struck off, and nothing else ever
-- referenced it because nothing is generated from it.
CREATE TABLE IF NOT EXISTS "egg_spot_orders" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "customer_id"    uuid NOT NULL REFERENCES "contacts"("id"),
  "order_date"     date NOT NULL,
  "boxes"          integer NOT NULL CHECK ("boxes" > 0),
  -- Null means: the customer's standing spread if they have one, else zero.
  "spread_per_egg" numeric(10,4),
  "notes"          text,
  "status"         varchar(10) NOT NULL DEFAULT 'booked',
  "voided_reason"  text,
  "voided_by"      uuid REFERENCES "users"("id"),
  "voided_at"      timestamptz,
  "created_by"     uuid NOT NULL REFERENCES "users"("id"),
  "created_at"     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "ck_egg_spot_status" CHECK ("status" IN ('booked', 'voided'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_egg_spot_date" ON "egg_spot_orders" ("order_date");
--> statement-breakpoint

-- Per-size differentials against the benchmark, in rupees per egg.
-- Effective-dated like every rate table here: a new row never reaches back.
CREATE TABLE IF NOT EXISTS "egg_size_offsets" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "effective_from" date NOT NULL UNIQUE,
  "small"          numeric(10,4) NOT NULL DEFAULT 0,
  "medium"         numeric(10,4) NOT NULL DEFAULT 0,
  "large"          numeric(10,4) NOT NULL DEFAULT 0,
  "xl"             numeric(10,4) NOT NULL DEFAULT 0,
  "jumbo"          numeric(10,4) NOT NULL DEFAULT 0,
  "dirty"          numeric(10,4) NOT NULL DEFAULT 0,
  "created_by"     uuid REFERENCES "users"("id"),
  "created_at"     timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- The loading that actually happened, and the invoice it raised. The ONLY
-- place actual quantities, drivers and money attach. Once one of these exists
-- the order rows above are no longer the document — the invoice is, and
-- undoing means voiding the invoice, which marks this row void with it.
CREATE TABLE IF NOT EXISTS "egg_dispatches" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "dispatch_date"  date NOT NULL,
  "customer_id"    uuid NOT NULL REFERENCES "contacts"("id"),
  -- What it fulfils. Both null is a walk-in (a spot order is created for it);
  -- both set is refused — a loading answers one piece of paper.
  "agreement_id"   uuid REFERENCES "egg_agreements"("id"),
  "spot_order_id"  uuid REFERENCES "egg_spot_orders"("id"),
  -- Boxes loaded, by size as graded at the bay.
  "loaded_small"   integer NOT NULL DEFAULT 0,
  "loaded_medium"  integer NOT NULL DEFAULT 0,
  "loaded_large"   integer NOT NULL DEFAULT 0,
  "loaded_xl"      integer NOT NULL DEFAULT 0,
  "loaded_jumbo"   integer NOT NULL DEFAULT 0,
  "loaded_dirty"   integer NOT NULL DEFAULT 0,
  "driver_name"    text NOT NULL,
  "vehicle_number" text NOT NULL,
  "notes"          text,
  "invoice_id"     uuid NOT NULL REFERENCES "invoices"("id"),
  "status"         varchar(10) NOT NULL DEFAULT 'invoiced',
  "loaded_by"      uuid NOT NULL REFERENCES "users"("id"),
  "created_at"     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "ck_egg_dispatch_status" CHECK ("status" IN ('invoiced', 'void')),
  CONSTRAINT "ck_egg_dispatch_source" CHECK (NOT ("agreement_id" IS NOT NULL AND "spot_order_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_egg_dispatch_date" ON "egg_dispatches" ("dispatch_date");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_egg_dispatch_invoice" ON "egg_dispatches" ("invoice_id");
--> statement-breakpoint

-- One row of knobs. eggs_per_box is the trade's own unit (210 around here);
-- stock_from is the day egg stock starts counting — production before it is
-- history with no matching sales, and incrementing 4.24 crore historical eggs
-- nobody ever decremented would put a phantom mountain in the store.
CREATE TABLE IF NOT EXISTS "egg_sales_preferences" (
  "id"            boolean PRIMARY KEY DEFAULT true CHECK ("id"),
  "eggs_per_box"  integer NOT NULL DEFAULT 210,
  "egg_item_id"   uuid REFERENCES "items"("id"),
  "stock_from"    date NOT NULL DEFAULT CURRENT_DATE
);
--> statement-breakpoint

-- The stock item the eggs move through: counted in eggs, ungraded, because
-- production counts eggs before anyone has sized them. Created here (not at
-- runtime) so every environment gets the same item, then remembered in
-- preferences.
INSERT INTO "items" ("type", "name", "unit", "category", "track_inventory", "is_sold", "is_purchased", "description")
SELECT 'goods', 'Eggs (farm)', 'eggs', 'eggs', true, true, false,
       'Ungraded shell eggs at the farm. Stock rises with the day-end production record and falls when a dispatch is invoiced.'
WHERE NOT EXISTS (SELECT 1 FROM "items" WHERE "name" = 'Eggs (farm)');
--> statement-breakpoint
INSERT INTO "egg_sales_preferences" ("id", "egg_item_id")
SELECT true, (SELECT "id" FROM "items" WHERE "name" = 'Eggs (farm)')
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "egg_size_offsets" ("effective_from")
SELECT CURRENT_DATE
WHERE NOT EXISTS (SELECT 1 FROM "egg_size_offsets");
