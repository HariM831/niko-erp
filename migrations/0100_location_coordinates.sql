-- The farm gets its coordinates, so a punch can say where it was made.
--
-- niko's punches carry raw GPS and nothing else; the calendar prints a site
-- letter beside each time, matched against the locations that have a point.
-- Until now no location had one, so no punch could be placed.
--
-- The centroid is the one Amino derived from about 2,300 punches at this gate:
-- every one of them lands within ~200 m of it, and the nearest other group site
-- is 12 km away, so a five-kilometre reach cannot confuse the two. The reach is
-- written as the location's own radius, which is also what a gate geofence
-- would read, and is deliberately generous: a farm is not a point, and a phone
-- scatters by tens of metres under a shed roof.

UPDATE locations
SET latitude = 26.64319, longitude = 92.61556, radius_m = 5000, updated_at = now()
WHERE code = 'NALBARI' AND latitude IS NULL;
