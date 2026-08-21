/**
 * What passes between Amino and the owner of a shed.
 *
 * Amino owns the ecosystem; Nandamuri owns L2–L3, Luit Valley owns L4–L5, and
 * the rearing houses are Amino's. A batch therefore crosses an ownership line
 * when it is housed, and three things need pricing: the feed Amino sells them,
 * the pullets Amino sells them, and the eggs Amino buys back.
 *
 * Amino's own sheds are billed for none of it.
 */

import {
  bigint,
  date,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth";
import { contacts } from "./contacts";

/**
 * The market price of an egg, carried forward until a new one is entered.
 *
 * Thin on purpose — the Sales module is bringing a daily price table and this
 * is the shape it will take over. Until then it is the one number egg purchases
 * are priced from, and it is better in a table than in somebody's formula.
 */
export const eggBenchmarkPrices = pgTable(
  "egg_benchmark_prices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    effectiveFrom: date("effective_from").notNull(),
    /** Per EGG, never per hundred — a shed reports eggs and a bill counts them. */
    ratePerEgg: numeric("rate_per_egg", { precision: 10, scale: 4 }).notNull(),
    source: text("source"),
    note: text("note"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("uq_egg_benchmark").on(t.effectiveFrom)],
);

/** What is agreed with one owner, rather than true of everyone. */
export const ownerAgreements = pgTable(
  "owner_agreements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id),
    effectiveFrom: date("effective_from").notNull(),
    /** Added to the benchmark. Signed, so a discount needs no second column. */
    eggSpreadPerEgg: numeric("egg_spread_per_egg", { precision: 10, scale: 4 })
      .notNull()
      .default("0"),
    /** Null means feed at what the mill made it for, which is the norm. */
    feedRatePerKg: numeric("feed_rate_per_kg", { precision: 10, scale: 4 }),
    note: text("note"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_owner_agreement").on(t.contactId, t.effectiveFrom),
    index("ix_owner_agreements_lookup").on(t.contactId, t.effectiveFrom),
  ],
);

/**
 * Which month has been billed to whom.
 *
 * The documents are not a reliable record of this on their own: reading
 * invoices back to work out whether Luit's March was done is how an owner gets
 * billed for the same feed twice.
 */
export const ownerBillingRuns = pgTable(
  "owner_billing_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id),
    /** The first of the month covered — a month, not a range. */
    period: date("period").notNull(),
    /**
     * Feed and pullets get an invoice each: different trades on different
     * terms, each carrying a statement of only its own transactions.
     *
     * On runs raised before the split, `feedInvoiceId` is the combined one.
     */
    feedInvoiceId: uuid("feed_invoice_id"),
    birdInvoiceId: uuid("bird_invoice_id"),
    billId: uuid("bill_id"),
    feedKg: numeric("feed_kg", { precision: 14, scale: 3 }).notNull().default("0"),
    birds: integer("birds").notNull().default(0),
    eggs: bigint("eggs", { mode: "number" }).notNull().default(0),
    note: text("note"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("uq_owner_billing_run").on(t.contactId, t.period)],
);


