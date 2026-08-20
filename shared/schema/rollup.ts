/**
 * `flockDay` — the reporting surface.
 *
 * One row per placement per day, holding every figure a report needs already
 * worked out. The reports read this and nothing else, so no report does
 * arithmetic of its own and two of them cannot disagree.
 *
 * Written only by `refreshFlockDay` in server/services/rollup.ts. Nothing else
 * may insert or update here.
 */
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { flockPlacements } from "./flocks";

export const flockDay = pgTable(
  "flock_day",
  {
    placementId: uuid("placement_id")
      .notNull()
      .references(() => flockPlacements.id, { onDelete: "cascade" }),
    day: date("day").notNull(),

    flockId: uuid("flock_id").notNull(),
    houseId: uuid("house_id").notNull(),
    locationId: uuid("location_id").notNull(),
    /** "rear" | "lay" — from the flock's lay date, never the house's purpose. */
    phase: text("phase").notNull(),

    /** Week 1 is days 0–6, matching how breed guides are published. */
    ageDays: integer("age_days").notNull(),
    ageWeek: integer("age_week").notNull(),

    openingBirds: integer("opening_birds").notNull(),
    closingBirds: integer("closing_birds").notNull(),
    mortality: integer("mortality").notNull().default(0),
    culls: integer("culls").notNull().default(0),
    maleRemovals: integer("male_removals").notNull().default(0),
    transfersIn: integer("transfers_in").notNull().default(0),
    transfersOut: integer("transfers_out").notNull().default(0),

    eggs: integer("eggs"),
    eggsCracked: integer("eggs_cracked"),
    eggsDirty: integer("eggs_dirty"),
    /** Hen-day: eggs over the average of opening and closing birds. */
    hdPct: numeric("hd_pct", { precision: 6, scale: 2 }),
    /** Runs over the FLOCK, across every house — not the placement. */
    cumEggs: bigint("cum_eggs", { mode: "number" }).notNull().default(0),
    eggsPerHenHoused: numeric("eggs_per_hen_housed", { precision: 8, scale: 2 }),

    feedKg: numeric("feed_kg", { precision: 10, scale: 2 }),
    feedDeliveredKg: numeric("feed_delivered_kg", { precision: 10, scale: 2 }).notNull().default("0"),
    feedClosingKg: numeric("feed_closing_kg", { precision: 10, scale: 2 }),
    feedPerBirdG: numeric("feed_per_bird_g", { precision: 8, scale: 2 }),
    feedGPerEgg: numeric("feed_g_per_egg", { precision: 8, scale: 2 }),
    cumFeedKg: numeric("cum_feed_kg", { precision: 12, scale: 2 }).notNull().default("0"),
    cumFeedKgPerBird: numeric("cum_feed_kg_per_bird", { precision: 8, scale: 3 }),

    itemId: uuid("item_id"),
    feedCost: numeric("feed_cost", { precision: 14, scale: 2 }),
    /** The rate the day actually realised — an output of FIFO, not an input. */
    feedCostPerKg: numeric("feed_cost_per_kg", { precision: 10, scale: 4 }),
    feedCostIncomplete: boolean("feed_cost_incomplete").notNull().default(false),
    cfpe: numeric("cfpe", { precision: 10, scale: 4 }),
    cumFeedCost: numeric("cum_feed_cost", { precision: 14, scale: 2 }),
    cumCfpe: numeric("cum_cfpe", { precision: 10, scale: 4 }),

    waterL: numeric("water_l", { precision: 10, scale: 2 }),
    waterPerBirdMl: numeric("water_per_bird_ml", { precision: 10, scale: 2 }),
    waterFeedRatio: numeric("water_feed_ratio", { precision: 8, scale: 3 }),

    cumMortality: integer("cum_mortality").notNull().default(0),
    cumMortalityPct: numeric("cum_mortality_pct", { precision: 6, scale: 3 }),
    liveabilityPct: numeric("liveability_pct", { precision: 6, scale: 3 }),

    bodyWeightG: numeric("body_weight_g", { precision: 8, scale: 1 }),
    eggWeightG: numeric("egg_weight_g", { precision: 6, scale: 2 }),

    stdBodyWeightG: numeric("std_body_weight_g", { precision: 8, scale: 1 }),
    stdFeedGPerBird: numeric("std_feed_g_per_bird", { precision: 6, scale: 2 }),
    stdWaterMlPerBird: numeric("std_water_ml_per_bird", { precision: 7, scale: 2 }),
    stdLayPct: numeric("std_lay_pct", { precision: 5, scale: 2 }),
    stdEggWeightG: numeric("std_egg_weight_g", { precision: 6, scale: 2 }),
    stdCumMortalityPct: numeric("std_cum_mortality_pct", { precision: 5, scale: 2 }),

    refreshedAt: timestamp("refreshed_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.placementId, t.day] }),
    index("ix_flock_day_day").on(t.day),
    index("ix_flock_day_flock").on(t.flockId, t.day),
    index("ix_flock_day_house").on(t.houseId, t.day),
    index("ix_flock_day_location").on(t.locationId, t.day),
  ],
);
