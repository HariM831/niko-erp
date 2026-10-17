# Zoho catch-up: the runbook

Zoho and niko were both written to from 5 August to 15 October 2026. This is
the sequence that brings them together, in the order it has to run. Rehearsed
on staging four times; the first three found defects that would have been
expensive on live books, and what they found is written down in §5.

Cutoff: **16 October 2026, morning.** Zoho's last invoices were keyed after
midnight and dated to the 15th.

---

## 1. Before anything

```bash
# a dump of production, not the one on the droplet
ssh root@143.110.186.90 'systemd-run --pipe --collect --uid=niko --gid=niko \
  --working-directory=/srv/niko --property=EnvironmentFile=/etc/niko/prod.env \
  /bin/sh -c "pg_dump -Fc --no-owner --no-privileges \"\$DATABASE_URL\" -f /srv/backups/prod-before-catchup.dump"'
```

**The droplet keeps its own `.zoho-dump` from the September pull.** Every script
that reads the dump must be pointed at the current one with `--dump` or
`--dir`, or it will compare today's database against three-week-old copies and
find nothing wrong.

Refresh the dump first: `npx tsx scripts/zoho/pull.ts --since=<last pull>`.

## 2. The order, and why

Each step depends on the one before it. The ordering is the part that went
wrong most often in rehearsal.

### 1. Renumber and re-date

```bash
npx tsx scripts/renumber-egg-series.ts            # read it
npx tsx scripts/renumber-egg-series.ts --apply
```

292 renumbered, 81 re-dated, from the plan in
`docs/egg-series-renumber-2026-10.json`. Everything dated before 5 August keeps
its number. The script refuses if the database is not the one the plan was
built against.

**The plan must be generated from PRODUCTION's state**, not staging's. A plan
describes a move from a known starting point; generate it against a database
that has already moved and it is nonsense.

### 2. Audit the Zoho links — BEFORE the backfill and the loaders

```bash
npx tsx scripts/zoho/audit-invoice-map.ts --dump <current dump>
npx tsx scripts/zoho/audit-invoice-map.ts --dump <current dump> --fix
```

~10 stale links dropped. This is second for a reason: a stale link makes a real
Zoho invoice look like one niko already has, so the loader skips it and the
series is left with holes. Run the loaders first and you get four gaps and a
receipt with nowhere to land.

### 3. Backfill the links that are simply missing

```bash
npx tsx scripts/zoho/backfill-invoice-map.ts <map-backfill.csv> --commit
```

~49 pairs. Build the file AFTER step 2, against the post-renumber database.

### 4. Items and contacts, then invoices and bills

```bash
npx tsx scripts/zoho/load-items.ts     --dir <catchup> --commit
npx tsx scripts/zoho/load-contacts.ts  --dir <catchup> --commit
npx tsx scripts/zoho/load-invoices.ts  --dir <catchup> --commit   # 173
npx tsx scripts/zoho/load-bills.ts     --dir <catchup> --commit   # 4
```

Items and contacts first: 14 invoices were refused in rehearsal for an item or
a customer created in Zoho after the September load.

### 5. Pre-cutoff receipts only

```bash
npx tsx scripts/zoho/load-payments.ts --dir <pre-cutoff> --commit   # 21
```

**Only receipts dated on or before 16 September.** The 291 later ones are keyed
in niko by categorizing the bank statement line; loading them posts the money
twice. See `docs/banking-categorize-plan.md`.

Of the 21, **ten are group** — Nandamuri and Luit, ₹6.08 crore of unapplied
advances entered into Zoho after the September load.

### 6. The seven corrections

Same invoice, same customer, same day, a different amount here. `0177` and
`0211` have their amounts transposed between them; `0702` is exactly double.

An amount cannot be corrected in place — the lines and the journal have to be
rebuilt, which is the loader's job. So:

```bash
npx tsx scripts/zoho/unload-selected.ts invoice <corrections.txt>   # names the receipts blocking it
npx tsx scripts/zoho/unload-selected.ts customer_payment <those receipts> --yes
npx tsx scripts/zoho/unload-selected.ts invoice <corrections.txt> --yes
npx tsx scripts/zoho/load-invoices.ts --dir <fix> --commit
npx tsx scripts/zoho/load-payments.ts --dir <fix> --commit
```

### 7. The re-allocations

```bash
npx tsx scripts/zoho/unload-selected.ts customer_payment <realloc.txt> --yes
npx tsx scripts/zoho/load-payments.ts --dir <fix> --commit
```

~402 receipts, ₹10.6 crore. Zoho wins on trade allocation (decided 16 Oct). The
cash and the customer balance already agree on both sides; only which invoice
each rupee settles differs. **Group is excluded** — its advances stay unapplied.

## 3. What to check afterwards

| check | expected |
|---|---|
| Series gaps `0567`–`1031` | **0** |
| Trade allocation matching Zoho | **all, zero differing** |
| Receipt applications pointing at an unmapped invoice | **0** |
| Journal date ≠ invoice date | **0** |
| Invoices left on a temporary `~` number | **0** |
| Out-of-date-order pairs | 2, both in the frozen pre-August run |

Then eggs produced against eggs sold, by month — it should sit near 100% from
April and no longer collapse in September and October.

## 4. Known differences that stay

- **Three invoices Zoho deleted and niko keeps**, by decision: `0383`, `0663`,
  `0779` (now `0810`), and the ₹2,43,600 cash receipt CP-2026-27/1001 attached
  to `0663`. They must be held OUT of matching — see §5.
- **Group advances unapplied**: ₹13.89 crore Zoho applied to the LLPs' feed and
  bird invoices and niko holds as advances.
- **Shreeram SSLLP/038** is deliberately not re-imported; it was voided here on
  30 Sep and replaced by BILL-002164.
- **The 29 June sale** is North East Egg Centre in Zoho and Pal Egg Center here.
  One of them bought ₹6,00,600 of eggs. Unsettled.

## 5. What the rehearsals found

The matching rule took four passes. Each failure is worth keeping:

**Identity is the date, plus either the customer or the amount.** Not all three.

- Requiring all three dropped six links that were one sale a few rupees apart —
  thirty rupees between `0848` and `INV-2026-27/0310` — and each would then have
  been imported a second time. A reconciliation producing duplicates.
- Requiring the customer dropped the North East / Pal Egg Center link and left a
  paid ₹6,00,600 receipt with nowhere to go.
- Requiring the amount dropped the seven figures-differ links — the very
  invoices needing correction, which then could not be corrected or rebuilt.

**An invoice Zoho deleted has no counterpart, so it must never be offered one.**
`0779` is a 15 September sale. The matcher gave it Zoho's 12 September invoice
— same customer, same ₹2,73,000, three days apart — re-dated a real sale to the
12th, and left the real 12 September sale unmatched.

**Nothing is a duplicate because niko has it.** Seventeen invoices were nearly
voided on that reasoning. The question for a duplicate is whether ZOHO holds it
twice, and it did not: each had its own receipt with its own UTR. The user put
it in one line — *if they are paid there are real invoices*.

**A link can be made wrong by an edit at the other end.** Zoho's `0801` was
re-dated and re-priced on 10 October, and a mapping that had been correct since
September was wrong from that moment with nothing to announce it.

---

## 6. Receivables: from two books to one figure

Run after the invoices, bills and receipts are in. Rehearsed on staging on
17 October 2026; the figures below are that rehearsal's.

```bash
npx tsx scripts/zoho/find-duplicate-receipts.ts --dump <current dump>
npx tsx scripts/zoho/unload-selected.ts customer_payment .zoho-fix/duplicate-receipts.txt --yes
npx tsx scripts/zoho/move-application.ts CP-2026-27/1001 A-INV-EG-27-0659 A-INV-EG-27-0668 --commit
npx tsx scripts/allocate-receipts.ts                  # read it, then --commit
npx tsx scripts/check-document-balances.ts --fix
npx tsx scripts/check-control-accounts.ts
npx tsx scripts/fix-control-drift.ts                  # read it, then --commit
npx tsx scripts/check-control-accounts.ts             # receivables must agree
```

**Eleven receipts are the same deposit twice.** Eight were re-keyed into Zoho
between 6 and 8 October against receipts Zoho already held —
`CP-2026-27/1346` carries the same UTR as `CP-2026-27/569` under a different
customer's name, and five July receipts for DG Egg Point were re-entered
against a second contact record. Zoho applied both copies to the same invoice,
so Zoho's own `A-INV-EG-27-0439` calls itself paid while carrying ₹7,04,026
against a total of ₹3,52,013. Three more were loaded although the bank
statement had already been keyed for the same UTR, same day, same customer;
the statement-keyed one is kept.

**The 2,43,600 cash on A-INV-EG-27-0659 is not that invoice's.** Zoho deleted
the 22 August sale to Tapan Saha and left its receipt on the invoice before it.
niko keeps that sale — it is `0668` after the renumber, open for exactly the
receipt.

**Then the allocation.** Zoho's receipts keep Zoho's allocation, by the
decision of 16 October. Only niko's own receipts move, forward: same day, next
day, the day after, an exact balance taken first, and then whatever the
customer still owes from before, oldest first. On staging that placed 124
receipts into 145 applications, ₹3.65 crore, and took the open figure for
those customers from ₹5.78 crore to ₹2.13 crore with ₹4.87 lakh left as
advances.

**What is left owing is a real gap, not credit.** ₹2.13 crore across 16
customers, nearly all of it October invoices raised after the last receipt
came across. There are no credit sales here, so each one is money to find.

### Nine invoices are over-applied by rounding

Between ₹2 and ₹2,541, on both books. Their balance is written as zero, which
is as true as a negative balance can be stored, and the check ignores an excess
under ₹100 or half a percent. `A-INV-EG-27-0188` is the largest: niko holds
₹6,37,791 where Zoho holds ₹6,40,332 for the same sale.

### The ledger moves onto the documents, never the other way

Receivables is a control account: its balance is the open invoices or it is
wrong. The invoices agreed to the rupee; the credit side had put ₹64.80 lakh
more into receivables than the applications could account for, because
applying an advance posts an entry of its own and two books of loading and
re-allocating left some standing after the application was deleted.
`fix-control-drift.ts` posts one correcting entry per customer, dated at the
cutoff.

A per-receipt version of that test is wrong and was deleted: ₹4.34 crore has
moved out of advances by its own entries, more than the ₹3.69 crore of receipts
whose own split "looks" wrong, so rewriting those splits would count the same
money into receivables twice.

Afterwards, on staging: receivables agrees to the rupee. Customer advances sits
₹30,95,320 below the receipts' unapplied total, which is the two refunds —
₹28 lakh to Luit Valley on 30 March, ₹3 lakh to Zakir Egg Store on 22 April —
less the ₹4,678 of rounding. A receipt knows only what it collected, so a
refund leaves that difference for good.

Payables is still ₹20,58,813 apart, and stays so until the 224 vendor payments
come across.

### Done on production, 17 October 2026

In this order, from a checkout of `main` at `/srv/zoho-16oct/niko-main` with
`EnvironmentFile=/etc/niko/prod.env` — not from `/srv/niko-staging`, whose
branch another session moves underneath you.

1. `pg_dump` → `/srv/backups/prod-before-duplicates-17oct.dump`
2. `merge-contacts.ts "PUYA MARKETING" "M/s Puya" --apply`
3. `void-invoices.ts 0508 0811 0932 0968 --commit` — ₹33,16,856 of sale written
   twice, once in each book. **Which copy survives is settled by the dispatch**,
   not by the number: `1034` keeps the 2 October sale although it sits out of
   date order, because the eggs left the farm against it and voiding it would
   have pulled ₹12.4 lakh of stock back.
4. `unload-selected.ts customer_payment <9 numbers> --yes`
5. `move-application.ts` — `PMT-00136` off `0668` onto `0810`, then
   `CP-2026-27/1001` from `0659` onto `0668`. **Move before allocating.** Run it
   the other way round and the pass has already filled the invoice the Zoho
   receipt belongs on.
6. `allocate-receipts.ts --commit` — 136 receipts into 161 applications,
   ₹3.89 crore. Open for those customers: ₹9.37 crore → ₹5.48 crore.
7. `check-document-balances.ts --fix`
8. `fix-control-drift.ts --commit` — 21 customers, ₹64,59,916.

Afterwards: **receivables agrees to the rupee**, ₹36,27,29,148 on both sides.
Advances is ₹30,95,420 below the receipts, which is the two refunds less
rounding. Payables is ₹27,75,013 apart and stays so until the vendor payments
come across.

### Then the receipts Zoho had and niko did not, the same day

```bash
load-missing-receipts.ts --dump <dump>                       # read it
load-missing-receipts.ts --dump <dump> --write <dir>/customerpayments.jsonl
load-payments.ts --dir <dir> --commit
find-duplicate-receipts.ts --dump <dump>                     # then check
allocate-receipts.ts --commit
check-document-balances.ts --fix
fix-control-drift.ts --commit
```

186 receipts, ₹4.86 crore. Three things it taught, each now in the scripts:

**A removed duplicate looks exactly like a missing receipt.** The eight Zoho
re-entries taken out that morning were offered straight back, loaded, and had
to be removed again. A receipt whose own earlier twin is already here under its
own number is the second copy, not a missing one — and the twin may be filed
under a second customer record, so the transfer reference has to join them.

**Who a receipt belongs to is its Zoho id, not the name on it.** Every Zoho
receipt still said PUYA MARKETING after the merge. On the name alone, ₹24.5
lakh already in niko would have loaded again, onto invoices voided an hour
earlier. `merge-contacts.ts` now carries `zoho_id_map` across with the rest —
it has no foreign key, so the catalogue walk went straight past it.

**Pair the proven before the likely.** PMT-00085 carries `CP-2026-27/1393`'s
exact reference, but a receipt three days later for the same round ₹2,68,800
reached it first and 1393 was loaded against a deposit niko already had.

And one about the correction itself: **`fix-control-drift` clears what the last
run wrote and works the figure out afresh.** Its own entries carry no customer,
so the attribution walked past them, and running it twice put ₹64.6 lakh into
receivables that nothing owed.

Afterwards, on production: **receivables agrees**, ₹32,62,01,695 against
₹32,62,01,696. Open for those 23 customers: ₹5.79 crore → **₹1.94 crore**, with
₹16,48,753 left as advances. No deposit is in the book twice. Advances stays
₹30,95,320 below the receipts (the refunds), and payables ₹27,75,013 apart
until the vendor payments come across.
