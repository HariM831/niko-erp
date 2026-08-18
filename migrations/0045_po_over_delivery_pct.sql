-- How far a delivery may run over an order's outstanding quantity and still
-- match at the gate. Zero was the previous behaviour and it blocked a truck
-- over 30 kg on 43 tonnes: an order is raised for a round tonnage before
-- anything is weighed, so a small over-run is the normal case.
ALTER TABLE "preferences"
  ADD COLUMN IF NOT EXISTS "po_over_delivery_pct" numeric(6, 3) DEFAULT '1.000' NOT NULL;
