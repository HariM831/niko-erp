import { boolean, integer, numeric, pgTable, timestamp, varchar } from "drizzle-orm/pg-core";

/**
 * Org-wide behaviour switches, mirroring Zoho's Module Settings.
 *
 * Singleton, like org_profile. Every column here is read by code somewhere —
 * a preference that is stored and ignored is worse than no preference, because
 * it tells the user they changed something when they did not.
 */
export const preferences = pgTable("preferences", {
  id: varchar("id", { length: 32 }).primaryKey().default("default"),

  // ---- Transactions ----
  /** "none" | "line" | "transaction" — where a discount may be entered. */
  discountLevel: varchar("discount_level", { length: 12 }).notNull().default("line"),
  /** Discount comes off before tax is computed rather than after. */
  discountBeforeTax: boolean("discount_before_tax").notNull().default(true),
  /** Offer a free-text adjustment line on documents. */
  enableAdjustment: boolean("enable_adjustment").notNull().default(true),
  /** Offer shipping/freight charges on documents. */
  enableShippingCharge: boolean("enable_shipping_charge").notNull().default(true),
  /** "exclusive" | "inclusive" | "both" — how line rates treat tax. */
  taxTreatment: varchar("tax_treatment", { length: 10 }).notNull().default("exclusive"),
  /** "none" | "whole" | "increment" — rounding applied to a document total. */
  roundingMode: varchar("rounding_mode", { length: 10 }).notNull().default("whole"),
  /** Step used when roundingMode is "increment", e.g. 0.50. */
  roundingIncrement: numeric("rounding_increment", { precision: 6, scale: 2 })
    .notNull()
    .default("1.00"),

  // ---- Items ----
  /** Decimal places accepted for a line quantity. */
  quantityDecimals: integer("quantity_decimals").notNull().default(2),
  allowDuplicateItemNames: boolean("allow_duplicate_item_names").notNull().default(false),
  /** Refuse an adjustment that would take stock below zero. */
  preventNegativeStock: boolean("prevent_negative_stock").notNull().default(true),
  /** Flag items sitting below zero rather than blocking them. */
  showOutOfStockWarning: boolean("show_out_of_stock_warning").notNull().default(true),
  /** Flag items at or under their reorder level. */
  notifyOnReorderLevel: boolean("notify_on_reorder_level").notNull().default(false),

  // ---- Customers & vendors ----
  allowDuplicateContactNames: boolean("allow_duplicate_contact_names").notNull().default(false),
  /** "business" | "individual" — preselected on a new customer. */
  defaultCustomerType: varchar("default_customer_type", { length: 12 })
    .notNull()
    .default("business"),
  /** Enforce contacts.creditLimit when an invoice is issued. */
  enableCreditLimit: boolean("enable_credit_limit").notNull().default(true),

  // ---- Accountant ----
  /** Account code is required on a new GL account. Codes are always unique. */
  requireAccountCode: boolean("require_account_code").notNull().default(true),

  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
