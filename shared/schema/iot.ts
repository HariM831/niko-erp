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
  text,
  timestamp,
  uniqueIndex,
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

/** Every reading, kept. This is the table the six-week window is about. */
export const iotHistory = pgTable(
  "iot_history",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    houseId: uuid("house_id")
      .notNull()
      .references(() => houses.id, { onDelete: "cascade" }),
    tagId: text("tag_id").notNull(),
    value: text("value"),
    quality: integer("quality").notNull().default(0),
    unit: text("unit").notNull().default(""),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The same instant twice is the same reading, however it arrived. Without
    // this, running the backfill twice doubles the history.
    uniqueIndex("uq_iot_history").on(t.houseId, t.tagId, t.recordedAt),
    index("ix_iot_history_house_time").on(t.houseId, t.recordedAt),
    // No index on tag alone: it was never once read and cost 189 MB. And the
    // prune's index is BRIN, declared in migration 0070 — Drizzle has no
    // spelling for it, and a btree there would cost more than it saves.
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
