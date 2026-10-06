-- The mill SCADA's latest live values, as the helper on the SCADA PC last read
-- them over WinCC's OPC UA server. One row, overwritten every couple of
-- seconds; nothing is archived here.
CREATE TABLE IF NOT EXISTS "scada_live" (
  "id" integer PRIMARY KEY DEFAULT 1,
  "read_at" timestamp with time zone NOT NULL,
  "values" jsonb NOT NULL,
  "device_id" uuid,
  "received_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "ck_scada_live_one_row" CHECK ("id" = 1)
);
