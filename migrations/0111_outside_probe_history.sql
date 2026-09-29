-- Keep the outside wall probe (温度06) with every sample.
--
-- 29 Sep 2026: the weather service ran about 3 degrees under the farm, and the
-- user took the coolest live wall probe - the one in shade - as the outside
-- temperature, and an outside humidity estimated from the forecast's dew point
-- at that temperature. The hour-by-hour bird comfort check needs the probe for
-- each hour, not only its latest value; its history starts today.
ALTER TABLE "iot_house_sample" ADD COLUMN IF NOT EXISTS "outside_temp_c" real;
