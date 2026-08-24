import { index, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";

/**
 * Which Zoho record became which niko row.
 *
 * Migration scaffolding, deliberately kept out of the domain tables: adding a
 * `zohoId` column to contacts, items and every document type would leave a
 * permanent trace of a one-time job on the schema. This table can be dropped
 * once the books are cut over and nothing else will notice.
 *
 * It exists because the load has to be re-runnable. Fifteen thousand records
 * across a dozen entity types will not import in one clean pass, and a second
 * run must be able to tell what it already created from what it has not. Rows
 * are written inside the same transaction as the record they describe, so the
 * two can never disagree — a file on disk could claim something exists that a
 * rolled-back transaction never created.
 */
export const zohoIdMap = pgTable(
  "zoho_id_map",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The niko table this refers to: "account", "contact", "invoice"... */
    entity: varchar("entity", { length: 40 }).notNull(),
    /** Zoho's own id for the record. */
    zohoId: varchar("zoho_id", { length: 64 }).notNull(),
    /** The row created in niko. */
    eggsyId: uuid("eggsy_id").notNull(),
    /** Document number or name, purely so the table is readable by a person. */
    label: text("label"),
    importedAt: timestamp("imported_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_zoho_id_map").on(t.entity, t.zohoId),
    index("idx_zoho_id_map_eggsy").on(t.eggsyId),
  ],
);
