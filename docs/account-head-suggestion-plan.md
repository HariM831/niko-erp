# Account head suggestion — plan

Status: **built and on staging** (6 Oct 2026). Checks:
`scripts/check-account-suggestions.ts`.

## Results on staging's books (6 Oct 2026)

Every hand-typed line and expense posted from 1 Jul 2026 (611 of them), each
guessed from only what was posted before it:

- History named a head for 233 and was right on 210 (90%). Same vendor, same
  text: 98 of 98. Similar text: 78 of 86. Vendor's usual head: 23 of 35. A
  stricter usual-head bar only lost right answers, so it stays at 3 lines / 80%.
- The model, on a spread of 30 lines history could not answer, was right on
  16. Three of the 30 had gone to heads a bill line may not take (director pay,
  PF), so 16 of 27. Before it was shown examples it managed 4 of 15.
- Petty-cash notes end "ref <name> sir"; those words are dropped before
  matching.

When a bill, purchase order, vendor credit or expense is keyed, niko fills the
account box itself. The person keying sees the head and the reason for it, and
can change it before saving. Nothing posts to a head nobody saw.

## Decisions taken (6 Oct 2026)

| Question | Answer |
|---|---|
| Prefill the box, or suggest beside an empty one? | **Prefill.** |
| History only, or history plus AI? | **History first, AI when history has nothing.** |
| A "usual head" field on vendors? | **No.** The vendor's usual head is worked out from history. |
| Can an expense land in stock? | **Never.** Expenses only offer and suggest expense accounts. |

## Where it applies

- **Bill, Purchase Order, Vendor Credit**: every line in the shared
  transaction form (`client/src/components/transaction-form.tsx`).
- **Expense** (`client/src/pages/expense-new.tsx`): the one Expense Account box.

Not touched: gate receipts and settlements (already automatic through the item),
sales documents, journals, bank-feed categorisation.

## The order a head is chosen in

For each line, the first rule that answers wins:

1. **Already saved.** On edit, a line's saved account is never replaced.
2. **Typed by the user.** Once the user changes the box, nothing overwrites it
   (not later text edits, not a vendor change).
3. **Item.** A line with an item shows the item's head: the stock account if the
   item tracks stock, otherwise its purchase account. This is the rule already in
   `resolveLineAccounts`. The box shows it, but the line is still **sent
   blank**, so the server's item rule stays the only authority. If the item has no
   head, the box says so on the line, not as a save error.
4. **History.** Looked up from what has already posted (below).
5. **AI.** Gemini picks from an allowed list of accounts (below).
6. **Nothing.** The box stays empty and the save asks for it, as it does today.

## History

Source: posted bill lines and vendor credit lines **with no item**, plus posted
expenses, from the last 24 months. Drafts and voids are left out, and so are
accounts that are now inactive. The Zoho-loaded history counts, which gives
useful answers from day one.

Line text is normalised: lower case, digits, punctuation, units and month names
stripped, then split into words.

- Bill line text = line name + description.
- Expense text = Notes. An expense with no notes uses only the vendor rules.

Tried in order:

| # | Match | Reason shown under the box |
|---|---|---|
| H1 | Same vendor, same text | `History · 14 of 15 times for this vendor` |
| H2 | Same vendor, similar text (at least half the words shared) | `History · similar lines from this vendor` |
| H3 | Any vendor, same text, used at least twice | `History · 6 times across vendors` |
| H4 | Vendor's usual head: at least 3 past lines, one head at least 80% | `History · this vendor's usual head` |

Inside a match, the most-used head wins. A tie goes to the most recent.

## AI

Only for lines history could not answer. One Gemini call per request covers all
of them (the same `GEMINI_API_KEY` and flash-lite model the bill reader uses).

Sent: vendor name, line text, HSN/SAC, amount, the allowed accounts as
code + name, and up to 80 past lines from history as worked examples (text →
account), with lines that share words with the request first and then this
vendor's. Without the examples the model chose textbook heads ("Repair &
Maintenance") where the books keep one head per site; see Results below.

Allowed accounts:

- **Expense:** expense-type accounts only.
- **Bill / PO / vendor credit line:** expense and fixed-asset accounts.
  **Never a stock account** (any account an item capitalises into). Stock comes
  only from an item, so a hand-typed line can never fill Feed Stock. Never bank,
  receivable, payable or any tax account; GST is part of the cost.

The model must return one of the ids it was given, plus a short reason. Anything
else is discarded and the box stays empty. Reason shown:
`AI · looks like generator repair`.

There is no AI suggestion for a line that already has an item.

If there is no key, or the call fails or takes longer than 8 s, history still
works and the line stays blank with `No suggestion`.

## When suggestions run

- On leaving the line text field (blur), not on every keystroke.
- Again for untouched suggested lines when the vendor changes, because the
  vendor rules depend on it.
- Never on a saved line when a document is opened for edit.

## API

`POST /api/purchases/account-suggestions`

```
{ docType: "bill" | "purchase_order" | "vendor_credit" | "expense",
  vendorId?: uuid,
  lines: [{ key, text, hsnOrSac?, amount? }] }
→ [{ key, accountId | null, source: "history" | "ai" | null, reason }]
```

Read-only. History runs first on the server, and AI only for the misses.

## Data model

So we can see whether the suggestions are earning their keep, each posted line
and expense records where its head came from:

- `bill_lines`, `purchase_order_lines`, `vendor_credit_lines`, `expenses`:
  - `account_source` — `item | history | ai | user | null`
  - `suggested_account_id` — what niko offered (null when nothing was offered)

`user` with a different `suggested_account_id` means the suggestion was
overridden. A small "Account suggestions" section on the expense/bill reports
can show the hit rate per source later. That report is not part of this build.

No new tables. History is read from posted documents, not kept separately.

## UI

- The box is filled, with a one-line grey reason under it (as in the tables
  above). Changing the box replaces the reason with nothing and marks the line
  `user`.
- The item lines' box keeps today's "Item default" placeholder text, filled
  with the item's head name in grey.
- No accept button and no extra click. A prefilled head saves like a chosen one.

## Edge cases

- **Mixed bill**: item lines use rule 3, typed lines use history/AI; each line
  stands alone.
- **Vendor not chosen yet**: H3 and AI still run; vendor rules wait for the
  vendor.
- **History points to an account that is now a header or inactive**: skipped,
  next rule.
- **Same text, two different heads equally often**: the most recent wins, and the
  reason says `3 of 6`, so the split is visible.
- **Expense whose history used a stock account** (Zoho-era data): that history is
  ignored for expenses.

## Checks

`scripts/check-account-suggestions.ts`, with its own fixtures inside a rolled-back
transaction:

- H1–H4 each fire on the right history, and in that order.
- Saved and user-typed accounts are never replaced.
- An expense is never offered a non-expense head, and a bill line is never
  offered a stock head, from either history or AI. The AI step uses a stubbed
  model that returns a forbidden id and an unknown id; both must be discarded.
- No key / AI failure → history still answers, misses stay blank.

## Deliberately excluded

- A vendor default-account field (decided against).
- Learning tables or embeddings. Plain counts over posted history are enough
  and can be explained line by line.
- Re-heading old documents.
- Sales-side documents.
