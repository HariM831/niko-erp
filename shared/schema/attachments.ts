import {
  bigint,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { users } from "./auth";
import { locations } from "./locations";

/** File attachments on any document (invoice, bill, expense, journal...). */
export const attachments = pgTable(
  "attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
  /**
   * Filing reference, written on the physical sheet before it goes in the box.
   * Unique and never reused, so a number on paper always finds one scan.
   */
  filingRef: varchar("filing_ref", { length: 30 }).unique(),
    entityType: varchar("entity_type", { length: 30 }).notNull(),
    entityId: uuid("entity_id").notNull(),
    fileName: text("file_name").notNull(),
    /** Random name on disk — original names are never used as paths. */
    storedName: varchar("stored_name", { length: 80 }).notNull().unique(),
    mimeType: varchar("mime_type", { length: 100 }).notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    uploadedBy: uuid("uploaded_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),

    // ── Field capture ────────────────────────────────────────────────────
    // Set when a photo was taken somewhere rather than uploaded at a desk.
    // Kept here rather than in a office-only table because a QC sample,
    // a shed inspection and a fixed-asset photo all want the same six facts.
    /** What this photo is of, e.g. "gate_in_bill", "gate_in_vehicle". */
    kind: varchar("kind", { length: 30 }),
    /** Device clock at the moment of capture; may precede createdAt. */
    capturedAt: timestamp("captured_at"),
    latitude: numeric("latitude", { precision: 10, scale: 7 }),
    longitude: numeric("longitude", { precision: 10, scale: 7 }),
    accuracyM: numeric("accuracy_m", { precision: 8, scale: 2 }),
    /**
     * The place the fix resolved to. This is the authoritative record of where
     * the photo was taken — the band burnt into the image is a copy for whoever
     * is holding a printout, never the thing the system reasons about.
     */
    locationId: uuid("location_id").references(() => locations.id),
  },
  (t) => [index("ix_attachments_entity").on(t.entityType, t.entityId)],
);
