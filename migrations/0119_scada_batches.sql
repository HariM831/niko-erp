-- The feed mill SCADA: batches copied from the WinCC PC (BATCH.dbo.HISTORY) by
-- a paired helper, and what its bin and recipe names mean in niko. Records
-- only - nothing here moves stock or posts (the user, 6 Oct 2026).
ALTER TYPE "device_role" ADD VALUE IF NOT EXISTS 'scada';

CREATE TABLE IF NOT EXISTS "scada_batches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "source_time" varchar(32) NOT NULL,
  "batched_at" timestamp with time zone NOT NULL,
  "recipe_name" text NOT NULL,
  "batch_seq" integer,
  "bins" jsonb NOT NULL,
  "set_total_kg" numeric(14, 3) NOT NULL,
  "act_total_kg" numeric(14, 3) NOT NULL,
  "device_id" uuid,
  "received_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_scada_batch_source" ON "scada_batches" ("source_time", "recipe_name", "batch_seq");
CREATE INDEX IF NOT EXISTS "ix_scada_batch_at" ON "scada_batches" ("batched_at");

CREATE TABLE IF NOT EXISTS "scada_names" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "kind" varchar(10) NOT NULL,
  "name" varchar(80) NOT NULL,
  "item_id" uuid REFERENCES "items"("id"),
  "formula_id" uuid REFERENCES "formulas"("id"),
  "created_by" uuid REFERENCES "users"("id"),
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_scada_name" ON "scada_names" ("kind", "name");
