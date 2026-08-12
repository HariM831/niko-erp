import {
  boolean,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { journalEntryLines } from "./accounting";

/**
 * A reporting dimension — "Vehicle", "Shed", "Cost Centre". Costs and income
 * get tagged with one of its options so the P&L can be read per vehicle or per
 * shed without inventing a GL account for each one.
 *
 * This is what stops the chart of accounts sprouting a row per truck.
 */
export const reportingTags = pgTable("reporting_tags", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  description: text("description"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/** One value of a tag, e.g. "Creta - 3333" under "Vehicle". */
export const reportingTagOptions = pgTable(
  "reporting_tag_options",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => reportingTags.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [uniqueIndex("uq_tag_option").on(t.tagId, t.name)],
);

/**
 * Tags carried by one journal line.
 *
 * `tagId` is denormalised from the option so the unique index can enforce the
 * rule that matters: a line takes at most one option per tag. Without it a
 * line could be charged to two vehicles at once and every per-vehicle total
 * would double-count.
 */
export const journalEntryLineTags = pgTable(
  "journal_entry_line_tags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    lineId: uuid("line_id")
      .notNull()
      .references(() => journalEntryLines.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => reportingTags.id),
    optionId: uuid("option_id")
      .notNull()
      .references(() => reportingTagOptions.id),
  },
  (t) => [uniqueIndex("uq_line_tag").on(t.lineId, t.tagId)],
);
