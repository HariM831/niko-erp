import { date, index, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { users } from "./auth";

/** User comments on any document — the "Comments & History" timeline. */
export const comments = pgTable(
  "comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entityType: varchar("entity_type", { length: 30 }).notNull(),
    entityId: uuid("entity_id").notNull(),
    /**
     * Only for `attendance_day`: the entity is the employee and this is the
     * day the comment is about. The day has no row of its own to point at.
     */
    entityDay: date("entity_day"),
    body: text("body").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("ix_comments_entity").on(t.entityType, t.entityId)],
);
