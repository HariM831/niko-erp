/**
 * Egg sales: agreements, spot orders, dispatches — and no slots.
 *
 * A day's order book is DERIVED, never materialised: standing agreements whose
 * schedule covers the day, minus that day's exceptions, plus the day's spot
 * orders. Only what somebody stated is stored — the rule, the exception, the
 * one-off, and the loading that actually happened. Amino's generated-slot
 * system died of drift between the copies and the rule; there are no copies.
 *
 * Price is never stored on an order. Every invoice line prices at
 * (benchmark on the day) + (size differential) + (customer's spread) per egg —
 * the benchmark being the same `egg_benchmark_prices` table owner billing
 * reads, so there is one egg rate in the whole system.
 */
import {
  boolean,
  date,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { users } from "./auth";
import { contacts } from "./contacts";
import { houses } from "./farms";
import { items } from "./items";
import { invoices } from "./sales";

/** The standing rule: N boxes on a schedule, priced at benchmark + spread. */
export const eggAgreements = pgTable(
  "egg_agreements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => contacts.id),
    /** 'daily', or 'weekdays' with the days named (0=Sunday .. 6=Saturday). */
    schedule: varchar("schedule", { length: 10 }).notNull().default("daily"),
    daysOfWeek: integer("days_of_week").array(),
    boxes: integer("boxes").notNull(),
    /** Rupees per EGG over (or under) the benchmark — the one price term. */
    spreadPerEgg: numeric("spread_per_egg", { precision: 10, scale: 4 }).notNull().default("0"),
    startDate: date("start_date").notNull(),
    /**
     * Null while open. Ending an agreement is setting this, never deleting the
     * row — past invoices were priced off its spread and must stay explainable.
     */
    endDate: date("end_date"),
    /** 'active' | 'paused' | 'ended' */
    status: varchar("status", { length: 10 }).notNull().default("active"),
    notes: text("notes"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ix_egg_agreements_customer").on(t.customerId)],
);

/**
 * One day where the rule does not apply: skipped, or a different quantity.
 * This is how a standing order is "voided" for a day without touching the
 * agreement or any other day.
 */
export const eggAgreementExceptions = pgTable(
  "egg_agreement_exceptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agreementId: uuid("agreement_id")
      .notNull()
      .references(() => eggAgreements.id, { onDelete: "cascade" }),
    onDate: date("on_date").notNull(),
    /** 'skip' | 'qty_override' */
    kind: varchar("kind", { length: 12 }).notNull(),
    /** The boxes for a qty_override; meaningless on a skip. */
    boxes: integer("boxes"),
    reason: text("reason"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("uq_egg_exceptions_day").on(t.agreementId, t.onDate)],
);

/**
 * A one-off booking for a date. Voiding sets status and keeps the row: the
 * calendar still shows what was booked and struck off, and nothing else ever
 * referenced it because nothing is generated from it.
 */
export const eggSpotOrders = pgTable(
  "egg_spot_orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => contacts.id),
    orderDate: date("order_date").notNull(),
    /** The total, maintained by the service as the sum of the sizes below. */
    boxes: integer("boxes").notNull(),
    /** Booked per size, as the trade orders: "200 Large and 50 Medium". */
    small: integer("small").notNull().default(0),
    medium: integer("medium").notNull().default(0),
    large: integer("large").notNull().default(0),
    xl: integer("xl").notNull().default(0),
    jumbo: integer("jumbo").notNull().default(0),
    dirty: integer("dirty").notNull().default(0),
    /** Null means: the customer's standing spread if they have one, else zero. */
    spreadPerEgg: numeric("spread_per_egg", { precision: 10, scale: 4 }),
    notes: text("notes"),
    /** 'booked' | 'voided' */
    status: varchar("status", { length: 10 }).notNull().default("booked"),
    voidedReason: text("voided_reason"),
    voidedBy: uuid("voided_by").references(() => users.id),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ix_egg_spot_date").on(t.orderDate)],
);

/**
 * Per-size differentials against the benchmark, in rupees per egg.
 * Effective-dated like every rate table here: a new row never reaches back.
 */
export const eggSizeOffsets = pgTable("egg_size_offsets", {
  id: uuid("id").primaryKey().defaultRandom(),
  effectiveFrom: date("effective_from").notNull().unique(),
  small: numeric("small", { precision: 10, scale: 4 }).notNull().default("0"),
  medium: numeric("medium", { precision: 10, scale: 4 }).notNull().default("0"),
  large: numeric("large", { precision: 10, scale: 4 }).notNull().default("0"),
  xl: numeric("xl", { precision: 10, scale: 4 }).notNull().default("0"),
  jumbo: numeric("jumbo", { precision: 10, scale: 4 }).notNull().default("0"),
  dirty: numeric("dirty", { precision: 10, scale: 4 }).notNull().default("0"),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The loading that actually happened, and the invoice it raised — the only
 * place actual quantities, drivers and money attach. Once one of these exists
 * the order rows are no longer the document; the invoice is, and undoing means
 * voiding the invoice, which marks this row void with it.
 */
export const eggDispatches = pgTable(
  "egg_dispatches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dispatchDate: date("dispatch_date").notNull(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => contacts.id),
    /** What it fulfils. Both null is a walk-in; both set is refused by CHECK. */
    agreementId: uuid("agreement_id").references(() => eggAgreements.id),
    spotOrderId: uuid("spot_order_id").references(() => eggSpotOrders.id),
    loadedSmall: integer("loaded_small").notNull().default(0),
    loadedMedium: integer("loaded_medium").notNull().default(0),
    loadedLarge: integer("loaded_large").notNull().default(0),
    loadedXl: integer("loaded_xl").notNull().default(0),
    loadedJumbo: integer("loaded_jumbo").notNull().default(0),
    loadedDirty: integer("loaded_dirty").notNull().default(0),
    driverName: text("driver_name").notNull(),
    vehicleNumber: text("vehicle_number").notNull(),
    notes: text("notes"),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id),
    /** 'invoiced' | 'void' */
    status: varchar("status", { length: 10 }).notNull().default("invoiced"),
    loadedBy: uuid("loaded_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ix_egg_dispatch_date").on(t.dispatchDate),
    index("ix_egg_dispatch_invoice").on(t.invoiceId),
  ],
);

/** One row of knobs. See the migration for why stock_from exists. */
export const eggSalesPreferences = pgTable("egg_sales_preferences", {
  id: boolean("id").primaryKey().default(true),
  eggsPerBox: integer("eggs_per_box").notNull().default(210),
  /** Retired placeholder (the ungraded item). Kept nullable for history. */
  eggItemId: uuid("egg_item_id").references(() => items.id),
  /** Grading on/after this date writes egg stock; before it is history. */
  stockFrom: date("stock_from").notNull(),
  /** The kg-per-box bands the grader sorts by; XL is above the large band. */
  bandSmallMaxKg: numeric("band_small_max_kg", { precision: 5, scale: 2 }).notNull().default("10.5"),
  bandMediumMaxKg: numeric("band_medium_max_kg", { precision: 5, scale: 2 }).notNull().default("12"),
  bandLargeMaxKg: numeric("band_large_max_kg", { precision: 5, scale: 2 }).notNull().default("13.5"),
});

/**
 * The Production Report half of the day sheet: graded boxes per shed per
 * size. Entered per shed because the sheet says which shed laid what; the
 * stock it produces is ONE pool per size — a sale is never per shed.
 */
export const eggGrading = pgTable(
  "egg_grading",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    gradedOn: date("graded_on").notNull(),
    houseId: uuid("house_id")
      .notNull()
      .references(() => houses.id),
    small: integer("small").notNull().default(0),
    medium: integer("medium").notNull().default(0),
    large: integer("large").notNull().default(0),
    xl: integer("xl").notNull().default(0),
    jumbo: integer("jumbo").notNull().default(0),
    dirty: integer("dirty").notNull().default(0),
    recordedBy: uuid("recorded_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_egg_grading_house_day").on(t.houseId, t.gradedOn),
    index("ix_egg_grading_day").on(t.gradedOn),
  ],
);

/**
 * The evening count, per shed — the one figure the ledger cannot derive.
 * Recorded as a count, never written into stock by itself; a difference
 * against the ledger is posted as an adjustment, where a difference belongs.
 */
export const eggHouseClosing = pgTable(
  "egg_house_closing",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    countedOn: date("counted_on").notNull(),
    houseId: uuid("house_id")
      .notNull()
      .references(() => houses.id),
    small: integer("small").notNull().default(0),
    medium: integer("medium").notNull().default(0),
    large: integer("large").notNull().default(0),
    xl: integer("xl").notNull().default(0),
    jumbo: integer("jumbo").notNull().default(0),
    dirty: integer("dirty").notNull().default(0),
    recordedBy: uuid("recorded_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_egg_house_closing_day").on(t.houseId, t.countedOn),
    index("ix_egg_house_closing_day").on(t.countedOn),
  ],
);

/** The stock item behind each size — data the service iterates, not code. */
export const eggSizeItems = pgTable("egg_size_items", {
  size: varchar("size", { length: 10 }).primaryKey(),
  itemId: uuid("item_id")
    .notNull()
    .unique()
    .references(() => items.id),
});
