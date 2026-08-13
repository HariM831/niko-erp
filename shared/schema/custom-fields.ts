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
import { customFieldDataType } from "./enums";

/**
 * A user-defined field on a document or master record — Zoho's "Fields" tab.
 *
 * Custom fields are document metadata and never reach the ledger: nothing here
 * affects totals, tax or posting. Anything that should slice the P&L is a
 * reporting tag instead.
 */
export const customFields = pgTable(
  "custom_fields",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Which record type the field belongs to, from shared/entities.ts. */
    entity: varchar("entity", { length: 40 }).notNull(),
    label: text("label").notNull(),
    dataType: customFieldDataType("data_type").notNull(),
    isMandatory: boolean("is_mandatory").notNull().default(false),
    /** Print on the document as well as showing on screen. */
    showInPdf: boolean("show_in_pdf").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    /** Shown under the input on the form. */
    helpText: text("help_text"),

    // Type-specific constraints, each meaningful only for some data types.
    maxLength: integer("max_length"),
    minValue: numeric("min_value", { precision: 18, scale: 4 }),
    maxValue: numeric("max_value", { precision: 18, scale: 4 }),
    /** For lookup fields: which entity the value points at. */
    lookupEntity: varchar("lookup_entity", { length: 40 }),

    /**
     * Auto-number settings. Its own counter rather than a document series: a
     * custom field numbering itself must not compete with the document's real
     * number, which is a different thing entirely.
     */
    numberPrefix: varchar("number_prefix", { length: 20 }),
    numberPadding: integer("number_padding").notNull().default(5),
    nextNumber: integer("next_number").notNull().default(1),

    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("uq_custom_field_label").on(t.entity, t.label)],
);

/** Choices for a dropdown or multi-select field. */
export const customFieldOptions = pgTable(
  "custom_field_options",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fieldId: uuid("field_id")
      .notNull()
      .references(() => customFields.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
  },
  (t) => [uniqueIndex("uq_custom_field_option").on(t.fieldId, t.label)],
);

/**
 * One field's value on one record.
 *
 * Stored in a typed column rather than a single text blob, so filtering and
 * reporting are real comparisons instead of string casts. Exactly one of the
 * value columns is populated, chosen by the field's data type.
 */
export const customFieldValues = pgTable(
  "custom_field_values",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fieldId: uuid("field_id")
      .notNull()
      .references(() => customFields.id, { onDelete: "cascade" }),
    /** The record this value belongs to; no FK, since the table varies. */
    entityId: uuid("entity_id").notNull(),

    valueText: text("value_text"),
    valueNumber: numeric("value_number", { precision: 18, scale: 4 }),
    valueDate: date("value_date"),
    valueTimestamp: timestamp("value_timestamp"),
    valueBool: boolean("value_bool"),
    /** Dropdown selection. */
    optionId: uuid("option_id").references(() => customFieldOptions.id),
    /** Lookup target's id — no FK, the table depends on the field's config. */
    valueLookupId: uuid("value_lookup_id"),

    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("uq_custom_field_value").on(t.fieldId, t.entityId)],
);

/** Multi-select picks, one row per chosen option. */
export const customFieldValueOptions = pgTable(
  "custom_field_value_options",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    valueId: uuid("value_id")
      .notNull()
      .references(() => customFieldValues.id, { onDelete: "cascade" }),
    optionId: uuid("option_id")
      .notNull()
      .references(() => customFieldOptions.id),
  },
  (t) => [uniqueIndex("uq_custom_field_value_option").on(t.valueId, t.optionId)],
);

/**
 * Records picked by a multi-select lookup field. Mirrors how multi-select
 * options are stored, but pointing at master data instead of choices. Order of
 * insertion is preserved, so "Farm A, Farm C" reads back as entered.
 */
export const customFieldValueLookups = pgTable(
  "custom_field_value_lookups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    valueId: uuid("value_id")
      .notNull()
      .references(() => customFieldValues.id, { onDelete: "cascade" }),
    /** No FK: the target table depends on the field's lookupEntity. */
    lookupId: uuid("lookup_id").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [uniqueIndex("uq_custom_field_value_lookup").on(t.valueId, t.lookupId)],
);
