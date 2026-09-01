/**
 * The flock spine: a cohort, where it has lived, and every bird in or out.
 *
 * The old model gave the bird count to the shed. That made a flock which moved
 * from a pullet house to a layer house into two unrelated records, so its
 * lifetime mortality, feed per bird and cost per egg all restarted at the move
 * — the one number anybody actually wants, broken at the one moment that
 * matters. Here the cohort owns its identity and the house is just where it
 * happens to be standing.
 */
import {
  date,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./auth";
import { breeds, mortalityCauses, standardSets } from "./breeds";
import { houses } from "./farms";
import { locations } from "./locations";

/** A cohort: one hatch date, one standard curve, one identity for life. */
export const flocks = pgTable(
  "flocks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull().unique(),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id),
    breedId: uuid("breed_id")
      .notNull()
      .references(() => breeds.id),
    /**
     * The breed's default curve, resolved once when the flock is placed and
     * never repointed afterwards. Null when the breed had no curve yet — a real
     * flock of birds should not be un-recordable because nobody has typed in a
     * benchmark.
     */
    standardSetId: uuid("standard_set_id").references(() => standardSets.id),
    /**
     * DERIVED — the bird-weighted average of `flockHatches`. Stored because it
     * is sorted and filtered on everywhere, and written by exactly one function
     * (`recomputeHatchProfile`) alongside `placedCount`. Nothing else may write
     * either, which is what keeps them from disagreeing with the hatch rows.
     */
    hatchDate: date("hatch_date").notNull(),
    /** DERIVED — the sum of `flockHatches.qty`. */
    placedCount: integer("placed_count").notNull(),
    /**
     * "rearing" | "laying" | "depleted". Comes from the flock's own age and
     * history — never from the kind of house it is sitting in.
     */
    status: text("status").notNull().default("rearing"),
    /**
     * The day the flock moved out of rearing and into a layer house. Distinct
     * from `layStartDate`: housed at 14 weeks, in lay around 18, and collapsing
     * the two makes every "age at first egg" figure wrong by a month.
     */
    housedOn: date("housed_on"),
    layStartDate: date("lay_start_date"),
    depletedOn: date("depleted_on"),
    note: text("note"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("ix_flocks_location_status").on(t.locationId, t.status)],
);

/**
 * The hatches a batch is made of.
 *
 * 10,000 chicks do not arrive on one day; they come as three or four hatches
 * across a week. Recording a single date makes the age wrong for most of the
 * birds, and age is what every standard comparison is keyed on — so the hatches
 * are the record and the flock's hatch date is their bird-weighted average.
 */
export const flockHatches = pgTable(
  "flock_hatches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    flockId: uuid("flock_id")
      .notNull()
      .references(() => flocks.id, { onDelete: "cascade" }),
    hatchDate: date("hatch_date").notNull(),
    qty: integer("qty").notNull(),
  },
  (t) => [
    uniqueIndex("uq_flock_hatches").on(t.flockId, t.hatchDate),
    index("ix_flock_hatches_flock").on(t.flockId, t.hatchDate),
  ],
);

/** A day number, so dates can be averaged without timezone arithmetic. */
const epochDay = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86_400_000);

/**
 * The bird-weighted average hatch date, and the total placed.
 *
 * Weighted, not the midpoint of the range: a batch of 9,000 hatched on Monday
 * and 1,000 on Friday is four days old on Friday, not two. Ties round to the
 * later day — a bird is not older than it is.
 */
export function hatchProfile(lines: Array<{ hatchDate: string; qty: number }>) {
  const total = lines.reduce((n, l) => n + l.qty, 0);
  if (!total) return null;
  const weighted = lines.reduce((n, l) => n + l.qty * epochDay(l.hatchDate), 0) / total;
  const avg = new Date(Math.round(weighted) * 86_400_000).toISOString().slice(0, 10);
  const dates = lines.map((l) => l.hatchDate).sort();
  return {
    placedCount: total,
    hatchDate: avg,
    firstHatch: dates[0]!,
    lastHatch: dates[dates.length - 1]!,
    /** How many days the batch is spread over. 0 when it is a single hatch. */
    spreadDays: epochDay(dates[dates.length - 1]!) - epochDay(dates[0]!),
  };
}

export const FLOCK_STATUSES = ["rearing", "laying", "depleted"] as const;
export type FlockStatus = (typeof FLOCK_STATUSES)[number];
export const FLOCK_STATUS_LABELS: Record<FlockStatus, string> = {
  rearing: "Rearing",
  laying: "Laying",
  depleted: "Depleted",
};

/**
 * A flock's occupancy of one house.
 *
 * A transfer closes one placement and opens another. It never edits a row, so
 * the timeline still reads correctly years later. A flock may be open in
 * several houses at once (a split) and a house may hold several flocks at once
 * (a merge); neither was representable before.
 */
export const flockPlacements = pgTable(
  "flock_placements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    flockId: uuid("flock_id")
      .notNull()
      .references(() => flocks.id),
    houseId: uuid("house_id")
      .notNull()
      .references(() => houses.id),
    fromDate: date("from_date").notNull(),
    /** Null while the flock is still in the house. */
    toDate: date("to_date"),
    note: text("note"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_flock_placements_open")
      .on(t.flockId, t.houseId)
      .where(sql`${t.toDate} IS NULL`),
    index("ix_flock_placements_house").on(t.houseId, t.fromDate),
    index("ix_flock_placements_flock").on(t.flockId, t.fromDate),
  ],
);

/**
 * Every bird that entered or left, and why. The bird count is derived from
 * this and stored nowhere, so there is no running total to drift out of step.
 *
 * `qty` is always positive; direction comes from `kind`. Storing a sign as well
 * as a kind gives the truth two places to live and one of them to be wrong.
 * `adjustment` is the single kind that can go either way, so it carries an
 * explicit sign — and a CHECK makes that column meaningless on every other kind.
 */
export const flockMovements = pgTable(
  "flock_movements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    placementId: uuid("placement_id")
      .notNull()
      .references(() => flockPlacements.id),
    eventDate: date("event_date").notNull(),
    kind: text("kind").notNull(),
    qty: integer("qty").notNull(),
    adjustmentSign: smallint("adjustment_sign"),
    /** Required on mortality and culls — the database refuses without it. */
    causeCode: text("cause_code").references(() => mortalityCauses.code),
    /** The other end of a transfer. A transfer with one end is a vanished bird. */
    counterpartPlacementId: uuid("counterpart_placement_id"),
    note: text("note"),
    recordedBy: uuid("recorded_by").references(() => users.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("ix_flock_movements_placement_date").on(t.placementId, t.eventDate)],
);

export const MOVEMENT_IN = ["place", "transfer_in"] as const;
export const MOVEMENT_OUT = [
  "mortality",
  "cull",
  "male_removal",
  "transfer_out",
  "depletion",
] as const;
export const MOVEMENT_KINDS = [...MOVEMENT_IN, ...MOVEMENT_OUT, "adjustment"] as const;
export type MovementKind = (typeof MOVEMENT_KINDS)[number];
export const MOVEMENT_KIND_LABELS: Record<MovementKind, string> = {
  place: "Placed",
  transfer_in: "Transferred in",
  mortality: "Mortality",
  cull: "Cull",
  male_removal: "Male removal",
  transfer_out: "Transferred out",
  depletion: "Depleted",
  adjustment: "Adjustment",
};

/**
 * One row per house per day: what was fed, drunk, laid and lost.
 *
 * The composite primary key is the fix for the duplicate-record bug. The table
 * this replaces had only non-unique indexes and leaned on an app-level check
 * comparing a UTC-parsed date against a server-local midnight, so on a non-UTC
 * server the same shed-day could be recorded twice with different numbers.
 *
 * Mortality is deliberately absent. It lives in `flockMovements` so it can
 * carry a cause, and so the bird count keeps coming from one ledger rather than
 * being split across two tables that can disagree. Saving a day writes both, in
 * one transaction.
 */
export const placementDays = pgTable(
  "placement_days",
  {
    placementId: uuid("placement_id")
      .notNull()
      .references(() => flockPlacements.id, { onDelete: "cascade" }),
    day: date("day").notNull(),
    feedConsumedKg: numeric("feed_consumed_kg", { precision: 10, scale: 2 }),
    /** What is left in the silo. The farm calls it "Stock". */
    feedClosingKg: numeric("feed_closing_kg", { precision: 10, scale: 2 }),
    /**
     * The day's water, in kilolitres.
     *
     * One number, because only one ever left this table anyway — every reader
     * summed the two tank meters and none of them cared which tank it came
     * from. The farm stopped wanting to split it, and the sensor cannot split
     * it, so the split is gone.
     */
    waterKl: numeric("water_kl", { precision: 10, scale: 2 }),
    /**
     * The two meters the operator used to read separately. Kept because 890
     * days of them are real and a dropped column is not recoverable; written
     * by nothing since 0085. Read through `water_kl`, which was backfilled
     * from their sum — never directly.
     */
    waterUpperKl: numeric("water_upper_kl", { precision: 10, scale: 2 }),
    waterLowerKl: numeric("water_lower_kl", { precision: 10, scale: 2 }),
    /** Nullable and unconstrained by house purpose — see the migration. */
    eggsTotal: integer("eggs_total"),
    eggsCracked: integer("eggs_cracked"),
    eggsDirty: integer("eggs_dirty"),
    note: text("note"),
    /** "manual" | "iot" | "import" */
    source: text("source").notNull().default("manual"),
    recordedBy: uuid("recorded_by").references(() => users.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.placementId, t.day] }), index("ix_placement_days_day").on(t.day)],
);

/** The kinds that must name a cause. */
export const CAUSE_REQUIRED: readonly string[] = ["mortality", "cull"];

/**
 * The signed effect of one movement on a bird count. The single place the sign
 * convention is applied — every caller derives counts through this.
 */
export function movementDelta(
  kind: string,
  qty: number,
  adjustmentSign?: number | null,
): number {
  if (kind === "adjustment") return qty * (adjustmentSign ?? 0);
  return (MOVEMENT_IN as readonly string[]).includes(kind) ? qty : -qty;
}
