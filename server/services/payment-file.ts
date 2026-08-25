import { sql } from "drizzle-orm";
import type { Db, Tx } from "../db";
import { buildXlsx, type Cell, type Sheet } from "../lib/xlsx";

/**
 * What we owe and have not paid, and the bank file that goes out to settle it.
 *
 * Two things sit unpaid in niko: a bill, which is a vendor's invoice for goods
 * we received, and an expense with no paid-through account, which is a charge
 * nobody has settled yet. They reach the bank the same way, so the Payments
 * screen reads them as one list and the file writes them as one batch.
 */

export interface PayableRow {
  kind: "bill" | "expense";
  id: string;
  /** Our own document number — BILL-00012, EXP-00043. */
  number: string;
  /** What the vendor calls it: their bill number, falling back to ours. */
  billNumber: string;
  vendorId: string;
  vendorName: string;
  /** The goods or the cost head — "Item & Desc" on the screen. */
  description: string | null;
  /** Still outstanding: a bill's balance due, an expense's gross amount. */
  amount: string;
  /** When the goods actually arrived, where anything recorded it. */
  deliveryDate: string | null;
  dueDate: string | null;
  overdueDays: number;
  notes: string | null;
  beneficiaryName: string | null;
  bankAccountNumber: string | null;
  bankIfsc: string | null;
  bankName: string | null;
  /** The last batch this document went to the bank in, if any. */
  sentBatchId: string | null;
  sentBatchNumber: string | null;
  sentBatchDate: string | null;
  sentAmount: string | null;
}

/**
 * Everything payable, oldest due first.
 *
 * One row per document rather than one per vendor: a vendor with four bills is
 * four transfers, each carrying its own bill number into the bank's narration,
 * so the remittance a vendor gets back reconciles against a document instead of
 * arriving as one lump they have to unpick.
 *
 * Group companies are not excluded. They are excluded from vendor *lists*
 * because they are not the market, but a payable to one is real money that has
 * to leave the account like anyone else's — the Bills list counts them too.
 */
export async function listPayables(
  conn: Db | Tx,
  opts: { vendorId?: string; includeSent?: boolean } = {},
): Promise<PayableRow[]> {
  const vendorFilter = opts.vendorId ?? null;
  const includeSent = opts.includeSent ?? false;
  const result = await conn.execute(sql`
    WITH payable AS (
      SELECT
        'bill'::text                                   AS kind,
        b.id,
        b.number,
        COALESCE(NULLIF(b.vendor_bill_number, ''), b.number) AS bill_number,
        b.vendor_id,
        (
          SELECT string_agg(
                   l.name || COALESCE(' · ' || NULLIF(l.description, ''), ''),
                   ', ' ORDER BY l.line_order
                 )
          FROM bill_lines l
          WHERE l.bill_id = b.id
        )                                              AS description,
        b.balance_due                                  AS amount,
        COALESCE(
          (SELECT MAX(r.departed_at)::date FROM office_receipts r WHERE r.bill_id = b.id),
          po.expected_delivery_date
        )                                              AS delivery_date,
        b.due_date,
        b.notes
      FROM bills b
      LEFT JOIN purchase_orders po ON po.id = b.purchase_order_id
      WHERE b.status IN ('open', 'partially_paid') AND b.balance_due > 0

      UNION ALL

      SELECT
        'expense'::text                                AS kind,
        e.id,
        e.number,
        COALESCE(NULLIF(e.reference, ''), e.number)    AS bill_number,
        e.vendor_id,
        a.name || COALESCE(' · ' || NULLIF(e.reference, ''), '') AS description,
        (e.amount + e.tax_amount)                      AS amount,
        NULL::date                                     AS delivery_date,
        e.due_date,
        e.notes
      FROM expenses e
      JOIN accounts a ON a.id = e.expense_account_id
      -- No paid-through account means the money has not left yet.
      WHERE e.paid_through_id IS NULL AND e.vendor_id IS NOT NULL
    )
    SELECT
      p.*,
      c.display_name                                   AS vendor_name,
      c.bank_beneficiary_name,
      c.bank_account_number,
      c.bank_ifsc,
      c.bank_name,
      GREATEST(0, (NOW() AT TIME ZONE 'Asia/Kolkata')::date - p.due_date) AS overdue_days,
      sent.batch_id,
      sent.batch_number,
      sent.batch_date,
      sent.sent_amount
    FROM payable p
    JOIN contacts c ON c.id = p.vendor_id
    LEFT JOIN LATERAL (
      SELECT pb.id AS batch_id, pb.number AS batch_number, pb.batch_date, pbl.amount AS sent_amount
      FROM payment_batch_lines pbl
      JOIN payment_batches pb ON pb.id = pbl.batch_id
      WHERE (p.kind = 'bill' AND pbl.bill_id = p.id)
         OR (p.kind = 'expense' AND pbl.expense_id = p.id)
      ORDER BY pb.batch_date DESC, pb.created_at DESC
      LIMIT 1
    ) sent ON TRUE
    WHERE (${vendorFilter}::uuid IS NULL OR p.vendor_id = ${vendorFilter}::uuid)
      AND (${includeSent}::boolean OR sent.batch_id IS NULL)
    ORDER BY p.due_date NULLS LAST, c.display_name, p.number
  `);

  return (result.rows as Array<Record<string, unknown>>).map((r) => ({
    kind: r.kind as "bill" | "expense",
    id: String(r.id),
    number: String(r.number),
    billNumber: String(r.bill_number),
    vendorId: String(r.vendor_id),
    vendorName: String(r.vendor_name),
    description: (r.description as string | null) ?? null,
    amount: String(r.amount),
    deliveryDate: (r.delivery_date as string | null) ?? null,
    dueDate: (r.due_date as string | null) ?? null,
    overdueDays: Number(r.overdue_days ?? 0),
    notes: (r.notes as string | null) ?? null,
    beneficiaryName: (r.bank_beneficiary_name as string | null) ?? null,
    bankAccountNumber: (r.bank_account_number as string | null) ?? null,
    bankIfsc: (r.bank_ifsc as string | null) ?? null,
    bankName: (r.bank_name as string | null) ?? null,
    sentBatchId: (r.batch_id as string | null) ?? null,
    sentBatchNumber: (r.batch_number as string | null) ?? null,
    sentBatchDate: (r.batch_date as string | null) ?? null,
    sentAmount: r.sent_amount === null || r.sent_amount === undefined ? null : String(r.sent_amount),
  }));
}

/**
 * Which rail the bank should use.
 *
 * A credit to an account at the same bank is an internal transfer — SBI's file
 * calls it DCR — and costs nothing; anything else goes out over NEFT. The IFSC
 * says which, since its first four characters are the bank.
 */
export function transferMode(ifsc: string, payerIfsc: string | null): "DCR" | "NEFT" {
  const bankOf = (code: string) => code.trim().slice(0, 4).toUpperCase();
  if (!payerIfsc) return "NEFT";
  return bankOf(ifsc) === bankOf(payerIfsc) ? "DCR" : "NEFT";
}

export interface PaymentFileLine {
  beneficiaryName: string;
  accountNumber: string;
  ifsc: string;
  amount: string;
  transferMode: string;
  remarks: string | null;
}

export interface PaymentFilePayer {
  /** Our customer code with the bank — SBI's "Cus Code". */
  customerCode: string | null;
  /** The account name the bank holds for us. */
  customerName: string;
  accountNumber: string | null;
}

/**
 * The bank's own column order. Changing it changes what their parser reads, so
 * it is written out here once rather than assembled from anything clever.
 */
const HEADERS = [
  "SL No",
  "Cus Code",
  "Customer Name",
  "Customer AC No",
  "DCR/NEFT",
  "Date",
  "Beneficiary Name",
  "Account Number",
  "IFSC Code",
  "Amount",
  "Payment Instruction\nBeneficiary Name",
];

/** Widths from the bank's template, so the file opens looking like theirs. */
const WIDTHS = [5.7, 10.1, 24.6, 17.2, 9.3, 10.7, 27.9, 17.8, 13, 10.9, 17.1];

/**
 * Render a batch as the bank's upload sheet.
 *
 * Account numbers, the customer code and the IFSC all go out as text: they are
 * identifiers that happen to be digits, and a spreadsheet that reads
 * 00000044656290967 as a number hands the bank 44656290967.
 */
export function buildPaymentSheet(args: {
  payer: PaymentFilePayer;
  batchDate: string;
  lines: PaymentFileLine[];
}): Sheet {
  const header: Cell[] = HEADERS.map((h) => ({ value: h, style: "header" }));
  const rows: Cell[][] = [header];

  args.lines.forEach((line, i) => {
    rows.push([
      { value: i + 1, style: "number" },
      { value: args.payer.customerCode, style: "text" },
      { value: args.payer.customerName },
      { value: args.payer.accountNumber, style: "text" },
      { value: line.transferMode },
      { value: args.batchDate, style: "date" },
      { value: line.beneficiaryName },
      { value: line.accountNumber, style: "text" },
      { value: line.ifsc, style: "text" },
      { value: Number(line.amount), style: "money" },
      { value: line.remarks },
    ]);
  });

  return { name: "Sheet1", columnWidths: WIDTHS, rows };
}

export function buildPaymentFile(args: Parameters<typeof buildPaymentSheet>[0]): Buffer {
  return buildXlsx(buildPaymentSheet(args));
}
