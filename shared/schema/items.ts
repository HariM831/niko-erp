import {
  boolean,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { itemType } from "./enums";
import { accounts } from "./accounting";
import { taxes } from "./core";
import { contacts } from "./contacts";

export const items = pgTable("items", {
  id: uuid("id").primaryKey().defaultRandom(),
  type: itemType("type").notNull().default("goods"),
  name: text("name").notNull().unique(),
  sku: varchar("sku", { length: 60 }),
  unit: varchar("unit", { length: 20 }).notNull().default("pcs"),
  hsnOrSac: varchar("hsn_or_sac", { length: 10 }),
  description: text("description"),

  // Sales information
  isSold: boolean("is_sold").notNull().default(true),
  sellingPrice: numeric("selling_price", { precision: 14, scale: 2 }),
  salesAccountId: uuid("sales_account_id").references(() => accounts.id),
  salesDescription: text("sales_description"),

  // Purchase information
  isPurchased: boolean("is_purchased").notNull().default(true),
  costPrice: numeric("cost_price", { precision: 14, scale: 2 }),
  purchaseAccountId: uuid("purchase_account_id").references(() => accounts.id),
  purchaseDescription: text("purchase_description"),
  preferredVendorId: uuid("preferred_vendor_id").references(() => contacts.id),

  taxId: uuid("tax_id").references(() => taxes.id),

  // Inventory tracking (optional, Zoho "track inventory for this item")
  trackInventory: boolean("track_inventory").notNull().default(false),
  inventoryAccountId: uuid("inventory_account_id").references(() => accounts.id),
  openingStock: numeric("opening_stock", { precision: 14, scale: 3 })
    .notNull()
    .default("0"),
  openingStockRate: numeric("opening_stock_rate", { precision: 14, scale: 2 })
    .notNull()
    .default("0"),
  reorderLevel: numeric("reorder_level", { precision: 14, scale: 3 }),

  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// NOTE: no price lists by design. Eggs are priced from a daily benchmark rate
// plus a per-agreement spread in ₹/egg, not from a stored per-customer rate —
// a static list would need rewriting every morning and would quote a stale
// price the first time nobody did. When the Sales module lands it brings a
// daily price table and agreement spreads instead.
