import { date, index, numeric, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { freightBasis } from "./enums";
import { users } from "./auth";
import { accounts, journalEntries } from "./accounting";
import { bankAccounts } from "./banking";
import { items } from "./items";
import { bills, purchaseOrders } from "./purchases";
import { officeReceipts } from "./office";

/**
 * Freight paid to a transporter for a PO's trucks (22 Oct 2026).
 *
 * Transporters are not vendors here: what is owed sits in one Freight Payable
 * account, truck by truck, and a payment clears the trucks it covers. See
 * migrations/0134_po_freight.sql.
 */
export const freightPayments = pgTable("freight_payments", {
  id: uuid("id").primaryKey().defaultRandom(),
  number: varchar("number", { length: 30 }).notNull().unique(),
  paymentDate: date("payment_date").notNull(),
  bankAccountId: uuid("bank_account_id")
    .notNull()
    .references(() => bankAccounts.id),
  amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
  /** Who was paid — free text, since a transporter is not a contact. */
  transporter: text("transporter"),
  reference: text("reference"),
  notes: text("notes"),
  journalEntryId: uuid("journal_entry_id").references(() => journalEntries.id),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/** One truck's freight: raised when the truck is settled (or a PO converted to a bill). */
export const freightCharges = pgTable(
  "freight_charges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    billId: uuid("bill_id")
      .notNull()
      .references(() => bills.id),
    receiptId: uuid("receipt_id").references(() => officeReceipts.id),
    purchaseOrderId: uuid("purchase_order_id")
      .notNull()
      .references(() => purchaseOrders.id),
    /** The day the truck reached the gate; the bill date where there was no gate. */
    chargeDate: date("charge_date").notNull(),
    vehicleNumber: varchar("vehicle_number", { length: 20 }),
    basis: freightBasis("basis").notNull(),
    rate: numeric("rate", { precision: 14, scale: 2 }).notNull(),
    /** The vendor's billed kilos the per-ton rate was applied to. */
    quantityKg: numeric("quantity_kg", { precision: 14, scale: 3 }),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    journalEntryId: uuid("journal_entry_id").references(() => journalEntries.id),
    freightPaymentId: uuid("freight_payment_id").references(() => freightPayments.id),
    /** Set when the bill it rides on is voided; its entry is reversed. */
    voidedAt: timestamp("voided_at"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("ix_fc_bill").on(t.billId),
    index("ix_fc_payment").on(t.freightPaymentId),
    index("ix_fc_po").on(t.purchaseOrderId),
  ],
);

/** How a charge was split across the materials on the truck. */
export const freightChargeLines = pgTable(
  "freight_charge_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    chargeId: uuid("charge_id")
      .notNull()
      .references(() => freightCharges.id, { onDelete: "cascade" }),
    itemId: uuid("item_id").references(() => items.id),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    name: text("name").notNull(),
    quantityKg: numeric("quantity_kg", { precision: 14, scale: 3 }),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
  },
  (t) => [index("ix_fcl_charge").on(t.chargeId)],
);

export type FreightCharge = typeof freightCharges.$inferSelect;
export type FreightPayment = typeof freightPayments.$inferSelect;
