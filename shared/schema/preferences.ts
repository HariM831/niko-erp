import {
  boolean,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

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

  // ---- Invoices ----
  /**
   * Permit editing an invoice after it has been sent. The journal is reversed
   * and re-posted, so the ledger keeps the trail rather than being rewritten.
   */
  allowEditingSentInvoice: boolean("allow_editing_sent_invoice").notNull().default(false),
  /** Leave nil-value lines off the printed document. */
  hideZeroValueLines: boolean("hide_zero_value_lines").notNull().default(false),
  /** Prefilled on a new invoice. */
  defaultInvoiceTerms: text("default_invoice_terms"),
  defaultInvoiceNotes: text("default_invoice_notes"),

  // ---- Accountant ----
  /** Account code is required on a new GL account. Codes are always unique. */
  requireAccountCode: boolean("require_account_code").notNull().default(true),

  // ---- Office ----
  /**
   * How far a delivery may run over what an order still has due, in percent,
   * and still match it at the gate.
   *
   * It cannot sensibly be zero. An order is raised for a round tonnage before
   * anything is weighed, and the vendor loads what the vendor loads — 43.300 MT
   * ordered against 43.330 MT delivered is the normal case, not an exception,
   * and blocking it leaves a loaded truck at the boom over 0.07%. The band
   * absorbs weighbridge reality; anything past it is a real over-supply and
   * still stops at the gate.
   */
  poOverDeliveryPct: numeric("po_over_delivery_pct", { precision: 6, scale: 3 })
    .notNull()
    .default("1.000"),

  // ---- Feed mill ----
  /**
   * Output weighs this share of raw input after milling — moisture bakes off.
   * Amino hardcoded 0.99 in two files with comments begging them to match;
   * both the formulator's reported cost and a production completion read this
   * one row instead.
   */
  millMoistureRetention: numeric("mill_moisture_retention", { precision: 5, scale: 4 })
    .notNull()
    .default("0.99"),
  /** Flat milling overhead added per finished kg — Amino's ₹1,000/ton. */
  millOverheadPerKg: numeric("mill_overhead_per_kg", { precision: 8, scale: 4 })
    .notNull()
    .default("1.00"),

  /**
   * What an owner's eggs and pullets are billed AS.
   *
   * Named rather than guessed: the item master holds several egg items and more
   * than one bird item, and choosing at posting time means the answer moves
   * when somebody adds an item. Feed needs no setting — a transfer already
   * names the item it carried.
   */
  eggPurchaseItemId: uuid("egg_purchase_item_id"),
  birdSaleItemId: uuid("bird_sale_item_id"),

  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
