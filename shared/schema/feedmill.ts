/**
 * Feed mill — what a material is made of, what a mix has to hit, and what was
 * actually milled.
 *
 * The load-bearing decision: **a formula's output is an ITEM.** Amino's formulas
 * were not, so finished feed existed only as a rupee balance on an inventory
 * account and nobody could ask how many kilos of Layer Mash were in the mill.
 * Naming an output item makes production one stock movement — raw out, finished
 * in — transfer another, and finished stock in kilos falls out of `stockOnHand`
 * with no machinery of its own.
 *
 * Nutrients are ROWS, not columns. Amino carried twenty-five columns on
 * `materials` plus a key-to-column map duplicated in two files; adding a nutrient
 * meant a migration and two edits that had to agree. Here it is data.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { items } from "./items";
import { locations } from "./locations";
import { users } from "./auth";

const qty = (name: string) => numeric(name, { precision: 14, scale: 3 });
const money = (name: string) => numeric(name, { precision: 14, scale: 2 });

export const lifeStage = pgEnum("life_stage", [
  "chick_starter",
  "developer",
  "grower",
  "prelayer",
  "layer_1",
  "layer_2",
  "layer_3",
]);

export const nutrientSource = pgEnum("nutrient_source", ["lab", "supplier", "book"]);

// ─────────────────────────── What a material is ───────────────────────────

/**
 * One nutrient reading for one material.
 *
 * Not versioned, deliberately, unlike a QC spec: this is the analysis of a
 * material as currently understood, and a formula that was solved against an
 * older figure keeps its own line quantities, which is the thing that actually
 * has to stay true. `testedAt` and `source` carry how much the figure is worth.
 */
export const itemNutrients = pgTable(
  "item_nutrients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    /** A key from shared/feed.ts — me, cp, digLys, and the rest. */
    nutrient: varchar("nutrient", { length: 20 }).notNull(),
    /** ME runs to four figures; percentages to four decimals. */
    value: numeric("value", { precision: 12, scale: 4 }).notNull(),
    source: nutrientSource("source").notNull().default("book"),
    testedAt: date("tested_at"),
    notes: text("notes"),
    updatedBy: uuid("updated_by").references(() => users.id),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("uq_item_nutrient").on(t.itemId, t.nutrient)],
);

// ─────────────────────── What a mix has to hit ────────────────────────

/**
 * The nutrient window for a life stage.
 *
 * Versioned and superseded rather than edited, for the same reason a QC spec is:
 * a formula solved last March was solved against March's standard, and rewriting
 * the standard would make that formula look like it never met it.
 */
export const feedStandards = pgTable(
  "feed_standards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    stage: lifeStage("stage").notNull(),
    version: integer("version").notNull().default(1),
    effectiveFrom: date("effective_from").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    notes: text("notes"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_feed_standard_version").on(t.stage, t.version),
    // One live standard per stage: two would make a solve a coin toss.
    uniqueIndex("uq_feed_standard_active").on(t.stage).where(sql`is_active`),
  ],
);

/** One nutrient's window within a standard. Either bound may be null. */
export const feedStandardParams = pgTable(
  "feed_standard_params",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    standardId: uuid("standard_id")
      .notNull()
      .references(() => feedStandards.id, { onDelete: "cascade" }),
    nutrient: varchar("nutrient", { length: 20 }).notNull(),
    minValue: numeric("min_value", { precision: 12, scale: 4 }),
    maxValue: numeric("max_value", { precision: 12, scale: 4 }),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [uniqueIndex("uq_feed_standard_param").on(t.standardId, t.nutrient)],
);

// ──────────────────────────────── Formulas ────────────────────────────────

/**
 * A recipe, versioned.
 *
 * `outputItemId` is what comes out and is an inventory-tracked item; `batchSizeKg`
 * is what one batch of it weighs. Amino derived batch size by summing the
 * ingredient rows and defaulting to 1,000 kg when they came to nothing — implicit,
 * and wrong the moment a line was mid-edit. Stated here.
 */
export const formulas = pgTable(
  "formulas",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    /** The feed this makes. Tracked inventory, so production can receive it. */
    outputItemId: uuid("output_item_id")
      .notNull()
      .references(() => items.id),
    /** Which standard a solve should judge it against. */
    stage: lifeStage("stage"),
    batchSizeKg: qty("batch_size_kg").notNull(),
    version: integer("version").notNull().default(1),
    effectiveFrom: date("effective_from").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    notes: text("notes"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_formula_version").on(t.name, t.version),
    uniqueIndex("uq_formula_active").on(t.name).where(sql`is_active`),
  ],
);

/**
 * An ingredient line — real rows with a foreign key, not jsonb.
 *
 * Amino held ingredients as a jsonb array, which cannot reference `items`: a
 * material could be renamed or deleted underneath a formula and nothing would
 * notice. It also makes "which formulas use maize" a scan rather than a join.
 *
 * `minPercent` / `maxPercent` are the solver's inclusion limits for this
 * ingredient, kept with the line they constrain rather than in a jsonb map keyed
 * by material id.
 */
export const formulaLines = pgTable(
  "formula_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    formulaId: uuid("formula_id")
      .notNull()
      .references(() => formulas.id, { onDelete: "cascade" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id),
    quantityKg: qty("quantity_kg").notNull(),
    minPercent: numeric("min_percent", { precision: 6, scale: 3 }),
    maxPercent: numeric("max_percent", { precision: 6, scale: 3 }),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [
    uniqueIndex("uq_formula_line").on(t.formulaId, t.itemId),
    index("ix_formula_line_item").on(t.itemId),
  ],
);

// ─────────────────────────────── Production ───────────────────────────────

/**
 * pending — a slip printed and handed to the mill floor
 * completed — the mix was made; stock moved and the ledger has it
 * void — printed and not made. Kept, because the number was issued.
 */
export const productionStatus = pgEnum("production_status", ["pending", "completed", "void"]);

/**
 * One document, not two.
 *
 * Amino split this into a `production_slips` row and a `batches` row, with the
 * batch carrying a jsonb snapshot of the formula and another of the cost. Here
 * the order IS the record: planned figures on issue, actual figures on
 * completion, and the movements it caused are findable by
 * `inventory_transactions.sourceId`. The formula VERSION it was made to is a
 * foreign key, so the recipe is readable without a snapshot of it.
 */
export const productionOrders = pgTable(
  "production_orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    number: varchar("number", { length: 30 }).notNull().unique(),
    /** The exact formula version. Superseding a formula cannot rewrite this. */
    formulaId: uuid("formula_id")
      .notNull()
      .references(() => formulas.id),
    /** Which mill made it. Recorded here rather than on every stock movement. */
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id),
    orderDate: date("order_date").notNull(),
    batchCount: integer("batch_count").notNull().default(1),
    /** batchCount × the formula's batch size, at the time of issue. */
    plannedOutputKg: qty("planned_output_kg").notNull(),
    status: productionStatus("status").notNull().default("pending"),

    /** What the floor actually produced. Null until completion. */
    actualOutputKg: qty("actual_output_kg"),
    /** Weighted-average value of the raw materials consumed. */
    inputValue: money("input_value"),
    /** Milling overhead added on completion, at the rate then in force. */
    overheadValue: money("overhead_value"),
    /** (inputValue + overheadValue) ÷ actualOutputKg — the finished cost. */
    costPerKg: numeric("cost_per_kg", { precision: 18, scale: 6 }),
    journalEntryId: uuid("journal_entry_id"),

    completedAt: timestamp("completed_at"),
    completedBy: uuid("completed_by").references(() => users.id),
    voidReason: text("void_reason"),
    notes: text("notes"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [index("ix_production_order_status").on(t.status, t.orderDate)],
);

/**
 * What one order actually consumed, per ingredient.
 *
 * Written at completion, from the formula scaled by batch count and then adjusted
 * to whatever the floor really used. `plannedKg` is kept beside `actualKg` so a
 * mix that ran off recipe is visible rather than averaged away.
 */
export const productionOrderLines = pgTable(
  "production_order_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => productionOrders.id, { onDelete: "cascade" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id),
    plannedKg: qty("planned_kg").notNull(),
    actualKg: qty("actual_kg"),
    /** Weighted-average rate this material was carrying when consumed. */
    ratePerKg: numeric("rate_per_kg", { precision: 18, scale: 6 }),
    value: money("value"),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [uniqueIndex("uq_production_order_line").on(t.orderId, t.itemId)],
);

// ──────────────────────────── Feed to the shed ────────────────────────────

/**
 * Feed leaving the mill for a shed.
 *
 * Consumption, not a location transfer: it leaves inventory and becomes an
 * expense against the shed. That is why there is no location on the stock ledger
 * — nothing needs to know how much feed a shed is holding, because a shed holds
 * none. The moment it arrives it has been fed.
 *
 * The destination is a location so the cost lands on a real place; Farms will
 * read these rows to know what a shed was given.
 */
export const feedTransfers = pgTable(
  "feed_transfers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    number: varchar("number", { length: 30 }).notNull().unique(),
    transferDate: date("transfer_date").notNull(),
    /** The finished feed — a formula's output item. */
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id),
    quantityKg: qty("quantity_kg").notNull(),
    fromLocationId: uuid("from_location_id")
      .notNull()
      .references(() => locations.id),
    /** The shed. Where the feed is eaten. */
    toLocationId: uuid("to_location_id")
      .notNull()
      .references(() => locations.id),
    /** Weighted-average value at the moment it left. */
    ratePerKg: numeric("rate_per_kg", { precision: 18, scale: 6 }),
    value: money("value"),
    journalEntryId: uuid("journal_entry_id"),
    status: productionStatus("status").notNull().default("completed"),
    voidReason: text("void_reason"),
    notes: text("notes"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("ix_feed_transfer_date").on(t.transferDate)],
);

export type ItemNutrient = typeof itemNutrients.$inferSelect;
export type FeedStandard = typeof feedStandards.$inferSelect;
export type FeedStandardParam = typeof feedStandardParams.$inferSelect;
export type Formula = typeof formulas.$inferSelect;
export type FormulaLine = typeof formulaLines.$inferSelect;
export type ProductionOrder = typeof productionOrders.$inferSelect;
export type FeedTransfer = typeof feedTransfers.$inferSelect;
