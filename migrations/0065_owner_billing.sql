-- What passes between Amino and the owner of a shed.
--
-- Amino owns the ecosystem; Nandamuri owns L2–L3 and Luit Valley owns L4–L5,
-- while the rearing houses P1–P2 are Amino's. So a batch crosses an ownership
-- line twice in its life and three things have to be priced:
--
--   feed   Amino sells it to them, at what the mill made it for
--   birds  Amino sells them the pullets when they are housed, by age week
--   eggs   Amino buys the eggs back, at a benchmark plus an agreed spread
--
-- Amino's own sheds are billed for none of it: moving feed from the mill to P1
-- is an internal transfer, not a sale to itself.

/* The market price of an egg, carried forward until a new one is entered.
   Deliberately thin: the Sales module is bringing a daily price table and this
   is the shape it will take over. Until then this is the one number egg
   purchases are priced from, so it lives somewhere rather than in a formula. */
CREATE TABLE IF NOT EXISTS "egg_benchmark_prices" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "effective_from"  date NOT NULL,
  /* Per EGG, not per hundred — a shed reports eggs and a bill counts eggs, and
     a per-100 rate would be divided by 100 at every call site until one of them
     forgot. */
  "rate_per_egg"    numeric(10,4) NOT NULL,
  "source"          text,
  "note"            text,
  "created_by"      uuid REFERENCES "users"("id"),
  "created_at"      timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "uq_egg_benchmark" UNIQUE ("effective_from")
);

/* What a given owner is paid over the benchmark, and anything else that is
   agreed with them rather than true of everyone.

   Effective-dated for the same reason the valuation rates are: a spread
   renegotiated in March must not restate January, because January is closed. */
CREATE TABLE IF NOT EXISTS "owner_agreements" (
  "id"                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "contact_id"         uuid NOT NULL REFERENCES "contacts"("id"),
  "effective_from"     date NOT NULL,
  /* Added to the benchmark. Signed, so an owner can be on a discount without a
     second column meaning the opposite of this one. */
  "egg_spread_per_egg" numeric(10,4) NOT NULL DEFAULT 0,
  /* Feed is charged at what the mill made it for. A rate here overrides that,
     for an owner on fixed terms. Null means "at cost", which is the norm. */
  "feed_rate_per_kg"   numeric(10,4),
  "note"               text,
  "created_by"         uuid REFERENCES "users"("id"),
  "created_at"         timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "uq_owner_agreement" UNIQUE ("contact_id", "effective_from")
);

CREATE INDEX IF NOT EXISTS "ix_owner_agreements_lookup"
  ON "owner_agreements" ("contact_id", "effective_from");

/* Which month has already been billed to whom, and with what.
   Without this a second run raises a second invoice for the same feed — the
   documents are the only record that a month was done, and reading them back
   to find out is how you end up double-billing an owner. */
CREATE TABLE IF NOT EXISTS "owner_billing_runs" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "contact_id"  uuid NOT NULL REFERENCES "contacts"("id"),
  /* The first of the month it covers. A month, not a range: the answer to
     "have we billed Luit for March" must not depend on how the range was typed. */
  "period"      date NOT NULL,
  "invoice_id"  uuid REFERENCES "invoices"("id"),
  "bill_id"     uuid REFERENCES "bills"("id"),
  "feed_kg"     numeric(14,3) NOT NULL DEFAULT 0,
  "birds"       integer NOT NULL DEFAULT 0,
  "eggs"        bigint NOT NULL DEFAULT 0,
  "note"        text,
  "created_by"  uuid REFERENCES "users"("id"),
  "created_at"  timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "uq_owner_billing_run" UNIQUE ("contact_id", "period")
);
