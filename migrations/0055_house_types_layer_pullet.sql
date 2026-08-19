-- Houses are Layer and Pullet, which is what the farm calls them.
--
-- 0052 stored 'rear'/'lay' — a description of the activity rather than the
-- name of the thing. The feed mill export already used layer/pullet, and every
-- other screen will have to say layer/pullet, so storing a third vocabulary
-- only buys a translation table nobody asked for.
ALTER TABLE "houses" DROP CONSTRAINT IF EXISTS "houses_purpose_check";

UPDATE "houses" SET "purpose" = 'pullet' WHERE "purpose" = 'rear';
UPDATE "houses" SET "purpose" = 'layer'  WHERE "purpose" = 'lay';

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM "houses" WHERE "purpose" NOT IN ('layer','pullet');
  IF n > 0 THEN
    RAISE EXCEPTION '% house(s) have a purpose that is neither layer nor pullet.', n;
  END IF;
END $$;

ALTER TABLE "houses" ADD CONSTRAINT "houses_purpose_check"
  CHECK ("purpose" IN ('layer','pullet'));
