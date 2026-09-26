# The two LLPs, as one account each

Nandamuri Poultries and Luit Valley Farms each sit in niko twice — once as a
customer, once as a vendor — because Zoho held them that way and the migration
carried the shape across faithfully. This is the plan to rejoin them. Nothing
here is done yet; decisions 2 and 3 have been open since 28 Aug 2026.

## niko already expects one contact per LLP

This is not a new feature. `server/services/owner-billing.ts` closes a farm
month by raising the feed invoice **and** the egg bill against the *same*
`contactId`, and refuses outright unless that contact's type is `vendor` or
`both`:

> `${vendor.displayName} is not set up as a vendor, so Amino cannot buy their eggs`

So today the Group Companies page (`/accountant/group-companies`) can never
close a month for either LLP: there is no single contact that can be invoiced
for the feed and billed for the eggs. The split is the blocker, not a
preference.

The same code says who a shed belongs to: `houses.owner_id`. All six sheds
currently have none, which is also why migration 0080 — which set
`is_group_company` from `houses.owner_id` — flagged nobody, and why the Group
Companies page is empty.

## What is actually there (staging, 26 Sep 2026)

| | Nandamuri | Luit Valley |
|---|---|---|
| Invoices (open) | 8 — **₹16,12,86,580** | 8 — **₹14,51,48,669** |
| Customer payments, all unapplied | 21 — ₹7,34,69,989 | 10 — ₹6,82,13,000 |
| Bills (open) | 4 — **₹9,42,85,116** | 4 — **₹7,81,19,797** |
| Vendor payments, all unapplied | 6 — ₹3,25,80,011 | 3 — ₹72,00,000 |
| **Net, in Amino's favour** | **₹2,61,11,486** | **₹60,15,872** |

₹3,21,27,358 between them — unchanged since §4.3 of
`docs/staging-to-production-2026-09.md` was written.

Nothing else points at any of the four contacts: no egg agreement, no owner
agreement, no billing run, no dispatch, no weigh ticket, no purchase order, no
expense, no credit note, no vendor credit. Two addresses each, identical on both
sides. Both sides of both LLPs: blank GSTIN, blank PAN, unregistered, Assam,
zero opening balance. One loose end: `INV-00001` on Nandamuri's customer side,
₹1,90,49,116 dated 18 Sep 2026, **void** — a test document. It moves with the
merge and stays void.

## Three decisions, not one

Only the first is the merge. They can be taken in order, and each is worth
taking on its own.

### 1. Rejoin each LLP into one contact — recommended, and safe

`scripts/merge-contacts.ts` was written for exactly this (its docstring names
Luit Valley) and has never been run. It reads the FK list from the catalogue
rather than a typed list, repoints every row, sets the survivor's type to
`both`, retires the loser rather than deleting it, and re-checks that nothing
still points at the retired record before committing — all in one transaction.
Its two refusals — a differing GSTIN or PAN, a non-zero opening balance — both
pass here, which is the evidence that these are one company entered twice.

It moves no money. Not one invoice, bill, payment or balance changes; the same
documents hang off one name instead of two.

Four things it does not do, and should, before this is run:

- **Drop the suffix.** The survivor would be called "Nandamuri Poultries LLP
  (Customer)". Both `display_name` and `company_name` need the "(Customer)" off.
- **Dedupe the addresses.** Two identical billing and shipping addresses each
  side become four. Keep one pair.
- **Fix Luit's pincode.** Their customer side reads 784001 (Tezpur); the other
  three read 784149 (Thelamara). 784149 is right.
- **Dry run first.** Add `--apply`, so the move can be read before it happens.

### 2. Flag them `is_group_company` — the question parked on 28 Aug

Separate from the merge, and the one with visible consequences. The flag is read
in six route files (`contacts`, `sales`, `purchases`, `reports`, `egg-sales`,
`boss-view`), and setting it takes **₹30.6 crore of receivables and ₹17.2 crore
of payables out of** every customer and vendor list, the gradient totals on
those lists, top-customer and top-vendor reports, AR and AP ageing, and the boss
view. It moves to the Group Companies page, which is where 0080 intended it.

That is right for "who are our biggest customers" and wrong for "what does the
balance sheet say we are owed" — the two LLPs are a third of the AR in this
company. **Recommendation: flag them, and keep one ageing report that includes
them**, marked, so nobody reconciles a trial balance against a screen that is
quietly hiding a third of it. That is a small change to
`server/routes/reports.ts`, not a new report.

### 3. Apply the advances — bookkeeping, not modelling

₹14,16,82,989 of customer payments and ₹3,97,80,011 of vendor payments sit
unapplied across the four contacts. Those payments were made against those
invoices and bills; nobody has told niko which. The Apply-credits dialog built
this week does it properly, document by document, and posts no journal because
AP and AR already moved when the payment was recorded.

This is worth doing *after* the merge, so each LLP's advances and its open
documents are on one page while somebody matches them.

**What I would not do without the accountant asking:** contra the AR against
the AP with a journal so that only ₹3.21 crore remains. It is one legal entity
on each side and the net is what will be settled, but that is a set-off entry
with a tax position attached, and it belongs to whoever signs the return.

## Then: who owns which shed

`houses.owner_id` is empty on all six. The schema says "three companies own two
each", and Amino owns no laying house — so P1 and P2 are Amino's (owner stays
NULL, meaning ours), and **two of L2, L3, L4, L5 are Nandamuri's and two are
Luit's**. Which pair is which is not recorded anywhere in the repo. That answer
is what finally lights up the Group Companies page.

## Order of work

1. ~~Add `--apply`, the rename and the address dedupe to
   `scripts/merge-contacts.ts`; dry-run both LLPs.~~ **Done 26 Sep 2026.** The
   dry run caught Luit's pincode disagreement by itself.
2. ~~Merge both on staging.~~ **Done 26 Sep 2026.** 12 rows moved for
   Nandamuri, 9 for Luit; every balance identical afterwards; the two retired
   halves are inactive and hold nothing. Luit's pincode corrected to 784149
   first, so the merge kept the right row.
3. ~~Decision 2, settled 26 Sep 2026: flag them, and keep the group in AR/AP
   ageing, marked, with the market on its own line.~~ The ageing change is
   written; **the flag itself is not set yet** and waits for that code to be
   live, because flagging first would drop the two LLPs out of ageing as well.
4. Set `houses.owner_id` on L2–L5 once the pairing is known, and confirm the
   Group Companies picker lists both LLPs.
5. Apply the advances (decision 3), through the app, by hand.
6. Repeat 1–4 on production as one scripted run, after the Zoho load.
