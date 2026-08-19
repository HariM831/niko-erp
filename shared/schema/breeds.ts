/**
 * Breeds, the standards a flock is measured against, and what a bird is worth.
 *
 * Kept apart from `farms.ts` (places) and `flocks.ts` (cohorts) because this is
 * reference data: it is edited in settings, it changes rarely, and it is read
 * by everything.
 */
import {
  boolean,
  date,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./auth";

export const breeds = pgTable("breeds", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  isActive: boolean("is_active").notNull().default(true),
});

/**
 * A published performance curve, versioned.
 *
 * Versioning is not neatness. A flock pins the set it was placed under, so
 * revising the breeder's guide next year cannot silently restate what a flock
 * placed this year was measured against — a "vs standard" history means nothing
 * if the standard moves underneath it. Editing a set any flock is pinned to
 * clones it as a new version rather than mutating in place.
 */
export const standardSets = pgTable(
  "standard_sets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    breedId: uuid("breed_id")
      .notNull()
      .references(() => breeds.id),
    name: text("name").notNull(),
    /** "breeder" | "in-house" | "blend" */
    source: text("source"),
    version: integer("version").notNull().default(1),
    effectiveFrom: date("effective_from"),
    isDefault: boolean("is_default").notNull().default(false),
    note: text("note"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_standard_sets_name").on(t.breedId, t.name, t.version),
    // One default per breed, decided by the database rather than by whoever
    // last saved the screen.
    uniqueIndex("uq_standard_sets_default").on(t.breedId).where(sql`${t.isDefault}`),
  ],
);

export const STANDARD_SOURCES = ["breeder", "in-house", "blend"] as const;

/**
 * One row per age week.
 *
 * The composite primary key is the whole point. The table this replaces had no
 * uniqueness on (breed, week), and every reader did `find(p => p.week === w)` —
 * which quietly takes the first of a duplicate pair after somebody imports the
 * same CSV twice, and then reports against it for a year.
 */
export const standardPoints = pgTable(
  "standard_points",
  {
    setId: uuid("set_id")
      .notNull()
      .references(() => standardSets.id, { onDelete: "cascade" }),
    ageWeek: integer("age_week").notNull(),
    bodyWeightG: numeric("body_weight_g", { precision: 8, scale: 1 }),
    /** The number that actually predicts a good lay curve during rearing. */
    uniformityCvPct: numeric("uniformity_cv_pct", { precision: 5, scale: 2 }),
    feedGPerBirdDay: numeric("feed_g_per_bird_day", { precision: 6, scale: 2 }),
    waterMlPerBirdDay: numeric("water_ml_per_bird_day", { precision: 7, scale: 2 }),
    layPct: numeric("lay_pct", { precision: 5, scale: 2 }),
    eggWeightG: numeric("egg_weight_g", { precision: 6, scale: 2 }),
    cumMortalityPct: numeric("cum_mortality_pct", { precision: 5, scale: 2 }),
  },
  (t) => [primaryKey({ columns: [t.setId, t.ageWeek] })],
);

/** The columns of a standard curve, in the order the grid shows them. */
export const STANDARD_METRICS = [
  { key: "bodyWeightG", label: "Body wt", unit: "g" },
  { key: "uniformityCvPct", label: "CV", unit: "%" },
  { key: "feedGPerBirdDay", label: "Feed", unit: "g/b/d" },
  { key: "waterMlPerBirdDay", label: "Water", unit: "mL/b/d" },
  { key: "layPct", label: "Lay", unit: "%" },
  { key: "eggWeightG", label: "Egg wt", unit: "g" },
  { key: "cumMortalityPct", label: "Cum mort", unit: "%" },
] as const;
export type StandardMetric = (typeof STANDARD_METRICS)[number]["key"];

/**
 * What a bird is worth, by breed and age week.
 *
 * Edited on the same grid as the benchmarks above, stored apart because it
 * obeys the opposite rule: a benchmark is pinned at placement, a valuation is
 * whatever is true today. `effectiveFrom` is what makes "today" safe — a new
 * rate carries live flocks forward from its date and leaves closed periods
 * alone, which matters because this app locks periods. Restating history stays
 * possible; it just has to be deliberate, by backdating.
 */
export const birdValuationRates = pgTable(
  "bird_valuation_rates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    breedId: uuid("breed_id")
      .notNull()
      .references(() => breeds.id),
    ageWeek: integer("age_week").notNull(),
    /** numeric, not float: it is money multiplied by a bird count. */
    rate: numeric("rate", { precision: 14, scale: 2 }).notNull(),
    effectiveFrom: date("effective_from").notNull(),
    note: text("note"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_bird_valuation").on(t.breedId, t.ageWeek, t.effectiveFrom),
    index("ix_bird_valuation_lookup").on(t.breedId, t.ageWeek, t.effectiveFrom),
  ],
);

/**
 * Why a bird died. Mandatory on every mortality and cull row, enforced by a
 * CHECK rather than by the form.
 *
 * "3 dead" tells you nothing. "3 prolapse" tells you the lighting programme is
 * wrong. This is the highest-value field the rebuild adds.
 */
export const mortalityCauses = pgTable("mortality_causes", {
  code: text("code").primaryKey(),
  label: text("label").notNull(),
  /** disease | environment | management | predation | unknown */
  category: text("category").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
});

export const MORTALITY_CATEGORIES = [
  "disease",
  "environment",
  "management",
  "predation",
  "unknown",
] as const;
