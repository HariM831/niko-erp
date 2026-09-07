-- The cooling-pad pump, sampled.
--
-- On 7 September 2026 L2's pads ran 365 minutes against L3's 690, because
-- the pad start had been raised and then, unknown to niko, an operator had
-- lowered it again by hand as the shed heated. The pump's state is already
-- in every poll; keeping it in the sample row makes "how long did the pads
-- run today" a number on the board rather than a walk to the shed.
ALTER TABLE iot_house_sample ADD COLUMN IF NOT EXISTS pump_on real;
