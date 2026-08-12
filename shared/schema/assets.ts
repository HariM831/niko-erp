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
import { assetStatus, depreciationMethod } from "./enums";
import { accounts, journalEntries } from "./accounting";
import { users } from "./auth";
import { contacts } from "./contacts";
import { items } from "./items";

const money = (name: string) => numeric(name, { precision: 14, scale: 2 });

/**
 * A depreciable asset. Cost and accumulated depreciation are never stored as a
 * running balance on the account — the GL remains the only source of truth, and
 * `depreciationEntries` records what has been charged against this asset so far.
 */
export const fixedAssets = pgTable(
  "fixed_assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    number: varchar("number", { length: 30 }).notNull().unique(),
    name: text("name").notNull(),
    description: text("description"),
    /** Asset account the cost sits in, e.g. "1013 Poultry Sheds". */
    assetAccountId: uuid("asset_account_id")
      .notNull()
      .references(() => accounts.id),
    status: assetStatus("status").notNull().default("active"),

    acquisitionDate: date("acquisition_date").notNull(),
    cost: money("cost").notNull(),
    /** Residual value at the end of useful life; depreciation stops here. */
    salvageValue: money("salvage_value").notNull().default("0"),
    method: depreciationMethod("method").notNull().default("straight_line"),
    usefulLifeMonths: integer("useful_life_months").notNull(),
    /**
     * Depreciation already charged before this asset was entered, for assets
     * migrated mid-life. Excluded from the GL — it is assumed to be part of the
     * opening balance of the accumulated depreciation account.
     */
    openingAccumulated: money("opening_accumulated").notNull().default("0"),
    /** First period to charge for; defaults to the acquisition month. */
    depreciationStartDate: date("depreciation_start_date").notNull(),

    vendorId: uuid("vendor_id").references(() => contacts.id),
    serialNumber: text("serial_number"),
    location: text("location"),

    disposalDate: date("disposal_date"),
    disposalProceeds: money("disposal_proceeds"),
    disposalJournalEntryId: uuid("disposal_journal_entry_id").references(
      () => journalEntries.id,
    ),

    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("ix_fixed_assets_account").on(t.assetAccountId),
    index("ix_fixed_assets_status").on(t.status),
  ],
);

/**
 * One depreciation charge for one asset in one period. A single run produces
 * many of these sharing a journal entry — the entry is the GL side, these rows
 * are the per-asset breakdown that makes the schedule reportable.
 */
export const depreciationEntries = pgTable(
  "depreciation_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => fixedAssets.id, { onDelete: "cascade" }),
    journalEntryId: uuid("journal_entry_id")
      .notNull()
      .references(() => journalEntries.id),
    /** Last day of the period being charged. */
    periodEnd: date("period_end").notNull(),
    amount: money("amount").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("ix_depreciation_asset").on(t.assetId),
    index("ix_depreciation_period").on(t.periodEnd),
  ],
);

/**
 * Movement of stock for an inventory-tracked item. Every source that changes
 * stock writes a row here; quantity on hand is always SUM(quantity) over this
 * table, never a stored column — the same rule the GL follows.
 *
 * Signed: positive increases stock, negative decreases it.
 */
export const inventoryTransactions = pgTable(
  "inventory_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id),
    transactionDate: date("transaction_date").notNull(),
    quantity: numeric("quantity", { precision: 14, scale: 3 }).notNull(),
    /** Value of this movement; drives the GL amount when one is posted. */
    value: money("value").notNull().default("0"),
    /** What produced this movement, e.g. "inventory_adjustment", "feed_mill". */
    sourceType: varchar("source_type", { length: 40 }).notNull(),
    sourceId: uuid("source_id"),
    notes: text("notes"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("ix_inv_txn_item").on(t.itemId, t.transactionDate),
    index("ix_inv_txn_source").on(t.sourceType, t.sourceId),
  ],
);

/** A manual stock correction — Zoho's "Inventory Adjustment" document. */
export const inventoryAdjustments = pgTable("inventory_adjustments", {
  id: uuid("id").primaryKey().defaultRandom(),
  number: varchar("number", { length: 30 }).notNull().unique(),
  adjustmentDate: date("adjustment_date").notNull(),
  /** "quantity" corrects counts; "value" revalues without moving quantity. */
  mode: varchar("mode", { length: 10 }).notNull().default("quantity"),
  reason: text("reason").notNull(),
  description: text("description"),
  /** Expense/income account absorbing the difference, e.g. stock written off. */
  adjustmentAccountId: uuid("adjustment_account_id")
    .notNull()
    .references(() => accounts.id),
  journalEntryId: uuid("journal_entry_id").references(() => journalEntries.id),
  isVoid: boolean("is_void").notNull().default(false),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const inventoryAdjustmentLines = pgTable("inventory_adjustment_lines", {
  id: uuid("id").primaryKey().defaultRandom(),
  adjustmentId: uuid("adjustment_id")
    .notNull()
    .references(() => inventoryAdjustments.id, { onDelete: "cascade" }),
  itemId: uuid("item_id")
    .notNull()
    .references(() => items.id),
  /** Signed change in quantity; zero for a value-only adjustment. */
  quantityChange: numeric("quantity_change", { precision: 14, scale: 3 })
    .notNull()
    .default("0"),
  /** Signed change in value posted to the GL. */
  valueChange: money("value_change").notNull().default("0"),
  notes: text("notes"),
  lineOrder: integer("line_order").notNull().default(0),
});
