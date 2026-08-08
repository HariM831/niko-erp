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

export const priceLists = pgTable("price_lists", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  description: text("description"),
  /** "markup" | "markdown" percentage list or per-item custom rates. */
  kind: varchar("kind", { length: 10 }).notNull().default("custom"),
  percentage: numeric("percentage", { precision: 6, scale: 3 }),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const priceListItems = pgTable("price_list_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  priceListId: uuid("price_list_id")
    .notNull()
    .references(() => priceLists.id, { onDelete: "cascade" }),
  itemId: uuid("item_id")
    .notNull()
    .references(() => items.id, { onDelete: "cascade" }),
  customRate: numeric("custom_rate", { precision: 14, scale: 2 }).notNull(),
});
