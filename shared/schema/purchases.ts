import {
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
  purchaseOrderStatus,
} from "./enums";
import { contacts } from "./contacts";
import { items } from "./items";
import { taxes } from "./core";
import { users } from "./auth";
import { accounts, journalEntries } from "./accounting";
import { bankAccounts } from "./banking";

const money = (name: string) => numeric(name, { precision: 14, scale: 2 });
const qty = (name: string) => numeric(name, { precision: 14, scale: 3 });

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
});

export const bills = pgTable(
  "bills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    number: varchar("number", { length: 30 }).notNull().unique(),
    /** Vendor's own bill/invoice number. */
    vendorBillNumber: text("vendor_bill_number"),
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
  paidThroughId: uuid("paid_through_id")
    .notNull()
    .references(() => bankAccounts.id),
  vendorId: uuid("vendor_id").references(() => contacts.id),
  amount: money("amount").notNull(),
  taxId: uuid("tax_id").references(() => taxes.id),
  taxAmount: money("tax_amount").notNull().default("0"),
  isTaxInclusive: integer("is_tax_inclusive").notNull().default(0),
  reference: text("reference"),
  notes: text("notes"),
  journalEntryId: uuid("journal_entry_id").references(() => journalEntries.id),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
