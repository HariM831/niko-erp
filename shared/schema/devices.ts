/**
 * Field devices and the canteen.
 *
 * One registry for every paired phone — a gate phone and a canteen phone are
 * the same app with a different role carried by the token. Amino grew three
 * registries and three pairing flows on the way to this one; only the unified
 * set comes across. The wire contract of /api/device/* (UNIFIED-00-CONTRACT)
 * is preserved so the Android app needs no change: its `siteCode` is our
 * `locations.code`, its `personKind` is answered from `employees.pay_type`.
 *
 * Device-generated ids (events, plates) are kept in `client_id` as the
 * idempotency key; a retried batch is harmless.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { users } from "./auth";
import { locations } from "./locations";
import { employees } from "./payroll";

export const deviceRole = pgEnum("device_role", ["gate", "canteen"]);
export const pairingStatus = pgEnum("pairing_status", ["unused", "claimed", "pending", "expired", "rejected"]);
export const requestStatus = pgEnum("device_request_status", ["pending", "approved", "rejected", "expired"]);
export const meal = pgEnum("meal", ["breakfast", "lunch", "dinner"]);
/** verified = face; name_matched = operator picked a name; override = no gate punch; guest. */
export const servingState = pgEnum("serving_state", ["verified", "name_matched", "unverified_attendance", "override", "guest"]);
export const extraPlateKind = pgEnum("extra_plate_kind", ["guest", "second_plate", "override"]);

export const canteens = pgTable("canteens", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 12 }).notNull().unique(),
  name: text("name").notNull(),
  locationId: uuid("location_id")
    .notNull()
    .references(() => locations.id),
  isActive: boolean("is_active").notNull().default(true),
});

export const devices = pgTable("devices", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  role: deviceRole("role").notNull(),
  locationId: uuid("location_id")
    .notNull()
    .references(() => locations.id),
  /** Required when role = canteen. */
  canteenId: uuid("canteen_id").references(() => canteens.id),
  tokenHash: varchar("token_hash", { length: 64 }).notNull(),
  installId: text("install_id"),
  deviceModel: text("device_model"),
  appVersionCode: integer("app_version_code"),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** A short single-use code; claiming one with `targetDeviceId` rotates that device's token. */
export const pairingCodes = pgTable("pairing_codes", {
  id: uuid("id").primaryKey().defaultRandom(),
  codeHash: varchar("code_hash", { length: 64 }).notNull().unique(),
  codeLast4: varchar("code_last4", { length: 4 }).notNull(),
  deviceName: text("device_name").notNull(),
  role: deviceRole("role").notNull(),
  locationId: uuid("location_id")
    .notNull()
    .references(() => locations.id),
  canteenId: uuid("canteen_id").references(() => canteens.id),
  targetDeviceId: uuid("target_device_id").references(() => devices.id),
  status: pairingStatus("status").notNull().default("unused"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** A pairing that needs an admin's yes. `issuedToken` is read once by the device's poll, then nulled. */
export const deviceRequests = pgTable("device_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  codeId: uuid("code_id")
    .notNull()
    .references(() => pairingCodes.id),
  installId: text("install_id"),
  deviceModel: text("device_model"),
  osVersion: text("os_version"),
  appVersionCode: integer("app_version_code"),
  latitude: real("latitude"),
  longitude: real("longitude"),
  status: requestStatus("status").notNull().default("pending"),
  deviceId: uuid("device_id").references(() => devices.id),
  issuedToken: text("issued_token"),
  decidedBy: uuid("decided_by").references(() => users.id),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * PINs pushed to every phone at a site so it can verify offline:
 * sha256(salt || pin). Guards a plate of food, not money.
 */
export const staffPins = pgTable("staff_pins", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  locationId: uuid("location_id")
    .notNull()
    .references(() => locations.id),
  /** Null = every phone at the site. */
  canteenId: uuid("canteen_id").references(() => canteens.id),
  saltHex: varchar("salt_hex", { length: 32 }).notNull(),
  pinHash: varchar("pin_hash", { length: 64 }).notNull(),
  canUnlock: boolean("can_unlock").notNull().default(true),
  canAuthorise: boolean("can_authorise").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Served in /api/device/config. `not_in_system` is the canteen telling the gate whom to enrol. */
export const reasonCodes = pgTable("reason_codes", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 40 }).notNull().unique(),
  label: text("label").notNull(),
  requiresText: boolean("requires_text").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  displayOrder: integer("display_order").notNull().default(0),
});

/** `canteenId` null = the default a canteen-specific row overrides. */
export const canteenMealWindows = pgTable(
  "canteen_meal_windows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    canteenId: uuid("canteen_id").references(() => canteens.id),
    meal: meal("meal").notNull(),
    startTime: varchar("start_time", { length: 5 }).notNull(),
    endTime: varchar("end_time", { length: 5 }).notNull(),
    isActive: boolean("is_active").notNull().default(true),
  },
  (t) => [uniqueIndex("uq_meal_windows").on(t.canteenId, t.meal)],
);

/** Lunch is universal for anyone present; only breakfast/dinner exceptions live here. */
export const canteenMealEligibility = pgTable("canteen_meal_eligibility", {
  employeeId: uuid("employee_id")
    .primaryKey()
    .references(() => employees.id),
  breakfast: boolean("breakfast").notNull().default(false),
  dinner: boolean("dinner").notNull().default(false),
  note: text("note"),
  updatedBy: uuid("updated_by").references(() => users.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** One row per plate. */
export const canteenServings = pgTable(
  "canteen_servings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: varchar("client_id", { length: 64 }).notNull().unique(),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id),
    canteenId: uuid("canteen_id")
      .notNull()
      .references(() => canteens.id),
    mealDate: date("meal_date").notNull(),
    meal: meal("meal").notNull(),
    /** Null for guests. */
    employeeId: uuid("employee_id").references(() => employees.id),
    /** Guests have no row to join to. */
    personName: text("person_name").notNull(),
    state: servingState("state").notNull(),
    matchScore: real("match_score"),
    servedAt: timestamp("served_at", { withTimezone: true }).notNull(),
    tokenNumber: varchar("token_number", { length: 20 }).notNull(),
    outsideWindow: boolean("outside_window").notNull().default(false),
    extraPlateKind: extraPlateKind("extra_plate_kind"),
    guestBatchId: varchar("guest_batch_id", { length: 64 }),
    guestParty: text("guest_party"),
    reasonCode: varchar("reason_code", { length: 40 }),
    reasonText: text("reason_text"),
    /** Set = this plate was authorised (a legitimate repeat or override). */
    authorisedBy: uuid("authorised_by").references(() => staffPins.id),
    photoUrl: text("photo_url"),
    latitude: real("latitude"),
    longitude: real("longitude"),
    accuracyM: real("accuracy_m"),
    /** Filled by reconciliation on sync, never by the device. */
    attendancePresent: boolean("attendance_present"),
    reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One plate per person per meal per canteen, unless somebody authorised a second.
    uniqueIndex("uq_serving_person_meal")
      .on(t.canteenId, t.mealDate, t.meal, t.employeeId)
      .where(sql`employee_id IS NOT NULL AND authorised_by IS NULL`),
    index("ix_servings_date_meal").on(t.mealDate, t.meal),
    index("ix_servings_canteen_date").on(t.canteenId, t.mealDate),
  ],
);
