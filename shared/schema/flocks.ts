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
  pgTable,
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
    /** Pinned at placement, never repointed when a standard is revised. */
    standardSetId: uuid("standard_set_id")
      .notNull()
      .references(() => standardSets.id),
    hatchDate: date("hatch_date").notNull(),
    /** "doc" | "purchased_pullet" | "opening" */
    origin: text("origin").notNull(),
    originRef: text("origin_ref"),
    placedCount: integer("placed_count").notNull(),
    /**
     * "rearing" | "laying" | "depleted". Comes from the flock's own age and
     * history — never from the kind of house it is sitting in.
     */
    status: text("status").notNull().default("rearing"),
    layStartDate: date("lay_start_date"),
    depletedOn: date("depleted_on"),
    note: text("note"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("ix_flocks_location_status").on(t.locationId, t.status)],
);

export const FLOCK_ORIGINS = ["doc", "purchased_pullet", "opening"] as const;
export type FlockOrigin = (typeof FLOCK_ORIGINS)[number];
export const FLOCK_ORIGIN_LABELS: Record<FlockOrigin, string> = {
  doc: "Day-old chicks",
  purchased_pullet: "Purchased pullets",
  opening: "Opening balance",
};

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
