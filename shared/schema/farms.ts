import {
  boolean,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { contacts } from "./contacts";
import { locations } from "./locations";
import { stockLocations } from "./stock-locations";

/**
 * A shed. The place a flock lives, inside a farm.
 *
 * Until now a shed WAS a location: the feed mill import had nowhere else to put
 * one, so L2 and Nalbari Feed Mill sat in the same list, and the feed transfer
 * screen offered the mill as somewhere to send feed. A location is a site — it
 * carries an address and the state code that decides GST place of supply — and
 * a shed is not a site.
 *
 * A house has two independent facts about it, and conflating them is the bug
 * 0052 shipped: WHERE it stands (`locationId` — Nalbari, Panbari) and WHO owns
 * it (`ownerId`). All six existing sheds stand at Nalbari; three companies own
 * two each. Owner decides who gets billed — feed delivered to a Luit shed is a
 * sale to Luit, and its eggs are a purchase from them.
 *
 * Every house owns a stock location, created with it in the same transaction.
 * The foreign key is NOT NULL because a house that cannot hold feed is not a
 * house; farm-level stock — vaccines, medicines, consumables — lives on the
 * location's main store instead.
 *
 * `purpose` describes the BUILDING, not the birds in it. It drives defaults and
 * warnings only: a flock's phase comes from its own age and status, never from
 * where it happens to be sitting.
 */
export const houses = pgTable(
  "houses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The site the shed physically stands on. */
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id),
    /**
     * The company that owns the shed. NULL means it is ours: these are Amino's
     * books, so Amino is the org rather than a contact — a self-referencing
     * contact would let somebody raise an invoice from us to us.
     */
    ownerId: uuid("owner_id").references(() => contacts.id),
    stockLocationId: uuid("stock_location_id")
      .notNull()
      .references(() => stockLocations.id),
    code: text("code").notNull(),
    name: text("name"),
    /** "rear" | "lay" */
    purpose: text("purpose").notNull(),
    /**
     * How many birds the building holds. Not a setting: it is a fact about the
     * flock currently in the house, so it is set when a flock is placed and read
     * for stocking-density warnings. Nothing writes it yet.
     */
    capacity: integer("capacity"),
    displayOrder: integer("display_order").notNull().default(0),
    /** Big Herdsman controller, where one is fitted. */
    bhDeviceId: text("bh_device_id"),
    silo1Kg: numeric("silo1_kg", { precision: 10, scale: 2 }),
    silo2Kg: numeric("silo2_kg", { precision: 10, scale: 2 }),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_houses_code").on(t.locationId, t.code),
    uniqueIndex("uq_houses_stock_location").on(t.stockLocationId),
    uniqueIndex("uq_houses_bh_device")
      .on(t.bhDeviceId)
      .where(sql`${t.bhDeviceId} IS NOT NULL`),
    index("ix_houses_location").on(t.locationId, t.displayOrder),
    index("ix_houses_owner").on(t.ownerId),
  ],
);

/**
 * Two kinds of shed, because that is how a farm is built. There is no "either":
 * a house that could be used for both is a house nobody has decided about, and
 * storing the indecision only pushes the question onto whoever reads it later.
 */
export const HOUSE_PURPOSES = ["rear", "lay"] as const;
export type HousePurpose = (typeof HOUSE_PURPOSES)[number];
export const HOUSE_PURPOSE_LABELS: Record<HousePurpose, string> = {
  rear: "Rearing",
  lay: "Laying",
};
