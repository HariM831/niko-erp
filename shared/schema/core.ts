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
 * Atomic document numbering. One row per series; next number claimed with
 * UPDATE ... SET next_number = next_number + 1 RETURNING inside the caller's
 * transaction, so numbers are race-free.
 */
export const documentSeries = pgTable("document_series", {
  id: uuid("id").primaryKey().defaultRandom(),
  entity: varchar("entity", { length: 40 }).notNull().unique(),
  prefix: varchar("prefix", { length: 20 }).notNull(),
  nextNumber: integer("next_number").notNull().default(1),
  padding: integer("padding").notNull().default(5),
});

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
