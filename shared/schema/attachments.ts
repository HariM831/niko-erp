import {
  bigint,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { users } from "./auth";

/** File attachments on any document (invoice, bill, expense, journal...). */
export const attachments = pgTable(
  "attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
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
  },
  (t) => [index("ix_attachments_entity").on(t.entityType, t.entityId)],
);
