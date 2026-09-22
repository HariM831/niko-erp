# Cost of production per egg — plan

Read of niko and the staging books as at 22 Sep 2026. No code written.

## The formula, as decided

For any date range the viewer picks:

```
                    FeedFIFO(range)        Σ P&L heads(range)        pullet cost per bird
cost per egg  =  ─────────────────────  +  ─────────────────────  +  ─────────────────────
                    eggs(range)              eggs(range)              eggs per pullet life
```

- **Feed** is the actual FIFO cost already computed per house per day —
  `flock_day.feed_cost`, written by `refreshFlockDay`
  (`server/services/rollup.ts:231-320`). Summed over the range, **lay phase
  only**. Rearing feed is inside the pullet figure and must not be counted twice.
- **Heads** are the Amino P&L expense accounts, each marked as belonging to
  one of three tiers or excluded, summed by journal `entry_date` over the range
  from `journal_entry_lines` (posted entries only, the same `accountMovements`
  sum the P&L uses, `server/routes/reports.ts:42`).
- **Pullet** is a constant: **₹360 per bird over 450 eggs = ₹0.80/egg.** Both
  numbers are preferences, not code, so they move when the farm's own rearing
  cost is known.
- **Eggs** = `Σ flock_day.eggs` over the range, every house, every phase — eggs
  produced, not eggs sold or graded.

No allocation to houses. Feed is naturally per house and can be shown so; the
heads are a farm-wide rate. A per-house cost of production is out of scope
until costs are tagged at entry, which they are not (zero reporting tags on
staging).

## What the three tiers mean

| Tier | Holds | Why it is a tier |
|---|---|---|
| **Production** | feed, pullet, vaccines & medicines, farm site expenses, power & fuel, labour, manure management, canteen, security, feed-material transport & loading, mill site expenses, depreciation | The cost of making an egg in the shed |
| **Packing** | packing material (trays, boxes) | Spent per egg *packed*, not laid; a director wanting COP at the shed door strikes it out |
| **Admin & finance** | office, directors, legal, travel, vehicles, insurance, bank charges, interest | Full cost; nobody argues about whether interest "belongs" because it is its own line |

Each tier prints a subtotal per egg; the page ends with all three.

## Heads: the proposed mapping

The live chart is Zoho's, not the seeded one (`server/db/seed.ts:255-260`), so
heads are picked by **account id in a settings screen**, never by code or name
in source. The mapping below is the proposed default, from the accounts that
carried postings in the last six months on staging. It is confirmed on the
screen, not here.

**Excluded — replaced or intra-group**

| Account | Reason |
|---|---|
| 5007 Feed & Additives | Raw-material purchases; replaced by feed FIFO |
| 5005 Chicks | Inside the ₹360 pullet |
| 5006 Eggs (Purchases) | Eggs bought back from the two LLPs — intra-group |
| 6605 Suspense A/C | Not a cost |
| 6047 Purchase Discounts, 6045 Other Expenses | Net credits; excluded until somebody says what they are |
| 6569 Panbari Site Expense | No houses at Panbari; **confirm** |

**Production**

5011 Vaccines & Medicines · 6011 Farm Expenses (Nabil) · 6014 Gas, Power, Fuel &
Electricity (Nabil) · 6016 LPG (Nabil) · 6015 Loading & Unloading (Nabil) ·
6017 Manure Management (Nabil) · 6018 Cleanopolis · 6019 Rental (Nabil) ·
6020 Repair & Maintenance (Nabil) · 6049 Repairs and Maintenance · 6021
Roadways, Freight & Transportation (Nabil) · 6022 Security (Nabil) · 6012 Farm
Canteen (Nabil) · 6050 Salaries and Employee Wages · 6549 PF Contribution ·
6546 ESI Contribution · 6548 Medical · 6552 Staff & Director Welfare · 6545
Employee Fooding · 5016 Transportation (Feed Material) · 5008 Loading &
Unloading (Feed Material) · 5009 Others · 6032/6033 Feed Plant Expenses
(Dhekiajuli) · 6034 Power (Dhekiajuli) · 6035 Loading (Dhekiajuli) · 6036
Rental (Dhekiajuli) · 6038 Freight (Dhekiajuli) · depreciation, once posted.

**Packing** — 5010 Packing Material.

**Admin & finance** — 6550 Remuneration to Directors · 6509 Legal &
Professional · 6529 Travelling & Conveyance · 6530 Vehicle Maintenance · 6531
Cars & Bikes Petrol · 6510/6511 Office Expenses · 6523/6516/6517 Office and
room rents · 6526 Printing & Stationery · 6528 Software · 6527 Puja, Donations ·
6508 Internet & Telephone · 6505 Insurance · 6503 Bank Charges · 6595 Postage ·
6512/6514 office electricity · 6515 LPG · 6583 Others (S&D) · 6558 Interest on
Term Loan · 6557 Interest on CC Account.

Any expense account not mapped is listed on the screen as **unassigned** and
the report shows a count of unassigned rupees in the range, so a new Zoho head
cannot silently fall out of the cost.

## Two double-counts the mapping avoids, and one it cannot

1. **Rearing feed.** `flock_day.phase = 'rear'` rows are left out of the feed
   sum. On staging that is ₹2.77 cr over six months that would otherwise sit on
   top of the ₹0.80 pullet line.
2. **Mill overhead.** `production_orders.cost_per_kg` adds a flat
   `preferences.mill_overhead_per_kg` (₹1/kg) to every batch, and that rate
   flows into `feed_transfers.rate_per_kg` and so into feed FIFO. Mapping the
   Dhekiajuli site heads as Production counts the mill twice. **Decision:** when
   production runs in niko, set `mill_overhead_per_kg` to 0 and let the actual
   heads carry it. Staging's transfers are Amino-imported rates, so today the
   flat ₹1 is already inside them; the report notes which basis a range used.
3. **Vaccines during rearing** are inside 5011 and cannot be split from lay
   vaccines in the GL. They stay in Production. Small over-count (≈₹0.02–0.05
   per egg on six months of staging); accepted rather than guessed.

## Weeks and months

Feed is daily, so a week is exact. Heads are not: salaries post on month-end,
egg purchases in arrears, power when the bill arrives. Read by entry date, a
week containing month-end shows the whole month's labour and the next week
shows none.

**Decision proposed:** heads are rated **per calendar month** — Σ head in the
month ÷ eggs in the month — and a range takes the egg-weighted blend of the
months it touches. Feed stays daily. A week then carries its month's overhead
rate, and a full month is exactly Σ heads ÷ eggs with nothing smoothed. The
page states which months the heads came from. A month that is not yet closed
(bills still arriving) is flagged as provisional — the number is what is
posted so far, which is what the P&L would also say.

## Where it lives

**Service** `server/services/cost-of-production.ts` — one function
`costOfProduction(db, from, to)` returning:

```
{
  eggs, feedKg, feedCost, feedIncomplete,          // from flock_day, lay phase
  feedByHouse: [{ house, eggs, feedKg, feedCost, perEgg }],
  months: [{ month, eggs, provisional, heads: [{ accountId, code, name, tier, amount }] }],
  pullet: { perBird, eggsPerLife, perEgg },
  tiers: { production, packing, admin },            // ₹ and ₹/egg for the range
  unassigned: { count, amount },
  perEgg: { feed, heads, pullet, production, delivered, full }
}
```

Reads: `flock_day` (eggs, feed_kg, feed_cost, feed_cost_incomplete, phase,
house_id), `journal_entry_lines ⋈ journal_entries ⋈ accounts` filtered by the
head mapping, `preferences`. Writes nothing. Dates through `istDate` helpers,
never `toISOString`.

**Schema** — one migration:

- `cost_of_production_heads(account_id uuid PK → accounts, tier text CHECK
  (tier IN ('production','packing','admin')))`. An account absent from the
  table is unassigned; excluded is a row with tier `'excluded'`? — no: excluded
  is simply absent *and acknowledged*, so add `tier = 'excluded'` to the CHECK
  so the screen can tell "decided out" from "never looked at".
- `preferences.pullet_cost_per_bird numeric(10,2) NOT NULL DEFAULT 360.00`
- `preferences.eggs_per_pullet_life integer NOT NULL DEFAULT 450`

**Routes**

- `GET /api/reports/cost-of-production?from&to` — `requirePermission("reports","view")`,
  the same gate the weekly summary's cost column already sits behind
  (`server/routes/reports.ts:1140-1142`).
- `GET/PUT /api/settings/cost-heads` — `requirePermission("settings","view")`;
  PUT takes `[{ accountId, tier }]`, `validateBody`, replaces in one transaction.
- Preferences PATCH already exists; the two new keys join it.

**Screens**

- **Reports → Farms → Cost of Production** (`client/src/pages/report-cost-of-production.tsx`).
  Zoho range chrome from `reports.tsx` (presets, dd/MM/yyyy period line,
  bare numbers with the currency stated once). Layout, top to bottom:
  1. Eggs produced · feed kg · g/egg · **cost per egg** (three tier figures)
  2. Feed by house: eggs, kg, ₹, ₹/egg — dashes and an "incomplete" mark where
     `feed_cost_incomplete`, never ₹0.00
  3. Heads by tier: account, ₹ in range, ₹/egg; tier subtotals
  4. Pullet line: ₹360 / 450 = ₹0.80, with the preference values printed
  5. Unassigned heads, if any, in red with the rupee total
  6. Footnote: months used for heads, which are provisional, feed cost basis
- **Settings → Preferences**: two new fields beside the mill overhead.
- **Settings → Cost of production heads** (`settings-cost-heads.tsx`): every
  expense and COGS account with postings, a tier picker per row, unassigned
  first. Seeded empty; `scripts/propose-cost-heads.ts` prints the mapping above
  matched by name for a one-time paste, and refuses to write.

**Home tile** (optional, after the report is agreed): this month's cost per
egg beside the benchmark, same permission.

## Out of scope, on purpose

- Per-house heads (needs tagging at entry — none exists).
- Realised price and margin per egg (a sales question; the report is cost).
- Capitalising the actual pullet (chick bill → flock, rear feed, rear
  overhead) — the ₹360 stands until the farm wants the derived figure.
- Cracked/dirty deductions — not entered on any day on staging.
- Depreciation — no asset register, nothing posted; it joins Production as a
  head the day it is.

## Numbers this would print today (staging, 6 months to 22 Sep)

Eggs 44.6M · feed ₹16.18 cr → ₹3.63 · heads (Production) ≈ ₹2.5 cr → ₹0.56 ·
pullet ₹0.80 · **Production ≈ ₹4.99** · packing ₹1.57 cr → ₹0.35 →
**Delivered ≈ ₹5.34** · admin & finance ≈ ₹0.93 cr → ₹0.21 → **Full ≈ ₹5.55**.
Realised egg price in the same window: ₹6.28. Salaries are unposted for
Jul–Sep on staging, so the labour part is understated by roughly ₹0.12.

## Sequence

| Step | What | Size |
|---|---|---|
| 1 | Migration: heads table, two preferences | small |
| 2 | Service + report route, tested on staging against the numbers above | medium |
| 3 | Settings screen for heads; preferences fields | small |
| 4 | Report page | medium |
| 5 | Home tile | small |
