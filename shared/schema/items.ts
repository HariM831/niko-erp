import { sql } from "drizzle-orm";
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
import { pgEnum } from "drizzle-orm/pg-core";
import { accounts } from "./accounting";
import { taxes } from "./core";
import { contacts } from "./contacts";

/**
 * Mirrors ITEM_CATEGORIES in shared/item-categories.ts — behaviour hangs off
 * these values (formulator picker, Farm Store intake), so they are code.
 */
export const itemCategory = pgEnum("item_category", [
  "feed",
  "vaccines",
  "medicines",
  "construction",
  "miscellaneous",
]);

export const items = pgTable("items", {
  id: uuid("id").primaryKey().defaultRandom(),
  type: itemType("type").notNull().default("goods"),
  /**
   * Not unique at the database level: whether duplicate item names are allowed
   * is an org preference, so the check lives in the route instead.
   */
  name: text("name").notNull(),
  sku: varchar("sku", { length: 60 }),
  unit: varchar("unit", { length: 20 }).notNull().default("pcs"),
  hsnOrSac: varchar("hsn_or_sac", { length: 10 }),
  description: text("description"),

  /**
   * What this material is called on a vendor's bill — "DORB", "D.O.R.B.",
   * "Rice bran DO". Data rather than a hardcoded map, because the people who
   * know the abbreviations are not the people who deploy.
   */
  aliases: text("aliases").array().notNull().default(sql`'{}'::text[]`),
  /** Weight of one bag, for sanity-checking a bag count against a weighbridge. */
  unitBagWeightKg: numeric("unit_bag_weight_kg", { precision: 8, scale: 3 }),

  /**
   * A raw material the feed mill mixes — maize, DORB, soya, premix.
   *
   * The org buys ninety-odd things and mixes a dozen of them; cement has no
   * crude protein. This flag is what puts a material on the Nutrient Profiles
   * screen and in the formulator's ingredient list, so the nutritionist's
   * screens show feed and only feed. Finished feed itself stays false: its
   * analysis is a consequence of the formula, not an input anybody types.
   */
  isFeedIngredient: boolean("is_feed_ingredient").notNull().default(false),

  /**
   * What kind of thing this is, for segregation and the module gates. Null
   * means nobody has said yet — honest for a ninety-item master imported from
   * Zoho, and a null is excluded from every category-gated picker.
   */
  category: itemCategory("category"),

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
