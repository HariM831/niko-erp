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
import { creditNoteStatus, invoiceStatus, paymentMode } from "./enums";
import { contacts } from "./contacts";
import { items } from "./items";
import { taxes } from "./core";
import { users } from "./auth";
import { accounts, journalEntries } from "./accounting";
import { bankAccounts } from "./banking";

const money = (name: string) => numeric(name, { precision: 14, scale: 2 });
const qty = (name: string) => numeric(name, { precision: 14, scale: 3 });

/** Columns shared by every transaction line (Zoho line-item grid). */
const lineColumns = {
  itemId: uuid("item_id").references(() => items.id),
  /** Income account this line posts to (item default or override). */
  accountId: uuid("account_id").references(() => accounts.id),
  name: text("name").notNull(),
  description: text("description"),
  hsnOrSac: varchar("hsn_or_sac", { length: 10 }),
  quantity: qty("quantity").notNull().default("1"),
  unit: varchar("unit", { length: 20 }),
  rate: money("rate").notNull().default("0"),
  discountPercent: numeric("discount_percent", { precision: 6, scale: 3 })
    .notNull()
    .default("0"),
  taxId: uuid("tax_id").references(() => taxes.id),
  taxAmount: money("tax_amount").notNull().default("0"),
  /** Line total exclusive of tax, after discount. */
  amount: money("amount").notNull().default("0"),
  lineOrder: integer("line_order").notNull().default(0),
};

/** Columns shared by every transaction header totals block. */
const totalsColumns = {
  subTotal: money("sub_total").notNull().default("0"),
  discountTotal: money("discount_total").notNull().default("0"),
  cgst: money("cgst").notNull().default("0"),
  sgst: money("sgst").notNull().default("0"),
  igst: money("igst").notNull().default("0"),
  adjustment: money("adjustment").notNull().default("0"),
  roundOff: money("round_off").notNull().default("0"),
  total: money("total").notNull().default("0"),
};

export const invoices = pgTable(
  "invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    number: varchar("number", { length: 30 }).notNull().unique(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => contacts.id),
    status: invoiceStatus("status").notNull().default("draft"),
    invoiceDate: date("invoice_date").notNull(),
    dueDate: date("due_date").notNull(),
    reference: text("reference"),
    placeOfSupplyState: varchar("place_of_supply_state", { length: 4 }),
    ...totalsColumns,
    /** Amount still unpaid = total - payments - credits applied. */
    balanceDue: money("balance_due").notNull().default("0"),
    customerNotes: text("customer_notes"),
    termsAndConditions: text("terms_and_conditions"),
    journalEntryId: uuid("journal_entry_id").references(() => journalEntries.id),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [index("ix_invoices_customer").on(t.customerId), index("ix_invoices_date").on(t.invoiceDate)],
);

export const invoiceLines = pgTable("invoice_lines", {
  id: uuid("id").primaryKey().defaultRandom(),
  invoiceId: uuid("invoice_id")
    .notNull()
    .references(() => invoices.id, { onDelete: "cascade" }),
  ...lineColumns,
});

export const customerPayments = pgTable("customer_payments", {
  id: uuid("id").primaryKey().defaultRandom(),
  number: varchar("number", { length: 30 }).notNull().unique(),
  customerId: uuid("customer_id")
    .notNull()
    .references(() => contacts.id),
  paymentDate: date("payment_date").notNull(),
  amount: money("amount").notNull(),
  /** Portion not yet applied to an invoice (customer excess/advance). */
  unappliedAmount: money("unapplied_amount").notNull().default("0"),
  mode: paymentMode("mode").notNull().default("bank_transfer"),
  reference: text("reference"),
  bankAccountId: uuid("bank_account_id").references(() => bankAccounts.id),
  notes: text("notes"),
  journalEntryId: uuid("journal_entry_id").references(() => journalEntries.id),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/** Open-item application of a payment against invoices. */
export const paymentApplications = pgTable("payment_applications", {
  id: uuid("id").primaryKey().defaultRandom(),
  paymentId: uuid("payment_id")
    .notNull()
    .references(() => customerPayments.id, { onDelete: "cascade" }),
  invoiceId: uuid("invoice_id")
    .notNull()
    .references(() => invoices.id),
  amountApplied: money("amount_applied").notNull(),
});

export const creditNotes = pgTable("credit_notes", {
  id: uuid("id").primaryKey().defaultRandom(),
  number: varchar("number", { length: 30 }).notNull().unique(),
  customerId: uuid("customer_id")
    .notNull()
    .references(() => contacts.id),
  status: creditNoteStatus("status").notNull().default("draft"),
  creditNoteDate: date("credit_note_date").notNull(),
  reference: text("reference"),
  /** Invoice this credit note was raised against, if any. */
  invoiceId: uuid("invoice_id").references(() => invoices.id),
  ...totalsColumns,
  /** Credit remaining to apply or refund. */
  balance: money("balance").notNull().default("0"),
  customerNotes: text("customer_notes"),
  journalEntryId: uuid("journal_entry_id").references(() => journalEntries.id),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const creditNoteLines = pgTable("credit_note_lines", {
  id: uuid("id").primaryKey().defaultRandom(),
  creditNoteId: uuid("credit_note_id")
    .notNull()
    .references(() => creditNotes.id, { onDelete: "cascade" }),
  ...lineColumns,
});

/** Application of a credit note against invoices. */
export const creditNoteApplications = pgTable("credit_note_applications", {
  id: uuid("id").primaryKey().defaultRandom(),
  creditNoteId: uuid("credit_note_id")
    .notNull()
    .references(() => creditNotes.id, { onDelete: "cascade" }),
  invoiceId: uuid("invoice_id")
    .notNull()
    .references(() => invoices.id),
  amountApplied: money("amount_applied").notNull(),
});
