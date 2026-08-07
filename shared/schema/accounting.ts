import {
  boolean,
  date,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { accountType, journalSourceType, journalStatus } from "./enums";
import { users } from "./auth";

export const accounts = pgTable("accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 12 }).notNull().unique(),
  name: text("name").notNull(),
  type: accountType("type").notNull(),
  parentId: uuid("parent_id"),
  /** Stable key for programmatic posting (e.g. "ar", "ap", "cash_bank"). */
  systemKey: varchar("system_key", { length: 40 }).unique(),
  description: text("description"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
// NOTE: no `balance` column by design. Balances are always aggregated from
// journal_entry_lines so they can never drift from the ledger.

export const journalEntries = pgTable(
  "journal_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entryNumber: varchar("entry_number", { length: 30 }).notNull().unique(),
    entryDate: date("entry_date").notNull(),
    status: journalStatus("status").notNull().default("draft"),
    narration: text("narration").notNull(),
    reference: text("reference"),
    sourceType: journalSourceType("source_type").notNull().default("manual"),
    /** id of the originating document (invoice, bill, payment...) if any. */
    sourceId: uuid("source_id"),
    isReversal: boolean("is_reversal").notNull().default(false),
    reversesEntryId: uuid("reverses_entry_id"),
    postedBy: uuid("posted_by")
      .notNull()
      .references(() => users.id),
    postedAt: timestamp("posted_at").notNull().defaultNow(),
  },
  (t) => [
    index("ix_je_date").on(t.entryDate),
    index("ix_je_source").on(t.sourceType, t.sourceId),
  ],
);

export const journalEntryLines = pgTable(
  "journal_entry_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entryId: uuid("entry_id")
      .notNull()
      .references(() => journalEntries.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    debit: numeric("debit", { precision: 14, scale: 2 }).notNull().default("0"),
    credit: numeric("credit", { precision: 14, scale: 2 })
      .notNull()
      .default("0"),
    description: text("description"),
    /** Zoho "reporting tag" style dimension, optional. */
    tag: varchar("tag", { length: 60 }),
    lineOrder: integer("line_order").notNull().default(0),
  },
  (t) => [index("ix_jel_account").on(t.accountId)],
);
