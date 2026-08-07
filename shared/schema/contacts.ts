import {
  boolean,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { contactType, gstTreatment } from "./enums";

/** Zoho-style unified contact: customers and vendors share one table. */
export const contacts = pgTable("contacts", {
  id: uuid("id").primaryKey().defaultRandom(),
  type: contactType("type").notNull(),
  displayName: text("display_name").notNull(),
  companyName: text("company_name"),
  email: text("email"),
  phone: text("phone"),
  mobile: text("mobile"),
  website: text("website"),
  gstTreatment: gstTreatment("gst_treatment").notNull().default("consumer"),
  gstin: varchar("gstin", { length: 15 }),
  pan: varchar("pan", { length: 10 }),
  placeOfSupplyState: varchar("place_of_supply_state", { length: 4 }),
  currency: varchar("currency", { length: 3 }).notNull().default("INR"),
  /** Net days for due-date computation; 0 = due on receipt. */
  paymentTermsDays: integer("payment_terms_days").notNull().default(0),
  creditLimit: numeric("credit_limit", { precision: 14, scale: 2 }),
  openingBalance: numeric("opening_balance", { precision: 14, scale: 2 })
    .notNull()
    .default("0"),
  notes: text("notes"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const contactPersons = pgTable("contact_persons", {
  id: uuid("id").primaryKey().defaultRandom(),
  contactId: uuid("contact_id")
    .notNull()
    .references(() => contacts.id, { onDelete: "cascade" }),
  salutation: varchar("salutation", { length: 10 }),
  firstName: text("first_name").notNull(),
  lastName: text("last_name"),
  email: text("email"),
  phone: text("phone"),
  isPrimary: boolean("is_primary").notNull().default(false),
});

export const contactAddresses = pgTable("contact_addresses", {
  id: uuid("id").primaryKey().defaultRandom(),
  contactId: uuid("contact_id")
    .notNull()
    .references(() => contacts.id, { onDelete: "cascade" }),
  kind: varchar("kind", { length: 10 }).notNull(), // "billing" | "shipping"
  attention: text("attention"),
  line1: text("line1"),
  line2: text("line2"),
  city: text("city"),
  state: text("state"),
  pincode: varchar("pincode", { length: 10 }),
  country: text("country").default("India"),
  phone: text("phone"),
  isDefault: boolean("is_default").notNull().default(false),
});
