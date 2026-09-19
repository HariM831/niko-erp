# Staging → production, September 2026

Everything staging has that production does not. Kept current as work continues,
so the cutover is a list to work through rather than a memory test.

**Code is done.** Production and staging both run `4477034` as of 19 Sep 2026 —
the 28 commits and migration `0097` are deployed to both, so the two are
identical code-wise and §1 and §2 below are history rather than a to-do.

**Data is what remains.** A deploy carries code and migrations and **no data** —
every load in §3 still has to be run against production, in the order given.

Last updated 19 Sep 2026.

---

## 0. By module, at a glance

Code columns are now the same on both; the data columns are the work left.

| module | code commits | schema | data on production today | data on staging |
|---|---|---|---|---|
| **Payroll** | 7 | `0097` | **0 employees** | 2 |
| **Feed mill** | 11 (3 touch the app, 8 are one-shot scripts) | none | 0 formulas, 0 nutrients, 0 standards | 5 / 197 / 7 |
| **Sales** | **0** — not one line | none | 0 invoices | 819 |
| **Farms** | **0** | none | 6 houses, 4 flocks | identical |
| Books / Zoho | 13 script files | none | 0 bills, 0 journals, 149 accounts | 2,101 / 10,482 / 403 |
| Numbering | 3 | none | 1 series, counters at 1 | 3 series, counters continued |

Two things that table makes plain:

- **Sales has no code change at all**, and is still the module the cutover
  changes most — every invoice, every payment and the whole numbering scheme
  arrive as data.
- **Farms is untouched end to end.** Nothing in these 27 commits goes near it,
  and its data already matches.
- **Payroll deploys onto an empty module.** Production has no employees. The
  code is proven on staging against 2 test records; the people and the history
  come from Amino and that importer is not written yet (§3.3).

## 1. Code — 28 commits, deployed 19 Sep 2026

Deployed with `sudo -u niko bash -c 'cd /srv/niko && ./scripts/deploy.sh'`,
which pulls main, builds, migrates and restarts. A database snapshot was taken
first at `/srv/backups/prod-before-0097-20260919-0217.dump`.

**Payroll completion** (built and proven on staging, decisions 1–4 and manual punch)

- `9439568` the gate checks whose face it is before learning it, and can name anybody
- `36c437a` the gate measures its roster once and keeps it between page loads
- `900f5c3` pick an employee by typing any part of the name or the code
- `ff000e0` an expense claim says which days it was for; a pending input can be corrected
- `0b59232` one Aadhaar, one person — refused by name, overruled on purpose
- `b0af8b4` a canteen counter in a browser, where the server reads the clock
- `d6ecb20` the face report: faces learned under the wrong name, and three finer readings

**Feed mill**

- `1bf8f37` the five recipes the mill is running, ordered as a bird lives them
- `c04afac` nutrient profiles for the twelve materials the mill actually uses
- `79f3160` Lime Stone Grit is LSP/Cal Carb, at 37% calcium
- `7427e9f` fold the feed items I created onto the ones that carry the buying
- `7299770` put the carriage back on the load it carried, and name three soya bills
- `02a819d` a formula costs what the material actually cost, delivered
- `f0a7b16` a material bought by the pack is divided by what the pack weighs
- `55b1d37` order the distinct name list by name, not by life stage
- `58f9c57` hold the breeder's nutrient specification, not just the recipe
- `285d4c5` judge a mix over the whole batch, not over the part that has an analysis
- `907220d` a material with no analysis at all is never filtered out by its weight
- `ee0f6cc` say once per mix what nothing is known about, not once per nutrient

**Zoho migration, numbering and infrastructure**

- `1629b2b` the Zoho load, rehearsed against 17 Sep: every account at every month-end
- `e1cfd7a` a staging refresh keeps the logins that are staging's own
- `f04c0d9` this list
- `d67c174` carry on the invoice numbering the farm already uses
- `7340f2c` claim a number the way a save does, then roll it back

## 2. Schema — applied

`migrations/0097_payroll_completion.sql`, applied to production by the deploy.
Verified present afterwards: `punches.manual_reason`, `pay_inputs.date_from` and
`.date_to` with the `ck_pay_inputs_dates` check, `canteen_servings.served_by`
and `.ineligible` with `device_id` now nullable, and
`canteen_meal_eligibility.breakfast_auto`. Every statement is additive and the
tables it touches were empty on production, which is why it needed no window.

## 3. Data — none of this arrives with a deploy

In this order. Every one of these has a dry run; read it before committing.

### 3.1 Zoho one-time load — the big one

Cutoff is **`ZOHO_CUTOFF=2026-09-30`** — the last day Zoho is used. Set it on
every command in this section; `scripts/zoho/cutoff.ts` refuses to run without
it, so there is no default to forget.

17 Sep 2026 was the rehearsal date and must not be used at go-live: Zoho keeps
trading until the 30th, and loading the older dump would have niko re-issue
invoice numbers Zoho had already given to real customers. See §6.

1. **Back production up first.** Non-negotiable; the load writes the whole ledger.
2. `ZOHO_CUTOFF=2026-09-30 npx tsx scripts/zoho/pull.ts` — resumable, so a
   network drop costs nothing.
   The ledger walk is separate and paced: `pull-ledger.ts` sleeps 3 s a page
   because the org got rate-blocked on `reports/accounttransaction`.
3. Loaders, each dry first and then `--commit`, all with
   `ZOHO_CUTOFF=2026-09-30`:
   `load-accounts` → `load-contacts` → `load-items` → `load-banks` →
   `load-invoices` → `load-bills` → `load-expenses` → `load-journals` →
   `load-payments` → `load-vendor-credits` → `load-bank-transactions`
4. `ZOHO_CUTOFF=2026-09-30 npx tsx scripts/zoho/reconcile.ts`, then
   `verify-ledger.ts` with the same cutoff.
5. **`npx tsx scripts/advance-number-series.ts --commit`** — see §6. Nothing
   else moves the counters. On staging it advanced bills to 2097 and expenses
   to 2697 (padding 5→6) and realigned the vendor-credit prefix `VCN-` → `VC-`
   at 16.
6. **`npx tsx scripts/continue-invoice-series.ts --apply`** — carries on the
   EG/FD/BD invoice sequences; see §6.
7. **`npx tsx scripts/check-invoice-series.ts`** — claims a number from each
   series and rolls it back. Exits non-zero if any sequence would collide.

What the staging rehearsal proved, and what production must match:

- 138 of 140 accounts exact. The two that differ are the approved move of
  ₹1,29,18,931 of free-text egg lines to Eggs (Sales).
- All 175 posting accounts agree at all 32 month-ends.
- All 2,914 invoice and bill balances match.

`load-attachments.ts` is **deliberately not run** — ~2.5 GB, deferred.

### 3.2 Feed mill

8. `npx tsx scripts/import-formulas-2026-09.ts` — the five recipes.
9. `npx tsx scripts/import-rm-nutrients.ts` — 197 nutrient values for 13 materials.
10. `npx tsx scripts/merge-feed-duplicates.ts --write` — folds the eight items the
   formula import created onto the ones carrying the purchase history, and fixes
   Soya Hipro's unit from pieces to kg.
11. `npx tsx scripts/attach-soya-bill-items.ts --write` — names the material on
   three soya bills that were billed as free text.
12. `npx tsx scripts/match-inward-freight.ts --write` — puts inward carriage back
    on the consignment it carried, so a material costs what it cost delivered.
13. `npx tsx scripts/load-hyline-feed-standards.ts --apply` — the Hy-Line W-80
    nutrient specification, 7 stages × 12 nutrients.

Order matters: 10 before 11–13, or the freight and the standards attach to items
that are about to be folded away.

### 3.3 Payroll history from Amino

Not built yet — see §5. The export script exists on the Amino repo
(branch `niko-history-export`, commit `bd73d71`) and **has not been pushed**.

## 4. Open decisions, before production

1. The 11 carried system keys from the Zoho chart — confirm before loading.
2. ~~Invoice numbering.~~ **Settled 19 Sep 2026: continue EG/FD/BD.** Applied
   on staging and proven. See §6.
3. Group companies: set `is_group_company` on the four contacts; decide whether
   to apply the advances; whether to rejoin each LLP's two sides. Net position
   is ₹3,21,27,358 in niko's favour (Nandamuri ₹2,61,11,486, Luit ₹60,15,872).
4. **Mixiblend P datasheet** — whether it carries phytase and at what dose.
   Until it is on file, no mix's available phosphorus can be judged against the
   Hy-Line standard at all.
5. Decisions 5–12 in `docs/payroll-completion-plan.md`.
6. Amino payroll history: push the export script, run it on Replit, write the
   niko-side importer.

## 5. Known gaps, carried knowingly

- Mixiblend P and Cantaxanthin have no nutrient profile at all.
- niko has no nutrient key for sodium, chloride, linoleic acid or choline, all
  of which the Hy-Line guide specifies.
- Zoho attachments (~2.5 GB) are not migrated.
- The phone app's data is not migrated, by decision; its recorded attendance is
  kept as history only.

## 6. Document numbering

### How it works

Two tables in `shared/schema/core.ts`. No Postgres sequence and no `max()+1` at
runtime.

- **`number_series`** — the named series (Zoho's "Transaction Number Series").
  One flagged `is_default`. Production and staging both have exactly one,
  "Default Transaction Series".
- **`document_series`** — one counter row per (series × entity): `prefix`,
  `next_number`, `padding`, unique on `(series_id, entity)`.

Every numbered document goes through `nextDocumentNumber()` in
`server/lib/numbering.ts:15`. It is a single `UPDATE … SET next_number =
next_number + 1 … RETURNING next_number - 1`, run inside the caller's
transaction — the row lock that `UPDATE` takes is what serialises two people
saving an invoice at the same moment. Behind it, every `number` column carries a
unique index, so a duplicate fails at the insert rather than being written.

The format is plain concatenation: `prefix + String(counter).padStart(padding, "0")`.
**There is no financial-year logic anywhere.** `A-INV-EG-27-0354` is the literal
prefix `A-INV-EG-27-` plus counter 354 at padding 4 — so the `27` is typed by
hand and somebody has to edit the prefix each April.

Other behaviour worth knowing:

- The number is claimed **at draft creation**, not at issue.
- A rolled-back transaction leaves a gap. Deliberate, and documented at
  `numbering.ts:12`.
- Voiding keeps the number; an invoice has no hard delete at all.
- Only office receipts reclaim numbers on delete, via `resyncDocumentNumber()`,
  which only ever moves a counter **down** to one past the highest survivor and
  never back into a gap.

### What the Zoho import does to it

Three different policies, and **none of the loaders touches a counter**:

| entity | numbers after import | counter | next number niko would issue |
|---|---|---|---|
| invoice | Zoho's own, verbatim — 802 × `A-INV-EG-27-`, 8 × `A-INV-FD-27-`, 2 × `A-INV-BD-27-` | still 2 | `INV-00002` |
| bill | niko's own, re-issued in date order to `BILL-002096` | still 6 | `BILL-00006` |
| expense | niko's own, to `EXP-002696` | still 1 | `EXP-00001` |
| vendor_credit | `VC-000015` | still 1 | `VCN-00001` |
| customer/vendor payment | Zoho's own (`CP-2026-27/998`) | still 1 | `PMT-00001` |
| journal | claimed properly — the loader posts through niko | 13673 | correct |

`scripts/advance-number-series.ts` is the fix and is a **required cutover step**.
Its dry run on staging today says: bill → 2097 (padding 5→6), expense → 2697
(padding 5→6), and it offers to realign the vendor-credit prefix from `VCN-` to
`VC-` at 16. Payments are reported as "left alone — kept Zoho's numbering".

### Invoices — settled, continue EG/FD/BD

Invoices are the one type that kept Zoho's numbers *and* has no continuation
`advance-number-series` can find, because `A-INV-EG-27-0802` is not `INV-` plus
digits and it will not parse a counter out of a number another system minted.
Left alone, the next invoice raised here would have been `INV-00002`.

`scripts/continue-invoice-series.ts` settles it. Applied on staging 19 Sep 2026:

| sequence | series | prefix | next |
|---|---|---|---|
| eggs (802 invoices) | Default Transaction Series | `A-INV-EG-27-` | 0803 |
| feed (8) | Feed *(new)* | `A-INV-FD-27-` | 0009 |
| birds (2) | Birds *(new)* | `A-INV-BD-27-` | 0003 |

Two decisions inside that, both deliberate:

- **Eggs ride the default series.** Egg dispatch and owner billing claim their
  number without naming a series (`server/services/egg-sales.ts:914`,
  `server/services/owner-billing.ts:544`), so they take whichever is default.
  Eggs are 802 of 818 invoices; putting the EG prefix on the default series is
  what keeps that path right without touching the code.
- **Feed and Birds carry a numbering row for invoices only.** Picking one of
  them for a bill fails with "No numbering is configured" — the right answer,
  since a full set of tagged counters would let a mis-picked series quietly open
  a second bill sequence in the books.

The one niko-native invoice, `INV-00001`, keeps its number. Nothing is renumbered.

`scripts/check-invoice-series.ts` proves the path rather than the row: it claims
a number from each series through `nextDocumentNumber` and rolls back. On
staging it returns `A-INV-EG-27-0803`, `A-INV-FD-27-0009`, `A-INV-BD-27-0003`
with no counter moved.

### Voids never give a number back

Tested, not assumed — `scripts/check-void-numbering.ts`. Voiding sets a status
and nothing else; there is no delete route for a bill or an invoice at all, and
`resyncDocumentNumber` — the only mechanism that could ever return a number — is
whitelisted to office receipts. The test issues three numbers on a scratch
series, shows a resync declining to move the bill counter, shows the same resync
winding a receipt counter back to 1, and cleans up after itself.

Two cases that get confused and should not be:

- A save that **fails or is cancelled** releases its number, because nothing was
  ever issued. It becomes a permanent gap only if somebody else claimed the next
  number before the failure.
- A bill that was **saved and later voided** keeps its number forever. The
  supplier has it on paper; a second BILL-002097 would make that reference
  ambiguous for good.

Office receipts are the deliberate exception: a receipt that never went anywhere
can be deleted and its number reclaimed, and the delete route refuses any
receipt that has already produced a bill.

### The parallel-entry period, 19 Sep to 1 Oct

From 19 Sep the farm is entering every document **twice** — into Zoho and into
staging — to catch differences before the switch. On 1 October Zoho stops and
production at aminofarms.com is the only system.

That makes staging a test rig rather than a mirror, and two things follow that
are easy to get wrong:

- **Never run the Zoho load against staging again.** A hand-keyed invoice has no
  row in `zoho_id_map`, so a top-up pull would import Zoho's copy of the same
  document beside it and double everything from 18 Sep on. Staging's job now is
  to be typed into, not loaded into.
- **Never run `scripts/refresh-staging.sh`.** It copies production over staging
  and would erase every parallel entry.

Production is untouched through all of this: 0 invoices, 0 bills, 0 contacts
today, and it takes one clean load from Zoho at go-live. Nothing typed into
staging ever moves to production — Zoho is the source for both, because every
document typed into staging was typed into Zoho as well.

**The numbering check falls out of this for free.** Each invoice raised in
staging should be handed the same number Zoho gives its twin —
`A-INV-EG-27-0803`, then 0804, and so on. The moment the two differ, one system
has an invoice the other does not, and that is worth stopping for rather than
reconciling later.

### Going live on a later date than the cutoff

**The sequence continues only if the load at go-live includes every invoice
Zoho issued right up to the switch.** This is the one part of the cutover where
being a fortnight stale is not a cosmetic problem.

As of 19 Sep, Zoho holds 802 EG invoices, highest `A-INV-EG-27-0802` dated
16 Sep, and the staging copy matches it exactly. Go live on 1 October off the
17 September dump — rather than the `2026-09-30` cutoff this document now
specifies — and niko would start issuing at 0803 while Zoho had already used
0803 onwards for a fortnight of real trading — the same invoice number on
two different documents, for GST, which is not a numbering nuisance.

Nothing needs building for this; the pipeline was made for it:

- `ZOHO_CUTOFF` is an environment variable read by everything
  (`scripts/zoho/cutoff.ts`), so the final pull is the same commands with the
  later date. **It is 2026-09-30.**
- The loaders skip anything already imported, keyed on `zoho_id_map`, so the
  final run is a top-up rather than a reload.
- `continue-invoice-series.ts` reads the counters off the invoices actually on
  file, never a hardcoded number, so it lands on the right one by itself —
  **provided it runs after the top-up, not before.**

Order on the day:

1. **Stop invoicing in Zoho on 30 September**, and stop the parallel entry into
   staging with it. A hard stop: the last Zoho invoice is the last one there will ever be.
   Anything raised there afterwards is a number niko does not know about.
2. `ZOHO_CUTOFF=2026-09-30` — pull, then the loaders, as a top-up.
3. `reconcile.ts` and `verify-ledger.ts`.
4. `advance-number-series.ts --commit`.
5. `continue-invoice-series.ts --apply`.
6. `check-invoice-series.ts` — every sequence unbroken, and the next number one
   past Zoho's last. Compare it against Zoho's own last invoice by eye.
7. Only now raise an invoice in niko.

And between the load and go-live, **do not raise test invoices on production**.
Each one consumes a number Zoho has no idea about, and the two sequences part
company at that point.

### April 2027

**The financial year is a literal in the prefix.** Nothing computes it. In April
all three prefixes must become `-28-` and their counters go back to 1, in
Settings → Number Series or by editing `SEQUENCES` in
`scripts/continue-invoice-series.ts`. Run `check-invoice-series.ts` afterwards.
