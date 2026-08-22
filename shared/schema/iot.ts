/**
 * The sheds' own instruments.
 *
 * Big Herdsman controllers report temperature, humidity, CO2, pressure, water
 * and feed for every house every few minutes. The vendor keeps roughly six
 * weeks of it and then discards it, so anything not pulled across is gone —
 * which is why capture came before anything clever is done with it.
 *
 * Written only by `server/services/iot/*`. A tag's name is kept verbatim as
 * the controller reports it; see the migration for why.
 */
import {
  bigserial,
  boolean,
  date,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { houses } from "./farms";

/** The latest value of every tag — a dial on a wall, not a record. */
export const iotReadings = pgTable(
  "iot_readings",
  {
    houseId: uuid("house_id")
      .notNull()
      .references(() => houses.id, { onDelete: "cascade" }),
    tagId: text("tag_id").notNull(),
    value: text("value"),
    /** The controller's own quality flag; zero means it does not stand behind it. */
    quality: integer("quality").notNull().default(0),
    unit: text("unit").notNull().default(""),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.houseId, t.tagId] })],
);

/**
 * Every reading kept, one row per house per instant.
 *
 * Wide, not tall. The tall shape this replaced stored one row per measurement
 * and cost 288 bytes to record 4 bytes of reading: the house id, the instant
 * and the tag name were re-stated for every value and then indexed together on
 * top. A year came to 4.9 GB. Paying that bookkeeping once per instant instead
 * of once per reading brings the same year to about 126 MB, and the age-based
 * thinning in `thinSamples` takes it to roughly 17 MB in steady state.
 *
 * It is also the shape the vendor answers history requests in, so a backfill
 * row maps across almost as it arrives.
 *
 * The columns are declared by `SAMPLE_COLUMNS` in `server/services/iot/bhfarm.ts`
 * and must stay in step with it; adding a tag is a migration, which is the
 * price of not storing its name a hundred thousand times a day.
 */
export const iotHouseSample = pgTable(
  "iot_house_sample",
  {
    houseId: uuid("house_id")
      .notNull()
      .references(() => houses.id, { onDelete: "cascade" }),
    at: timestamp("at", { withTimezone: true }).notNull(),

    tempC: real("temp_c"),
    targetTempC: real("target_temp_c"),
    humidityPct: real("humidity_pct"),
    co2Ppm: real("co2_ppm"),
    pressurePa: real("pressure_pa"),
    birdCount: real("bird_count"),
    birdAgeDays: real("bird_age_days"),
    feedPerBirdG: real("feed_per_bird_g"),
    waterPerBirdMl: real("water_per_bird_ml"),

    siloKg: real("silo_kg"),
    siloKg1: real("silo_kg_1"),
    siloKg2: real("silo_kg_2"),
    siloKg3: real("silo_kg_3"),
    siloKg4: real("silo_kg_4"),
    feedKg: real("feed_kg"),
    feedKg1: real("feed_kg_1"),
    feedKg2: real("feed_kg_2"),
    feedKg3: real("feed_kg_3"),
    feedKg4: real("feed_kg_4"),
    waterL: real("water_l"),
    waterL1: real("water_l_1"),
    waterL2: real("water_l_2"),
    waterL3: real("water_l_3"),
    waterL4: real("water_l_4"),

    ventLevel: real("vent_level"),
    ventRate: real("vent_rate"),
    mortalityToday: real("mortality_today"),
  },
  (t) => [
    // House and instant identify the row, so the key does the de-duplication a
    // separate unique index used to — running the backfill twice adds nothing.
    // No secondary index: every read is "this house, this stretch of time",
    // which is exactly what the key's own order serves. The thinning's index is
    // BRIN on `at`, declared in migration 0071 — Drizzle has no spelling for it.
    primaryKey({ columns: [t.houseId, t.at] }),
  ],
);

/**
 * What the instruments say a house did in a day.
 *
 * Deliberately not merged into `placement_days`. What a person wrote down and
 * what a sensor measured are two different claims, and the day they disagree
 * is the day you want both of them.
 */
export const iotHouseDay = pgTable(
  "iot_house_day",
  {
    houseId: uuid("house_id")
      .notNull()
      .references(() => houses.id, { onDelete: "cascade" }),
    day: date("day").notNull(),
    /** How many polls landed in the day — an average over four is not one over two hundred. */
    samples: integer("samples").notNull().default(0),

    tempAvg: numeric("temp_avg", { precision: 6, scale: 2 }),
    tempMin: numeric("temp_min", { precision: 6, scale: 2 }),
    tempMax: numeric("temp_max", { precision: 6, scale: 2 }),
    humidityAvg: numeric("humidity_avg", { precision: 6, scale: 2 }),
    co2Avg: numeric("co2_avg", { precision: 8, scale: 2 }),
    co2Max: numeric("co2_max", { precision: 8, scale: 2 }),
    pressureAvg: numeric("pressure_avg", { precision: 8, scale: 2 }),

    /** The controller's own daily totals, not a sum of our samples. */
    waterL: numeric("water_l", { precision: 12, scale: 2 }),
    feedKg: numeric("feed_kg", { precision: 12, scale: 2 }),
    waterPerBirdMl: numeric("water_per_bird_ml", { precision: 10, scale: 2 }),
    feedPerBirdG: numeric("feed_per_bird_g", { precision: 10, scale: 2 }),
    /** What the silos weigh — the reading the 2026-07-16 tag rename broke. */
    siloKg: numeric("silo_kg", { precision: 12, scale: 2 }),

    /** The controller's own count and age, kept apart from the flock ledger's. */
    birdCount: integer("bird_count"),
    birdAgeDays: integer("bird_age_days"),

    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.houseId, t.day] }), index("ix_iot_house_day_day").on(t.day)],
);

/**
 * How the last poll went.
 *
 * A silent integration is indistinguishable from a working one until somebody
 * needs the data, by which time the vendor's window has closed.
 */
export const iotPollLog = pgTable(
  "iot_poll_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    ok: boolean("ok").notNull().default(false),
    houses: integer("houses").notNull().default(0),
    tags: integer("tags").notNull().default(0),
    readings: integer("readings").notNull().default(0),
    error: text("error"),
  },
  (t) => [index("ix_iot_poll_log_time").on(t.startedAt)],
);
