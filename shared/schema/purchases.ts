import {
  boolean,
  date,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import {
  billStatus,
  creditNoteStatus,
  paymentMode,
  freightBasis,
  purchaseOrderStatus,
  vendorAdvanceStatus,
} from "./enums";
import { contacts } from "./contacts";
import { items } from "./items";
import { taxes } from "./core";
import { users } from "./auth";
import { accounts, journalEntries } from "./accounting";
import { bankAccounts } from "./banking";

const money = (name: string) => numeric(name, { precision: 14, scale: 2 });
const qty = (name: string) => numeric(name, { precision: 14, scale: 3 });

/**
 * Where a line's account head came from, and what niko offered for it
 * (docs/account-head-suggestion-plan.md). `user` beside a different suggested
 * head means the suggestion was overridden; null on anything keyed before
 * suggestions existed, or written by a program rather than a person.
 */
const headSourceColumns = {
  accountSource: varchar("account_source", { length: 10 }).$type<AccountSource>(),
  suggestedAccountId: uuid("suggested_account_id").references(() => accounts.id),
};

export const ACCOUNT_SOURCES = ["item", "history", "ai", "user"] as const;
export type AccountSource = (typeof ACCOUNT_SOURCES)[number];

const lineColumns = {
  itemId: uuid("item_id").references(() => items.id),
  /** Expense/COGS/asset account this line posts to (item default or override). */
  accountId: uuid("account_id").references(() => accounts.id),
  name: text("name").notNull(),
  description: text("description"),
  hsnOrSac: varchar("hsn_or_sac", { length: 10 }),
  quantity: qty("quantity").notNull().default("1"),
  unit: varchar("unit", { length: 20 }),
  /**
   * Unit price, to six decimals. Feed is priced per kilo to fractions of a
   * paisa — Zoho carries rates like 24.813751 — and rounding that to paise
   * makes a 393,440 kg line read 1,992 rupees away from its own amount.
   */
  rate: numeric("rate", { precision: 18, scale: 6 }).notNull().default("0"),
  discountPercent: numeric("discount_percent", { precision: 6, scale: 3 })
    .notNull()
    .default("0"),
  taxId: uuid("tax_id").references(() => taxes.id),
  taxAmount: money("tax_amount").notNull().default("0"),
  amount: money("amount").notNull().default("0"),
  lineOrder: integer("line_order").notNull().default(0),
  ...headSourceColumns,
};

const totalsColumns = {
  subTotal: money("sub_total").notNull().default("0"),
  discountTotal: money("discount_total").notNull().default("0"),
  cgst: money("cgst").notNull().default("0"),
  sgst: money("sgst").notNull().default("0"),
  igst: money("igst").notNull().default("0"),
  /** See the note on the sales side: a typed correction, not derived rounding. */
  adjustment: money("adjustment").notNull().default("0"),
  adjustmentAccountId: uuid("adjustment_account_id").references(() => accounts.id),
  adjustmentDescription: text("adjustment_description"),
  roundOff: money("round_off").notNull().default("0"),
  total: money("total").notNull().default("0"),
};

export const purchaseOrders = pgTable("purchase_orders", {
  id: uuid("id").primaryKey().defaultRandom(),
  number: varchar("number", { length: 30 }).notNull().unique(),
  vendorId: uuid("vendor_id")
    .notNull()
    .references(() => contacts.id),
  status: purchaseOrderStatus("status").notNull().default("draft"),
  orderDate: date("order_date").notNull(),
  expectedDeliveryDate: date("expected_delivery_date"),
  reference: text("reference"),
  ...totalsColumns,
  notes: text("notes"),
  termsAndConditions: text("terms_and_conditions"),
  /**
   * Freight we pay the transporter for this order's trucks, as agreed with
   * the vendor: so much a ton on the kilos they bill, or a lump sum a truck.
   * Charged to the material's cost when each truck is settled (22 Oct 2026).
   */
  freightBasis: freightBasis("freight_basis").notNull().default("none"),
  freightRate: numeric("freight_rate", { precision: 14, scale: 2 }).notNull().default("0"),
  /**
   * Over-delivery allowed on this order beyond the org-wide allowance, set by a
   * purchase manager (at most 5%), with who, when and why (3 Oct 2026).
   */
  extraAllowancePct: numeric("extra_allowance_pct", { precision: 5, scale: 2 }).notNull().default("0"),
  extraAllowanceReason: text("extra_allowance_reason"),
  extraAllowanceBy: uuid("extra_allowance_by").references(() => users.id),
  extraAllowanceAt: timestamp("extra_allowance_at", { withTimezone: true }),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const purchaseOrderLines = pgTable("purchase_order_lines", {
  id: uuid("id").primaryKey().defaultRandom(),
  purchaseOrderId: uuid("purchase_order_id")
    .notNull()
    .references(() => purchaseOrders.id, { onDelete: "cascade" }),
  ...lineColumns,
  /** Quantity already billed against this line (PO→bill conversion tracking). */
  billedQuantity: qty("billed_quantity").notNull().default("0"),
  /**
   * Quantity the vendor has actually delivered against this line — whatever we
   * then did with it.
   *
   * The vendor discharges the order by sending the vehicle. Rejecting the load
   * at QC, or unloading only part of it, is our decision about quality and
   * about what to pay; it does not revive their obligation to deliver more. So
   * this rises by the full quantity sent, while billedQuantity rises only by
   * what reached a bill. The two answer different questions and must never be
   * conflated: this one says whether the order is finished, that one says how
   * much we have been invoiced for.
   */
  deliveredQuantity: qty("delivered_quantity").notNull().default("0"),
});

export const bills = pgTable(
  "bills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    number: varchar("number", { length: 30 }).notNull().unique(),
    /** Vendor's own bill/invoice number. */
    vendorBillNumber: text("vendor_bill_number"),
    /**
     * The grand total the vendor printed, before anything we deducted.
     *
     * Our own total is what we owe — their figure less short weight — so it is
     * never the number on the paper somebody is holding when they ring up about
     * a bill. Kept so it can be searched on, and shown on the document beside
     * their bill number.
     */
    vendorBillTotal: numeric("vendor_bill_total", { precision: 14, scale: 2 }),
    vendorId: uuid("vendor_id")
      .notNull()
      .references(() => contacts.id),
    status: billStatus("status").notNull().default("draft"),
    billDate: date("bill_date").notNull(),
    dueDate: date("due_date").notNull(),
    reference: text("reference"),
    purchaseOrderId: uuid("purchase_order_id").references(() => purchaseOrders.id),
    ...totalsColumns,
    /**
     * Third-party carriage on this consignment. It never touches this vendor's
     * payable — it is expensed on its own journal entry (freightJournalEntryId)
     * and only allocated across lines for costing, to show the true landed cost.
     */
    freightAmount: money("freight_amount").notNull().default("0"),
    /** The transporter (a vendor contact); who we owe the freight to. */
    freightVendorId: uuid("freight_vendor_id").references(() => contacts.id),
    /** Expense account the freight is charged to. */
    freightAccountId: uuid("freight_account_id").references(() => accounts.id),
    /** The freight's own journal entry, separate from the goods entry. */
    freightJournalEntryId: uuid("freight_journal_entry_id").references(() => journalEntries.id),
    tdsAmount: money("tds_amount").notNull().default("0"),
    tdsSection: varchar("tds_section", { length: 12 }),
    balanceDue: money("balance_due").notNull().default("0"),
    notes: text("notes"),
    journalEntryId: uuid("journal_entry_id").references(() => journalEntries.id),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [index("ix_bills_vendor").on(t.vendorId), index("ix_bills_date").on(t.billDate)],
);

export const billLines = pgTable("bill_lines", {
  id: uuid("id").primaryKey().defaultRandom(),
  billId: uuid("bill_id")
    .notNull()
    .references(() => bills.id, { onDelete: "cascade" }),
  ...lineColumns,
  /** This line's share of the bill's freight, allocated by line value. */
  allocatedFreight: money("allocated_freight").notNull().default("0"),
  /** (line amount + allocated freight) / quantity — the true per-unit cost. */
  landedUnitCost: money("landed_unit_cost").notNull().default("0"),
  /**
   * Which deduction rule produced this line, where the line is a NEGATIVE
   * deduction rather than goods.
   *
   * Office settles a truck as one bill: the goods at what the vendor
   * invoiced, then a negative line for each thing we are not paying for. The
   * vendor never countersigns a credit note, so a second document bought
   * nothing a line on this one does not — and the bill's own goods line still
   * ties to their invoice figure for figure, with the difference explained one
   * row below it.
   *
   * Not a foreign key: office's schema imports this file, so pointing at
   * deduction_rules would close a cycle. Null on goods and on a figure somebody
   * typed by hand.
   */
  ruleId: uuid("rule_id"),
  ruleVersion: integer("rule_version"),
});

export const vendorPayments = pgTable("vendor_payments", {
  id: uuid("id").primaryKey().defaultRandom(),
  number: varchar("number", { length: 30 }).notNull().unique(),
  vendorId: uuid("vendor_id")
    .notNull()
    .references(() => contacts.id),
  paymentDate: date("payment_date").notNull(),
  amount: money("amount").notNull(),
  unappliedAmount: money("unapplied_amount").notNull().default("0"),
  mode: paymentMode("mode").notNull().default("bank_transfer"),
  reference: text("reference"),
  bankAccountId: uuid("bank_account_id").references(() => bankAccounts.id),
  tdsAmount: money("tds_amount").notNull().default("0"),
  notes: text("notes"),
  journalEntryId: uuid("journal_entry_id").references(() => journalEntries.id),
  /**
   * Whether the unapplied part sits in Vendor Advances rather than inside
   * payables. True for everything from Zoho and everything niko raises since
   * 22 Oct 2026; false only for niko's older payments until
   * scripts/move-vendor-advances.ts moves them (services/payment-ledger.ts).
   */
  advancesInLedger: boolean("advances_in_ledger").notNull().default(false),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const vendorPaymentApplications = pgTable("vendor_payment_applications", {
  id: uuid("id").primaryKey().defaultRandom(),
  paymentId: uuid("payment_id")
    .notNull()
    .references(() => vendorPayments.id, { onDelete: "cascade" }),
  billId: uuid("bill_id")
    .notNull()
    .references(() => bills.id),
  amountApplied: money("amount_applied").notNull(),
});

/**
 * Money a vendor sent back out of an advance — Zoho's Refund on a Payment Made.
 *
 * It comes off what the payment has spare (unapplied_amount is net of every
 * refund), and its journal — DR the bank it came into, CR Vendor Advances (or
 * payables, for a payment from before 22 Oct 2026 still holding its advance
 * there) — is sourced to the payment, so services/payment-ledger.ts sees the
 * advance and its postings move together.
 */
export const vendorPaymentRefunds = pgTable(
  "vendor_payment_refunds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    paymentId: uuid("payment_id")
      .notNull()
      .references(() => vendorPayments.id),
    refundDate: date("refund_date").notNull(),
    amount: money("amount").notNull(),
    /** Where the money came back to; null where Zoho put it in Undeposited Funds. */
    bankAccountId: uuid("bank_account_id").references(() => bankAccounts.id),
    reference: text("reference"),
    notes: text("notes"),
    journalEntryId: uuid("journal_entry_id").references(() => journalEntries.id),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("ix_vpr_payment").on(t.paymentId)],
);

export const vendorCredits = pgTable("vendor_credits", {
  id: uuid("id").primaryKey().defaultRandom(),
  number: varchar("number", { length: 30 }).notNull().unique(),
  vendorId: uuid("vendor_id")
    .notNull()
    .references(() => contacts.id),
  status: creditNoteStatus("status").notNull().default("draft"),
  creditDate: date("credit_date").notNull(),
  reference: text("reference"),
  billId: uuid("bill_id").references(() => bills.id),
  ...totalsColumns,
  balance: money("balance").notNull().default("0"),
  notes: text("notes"),
  journalEntryId: uuid("journal_entry_id").references(() => journalEntries.id),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const vendorCreditLines = pgTable("vendor_credit_lines", {
  id: uuid("id").primaryKey().defaultRandom(),
  vendorCreditId: uuid("vendor_credit_id")
    .notNull()
    .references(() => vendorCredits.id, { onDelete: "cascade" }),
  ...lineColumns,
  /**
   * Which deduction rule charged this line, and which version of it.
   *
   * The credit note already explains its own arithmetic in prose, which is what
   * a vendor querying a figure actually needs. This is the other half: it makes
   * the link answerable by query rather than by reading, so a rule can be asked
   * what it has cost and a version can be retired knowing what it charged.
   *
   * Deliberately not a foreign key. `shared/schema/office.ts` imports this
   * file, so pointing back at `deduction_rules` would close a cycle — the same
   * reason `office_receipt_lines.qc_spec_id` is a bare uuid. Null on a
   * deduction somebody typed by hand, which is the honest record of that.
   */
  ruleId: uuid("rule_id"),
  ruleVersion: integer("rule_version"),
});

export const vendorCreditApplications = pgTable("vendor_credit_applications", {
  id: uuid("id").primaryKey().defaultRandom(),
  vendorCreditId: uuid("vendor_credit_id")
    .notNull()
    .references(() => vendorCredits.id, { onDelete: "cascade" }),
  billId: uuid("bill_id")
    .notNull()
    .references(() => bills.id),
  amountApplied: money("amount_applied").notNull(),
});

/** Direct expense (no bill) — Zoho "Expenses". */
export const expenses = pgTable("expenses", {
  id: uuid("id").primaryKey().defaultRandom(),
  number: varchar("number", { length: 30 }).notNull().unique(),
  expenseDate: date("expense_date").notNull(),
  expenseAccountId: uuid("expense_account_id")
    .notNull()
    .references(() => accounts.id),
  /**
   * The account the money left, or null while it has not left yet.
   *
   * Most expenses are entered after the fact — somebody paid for diesel and
   * the entry records which account it came out of. But a bill is not the only
   * thing that can sit unpaid: a vendor's charge with no goods behind it is
   * still owed, and pretending the bank was credited on the day it was typed
   * puts money in the ledger that is still in the account. So a null here
   * means unpaid: the journal credits Accounts Payable instead of a bank, the
   * expense shows on the Payments screen with the unpaid bills, and setting
   * this later re-posts it against the account that actually paid.
   */
  paidThroughId: uuid("paid_through_id").references(() => bankAccounts.id),
  vendorId: uuid("vendor_id").references(() => contacts.id),
  amount: money("amount").notNull(),
  taxId: uuid("tax_id").references(() => taxes.id),
  taxAmount: money("tax_amount").notNull().default("0"),
  isTaxInclusive: integer("is_tax_inclusive").notNull().default(0),
  /** When an unpaid expense falls due. Null once it is paid, or on entry with no term. */
  dueDate: date("due_date"),
  reference: text("reference"),
  notes: text("notes"),
  ...headSourceColumns,
  journalEntryId: uuid("journal_entry_id").references(() => journalEntries.id),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/**
 * One upload to the bank: the rows of a bulk-transfer file, as they were sent.
 *
 * A batch is a record of an instruction, not of a payment. The money has not
 * moved when this row is written — the file has merely been handed to the
 * bank, and the bank may still reject a line for a stale IFSC or a closed
 * account. So nothing here touches the ledger and nothing here marks a bill
 * paid; the batch exists so the same bill is not sent twice on Tuesday and
 * again on Wednesday, and so the file that went out can be re-read months
 * later when a vendor asks what we sent.
 *
 * The payment itself is recorded the usual way, once the bank confirms it:
 * a vendor payment against the bill, or the paid-through account filled in on
 * the expense.
 */
export const paymentBatches = pgTable("payment_batches", {
  id: uuid("id").primaryKey().defaultRandom(),
  number: varchar("number", { length: 30 }).notNull().unique(),
  /** Value date on the instruction — what goes in the file's Date column. */
  batchDate: date("batch_date").notNull(),
  /** The account the bank is told to debit. */
  bankAccountId: uuid("bank_account_id")
    .notNull()
    .references(() => bankAccounts.id),
  total: money("total").notNull().default("0"),
  notes: text("notes"),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  /**
   * Cancelled: the file was raised in error or never went. Every line is
   * cancelled with it, so its documents are back on To pay. Kept, not deleted.
   */
  cancelledAt: timestamp("cancelled_at"),
  cancelledBy: uuid("cancelled_by").references(() => users.id),
  cancelReason: text("cancel_reason"),
  /**
   * Paid: the bank confirmed the file and every live transfer in it was
   * recorded as a vendor payment (or the expense marked paid) on `paidOn`.
   */
  paidAt: timestamp("paid_at"),
  paidBy: uuid("paid_by").references(() => users.id),
  paidOn: date("paid_on"),
});

/**
 * Money asked for against a purchase order before its bill — the vendor sent a
 * proforma and wants paying first.
 *
 * Always against a PO, so the bill that follows on the same order can find it.
 * The proforma itself is an attachment on this row (entity
 * "vendor_advance_request"); there is no proforma document. It goes to the bank
 * in a batch like a bill does, and Mark paid turns it into a vendor payment
 * with nothing applied, held in Vendor Advances until the bill takes it.
 * Whether it is in a live batch is read from payment_batch_lines, as it is for
 * a bill, so the status here is only open, paid or cancelled.
 */
export const vendorAdvanceRequests = pgTable(
  "vendor_advance_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    number: varchar("number", { length: 30 }).notNull().unique(),
    purchaseOrderId: uuid("purchase_order_id")
      .notNull()
      .references(() => purchaseOrders.id),
    vendorId: uuid("vendor_id")
      .notNull()
      .references(() => contacts.id),
    amount: money("amount").notNull(),
    proformaNumber: text("proforma_number"),
    proformaDate: date("proforma_date"),
    notes: text("notes"),
    status: vendorAdvanceStatus("status").notNull().default("open"),
    /** The payment it became once paid. */
    vendorPaymentId: uuid("vendor_payment_id").references(() => vendorPayments.id),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    cancelledAt: timestamp("cancelled_at"),
    cancelledBy: uuid("cancelled_by").references(() => users.id),
    cancelReason: text("cancel_reason"),
  },
  (t) => [index("ix_var_po").on(t.purchaseOrderId), index("ix_var_payment").on(t.vendorPaymentId)],
);

/**
 * One transfer in a batch — one row of the file.
 *
 * The beneficiary's name, account and IFSC are copied rather than joined:
 * they are what was actually sent to the bank that day, and a vendor whose
 * account changes next month must not rewrite the history of a transfer that
 * already succeeded or failed on the old one.
 */
export const paymentBatchLines = pgTable(
  "payment_batch_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => paymentBatches.id, { onDelete: "cascade" }),
    /** Exactly one of these is set — the document being paid. */
    billId: uuid("bill_id").references(() => bills.id),
    expenseId: uuid("expense_id").references(() => expenses.id),
    advanceRequestId: uuid("advance_request_id").references(() => vendorAdvanceRequests.id),
    vendorId: uuid("vendor_id")
      .notNull()
      .references(() => contacts.id),
    amount: money("amount").notNull(),
    beneficiaryName: text("beneficiary_name").notNull(),
    accountNumber: varchar("account_number", { length: 30 }).notNull(),
    ifsc: varchar("ifsc", { length: 11 }).notNull(),
    /** "DCR" for an in-bank credit, "NEFT" for anything else. */
    transferMode: varchar("transfer_mode", { length: 8 }).notNull(),
    /** What the vendor sees against the credit — the document number. */
    remarks: text("remarks"),
    lineOrder: integer("line_order").notNull().default(0),
    /**
     * This one transfer will not happen — the bank bounced it, or it was taken
     * out before upload. The document counts as unsent again.
     */
    cancelledAt: timestamp("cancelled_at"),
    cancelledBy: uuid("cancelled_by").references(() => users.id),
    cancelReason: text("cancel_reason"),
    /** The vendor payment Mark paid recorded for it (none for an expense). */
    vendorPaymentId: uuid("vendor_payment_id").references(() => vendorPayments.id),
    /**
     * When Mark paid put this transfer in the books. Deleting the payment it
     * made clears it, and the batch is waiting again.
     */
    recordedAt: timestamp("recorded_at"),
  },
  (t) => [
    index("ix_pbl_batch").on(t.batchId),
    index("ix_pbl_bill").on(t.billId),
    index("ix_pbl_expense").on(t.expenseId),
    index("ix_pbl_advance").on(t.advanceRequestId),
  ],
);
