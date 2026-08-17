# Feed Mill: integrating Amino's mill into EGGSY

Read of `Amino farms` as at 17 Aug 2026. Covers formulas, formulator, production,
transfer and inventory. No code written.

---

## 1. The finding that reframes the port

EGGSY's inventory service already exists, and it was written for this. From
`server/services/inventory.ts`:

> **postInventoryMovement** — "This is the seam operational modules use — *the
> feed mill says what moved* and which account the other side belongs to, and all
> the accounting happens here."

And `inventory_transactions.sourceType` documents its own values as
`e.g. "inventory_adjustment", "feed_mill"`.

So EGGSY has a movement ledger, valuation from that ledger, GL posting, negative
stock guards and reversal — `moveStock`, `postInventoryMovement`, `stockOnHand`,
`reverseStock`, `assertStockNotNegative`. The inventory half of the feed mill is
not a port. It is a caller.

**The consequence: make each formula's output an item.** Amino's formulas are not
items, so finished feed exists only as a rupee balance on `feed_inventory` and
**nobody can ask how many kilos of Layer Mash are in the mill.** If a formula's
output is an inventory-tracked item, then:

- production = one stock movement (raw materials out, finished feed in)
- transfer = one stock movement between locations
- finished feed stock in kg falls out of `stockOnHand` for free
- feed valuation falls out of the same ledger
- the day-end inventory value you wanted is a query, not a posting

That removes most of what Amino built by hand.

---

## 2. What does NOT need rebuilding

| Amino | EGGSY equivalent | Note |
|---|---|---|
| `materials` (CRUD, stock, min levels) | `items` | Has `aliases`, `unitBagWeightKg`, purchase account, `trackInventory`, opening stock + rate, reorder level |
| `vendors` | `contacts` | Richer — GSTIN/PAN, payment terms, place of supply |
| `sheds`, farm names | `locations` | `parentLocationId` already models a bay inside a mill; typed; carries coordinates |
| `deliveries` (+ moisture QC, price alerts, bag/tare) | Procurement receipts + bills | **Already rebuilt and better.** Six stations, OCR, PO match, QC specs, deduction rules |
| `stock_adjustments` | `inventory_adjustments` | A real document: numbered, posted, quantity or value mode |
| `materials.currentStock`, `deliveries.remainingQuantity` | `inventory_transactions` | Movement ledger instead of mutable balances |
| Purchase orders | `purchase_orders` | |
| Permissions (`PermissionResource` union) | `shared/permissions.ts` | Module-aware with custom actions |
| Activity log, journal posting, numbering | `activity`, `posting.ts`, `numbering.ts` | |
| `production_plan` | — | **Not feed mill.** It plans egg boxes; belongs to Farms |

Roughly 60% of Amino's feed-mill surface is already standing in EGGSY, most of it
in better shape.

---

## 3. What is genuinely new

Five things, in dependency order.

### 3.1 Nutrient profile per item

Amino puts ~25 nutrient columns on `materials`: `caloriesPerKg`,
`proteinPercent`, `fiberPercent`, `fatPercent`, `calciumPercent`,
`totalPhosphorusPercent`, `avPhosphorusPercent`, and eleven `dig*Percent` amino
acids. A `NUTRIENT_FIELD_MAP` in `client/src/lib/feed-nutrients.ts` maps solver
keys to column names, and the same map is **duplicated inside the solver
endpoint** in `server/routes.ts`.

**Recommendation: a normalised `item_nutrients` table**, not 25 columns.

- One row per item per nutrient: `itemId`, `nutrient`, `value`, `unit`, `source`
- Reuses the shape `qc_spec_params` already established in this codebase
- Adding a nutrient becomes data, not a migration plus two map edits
- The duplicated field map disappears — the solver reads rows

Carry `source` (supplier datasheet / lab / book value) and `testedAt`. A least-cost
mix is only as good as its analysis, and knowing which numbers are guesses is
worth a column.

### 3.2 Feed standards

Amino's `feed_standards` is `lifeStage × nutrient → min/max`. Clean, port nearly
as-is. Life stages live in a shared const.

Fits EGGSY as reference data under **Settings → Feed Mill**, beside the
procurement tabs. Same treatment as QC specs: versioned, superseded rather than
edited, because a formula solved last March was solved against March's standard.

### 3.3 Formulas and versions

Amino: `formulas` (ingredients as `jsonb`, `targetProtein`, `dosageLimits` jsonb,
`feedIntakeG`) plus `formula_versions` snapshotting every edit.

**Recommendation: follow the `qc_specs` pattern already in EGGSY** — a `formulas`
header, `formula_lines` as real rows (not jsonb), versioned with one live version
per formula, superseded on save. Reasons:

- ingredient lines want a foreign key to `items`; jsonb cannot have one
- a batch must record *which version* it was made to, exactly as a receipt line
  records `qcSpecId`
- EGGSY already has the supersede-with-history idiom, screens included

Each formula names its **output item** and its **batch size in kg**. Amino derives
batch size by summing ingredient kg (`formulaTotalKg`, defaulting to 1000) —
implicit and easy to break. Make it explicit.

### 3.4 The formulator (least-cost solver)

`POST /api/formulator/solve` in `server/routes.ts:7298`, using
`javascript-lp-solver`. Minimise cost per 100 kg subject to:

- `total = 100` (percentages sum)
- nutrient min/max from `feed_standards`
- per-ingredient min/max dosage limits
- only ingredients with a price > 0, and (in the UI) only those in stock

It also computes **shadow prices**: for each excluded ingredient, the break-even
price at which it would enter the mix, by re-solving with a forced inclusion.
That is the genuinely valuable part and worth porting faithfully.

Port as `server/services/formulator.ts`. Keep the solve server-side. Add
`javascript-lp-solver` (~1 dependency, MIT).

**Two hardcoded constants to lift into config.** The cost model bakes in:

```
MOISTURE_RETENTION = 0.99      // 1% bakes off in manufacturing
OVERHEAD_PER_KG    = 0.75      // ₹750/ton processing overhead
```

They appear **twice** — in the solver and again in slip confirmation — with a
comment in each saying they must match the other. That is a bug waiting for the
day someone changes one. They belong in feed mill settings.

### 3.5 Production, transfer, and where stock moves

Amino's flow: **generate slip → print → confirm → batch**. The slip is a work
order; confirming it consumes stock and creates the batch record. Backdating is
allowed and skips the stock check.

Map onto EGGSY documents:

| Amino | EGGSY |
|---|---|
| `production_slips` (pending/confirmed/void) | **Production Order** — numbered document, `nextDocumentNumber` |
| `batches` (+ `formulaSnapshot`, `costSnapshot`) | **Production Entry** — the completion, posts the movements |
| `lot_consumption` | `inventory_transactions` rows with `sourceType = 'feed_mill'` |
| `formula_transfers` | **Feed Transfer** — numbered document, one movement between locations |

Confirming a production entry is a single `postInventoryMovement` call:

```
raw materials   −quantity  at consumption value   (credit raw inventory)
finished feed   +quantity  at total input + overhead (debit finished inventory)
```

Balanced by construction, one journal entry, no bespoke posting code.

A transfer is the same call with the finished item moving from mill location to
shed location.

---

## 4. Two foundation decisions to settle first

### 4.1 Stock is not location-aware

`inventory_transactions` has **no `locationId`**. Org-wide stock is fine for
Purchases; it is meaningless for a transfer, because mill → shed does not change
the total. Feed transfer cannot be built until this is fixed.

**Recommendation:** add `locationId` (nullable, FK, indexed) to
`inventory_transactions`, and a `locationId` filter on `stockOnHand`. Additive,
back-compatible — existing rows stay null and read as org-wide. Two migrations'
worth of work at most, and every module gains from it.

A transfer then writes two rows: minus at the mill, plus at the shed, same item,
same value, net zero quantity and value org-wide.

### 4.2 Valuation method

Amino runs **FIFO** over `deliveries.remainingQuantity`, decrementing a stored
balance per lot and recording `lot_consumption` for retrospective recalculation.
It also has three fallbacks — backdated entries, opening stock with no lots,
missing lots — each estimating from `materials.costPerKg`.

EGGSY has **no lot tracking**, and `inventory_transactions` carries a `value` on
every movement.

**Recommendation: weighted average from the movement ledger.**

- no new tables, no stored balances, no mutable per-lot counters
- consistent with how `stockOnHand` already values stock
- one rule, no fallbacks to reason about
- a backdated entry recalculates naturally instead of needing a special case

FIFO on feed ingredients buys very little: maize is maize, and the mill consumes
within days of receipt. If lot traceability is wanted later for recall reasons,
that is a different feature (batch/lot numbers) and should not be smuggled in as
a costing method.

**This is your call and it changes reported cost per kg.** Worth deciding before
anything is built.

---

## 5. Suggested sequence

| Phase | Contents | Depends on |
|---|---|---|
| **F0** | `locationId` on inventory transactions; `stockOnHand` by location; `feed_mill` permission module; nav group | — |
| **F1** | `item_nutrients` + nutrient vocabulary; Nutrients tab on the item (beside Quality Specs) | F0 |
| **F2** | Feed standards under Settings → Feed Mill; versioned | F1 |
| **F3** | Formulas + versions + lines; output item; batch size; Formulas screen | F1 |
| **F4** | Formulator: solver service, shadow prices, screen; overhead constants into settings | F2, F3 |
| **F5** | Production Order → Production Entry; consumption + output as one movement | F3, valuation decision |
| **F6** | Feed Transfer mill → shed | F0, F5 |
| **F7** | Reports: cost per kg trend, consumption vs production, formula cost comparison | F5 |

F0 through F3 are independent of the valuation decision and can start immediately.
F5 cannot.

---

## 6. Things in Amino not worth porting

- **`deliveries`** and its moisture/price alerting — procurement supersedes it
- **`materials.currentStock`** and `remainingQuantity` — stored balances, against
  EGGSY's foundations
- **`production_plan`** — egg boxes, belongs to Farms
- **`batches.formulaSnapshot` / `costSnapshot` as jsonb** — a version reference
  plus real movement rows says the same thing and can be queried
- **`Cr feed_cogs` on production** — Amino capitalises a batch as
  `Dr feed_inventory / Cr feed_cogs`, crediting an expense account to move value
  into stock. It nets out only if COGS was debited earlier, which for a slip-built
  batch it was not. Worth checking against Amino's actuals before assuming the
  balances there are right; EGGSY should post raw-inventory-out to
  finished-inventory-in and never touch COGS until feed leaves for a shed.
- **The duplicated `NUTRIENT_FIELD_MAP`** — one on the client, one inside the
  solver endpoint

---

## 7. Open questions

1. **Valuation: weighted average or FIFO?** (§4.2) Changes cost per kg.
2. **Is finished feed one item per formula, or one item with a formula attribute?**
   Recommendation is one item per formula — it makes stock, valuation and transfer
   free. Costs an item per formula in the item master.
3. **Moisture retention and overhead** — 0.99 and ₹0.75/kg. Still current? Per
   formula or org-wide?
4. **Does a shed hold feed stock, or is a transfer a consumption?** If feed is
   consumed the moment it reaches a shed, the transfer posts to expense and shed
   stock is not tracked. If sheds hold stock, F0's location work is required and
   Farms will read those balances. Amino does the former (`Dr egg_inventory`).
5. **Who signs off feed standards?** Same question as the QC bands, same person.
