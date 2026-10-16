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
