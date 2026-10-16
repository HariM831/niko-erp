# Banking: match and categorize to a customer or vendor — plan

Status: **built, on staging** (16 Oct 2026). Checks: `scripts/check-bank-links.ts`.

## Decisions taken (16 Oct 2026)

| Question | Answer |
|---|---|
| Receipts after 16 Sep that are in Zoho only | **Keyed from the statement** (categorized here); the Zoho catch-up never loads them. |
| Several transactions on one line | **Now.** |
| Suggest the party from the statement text | **Yes**, at the top of the picker, never chosen for anyone. |
| Customer Advance as its own type | **Yes**, as Zoho. |

## What Zoho does (read on Amino's own Zoho org, 16 Oct 2026)

- Uncategorized line → pane with two tabs: **Match Transactions** and
  **Categorize Manually**.
- **Match** lists "possible matches": transactions already in the books on
  this bank account, same side, amount and date close. Lines with an exact one
  carry a **Match found** tag. More than one can be selected; Match is allowed
  once they add up to the line. A filter searches by amount range, date range,
  customer/vendor, type and reference.
- **Categorize Manually** offers the same types as Add Transaction:
  - Money in: Customer Advance, Customer Payment, Transfer From Another
    Account, Interest Income, Other Income, Expense Refund, Owner's
    Contribution, Vendor Credit Refund, Vendor Payment Refund.
  - Money out: Expense, Vendor Advance, Vendor Payment, Transfer To Another
    Account, Card Payment, Owner Drawings, Credit Note Refund, Payment Refund,
    Employee Reimbursement.
- Customer Payment pane: Customer, Amount Received, Bank Charges, Date,
  Payment #, Reference#, Received Via, Description; once a customer is picked,
  their **unpaid invoices** to apply against. Vendor Payment pane: Vendor,
  Amount, Date, Reference#, Paid Via, Description. Expense pane: Expense
  Account, Amount, Vendor, Tax, Invoice#, Description.
- Uncategorize **deletes** the transaction the categorize created; Unmatch
  only unlinks it.

How Amino actually uses it, on the SBI CC account: every deposit is a
**Customer Advance** to a named customer, nearly every withdrawal a **Vendor
Payment** to a named vendor, the rest straight to an expense head (bank
charges, wages, directors' remuneration).

## What niko has today

- Categorize posts a two-line journal to one chosen account. No customer or
  vendor, so it never reaches a ledger. Accounts Receivable is offered and
  would leave money in AR against nobody.
- Match accepts one journal entry and checks the bank line, side and amount.
  The picker lists every journal, unfiltered.
- Unmatch only unlinks. On a categorized line that leaves the categorize
  journal standing, so categorizing again posts twice. **Bug, fix in this work.**
- Payments Received and Payments Made exist (`/api/sales/payments`,
  `/api/purchases/payments`). A receipt with nothing applied already goes to
  Customer Advances, so niko's Customer Payment covers Zoho's Customer Advance.
  The posting sits inline in the route handlers and has to be lifted into
  functions that take a transaction.

## The 7 Oct SBI CC statement: match, don't categorize

All 11 deposits on the statement are already Zoho customer payments on SBI
CC (CP-2026-27/1444 to /1454, same amounts, same UTRs). They sit in the local
catch-up dump (`.zoho-catchup/customerpayments.jsonl`, refreshed 16 Oct).

On niko production (read 16 Oct): Zoho's CP series stops at 16 Sep, the load.
Since then niko has its own PMT series (110 receipts), but only 2 on SBI CC
in 9–15 Oct against dozens in Zoho. For the 7 Oct statement:

- NB Traders ₹2,62,013 and DG Egg Point ₹2,92,470 are in niko as PMT-00111
  and PMT-00110, **dated 8 Oct**, keyed in niko. Match them (a day out, so
  the window must not be same-day only).
- The other 9 deposits are in Zoho only. If the catch-up later loads
  CP-1444 to /1454, a receipt categorized here now would be there twice.
- No withdrawal on the statement has anything in niko.

So the first thing to build is **Match**, and Categorize is for lines with
nothing to match. Whether the office keeps keying receipts in Zoho needs
settling before anyone categorizes these.

## Proposed build

1. **Possible matches** (server): for a line, the posted journals with a line
   on this bank's GL account, same side, same amount, within ±7 days, not
   already matched. Each shows its type (Customer Payment, Vendor Payment,
   Expense, Journal…), number, contact name, date and reference. Exact amount
   + same date + same UTR ranks first. The Uncategorized list shows
   **Match found** where there is exactly one.
2. **Match pane** (client): Zoho's pane in place of today's row panel, with
   tabs Match Transactions / Categorize Manually. Select one or several;
   Match is enabled when they add up to the line. Several journals on one line
   needs a link table (line → journals) in place of the single
   `matched_journal_entry_id`.
3. **Categorize Manually**, with Zoho's type dropdown. First pass:
   - Customer Payment: customer, unpaid invoices to apply, the rest to
     advance. Creates a real Payment Received.
   - Vendor Payment: vendor, open bills to apply. Creates a real Payment Made.
   - Expense: expense account (with the existing head suggestion), vendor
     optional. Creates a real Expense.
   - Transfer to/from another account.
   - Any other type posts to a chosen account, as today, with Accounts
     Receivable and Accounts Payable taken out of the picker.

   Date, amount, bank account and reference are filled from the line and
   locked. Each posts and links in one transaction.
4. **Suggest the party.** Read the line for a name the books hold (CHOWDHURY
   AND SONS → Chowdhury n Sons) or an account number on a contact's bank
   details, and offer it at the top of the picker. Never picked on its own.
5. **Uncategorize** deletes what categorize created (the payment, expense or
   journal) and frees the line; **Unmatch** only unlinks.

Group companies stay out of the pickers, as everywhere else.

## Questions for the user

1. Is the Zoho catch-up already loaded onto production, so the 7 Oct receipts
   are in niko to match? (I'm not allowed to read production.)
2. Several journals on one line (Zoho's multi-select): now, or later?
3. Party suggestion from the statement text: in this round, or later?
4. Customer Advance as its own item in the dropdown, as Zoho has it, or only
   Customer Payment (an unapplied receipt is already an advance in niko)?
