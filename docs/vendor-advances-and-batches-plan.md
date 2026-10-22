# Vendor Sheet: advances, and Sent to bank by batch

Planned and built 22 Oct 2026; on staging (5dff4ea) and production (57d2f7c).
`scripts/check-vendor-advances.ts` passes there, rolled back. On staging the
same day, `scripts/move-vendor-advances.ts --commit` moved 23 payments,
Rs 71,21,378, from payables to Vendor Advances; on production, 39 payments,
Rs 1,48,66,613.

## What was decided

| Question | Answer |
|---|---|
| Is every advance against a purchase order? | **Yes, always a PO.** A service with no PO needs one raised first. |
| Where does the proforma live? | **Attached to the advance request** (its number, date, and the file through the one attachments mechanism). No proforma document type. |
| How does a paid advance post? | **Vendor Advances**, until a bill uses it, the way customer advances work on the sales side. |
| Approval before sending? | **None.** Anyone with access to the Vendor Sheet can send. |
| Does Send to bank download the file? | **No.** Send only creates the batch; the file is downloaded from Sent to bank. |
| How is the payment recorded once the bank confirms? | **Mark paid on the batch**: one vendor payment per live transfer. |

## The page: three tabs

**To pay**: bills and unpaid expenses, by vendor, as now. Send to bank creates
a batch and moves its rows off the list; nothing downloads.

**Advances** (new): open advance requests, by vendor, with their PO number,
proforma number and date, amount, and the vendor's bank details. They are ticked
and sent like bills, and can go in the same batch as bills. **New advance**
starts from a PO.

**Sent to bank** (reworked): one row per batch, newest first, with number,
value date, paying account, transfers, total, sent by, and status
(Sent / Paid / Cancelled), and **Download file** on the row itself: the bank's
upload sheet for that batch, any number of times (`GET /payment-batches/:id/file`
already exists).

Clicking a row opens a **pop-up** for that batch:
- the batch's header and total;
- every bill, expense and advance in it: vendor, document number (vendor bill
  number, expense number, or PO and proforma for an advance), description, delivery
  or due date, amount, and the beneficiary, account, IFSC and transfer mode that
  went out;
- cancelled transfers greyed, with why;
- a link from each document to the bill, expense or PO;
- the actions: **Download file**, **Mark paid**, **Cancel batch**, and
  **Cancel transfer** on ticked lines that bounced. A cancelled line's document
  goes back to To pay or Advances.

## The advance request

A new table, `vendor_advance_requests`:
- the PO (required) and its vendor;
- the amount, which can be part of the PO;
- the proforma's number and date;
- notes, who raised it and when;
- status: open, sent, paid or cancelled;
- the vendor payment it became, once paid.

The proforma goes on it as an attachment, `entity_type = 'vendor_advance_request'`.

Raised from a **Request advance** button on the PO, or **New advance** on the
Advances tab. It is refused when:
- the PO is draft, cancelled or fully billed;
- the amount is not positive;
- the open and paid advances on the PO would come to more than the PO's total.

Cancelling a request (if it is not in a live batch) keeps the record, marked.

`payment_batch_lines` gets a third target, `advance_request_id`, alongside
`bill_id` and `expense_id`, with exactly one of the three set. The remark the
vendor sees is the proforma number, or the PO number when there is none.

## Mark paid

From a batch on Sent to bank, Mark paid records one vendor payment for each
live transfer. It is dated the batch's value date (which can be changed in the
dialog) and paid from the batch's paying account:
- **bill**: a payment applied to that bill, as Record Payment does today;
- **expense**: the paid-through account is set to the paying bank;
- **advance**: a payment with nothing applied, all unapplied, linked to the
  request; the request becomes paid.

It is all or nothing for the batch. A line whose bill has since been paid some
other way stops the run and names it; that line can be cancelled first. A
paid batch cannot be cancelled. Undoing it means deleting its payments, as
anywhere else.

## Bill arrives for a PO with a paid advance

On the bill, the PO's paid advances are shown first in Apply Credits (which
already exists: `/bills/:id/apply-credits`), already proposed against the bill.
To pay shows only the remainder. Nothing is applied without someone pressing
Apply.

## Accounting: one convention for vendor advances

Today, a niko vendor payment debits **payables** for the whole amount, while a
payment loaded from Zoho debits **Vendor Advances** for its unapplied part
(see `server/services/payment-ledger.ts`). That changes to one convention:
- a niko vendor payment debits payables for what it applies, and Vendor
  Advances for what it leaves unapplied;
- `positionOf` treats every vendor payment the way it treats an imported one
  now, so a later Apply Credits or dissociate moves money between Vendor
  Advances and payables by exactly the change, dated that day, tied to the
  payment (the rule of 22 Oct 2026).

**Existing niko payments with an unapplied part** get a one-off entry, dated
the day it runs: DR Vendor Advances / CR payables, for each payment's unapplied
amount. Earlier journals are left as they are. The script is a dry run by
default and lists every payment and amount first. Afterwards it runs
`check-document-balances`, `check-control-accounts --account ap` and
`fix-control-drift`, expecting payables to agree.

**Checked 22 Oct 2026:** `vendor_advances` is 1095 Prepaid Expenses, an asset,
on both staging and production (the seed's 2130 is not what either carries).

## Build order

1. Migration: `vendor_advance_requests`; `payment_batch_lines.advance_request_id`
   and its check that exactly one target is set; a status on the batch (sent,
   paid or cancelled) with who and when.
2. Vendor payment posting moves to the Vendor Advances convention, plus the
   one-off script for existing payments (staging first).
3. Server: advance request create, list and cancel; batch create takes
   advances and no longer returns the file; Mark paid.
4. Page: the Advances tab; Sent to bank listed by batch with Download, Mark
   paid and Cancel; Request advance on the PO.
5. Bill: the PO's advances first in Apply Credits.
6. A check script with its own fixtures, inside a rolled-back transaction:
   request, send, mark paid, bill, apply. It expects payables, Vendor Advances
   and the documents to agree at every step.

Staging first, then production on request.
