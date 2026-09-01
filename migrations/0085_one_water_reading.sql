-- One water reading, not two.
--
-- The form asked for an upper and a lower tank meter and every reader summed
-- them: rollup multiplied the sum by 1000, the house page added them before
-- display, nothing anywhere used one without the other. The farm no longer
-- wants to split it and the shed sensor reports a single daily total, so the
-- split has nowhere left to come from.
--
-- The old columns are kept rather than dropped. 890 days hold two genuine
-- readings taken by a person, that is a real record of what was measured, and
-- a dropped column cannot be un-dropped. Nothing writes them from here on.
ALTER TABLE placement_days ADD COLUMN water_kl numeric(10,2);

UPDATE placement_days
   SET water_kl = coalesce(water_upper_kl, 0) + coalesce(water_lower_kl, 0)
 WHERE water_upper_kl IS NOT NULL OR water_lower_kl IS NOT NULL;
