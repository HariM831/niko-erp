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
  /**
   * Where money owed to this vendor is sent.
   *
   * Held on the contact rather than derived from the name, because a bank
   * credits on the name it holds, not the one we trade under: the beneficiary
   * name has to be typed as the passbook prints it or the transfer bounces.
   * Read by the purchase payment file — see server/services/payment-file.ts.
   */
  bankBeneficiaryName: text("bank_beneficiary_name"),
  bankAccountNumber: varchar("bank_account_number", { length: 30 }),
  bankIfsc: varchar("bank_ifsc", { length: 11 }),
  bankName: text("bank_name"),
  /**
   * One of the group's own companies — Nandamuri, Luit Valley. Their
   * documents post to the GL like anyone's, but they are the group, not the
   * market: excluded from every customer- and vendor-scoped list, report and
   * KPI. Their ledger lives on its own page under Accountant.
   */
  isGroupCompany: boolean("is_group_company").notNull().default(false),
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
