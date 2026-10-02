-- Other markets' daily egg rates, read beside the benchmark (the user, 2 Oct
-- 2026): Kolkata first. Kept apart from egg_benchmark_prices on purpose — the
-- benchmark is the one rate an invoice is priced by; a market rate is a reading
-- of the market, for the forecast and for the eye, and never prices anything.

CREATE TABLE IF NOT EXISTS "egg_market_rates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "market" varchar(30) NOT NULL,
  "rate_date" date NOT NULL,
  "rate_per_egg" numeric(10, 4) NOT NULL,
  "source" text,
  "note" text,
  "created_by" uuid REFERENCES "users"("id"),
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_egg_market_rate" ON "egg_market_rates" ("market", "rate_date");
