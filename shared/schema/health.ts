/**
 * Weighings and vaccination.
 *
 * Both are keyed to the PLACEMENT rather than the shed. In the app these come
 * from they belonged to a shed, so a flock's weight history restarted when it
 * moved into the layer house — the same break that made lifetime mortality
 * unusable. Keyed to the placement the series follows the birds, and the screen
 * that wants them by shed gets them grouped in the adapter.
 */
import {
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
import { flockPlacements } from "./flocks";

export const birdWeighings = pgTable(
  "bird_weighings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    placementId: uuid("placement_id")
      .notNull()
      .references(() => flockPlacements.id, { onDelete: "cascade" }),
    weekNumber: integer("week_number").notNull(),
    weighedOn: date("weighed_on").notNull(),
    /** Grams. numeric, not real — it is compared against a standard to one
     *  decimal, and float drift shows up in the comparison. */
    avgWeightG: numeric("avg_weight_g", { precision: 8, scale: 1 }),
    /** Layers only; a rearing weighing leaves it null rather than zero. */
    eggWeightG: numeric("egg_weight_g", { precision: 6, scale: 2 }),
    sampleSize: integer("sample_size"),
    note: text("note"),
    recordedBy: uuid("recorded_by").references(() => users.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_bird_weighings").on(t.placementId, t.weekNumber),
    index("ix_bird_weighings_placement").on(t.placementId, t.weekNumber),
  ],
);

/**
 * The programme — which vaccine is due at what age.
 *
 * `age` is free text ("Day 1", "Week 6") rather than a parsed number, because
 * that is how it reads on the sheet pinned up in the shed, and turning it into
 * a number would mean guessing at the ones that do not parse.
 */
export const vaccineStandards = pgTable("vaccine_standards", {
  id: uuid("id").primaryKey().defaultRandom(),
  age: text("age").notNull(),
  vaccineName: text("vaccine_name").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
});

/** What was actually given. */
export const vaccinationEvents = pgTable(
  "vaccination_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    placementId: uuid("placement_id")
      .notNull()
      .references(() => flockPlacements.id, { onDelete: "cascade" }),
    eventDate: date("event_date").notNull(),
    vaccineName: text("vaccine_name").notNull(),
    make: text("make"),
    birdsVaccinated: integer("birds_vaccinated"),
    vaccinatorCount: integer("vaccinator_count"),
    laboursCount: integer("labours_count"),
    imageUrl: text("image_url"),
    note: text("note"),
    recordedBy: uuid("recorded_by").references(() => users.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("ix_vaccination_events_placement").on(t.placementId, t.eventDate)],
);
