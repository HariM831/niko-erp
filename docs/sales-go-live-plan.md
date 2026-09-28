# Sales go-live on staging — the plan

Staging becomes production (decided 27 Sep 2026), and Sales goes first. This
is what has to be true before the first truck is loaded in niko, what comes
across from Amino, and what is waiting on a decision. Nothing here is built
yet.

## How niko sells eggs

The load **is** the invoice. At the Loading Bay a truck is loaded against a
standing agreement, a spot order or as a walk-in; niko prices each size, raises
the invoice under the next `A-INV-EG-27-` number, applies the customer's money
on account, and takes the boxes out of egg stock. The packing room feeds that
stock from the Egg stock page: grading adds boxes, the evening count corrects
the ledger to what is on the floor.

A load is refused when:

| Missing | Message |
|---|---|
| a benchmark rate on or before the day | "No benchmark rate is set for … — set it on the Benchmark page" |
| a Niko box rate, when Niko is loaded | "No Niko box rate is set for …" |
| the boxes in stock | "Only n Size box(es) in store — cannot load q" |
| money on the customer's ledger | "…'s ledger holds ₹X against a load of ₹Y — record their payment first" |

Two things are **not** refused and would misprice silently:

- **No benchmark for today** takes the latest earlier one (the invoice note
  says so, nothing stops the load).
- **No size offset** prices every size like Large. Staging's only offset row
  (26 Aug) is all zeros today.

Price per box = (benchmark + size offset + customer spread) × eggs in the box
(210; jumbo 180). Niko is its own box rate (360 eggs), no offset, no spread.

## State of staging, 27 Sep

| | |
|---|---|
| Customers | from the 18 Sep Zoho load; 24 with money on account |
| Invoices | last A-INV-EG-27-0802, 16 Sep — nothing since |
| Customer payments | last 16 Sep |
| Benchmark | last 30 Jan 2026 |
| Niko box rate | never set |
| Size offsets | one row, all zero |
| Agreements, spot orders, dispatches | none |
| Egg stock | none; `stock_from` is 26 Aug |
| Size → item mapping | all 7 sizes, tracked |
| Sales rights | Accountant, Director, Admin (6 users); Packing Room role added |

## Where it stands, 28 Sep

The first Amino export (28 Sep 10:39 UTC) was dry-run on staging twice. Run
from 16 Sep it is clean: 45 of 49 customers matched (Ashim Dey and HKD Egg
Traders were created on staging with their Zoho ids mapped, the other four
have nothing to bring), 34 invoices A-INV-EG-27-0803 to 0836, 67 payments,
95 applications, 134 benchmark days to 28 Sep at ₹5.35, 15 agreements, 6 spot
orders for 28–30 Sep, opening stock from Amino's 27 Sep count (Small 37,
Medium 210, Large 213, Jumbo 37).

**Not applied.** Invoices for 22–24 Sep are still to be entered in Amino, and
the sequence must not be broken. Amino keeps invoicing until then; export
again afterwards and re-run the same dry import with `--from 2026-09-16
--opening-stock` — it leaves what niko already holds alone — then `--apply`,
then `continue-invoice-series.ts --apply` and `check-invoice-series.ts`. No
invoice is to be raised on staging before that. The closing egg count on the
day of the final export is what becomes niko's opening stock.

## What comes across from Amino

Amino created every invoice and pushed it to Zoho under the same number, so
its invoices are Zoho's invoices, matched by `zoho_invoice_number`. One export
on Replit (`scripts/export-sales-for-niko.ts`, Amino repo), one importer in
niko (`scripts/import-sales-from-amino.ts`, dry by default, one transaction):

1. **Customers.** Matched through Amino's `zoho_customer_map` to niko's
   `zoho_id_map`, then GSTIN, then exact name. Customers Amino has that niko
   does not (created since the Zoho load) are listed — see decision 5.
2. **Benchmark rates** from `daily_prices.benchmark_rate_per_egg`, every day
   after 30 Jan 2026 (niko's history ends there). Source `amino`.
3. **Size offsets** from Amino's sales settings. Amino holds them in ₹ per box
   below Large; niko in ₹ per egg. Converted ÷ 210, dated 28 Sep — see
   decision 3.
4. **Agreements** (`customer_agreements` → `egg_agreements`): spread per egg,
   boxes, schedule (Amino's `weekly`/`specific_days` become niko's `weekdays`
   with the same days), start/end, status. Skipped days
   (`agreement_date_voids`) become skip exceptions.
5. **Invoices after A-INV-EG-27-0802** with the same numbers, one line per size
   from Amino's loaded boxes and per-box prices, posted to the books like any
   niko invoice — but **without moving egg stock**: the opening count below
   already reflects them. Feed, bird and other invoices in the window come
   too, with their own lines.
6. **Customer payments and credit notes** after 16 Sep, applied to those
   invoices oldest first (Amino's own rule; where Amino kept allocations,
   those instead).
7. **Open spot orders** booked for 28 Sep onward, so tomorrow's calendar is
   already there.

Afterwards `scripts/continue-invoice-series.ts --apply` sets the next number
from the highest imported one, and `scripts/check-egg-sales.ts` runs the whole
flow once and rolls back.

## Settings on staging before the first load

- `stock_from` set to the go-live date, so nothing earlier moves egg stock.
- Opening egg stock per size — decision 4.
- The day's benchmark (and Niko box rate) each morning, Benchmark page.
- Loading Bay users: whoever loads trucks needs Sales rights — decision 6.

## Decisions

Settled 27 Sep: Amino's "dirty" maps to niko's Dirty; customers are matched to
niko's existing contacts, never created; Brown is a fixed box rate (₹1,680 a box
of 210); Dirty is a grade again.

1. ~~Does Amino stop invoicing from tomorrow?~~ **Settled 27 Sep: Amino stops
   invoicing after tonight's export.** From 28 Sep every truck is invoiced in
   niko only.
2. ~~Zoho for 28–30 Sep.~~ **Settled 27 Sep: no link to Zoho is built.** Zoho
   is discontinued on 1 Oct as planned; for 28–30 Sep anything Zoho should
   still have is keyed by hand, as parallel entry has done for bills.
3. ~~Size offsets.~~ **Settled 27 Sep: your own**, per egg over VIJ — Small
   0.50, Medium 0.75, Large 1.00, Jumbo 1.85; Dirty's still to come.
4. ~~Opening egg stock.~~ **Settled 27 Sep: Amino's closing count** — the
   import runs with `--opening-stock`, which sets each size item's opening
   balance from Amino's last closing entry (check its date is 27 Sep before
   applying). Amino counts no Brown or Niko boxes: those two need their own
   figures.
5. **Customers Amino has and niko does not.** Create them in niko from Amino's
   record (name, GSTIN, phone, address), or list them for you to add?
6. **Who loads the trucks,** and which role do they get?
7. **The Niko box rate** for 28 Sep — Amino never had one; its "dirty" size was
   priced off the benchmark.
