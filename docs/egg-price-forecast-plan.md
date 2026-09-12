# Egg price forecast — plan and API contract

A forecast of the egg benchmark on the home page, run by Google's TimesFM
against the benchmark series the system already keeps. Nothing here invents a
second price: the input is `egg_benchmark_prices` and the output is a forecast
*of that same number*, so the ₹/egg on the tile means what it means everywhere
else — the market rate an agreement's spread is added to.

## Decisions taken before writing this

- **TimesFM 2.5 (200M, Apache-2.0), self-hosted.** TimesFM-3 (31 Aug 2026) is
  the better model — multivariate, covariates, 330M — but its weights ship
  under `timesfm-non-commercial-license-v1.0`, which forbids production and
  commercial use. EGGSY is both. 2.5 is univariate, Apache-2.0, and needs no
  cloud account. If Google's BigQuery `AI.FORECAST` later offers TimesFM-3
  under commercial terms, only `forecast.py` changes — everything else in this
  document is the same.
- **Fed the year-over-year difference, not the rate.** Decided by measurement
  after the plan was written: on the raw series TimesFM is *worse than a flat
  line*, and its band held 4% of the held-out month. See "What it actually
  scores" below.
- **The history goes into `egg_benchmark_prices`**, source `zoho-history`. One
  rate table, as today. Rates already typed by the sales desk are never
  overwritten by the import.
- **The Indian festival calendar is built, measured, and off.** Worth 0.7%.
  See "The festival calendar" below.
- **Horizons 7 / 14 / 28 days**, chosen on the tile.
- **Recent rates come from the live table.** The workbook covers 01 Apr 2019 →
  30 Jan 2026; Feb 2026 onward is already in `egg_benchmark_prices`.

## 1. The history import

`fixtures/egg-benchmark-history.csv` — `date,rate_per_egg`, 2,458 rows,
01 Apr 2019 → 30 Jan 2026, converted once from `Price_Movement_Graph.xlsx`
(Zoho's *Average Price by Invoice Date*). Committed, because a fixture that
lives in someone's Downloads folder is a fixture that cannot be re-run.

`scripts/import-benchmark-history.ts`:

- Inserts into `egg_benchmark_prices` with `source = 'zoho-history'`,
  `rate_per_egg` rounded to 4 dp, `created_by` null.
- `onConflictDoNothing` on `effective_from`. **A rate someone typed wins over
  the import, always** — the unique index makes that a one-word guarantee
  rather than a rule to remember.
- Reports inserted / skipped counts and the date span, and is safe to re-run.
- The 39 missing days across the series (29 gaps, the longest 8 days in
  Mar 2020) are left missing. The system's existing rule already answers for
  them: a day with no rate of its own carries the last rate before it.

## 1b. The festival calendar

`fixtures/india-holidays.csv` — `date,class,name`, 1,382 day-classes across
2018–2032, written by `scripts/forecast/build_holiday_calendar.py` from the
`holidays` package (India, subdivision `AS`). Committed, so production never
depends on that package and a wrong date can be fixed by hand.

The package's lunar tables are good and run past 2030, but it does not carry
what an egg market actually reacts to, so the builder derives it:

| class | what it is |
|---|---|
| `navratri` | the nine days to Dussehra, and the nine to Ram Navami — the year's two demand troughs |
| `durga_puja` | Dussehra − 5 … Dussehra. Assam's own, and a feast |
| `shravan` | the vegetarian month. **Approximate** — anchored off Janmashtami, so within a day or two |
| `bihu_bohag` / `bihu_kati` | 13–16 April and 17–18 October, Assamese solar dates the package omits |
| `diwali`, `bihu_magh`, `eid`, `holi`, `christmas`, `public` | from the package, windowed |

`scripts/forecast/calendar_effects.py` fits the effect: a ridge regression of
the **detrended** rate (centred 61-day median) on two indicators per class —
`during` and the week `after`, because a market that stopped buying eggs for
nine nights does not resume gently. Ridge rather than per-class means because
the classes overlap; Durga Puja sits inside Navratri. Fitted only on data
before each origin, or the backtest would be scoring a model that has seen
the answer.

## 2. Schema — `egg_price_forecasts`

Migration `0093_egg_price_forecast.sql`, Drizzle in `shared/schema/egg-sales.ts`
beside the rest of the market's tables.

| column | type | |
|---|---|---|
| `id` | uuid pk | |
| `anchor_date` | date | the last **actual** rate the forecast was made from |
| `for_date` | date | the day being forecast |
| `p10`, `p50`, `p90` | numeric(10,4) | ₹/egg, quantiles from the model |
| `model` | text | `timesfm-2.5-200m-yoy` — so a later model is distinguishable |
| `context_days` | integer | how much history went in |
| `generated_at` | timestamp | |

Unique on `(anchor_date, for_date)`, upserted. The home page reads the rows of
the newest `anchor_date` only. History is kept rather than replaced: it is what
makes "was the forecast any good?" answerable next month without a backtest.

## 3. The model job

**`scripts/forecast/egg_price_forecast.py`** — a pure function, no database.
Reads JSON on stdin, writes JSON on stdout:

```json
in  { "series": [{"date":"2026-09-11","value":4.83}, …], "horizon": 28,
      "calendar": false }
out { "model":"timesfm-2.5-200m-yoy", "contextDays": 2048,
      "anchorDate": "2026-09-11",
      "points": [{"date":"2026-09-12","p10":4.79,"p50":4.86,"p90":4.94}, …] }
```

What it does inside, and why:

1. **Differences the series against the same day last year** (364 days, which
   keeps the weekday alignment 365 would lose) and forecasts *that*, then adds
   the forecast back onto last year's known path. Egg prices run on one strong
   annual cycle; TimesFM 2.5 is univariate, has no calendar, and does not find
   that cycle on its own. This hands it the seasonality and leaves it the part
   it is good at — where the deviation from last year is heading.
2. **Fades the model's path in from today's rate over the first week.** A path
   rebuilt through last year is free to start somewhere other than where the
   market actually is, and tomorrow is not in doubt. Without this, week one is
   22% worse than a flat line; with it, 5.6%.
3. **Optionally removes the festival effect first** and adds it back onto the
   days being forecast, whose festivals are known. `"calendar": true`, which
   the server sends when `FORECAST_CALENDAR=1`. Off by default — 0.7%.

Keeping Postgres out of the Python means one place holds credentials and one
language owns the schema; the job can also be run by hand against a file.

**`server/services/egg-price-forecast.ts`** — the TypeScript half:

1. Reads every benchmark rate up to today, ordered.
2. Builds a **dense daily grid** to the anchor date, carrying the last rate
   forward over the gaps — the same carry-forward the billing code applies, so
   the model sees the series the business sees. TimesFM needs regular spacing.
3. Sends the **whole** series, not a window: the Python differences against a
   year earlier before it takes its 2,048 days of context, so trimming here
   would cost the model a year. 2,048 after differencing is ≈5.6 years, well
   inside 2.5's 16k limit.
4. Spawns `FORECAST_PYTHON`, pipes the JSON, parses the result, upserts the 28
   rows.
5. On any failure — no interpreter, no weights, bad JSON, non-zero exit — logs
   once and leaves the previous forecast in place. **No statistical fallback.**
   A naive line dressed as a model forecast is worse than no line.

## 4. When it runs

One tick in `server/index.ts` beside `startIotPolling()`, following the same
shape: `startPriceForecast()`, first run 2 minutes after boot, then every 30
minutes. The tick is nearly free — it reads the newest benchmark date and the
newest `anchor_date`, and **only spawns Python when the anchor has moved**. That
single mechanism covers all three cases that should refresh a forecast: a
restart, a new day, and the sales desk setting this evening's rate.

Two guards, both because prod and staging share a 4 GB droplet and TimesFM
holds ~1.5 GB while it runs:

- `FORECAST_ENABLED=1` — set in `prod.env` only, so staging never loads the
  model. Same hazard the deploy README already flags for the IoT poller
  running twice.
- Runs are serialised in-process and never overlap.

## 5. API

`/api/boss-view` gains one field inside `sales`:

```ts
priceForecast: {
  anchorDate: string;     // last actual rate behind it
  generatedAt: string;
  model: string;
  points: { date: string; p10: number; p50: number; p90: number }[];  // 28
} | null                  // null until the first run
```

`sales.priceHistory` grows from the last 30 rates to the last 56, so the 28-day
view can show 28 days of history against 28 of forecast. No new route, no new
permission: the home page is already everyone's.

## 6. The tile

Inside the existing Market tile on `client/src/pages/home.tsx`, the same
`Sparkline`, extended — not a second chart:

- History solid in yolk, as now; forecast **dashed**, with a shaded p10–p90
  band, and a hairline at the anchor so "today" is unmistakable.
- A `7 / 14 / 28` selector in the tile header. History shown scales with it
  (14 / 28 / 56 days) so the picture stays balanced.
- A headline line: `Next 7 days ₹4.92 avg · +2.3% vs today`, the percentage
  against the latest actual rate, coloured by direction in the page's own
  tokens.
- If `anchorDate` is older than yesterday, the tile says
  `anchored to 30 Jan 2026` instead of implying it is current.
- If `priceForecast` is null, the tile is exactly what it is today. No error,
  no empty frame.

## 7. What it actually scores

`scripts/forecast/backtest.py` — Python rather than a `check-*.ts`, because the
model is in Python and a TypeScript wrapper would only be a second way to run
the same thing. Two questions: the held-out last month, and walk-forward over
180 origins. Every candidate scored against what somebody would otherwise do.

```bash
.venv-timesfm/bin/python scripts/forecast/backtest.py     --origins 180 --variants raw,yoy,yoy+anchor
```

**Walk-forward, 180 origins (8 Jul 2025 → 3 Jan 2026), MAE ₹/egg:**

| | overall | h1–7 | h8–14 | h15–28 | p10–p90 held |
|---|---|---|---|---|---|
| **TimesFM yoy + anchor** | **0.2327** | 0.1340 | 0.2295 | 0.2836 | 84% |
| TimesFM yoy | 0.2380 | 0.1554 | 0.2295 | 0.2836 | 89% |
| seasonal delta | 0.2836 | 0.1510 | 0.2479 | 0.3678 | — |
| flat (last rate) | 0.3114 | 0.1269 | 0.2596 | 0.4295 | — |
| TimesFM on the raw rate | 0.3169 | 0.1280 | 0.2668 | 0.4364 | 75% |
| 7-day mean | 0.3494 | 0.1776 | 0.2964 | 0.4619 | — |
| same weeks last year | 0.3537 | 0.3489 | 0.3542 | 0.3559 | — |

25% better than a flat line overall, 34% better at 15–28 days, and the band is
honestly calibrated (84% of days inside a nominal 80%). **It is still 5.6%
worse than a flat line in week one** — 0.7 paise — which is worth knowing and
not worth hiding: nothing beats "today's rate" for tomorrow.

**Held-out month (3–30 Jan 2026, forecast from 2 Jan):** the benchmark fell
from ₹6.12 to ₹4.45 and recovered to ₹4.83 — a turning point, the hardest
month in the file to call.

| | MAE | h1–7 | h8–14 | h15–28 | band |
|---|---|---|---|---|---|
| TimesFM yoy | 0.4371 | 0.2447 | 0.4252 | 0.5393 | 82% |
| TimesFM yoy + anchor | 0.4485 | 0.2904 | 0.4252 | 0.5393 | 64% |
| same weeks last year | 0.4380 | 0.9236 | 0.5093 | 0.1596 | — |
| TimesFM on the raw rate | 0.8557 | 0.4214 | 0.7528 | 1.1243 | 4% |
| flat (last rate) | 1.0182 | 0.3968 | 0.8560 | 1.4100 | — |

The raw model missed the fall almost entirely and its band held 4% of the
days — that number alone is why the framing changed. Anchoring costs a little
on this particular month and wins across the 180, so it stays.

### The festival calendar: 0.7%, and off

Same model, same origins, calendar on versus off, MAE ₹/egg:

| festival-effect window | overall | h1–7 | h8–14 | h15–28 |
|---|---|---|---|---|
| **off (shipping)** | 0.2327 | 0.1340 | 0.2295 | 0.2836 |
| 31 days | 0.2312 | 0.1374 | 0.2315 | 0.2780 |
| 61 days | 0.2311 | 0.1402 | 0.2319 | 0.2761 |
| 91 days | 0.2315 | 0.1410 | 0.2329 | 0.2761 |
| 121 days | 0.2329 | 0.1424 | 0.2357 | 0.2767 |

0.16 paise an egg overall. The one durable signal is at 15–28 days, where
every window beats calendar-off by about 2.5%, and it consistently gives some
of that back in week one. The effects themselves are real but small — Bohag
Bihu +₹0.04, Diwali +₹0.04, Shravan −₹0.03, Magh Bihu −₹0.03.

Two reasons they are this faint, and both say when to revisit:

1. **The series is already an average.** Zoho's *average invoice price* moves
   ₹0.06 a day; a nine-day Navratri collapse is averaged into the mean before
   it reaches the sheet. A raw NECC daily quote should show the festivals
   properly.
2. **The yoy framing already carries most of it.** Diwali, Durga Puja and Bihu
   fall in nearly the same weeks each year, so "last year's same days" has
   them. What the calendar adds is only the 10–20 day lunar drift.

So `FORECAST_CALENDAR` exists, defaults off, and the code stays. Switch it on
and re-run the backtest the day the input is a raw market quote.

Re-run this whenever the model, the framing or the series changes, and paste
the new table here. It is not on a schedule; it is how the tile earns its
place.

## 8. Deploy

On the droplet, once:

```bash
python3 -m venv /srv/niko/.venv-timesfm
/srv/niko/.venv-timesfm/bin/pip install torch --index-url https://download.pytorch.org/whl/cpu
/srv/niko/.venv-timesfm/bin/pip install "timesfm[torch]"
```

`deploy/niko.service` needs two additions, because the unit is
`ProtectSystem=strict` and the job is spawned by the web process:

```
Environment=HF_HOME=/srv/niko/.cache/huggingface
ReadWritePaths=/srv/niko/uploads /srv/niko/.cache
```

`prod.env` gains `FORECAST_ENABLED=1` and
`FORECAST_PYTHON=/srv/niko/.venv-timesfm/bin/python`. Weights (~800 MB) download
on the first run and are cached. A 1 GB swapfile is cheap insurance on a 4 GB
box that already runs two Node apps — the model's 1.5 GB is transient, but it
is transient at 3 a.m. next to nothing that should be killed.

`.env.example` documents both variables and says plainly that without them the
forecast simply does not appear.

## Order of work

1. CSV fixture + import script, run it, confirm the span and the skip count.
2. Migration + schema.
3. `forecast.py` + the service, proved by hand on the imported series.
4. The tick, behind its flag.
5. boss-view field.
6. The tile.
7. The backtest, and this document updated with what it actually scored.

## What is live, and the one thing holding it back

Deployed to production on 12 Sep 2026 (`91f7b91`). Migration 0093 applied,
2,458 rates imported — 01 Apr 2019 → 30 Jan 2026, every row
`source = zoho-history`, per-year counts matching the workbook. TimesFM and
its venv are installed on the droplet with a 1 GB swapfile behind them.

**And the tile will stay bare until somebody enters a rate.**
`egg_benchmark_prices` was empty when the import ran — the books were emptied
in August and the daily benchmark has not been set since. The newest rate in
the system is therefore 30 Jan 2026, seven months old, so:

- the service declines to forecast (`STALE_AFTER_DAYS = 7`) and logs
  `[price] no forecast — benchmark last set 2026-01-30` once;
- the tile drops the dashed line, the band and the horizon selector, and says
  *No forecast: the benchmark has not been set since 30/01.*

Both are deliberate. A forecast anchored to last winter would draw February
as though it were the week ahead. The moment a rate is set on the Egg
benchmark screen the anchor moves, the tick notices within half an hour, and
the line appears with no further work.

Two things were never verified and should be, the first time a real forecast
exists: the tile rendered in a browser against live data (checked here only
as far as the database — `/api/boss-view` is behind auth), and the model's
first run on the droplet's own CPU, which is slower than the machine the
timings in this document came from.
