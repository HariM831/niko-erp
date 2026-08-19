-- A house is for rearing or for laying. There is no third kind.
--
-- 0052 allowed 'both' as a hedge for sheds whose type the feed mill export did
-- not name. Nothing ever used it — all six migrated houses came through as
-- 'rear' or 'lay' — and a settings field that offers "either" only records that
-- nobody has decided yet, which is a question, not a fact.
--
-- Guarded: if a 'both' row ever appeared, fail loudly rather than silently
-- rewriting somebody's data to a guess.
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM "houses" WHERE "purpose" = 'both';
  IF n > 0 THEN
    RAISE EXCEPTION
      '% house(s) still have purpose ''both''. Set each to rear or lay, then re-run.', n;
  END IF;
END $$;

ALTER TABLE "houses" DROP CONSTRAINT IF EXISTS "houses_purpose_check";
ALTER TABLE "houses" ADD CONSTRAINT "houses_purpose_check"
  CHECK ("purpose" IN ('rear','lay'));
