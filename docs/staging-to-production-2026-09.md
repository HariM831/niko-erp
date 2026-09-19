# Staging → production, September 2026

Everything staging has that production does not. Kept current as work continues,
so the cutover is a list to work through rather than a memory test.

Production is at `659dd51`; staging is 21 commits ahead. A deploy carries code
and migrations. It carries **no data** — every load below has to be run again
against production, in the order given.

Last updated 19 Sep 2026.

---

## 1. Code — 21 commits

`sudo -u niko bash -c 'cd /srv/niko && ./scripts/deploy.sh'` pulls main, builds,
migrates and restarts. One deploy takes all of these.

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

**Zoho migration and infrastructure**

- `1629b2b` the Zoho load, rehearsed against 17 Sep: every account at every month-end
- `e1cfd7a` a staging refresh keeps the logins that are staging's own

## 2. Schema

- `migrations/0097_payroll_completion.sql` — the only migration production has
  not applied. `deploy.sh` runs it; nothing to do by hand.

## 3. Data — none of this arrives with a deploy

In this order. Every one of these has a dry run; read it before committing.

### 3.1 Zoho one-time load — the big one

Cutoff is **17 Sep 2026**, held in one place at `scripts/zoho/cutoff.ts`.

1. **Back production up first.** Non-negotiable; the load writes the whole ledger.
2. `npx tsx scripts/zoho/pull.ts` — resumable, so a network drop costs nothing.
   The ledger walk is separate and paced: `pull-ledger.ts` sleeps 3 s a page
   because the org got rate-blocked on `reports/accounttransaction`.
3. Loaders, each dry first and then `--commit`:
   `load-accounts` → `load-contacts` → `load-items` → `load-banks` →
   `load-invoices` → `load-bills` → `load-expenses` → `load-journals` →
   `load-payments` → `load-vendor-credits` → `load-bank-transactions`
4. `npx tsx scripts/zoho/reconcile.ts` and `verify-ledger.ts`.
5. **`npx tsx scripts/advance-number-series.ts --commit`** — see §6. Nothing
   else moves the counters, and skipping it leaves the bill counter at 6 with
   2,096 bills already on file. **This was never run in the staging rehearsal**,
   so run the dry form on staging first and read it.

What the staging rehearsal proved, and what production must match:

- 138 of 140 accounts exact. The two that differ are the approved move of
  ₹1,29,18,931 of free-text egg lines to Eggs (Sales).
- All 175 posting accounts agree at all 32 month-ends.
- All 2,914 invoice and bill balances match.

`load-attachments.ts` is **deliberately not run** — ~2.5 GB, deferred.

### 3.2 Feed mill

6. `npx tsx scripts/import-formulas-2026-09.ts` — the five recipes.
7. `npx tsx scripts/import-rm-nutrients.ts` — 197 nutrient values for 13 materials.
8. `npx tsx scripts/merge-feed-duplicates.ts --write` — folds the eight items the
   formula import created onto the ones carrying the purchase history, and fixes
   Soya Hipro's unit from pieces to kg.
9. `npx tsx scripts/attach-soya-bill-items.ts --write` — names the material on
   three soya bills that were billed as free text.
10. `npx tsx scripts/match-inward-freight.ts --write` — puts inward carriage back
    on the consignment it carried, so a material costs what it cost delivered.
11. `npx tsx scripts/load-hyline-feed-standards.ts --apply` — the Hy-Line W-80
    nutrient specification, 7 stages × 12 nutrients.

Order matters: 8 before 9–11, or the freight and the standards attach to items
that are about to be folded away.

### 3.3 Payroll history from Amino

Not built yet — see §5. The export script exists on the Amino repo
(branch `niko-history-export`, commit `bd73d71`) and **has not been pushed**.

## 4. Open decisions, before production

1. The 11 carried system keys from the Zoho chart — confirm before loading.
2. Whether niko continues Zoho's `A-INV-EG-27` numbering or starts its own
   series — and if it continues, whether eggs becomes the default series or the
   two egg call sites learn to name one. See §6.
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

### The open question on invoices

Invoices are the one type that kept Zoho's numbers *and* has no continuation the
script can find, because `A-INV-EG-27-0802` does not match `^INV-[0-9]+$`. So
after a production load, **the next invoice raised in niko is `INV-00002`** —
technically safe, since the unique index holds and the shapes differ, but it
abandons the series the business has used for 802 invoices this year.

Continuing Zoho's numbering means creating the series the business actually
runs — EG for eggs, FD for feed, BD for birds — and setting each counter to
803 / 9 / 3 at padding 4.

One thing to settle first if that is the choice: **the egg dispatch path never
picks a series.** `server/services/egg-sales.ts:914` and
`server/services/owner-billing.ts:544` call `nextDocumentNumber(tx, "invoice")`
with no series, so they take whichever is flagged default; only the manual
invoice form at `server/routes/sales.ts:300` can choose one. So either eggs must
be the default series, or those two call sites need to name theirs.
