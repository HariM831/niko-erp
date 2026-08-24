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
  varchar,
} from "drizzle-orm/pg-core";
import { users } from "./auth";
import { houses } from "./farms";
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

/**
 * Dr niko: a field observation sent for diagnosis.
 *
 * A worker photographs what they found — a post-mortem, wet litter, a bird
 * that looks wrong — and the observation goes to a model along with the
 * flock's own numbers for a first opinion. The photos live in `attachments`
 * under entity_type 'ai_observation'; this row is the observation itself and
 * what the model said.
 *
 * Keyed to the HOUSE, not the placement: the person in the shed knows which
 * shed they are standing in and nothing else. The analyze step resolves which
 * placement held birds there that day and builds the clinical context from its
 * flock_day rows.
 */
export const aiObservations = pgTable(
  "ai_observations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    houseId: uuid("house_id")
      .notNull()
      .references(() => houses.id),
    observedOn: date("observed_on").notNull(),
    /** What the person saw, in their own words. The model gets it too. */
    note: text("note"),
    /** The model's answer, verbatim. */
    aiRemark: text("ai_remark"),
    /** Who answered — recorded per row so a change in behaviour stays attributable. */
    aiModel: text("ai_model"),
    analyzedAt: timestamp("analyzed_at", { withTimezone: true }),
    submittedBy: uuid("submitted_by")
      .notNull()
      .references(() => users.id),
    /** Amino's observation id, so the import can run twice without doubling. */
    legacyId: varchar("legacy_id", { length: 40 }).unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ix_ai_observations_house").on(t.houseId, t.observedOn)],
);
