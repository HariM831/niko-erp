import {
  boolean,
  date,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

/** Singleton row (id = "default") holding the organisation profile. */
export const orgProfile = pgTable("org_profile", {
  id: varchar("id", { length: 32 }).primaryKey().default("default"),
  name: text("name").notNull().default(""),
  legalName: text("legal_name"),
  address: text("address"),
  city: text("city"),
  state: text("state"),
  stateCode: varchar("state_code", { length: 4 }),
  pincode: varchar("pincode", { length: 10 }),
  phone: text("phone"),
  email: text("email"),
  gstin: varchar("gstin", { length: 15 }),
  pan: varchar("pan", { length: 10 }),
  logoUrl: text("logo_url"),
  baseCurrency: varchar("base_currency", { length: 3 }).notNull().default("INR"),
  fiscalYearStart: varchar("fiscal_year_start", { length: 5 })
    .notNull()
    .default("04-01"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const financialYears = pgTable("financial_years", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  startDate: date("start_date").notNull(),
  endDate: date("end_date").notNull(),
  isActive: boolean("is_active").notNull().default(false),
  /** Transactions on or before this date are locked (Zoho "transaction locking"). */
  lockedThrough: date("locked_through"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/**
 * Per-module transaction locking. One row per module; nothing may post, edit or
 * void on or before `lockedThrough` for that module. Zoho locks Sales, Purchases,
 * Banking and Accountant independently, with a "lock everything" convenience that
 * simply sets the same date on all four.
 */
export const transactionLocks = pgTable("transaction_locks", {
  module: varchar("module", { length: 20 }).primaryKey(),
  lockedThrough: date("locked_through"),
  reason: text("reason"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/**
 * A budget is a set of target amounts per account per period. Actuals are never
 * stored here — they're aggregated from posted journal lines at read time, so a
 * budget can never drift from the ledger it's compared against.
 */
export const budgets = pgTable("budgets", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  startDate: date("start_date").notNull(),
  endDate: date("end_date").notNull(),
  /** How the range is sliced for entry and reporting. */
  period: varchar("period", { length: 12 }).notNull().default("monthly"),
  /** Budget balance-sheet accounts too, not just income and expense. */
  includeBalanceSheet: boolean("include_balance_sheet").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const budgetLines = pgTable(
  "budget_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    budgetId: uuid("budget_id")
      .notNull()
      .references(() => budgets.id, { onDelete: "cascade" }),
    accountId: uuid("account_id").notNull(),
    /** First day of the period this figure covers. */
    periodStart: date("period_start").notNull(),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull().default("0"),
  },
  (t) => [uniqueIndex("uq_budget_line").on(t.budgetId, t.accountId, t.periodStart)],
);

/**
 * A named set of document numbers, e.g. "Default", "Eggs", "Feed". Zoho lets an
 * organisation run several in parallel so each line of business gets its own
 * numbering; the transaction picks which one to draw from.
 */
export const numberSeries = pgTable("number_series", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  /** Used when a transaction doesn't name a series. Exactly one row should be true. */
  isDefault: boolean("is_default").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/**
 * Atomic document numbering: one row per series per document type. The next
 * number is claimed with UPDATE ... SET next_number = next_number + 1 RETURNING
 * inside the caller's transaction, so numbers are race-free.
 */
export const documentSeries = pgTable(
  "document_series",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    seriesId: uuid("series_id")
      .notNull()
      .references(() => numberSeries.id, { onDelete: "cascade" }),
    entity: varchar("entity", { length: 40 }).notNull(),
    prefix: varchar("prefix", { length: 20 }).notNull(),
    nextNumber: integer("next_number").notNull().default(1),
    padding: integer("padding").notNull().default(5),
  },
  (t) => [uniqueIndex("uq_document_series").on(t.seriesId, t.entity)],
);

export const taxes = pgTable(
  "taxes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    /** Total rate in percent, e.g. 18.00 for GST 18. */
    rate: numeric("rate", { precision: 6, scale: 3 }).notNull(),
    /** true for GST group taxes split CGST/SGST intra-state. */
    isGstGroup: boolean("is_gst_group").notNull().default(true),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("uq_taxes_name_rate").on(t.name, t.rate)],
);
