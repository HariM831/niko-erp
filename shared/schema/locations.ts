import {
  boolean,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { locationType } from "./enums";

/**
 * A physical place the business operates from — a farm, the feed mill, an
 * office, a warehouse.
 *
 * This is the dimension the operational modules hang off: a shed belongs to a
 * farm, a feed batch is milled somewhere, a delivery is received somewhere.
 * Defined here rather than inside those modules so they all agree on one list,
 * and so transactions can carry a location before any of them are built —
 * retrofitting a dimension across posted journals is the expensive way to do it.
 */
export const locations = pgTable("locations", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Short code used on documents and reports, e.g. "BH" for Bhadra farm. */
  code: varchar("code", { length: 12 }).notNull().unique(),
  name: text("name").notNull().unique(),
  type: locationType("type").notNull().default("farm"),
  /** Exactly one location is the default for new transactions. */
  isPrimary: boolean("is_primary").notNull().default(false),

  addressLine1: text("address_line1"),
  addressLine2: text("address_line2"),
  city: text("city"),
  state: text("state"),
  stateCode: varchar("state_code", { length: 4 }),
  pincode: varchar("pincode", { length: 10 }),
  phone: text("phone"),
  /** Whoever runs the place day to day. */
  inCharge: text("in_charge"),
  notes: text("notes"),

  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
