-- A standalone weighbridge slip: a vehicle weighed, and nothing more claimed.
--
-- Kept apart from office_receipts because a goods receipt is a purchase — a
-- vendor bill, lines matched to a PO, a QC verdict, a settlement. Selling
-- scrap has none of that shape, and routing it through the receipt flow would
-- mean inventing a purchase order for a load leaving the yard.

CREATE TABLE IF NOT EXISTS "weigh_tickets" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "number"          text NOT NULL UNIQUE,
  "location_id"     uuid REFERENCES "locations"("id"),
  "vehicle_number"  varchar(20) NOT NULL,
  "party_id"        uuid REFERENCES "contacts"("id"),
  "item_id"         uuid REFERENCES "items"("id"),

  "gross_weight_kg" numeric(14,3),
  "gross_at"        timestamp,
  "gross_by"        uuid REFERENCES "users"("id"),

  "tare_weight_kg"  numeric(14,3),
  "tare_at"         timestamp,
  "tare_by"         uuid REFERENCES "users"("id"),

  -- The net is what the load is sold on. Computed, so it cannot drift from the
  -- two weighments it comes from — the same rule office_receipts follows.
  "net_weight_kg"   numeric(14,3)
    GENERATED ALWAYS AS ("gross_weight_kg" - "tare_weight_kg") STORED,

  "notes"           text,
  "print_count"     integer NOT NULL DEFAULT 0,
  "created_at"      timestamp NOT NULL DEFAULT now(),
  "created_by"      uuid REFERENCES "users"("id"),

  -- A weighment is a reading off a platform; it is never negative, and a tare
  -- heavier than the gross means the two were entered the wrong way round.
  CONSTRAINT "weigh_tickets_gross_nonneg" CHECK ("gross_weight_kg" IS NULL OR "gross_weight_kg" >= 0),
  CONSTRAINT "weigh_tickets_tare_nonneg"  CHECK ("tare_weight_kg"  IS NULL OR "tare_weight_kg"  >= 0),
  CONSTRAINT "weigh_tickets_net_positive" CHECK (
    "gross_weight_kg" IS NULL OR "tare_weight_kg" IS NULL OR "gross_weight_kg" >= "tare_weight_kg"
  )
);

CREATE INDEX IF NOT EXISTS "idx_weigh_tickets_vehicle" ON "weigh_tickets" ("vehicle_number");
CREATE INDEX IF NOT EXISTS "idx_weigh_tickets_created" ON "weigh_tickets" ("created_at");

-- Numbering. nextDocumentNumber() throws when the entity has no row in a
-- series, so every series that exists today needs one or the first slip fails
-- with "No numbering is configured" — new series get it from NUMBERED_ENTITIES.
--
-- The prefix follows whatever tag the series already carries on its invoices,
-- so a series running "INV-EG-" gets "WS-EG-" rather than a bare "WS-". A
-- series is a business split, not decoration, and a new document type has to
-- land on the right side of it.
INSERT INTO "document_series" ("series_id", "entity", "prefix", "next_number", "padding")
SELECT
  s."id",
  'weigh_ticket',
  'WS-' || COALESCE(
    (SELECT regexp_replace(d."prefix", '^.*?INV-', '')
       FROM "document_series" d
      WHERE d."series_id" = s."id" AND d."entity" = 'invoice'),
    ''
  ),
  1,
  5
FROM "number_series" s
WHERE NOT EXISTS (
  SELECT 1 FROM "document_series" d
   WHERE d."series_id" = s."id" AND d."entity" = 'weigh_ticket'
);
