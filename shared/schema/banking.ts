import {
  boolean,
  date,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { bankTxnDirection, bankTxnMatchStatus } from "./enums";
import { accounts, journalEntries } from "./accounting";

const money = (name: string) => numeric(name, { precision: 14, scale: 2 });

export const bankAccounts = pgTable("bank_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  kind: varchar("kind", { length: 10 }).notNull().default("bank"), // "bank" | "cash" | "card"
  bankName: text("bank_name"),
  accountNumber: varchar("account_number", { length: 30 }),
  ifsc: varchar("ifsc", { length: 11 }),
  branch: text("branch"),
  /** GL account this bank account posts to. */
  glAccountId: uuid("gl_account_id")
    .notNull()
    .references(() => accounts.id),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const bankTransactions = pgTable(
  "bank_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bankAccountId: uuid("bank_account_id")
      .notNull()
      .references(() => bankAccounts.id),
    txnDate: date("txn_date").notNull(),
    valueDate: date("value_date"),
    direction: bankTxnDirection("direction").notNull(),
    amount: money("amount").notNull(),
    utr: varchar("utr", { length: 40 }),
    description: text("description"),
    counterparty: text("counterparty"),
    /** Hash of (account, date, amount, utr/description) to dedupe re-imports. */
    importHash: varchar("import_hash", { length: 64 }),
    matchStatus: bankTxnMatchStatus("match_status")
      .notNull()
      .default("unmatched"),
    matchedJournalEntryId: uuid("matched_journal_entry_id").references(
      () => journalEntries.id,
    ),
    reconciledAt: timestamp("reconciled_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("ix_banktxn_account_date").on(t.bankAccountId, t.txnDate),
    index("ix_banktxn_hash").on(t.importHash),
  ],
);
