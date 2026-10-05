-- The QC person asks niko for an NIR reading on one receipt line; scans that
-- arrive while it waits are claimed for that line, whatever IAS named them.
CREATE TABLE IF NOT EXISTS "nir_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "receipt_line_id" uuid NOT NULL REFERENCES "office_receipt_lines"("id") ON DELETE CASCADE,
  "status" varchar(12) NOT NULL DEFAULT 'waiting',
  "requested_by" uuid REFERENCES "users"("id"),
  "requested_at" timestamp with time zone NOT NULL DEFAULT now(),
  "expires_at" timestamp with time zone NOT NULL,
  "last_scan_at" timestamp with time zone,
  "last_error" text,
  "closed_at" timestamp with time zone
);
CREATE INDEX IF NOT EXISTS "ix_nir_req_status" ON "nir_requests" ("status", "expires_at");
-- One analyser: at most one request waiting at a time.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_nir_req_waiting" ON "nir_requests" ((true)) WHERE "status" = 'waiting';

ALTER TABLE "nir_results" ADD COLUMN IF NOT EXISTS "claimed_line_id" uuid REFERENCES "office_receipt_lines"("id");
ALTER TABLE "nir_results" ADD COLUMN IF NOT EXISTS "request_id" uuid REFERENCES "nir_requests"("id");
CREATE INDEX IF NOT EXISTS "ix_nir_claimed" ON "nir_results" ("claimed_line_id");
