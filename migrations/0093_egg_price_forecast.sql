-- What the model thinks the egg benchmark will do next.
--
-- Written by the TimesFM job, read by the home page, and never by billing:
-- an invoice prices off egg_benchmark_prices and only off that. A forecast is
-- an opinion about a number, not the number.
--
-- Rows are kept rather than replaced. The point of keeping them is that in a
-- month somebody can ask whether the line the home page drew was any good,
-- and the answer is a join against the rates that actually arrived rather
-- than a backtest nobody will re-run.

CREATE TABLE IF NOT EXISTS "egg_price_forecasts" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The last ACTUAL rate behind the forecast, not the day it was computed.
  -- Two runs on the same anchor say the same thing and overwrite each other;
  -- a run after the sales desk sets this evening's rate is a new anchor and a
  -- new forecast.
  "anchor_date"  date NOT NULL,
  "for_date"     date NOT NULL,

  -- Per EGG, four decimals, exactly as the benchmark it forecasts.
  "p10"          numeric(10,4) NOT NULL,
  "p50"          numeric(10,4) NOT NULL,
  "p90"          numeric(10,4) NOT NULL,

  "model"        text NOT NULL,
  "context_days" integer NOT NULL,
  "generated_at" timestamp NOT NULL DEFAULT now(),

  CONSTRAINT "egg_price_forecasts_ahead" CHECK ("for_date" > "anchor_date"),
  -- A band whose quantiles cross is a broken parse, not a forecast.
  CONSTRAINT "egg_price_forecasts_band" CHECK ("p10" <= "p50" AND "p50" <= "p90"),
  CONSTRAINT "egg_price_forecasts_positive" CHECK ("p10" > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_egg_price_forecast"
  ON "egg_price_forecasts" ("anchor_date", "for_date");

-- The home page's only query: the newest anchor, then its days in order.
CREATE INDEX IF NOT EXISTS "ix_egg_price_forecast_anchor"
  ON "egg_price_forecasts" ("anchor_date" DESC, "for_date");
