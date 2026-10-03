-- NIR analyser scans copied off the bench PC (IAS Pro2 writes them to a local
-- SQLite file; the Weighment page reads it and uploads). A scan is matched to a
-- goods receipt by the GR number typed as its sample name, worked out when QC
-- asks, and fixed to a line only when QC is committed. See docs/nir-integration-plan.md.

CREATE TABLE IF NOT EXISTS "nir_models" (
  "short_name" varchar(60) PRIMARY KEY,
  "model_name" text,
  "version" varchar(20),
  "matter_names" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "device_sn" varchar(40),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "nir_model_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "short_name" varchar(60) NOT NULL,
  "item_id" uuid NOT NULL REFERENCES "items"("id"),
  "created_by" uuid REFERENCES "users"("id"),
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_nir_model_item" ON "nir_model_items" ("item_id");

CREATE TABLE IF NOT EXISTS "nir_results" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "result_sn" varchar(60) NOT NULL UNIQUE,
  "ias_id" integer,
  "device_sn" varchar(40) NOT NULL,
  "model" varchar(60) NOT NULL,
  "model_version" varchar(20),
  "sample_name" text,
  "sample_key" varchar(60),
  "scanned_at" timestamp with time zone NOT NULL,
  "ias_status" integer,
  "readings" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "flags" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "raw" jsonb,
  "receipt_line_id" uuid REFERENCES "office_receipt_lines"("id"),
  "used_at" timestamp,
  "used_by" uuid REFERENCES "users"("id"),
  "uploaded_by" uuid REFERENCES "users"("id"),
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "ix_nir_sample_key" ON "nir_results" ("sample_key");
CREATE INDEX IF NOT EXISTS "ix_nir_scanned" ON "nir_results" ("scanned_at");
CREATE INDEX IF NOT EXISTS "ix_nir_line" ON "nir_results" ("receipt_line_id");

ALTER TABLE "office_receipt_lines" ADD COLUMN IF NOT EXISTS "qc_nir" jsonb;
