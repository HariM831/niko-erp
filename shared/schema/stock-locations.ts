import {
  boolean,
  date,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { items } from "./items";
import { locations } from "./locations";

/**
 * Where stock physically sits.
 *
 * `locations` answers "which site" and carries the address and state code that
 * decide GST place of supply — a location picker on an invoice should offer
 * four farms, not forty sheds. This answers "which store", one level finer:
 * feed is held per house, everything else per farm.
 *
 * Every location gets a `main` row when it is created; that is where farm-level
 * stock lives. A house owns a `house` row of its own. `silo` is reserved and
 * unused — it exists so per-silo feed tracking is a data change rather than a
 * schema change if the mill's silo sensors ever need reconciling against book
 * stock.
 */
export const stockLocations = pgTable(
  "stock_locations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id),
    code: varchar("code", { length: 20 }).notNull(),
    name: text("name").notNull(),
    /** "main" | "house" | "silo" */
    kind: varchar("kind", { length: 12 }).notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_stock_locations_code").on(t.locationId, t.code),
    index("ix_stock_locations_location").on(t.locationId),
  ],
);

/**
 * A batch of something, with the expiry that makes it matter.
 *
 * Vaccines and medicines are the reason: the vial batch and its expiry ARE the
 * record, and a course given from an expired vial is a finding. It sits in the
 * core rather than in Farms because a feed ingredient has a batch too, and the
 * first time somebody needs to trace a bad consignment they will want this.
 *
 * Issue policy is FEFO — earliest expiry first — decided by the caller. The
 * schema records what a lot IS; which one to reach for is a judgement about
 * shelf life that belongs with the thing doing the issuing.
 */
export const itemLots = pgTable(
  "item_lots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id),
    lotNo: text("lot_no"),
    expiryDate: date("expiry_date"),
    receivedOn: date("received_on").notNull(),
    notes: text("notes"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_item_lots_no").on(t.itemId, t.lotNo),
    index("ix_item_lots_expiry")
      .on(t.expiryDate)
      .where(sql`${t.expiryDate} IS NOT NULL`),
  ],
);
