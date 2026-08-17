/**
 * Procurement — the physical record of a truck arriving with raw material.
 *
 * This module owns what happened at the gate, on the weighbridge, at the NIR
 * bench and in the godown. It does not own stock and it does not own the
 * ledger: settlement produces a Bill (and, when anything is deducted, a Vendor
 * Credit applied to it) through the existing purchases path, and stops there.
 *
 * There is no tax anywhere in here. Eggs are exempt, so any GST a registered
 * vendor charges is part of what the goods cost — see docs/procurement-plan.md.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { locations } from "./locations";
import { contacts } from "./contacts";
import { items } from "./items";
import { users } from "./auth";
import { bills, billLines, purchaseOrderLines, purchaseOrders, vendorCredits } from "./purchases";

const qty = (name: string) => numeric(name, { precision: 14, scale: 3 });
const money = (name: string) => numeric(name, { precision: 14, scale: 2 });
/** Matches bill_lines.rate — a receipt line and its bill line must not disagree. */
const rate = (name: string) => numeric(name, { precision: 18, scale: 6 });

/**
 * A boom barrier. Its coordinate is surveyed standing at the barrier itself,
 * and the radius is metres rather than kilometres — a radius sized for
 * attendance would pass a truck standing in the next village.
 */
export const gates = pgTable("gates", {
  id: uuid("id").primaryKey().defaultRandom(),
  locationId: uuid("location_id")
    .notNull()
    .references(() => locations.id),
  name: text("name").notNull(),
  latitude: numeric("latitude", { precision: 10, scale: 7 }),
  longitude: numeric("longitude", { precision: 10, scale: 7 }),
  radiusM: integer("radius_m").notNull().default(200),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/** A weighing platform. Capacity is the sanity ceiling on an entered weight. */
export const weighbridges = pgTable("weighbridges", {
  id: uuid("id").primaryKey().defaultRandom(),
  locationId: uuid("location_id")
    .notNull()
    .references(() => locations.id),
  name: text("name").notNull(),
  capacityKg: qty("capacity_kg"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type Gate = typeof gates.$inferSelect;
export type Weighbridge = typeof weighbridges.$inferSelect;

// ───────────────────────────── The receipt ──────────────────────────────

export const receiptStatus = pgEnum("receipt_status", [
  "gate_in", // allowed in, awaiting gross weight
  "weighed_in", // gross recorded, awaiting QC
  "qc_passed", // at least one line accepted, awaiting unloading
  "unloading", // unloading in progress
  "unloading_complete", // every accepted line unloaded, awaiting tare
  "gate_out", // tare recorded, awaiting settlement
  "settled", // bill raised, record locked
  "turned_away", // refused at the gate, never entered
  "rejected", // every line failed QC
]);

export const receiptLineStatus = pgEnum("receipt_line_status", [
  "pending",
  "qc_accepted",
  "qc_rejected",
  "unloading",
  "unloaded",
  "settled",
]);

export const qcVerdict = pgEnum("qc_verdict", [
  "pass",
  "warning",
  "rejected",
  "overridden",
  /** The material has no active spec: free entry and a manual judgement. */
  "no_spec",
]);

export const poMatchMethod = pgEnum("po_match_method", [
  "auto",
  "chosen_from_list",
  "manual",
  "unmatched",
]);

export const vendorMatchMethod = pgEnum("vendor_match_method", [
  "gstin",
  "pan",
  "exact",
  "fuzzy",
  "manual",
  "none",
]);

export const allocationMethod = pgEnum("allocation_method", ["pro_rata", "manual"]);

export const procurementReceipts = pgTable(
  "procurement_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    number: varchar("number", { length: 30 }).notNull().unique(),
    status: receiptStatus("status").notNull().default("gate_in"),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id),

    // ── Vendor and bill. One bill, one vendor; materials live on the lines ──
    vendorId: uuid("vendor_id").references(() => contacts.id),
    vendorBillNumber: text("vendor_bill_number"),
    vendorBillDate: date("vendor_bill_date"),
    /** tax_invoice | bill_of_supply | delivery_challan | unknown */
    billDocumentType: varchar("bill_document_type", { length: 20 }),
    /** Grand total as printed — the footing check runs against this. */
    billTotalAmount: money("bill_total_amount"),
    /**
     * Tax as printed on the vendor's paper. Recorded so the lines reconcile to
     * the grand total, then folded into cost. Never posted to a tax account:
     * eggs are exempt, so there is no credit to claim. Null on a bill of supply.
     */
    billTaxAmount: money("bill_tax_amount"),
    billVendorPan: varchar("bill_vendor_pan", { length: 10 }),
    billVendorGstin: varchar("bill_vendor_gstin", { length: 15 }),
    paymentTermsDays: integer("payment_terms_days"),
    vendorMatchMethod: vendorMatchMethod("vendor_match_method"),

    // ── OCR provenance: what the machine read, before any human correction ──
    ocrRaw: jsonb("ocr_raw"),
    ocrConfidence: jsonb("ocr_confidence"),
    ocrFootingOk: boolean("ocr_footing_ok"),
    ocrCorrectedFields: text("ocr_corrected_fields").array(),
    /** Stored from day one so a model regression is attributable. */
    ocrModel: text("ocr_model"),
    ocrExtractedAt: timestamp("ocr_extracted_at"),

    // ── Station 1 · gate ──
    vehicleNumber: varchar("vehicle_number", { length: 20 }).notNull(),
    gateId: uuid("gate_id").references(() => gates.id),
    arrivalAt: timestamp("arrival_at").notNull().defaultNow(),
    /**
     * When the guard's device recorded the arrival, from the device clock.
     * Equals arrivalAt on a live capture and differs when the record was
     * queued with no signal and forwarded later. Present from the start:
     * retrofitting a time dimension onto posted documents is the expensive way.
     */
    deviceCapturedAt: timestamp("device_captured_at"),
    gateInBy: uuid("gate_in_by").references(() => users.id),
    gateInLatitude: numeric("gate_in_latitude", { precision: 10, scale: 7 }),
    gateInLongitude: numeric("gate_in_longitude", { precision: 10, scale: 7 }),
    gateInAccuracyM: numeric("gate_in_accuracy_m", { precision: 8, scale: 2 }),
    gateInDistanceM: numeric("gate_in_distance_m", { precision: 10, scale: 2 }),
    /** inside | outside | no_fix — recorded and flagged, never blocking. */
    gateInGeofence: varchar("gate_in_geofence", { length: 10 }),
    plateOcrText: text("plate_ocr_text"),
    plateMatchesBill: boolean("plate_matches_bill"),
    vendorSlipGrossKg: qty("vendor_slip_gross_kg"),
    vendorSlipTareKg: qty("vendor_slip_tare_kg"),
    vendorSlipNetKg: qty("vendor_slip_net_kg"),

    // ── Station 2 · gross ──
    grossWeightKg: qty("gross_weight_kg"),
    grossWeighedAt: timestamp("gross_weighed_at"),
    grossWeighedBy: uuid("gross_weighed_by").references(() => users.id),
    grossWeighbridgeId: uuid("gross_weighbridge_id").references(() => weighbridges.id),
    grossVariancePct: numeric("gross_variance_pct", { precision: 6, scale: 3 }),
    grossVarianceReason: text("gross_variance_reason"),

    // ── Station 3 · QC roll-up ──
    qcAt: timestamp("qc_at"),
    qcBy: uuid("qc_by").references(() => users.id),
    /** all_passed | partial | all_rejected */
    qcRollupVerdict: varchar("qc_rollup_verdict", { length: 15 }),

    // ── Station 4 · unloading roll-up ──
    unloadingStartedAt: timestamp("unloading_started_at"),
    unloadingCompletedAt: timestamp("unloading_completed_at"),

    // ── Station 5 · tare ──
    tareWeightKg: qty("tare_weight_kg"),
    tareWeighedAt: timestamp("tare_weighed_at"),
    tareWeighedBy: uuid("tare_weighed_by").references(() => users.id),
    tareWeighbridgeId: uuid("tare_weighbridge_id").references(() => weighbridges.id),
    /**
     * GENERATED ALWAYS AS (gross - tare) STORED, added in the migration.
     * Net weight decides what a vendor is paid; it must not be able to drift
     * from its inputs, so the database computes it rather than the application.
     */
    netWeightKg: qty("net_weight_kg"),
    allocationMethod: allocationMethod("allocation_method").default("pro_rata"),
    shortageReason: text("shortage_reason"),
    departedAt: timestamp("departed_at"),
    gateOutBy: uuid("gate_out_by").references(() => users.id),

    // ── Station 6 · settlement outputs ──
    billId: uuid("bill_id").references(() => bills.id),
    vendorCreditId: uuid("vendor_credit_id").references(() => vendorCredits.id),
    /** Why the bill total differs from the vendor's printed grand total. */
    billTotalVarianceReason: text("bill_total_variance_reason"),
    settledAt: timestamp("settled_at"),
    settledBy: uuid("settled_by").references(() => users.id),

    // ── Exit ──
    /** gate | qc | supervisor */
    exitStage: varchar("exit_stage", { length: 12 }),
    exitReason: text("exit_reason"),
    exitAt: timestamp("exit_at"),
    exitBy: uuid("exit_by").references(() => users.id),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("ix_pr_queue").on(t.status, t.locationId, t.arrivalAt),
    index("ix_pr_vendor").on(t.vendorId),
  ],
);

export const procurementReceiptLines = pgTable(
  "procurement_receipt_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    receiptId: uuid("receipt_id")
      .notNull()
      .references(() => procurementReceipts.id, { onDelete: "cascade" }),
    /** 1-based, as printed on the bill. */
    lineNo: integer("line_no").notNull(),
    status: receiptLineStatus("status").notNull().default("pending"),

    // ── Link and snapshot. The PO link lives here: one truck, several POs ──
    purchaseOrderId: uuid("purchase_order_id").references(() => purchaseOrders.id),
    poLineId: uuid("po_line_id").references(() => purchaseOrderLines.id),
    itemId: uuid("item_id").references(() => items.id),
    /** Snapshot. An item renamed in 2027 must not rewrite a 2026 receipt. */
    itemName: text("item_name"),
    agreedRatePerKg: rate("agreed_rate_per_kg"),
    // No taxId. Tax is folded into cost — see the file header.

    // ── From the bill ──
    billDescription: text("bill_description"),
    billHsnCode: varchar("bill_hsn_code", { length: 10 }),
    billQuantityKg: qty("bill_quantity_kg").notNull(),
    billRatePerKg: rate("bill_rate_per_kg"),
    /** kg | quintal | mt — what was printed. Conversion happens server-side. */
    billRateBasis: varchar("bill_rate_basis", { length: 10 }),
    billAmount: money("bill_amount"),
    /** This line's tax where the paper itemises it; else allocate the header's. */
    billTaxAmount: money("bill_tax_amount"),
    billBagCount: integer("bill_bag_count"),

    // ── PO matching ──
    poMatchScore: numeric("po_match_score", { precision: 5, scale: 2 }),
    poMatchMethod: poMatchMethod("po_match_method").notNull().default("unmatched"),
    /** The reasons shown to the guard, verbatim. */
    poMatchReasons: jsonb("po_match_reasons"),
    rateVarianceReason: text("rate_variance_reason"),

    // ── Station 3 · QC, per line ──
    /**
     * The spec version this line was judged against. Without it a verdict is
     * unreadable the moment a limit changes — a past acceptance has to stay
     * explicable under the rule that was live when it was given.
     */
    qcSpecId: uuid("qc_spec_id"),
    qcVerdict: qcVerdict("qc_verdict"),
    qcMoisturePct: numeric("qc_moisture_pct", { precision: 6, scale: 3 }),
    qcProteinPct: numeric("qc_protein_pct", { precision: 6, scale: 3 }),
    qcFiberPct: numeric("qc_fiber_pct", { precision: 6, scale: 3 }),
    qcFatPct: numeric("qc_fat_pct", { precision: 6, scale: 3 }),
    qcOtherParams: jsonb("qc_other_params"),
    qcSampleCount: integer("qc_sample_count"),
    qcOverrideReason: text("qc_override_reason"),
    qcOverrideBy: uuid("qc_override_by").references(() => users.id),
    qcRejectionReason: text("qc_rejection_reason"),

    // ── Station 4 · unloading, per line ──
    warehouseLocationId: uuid("warehouse_location_id").references(() => locations.id),
    unloadingStartedAt: timestamp("unloading_started_at"),
    unloadingCompletedAt: timestamp("unloading_completed_at"),
    unloadingBy: uuid("unloading_by").references(() => users.id),
    bagCountExpected: integer("bag_count_expected"),
    /** What actually came off. Never overwrites the expected count. */
    bagCountActual: integer("bag_count_actual"),
    unitCount: integer("unit_count"),
    damagePercent: numeric("damage_percent", { precision: 5, scale: 2 }),
    damageType: varchar("damage_type", { length: 12 }),
    damageRemarks: text("damage_remarks"),

    // ── Station 5 · allocation ──
    /** This line's share of the vehicle net. Rejected lines take none. */
    allocatedNetKg: qty("allocated_net_kg"),
    /** GENERATED: billQuantityKg − coalesce(allocatedNetKg, 0). */
    shortageKg: qty("shortage_kg"),

    // ── Station 6 · the seam downstream ──
    /** Feed Mill and Farms read landed cost through this link. */
    billLineId: uuid("bill_line_id").references(() => billLines.id),
  },
  (t) => [
    index("ix_prl_receipt").on(t.receiptId, t.lineNo),
    index("ix_prl_po_line").on(t.poLineId),
    index("ix_prl_item").on(t.itemId),
  ],
);

export type ProcurementReceipt = typeof procurementReceipts.$inferSelect;
export type ProcurementReceiptLine = typeof procurementReceiptLines.$inferSelect;
export type ReceiptStatus = (typeof receiptStatus.enumValues)[number];
export type ReceiptLineStatus = (typeof receiptLineStatus.enumValues)[number];

/**
 * The only legal moves. Anything not listed is a 409, enforced server-side —
 * six operators who never speak to each other cannot be trusted to arrive in
 * order, and a receipt that skips a station is one nobody can account for.
 *
 * A supervisor exit to `rejected` is handled separately: it is legal from any
 * non-terminal state and so does not belong in a per-state table.
 */
export const RECEIPT_TRANSITIONS: Record<ReceiptStatus, ReceiptStatus[]> = {
  gate_in: ["weighed_in"],
  weighed_in: ["qc_passed", "rejected"],
  qc_passed: ["unloading"],
  unloading: ["unloading", "unloading_complete"],
  unloading_complete: ["gate_out"],
  gate_out: ["settled"],
  settled: [],
  turned_away: [],
  rejected: [],
};

/** Terminal states hold a finished record: nothing may move them again. */
export const TERMINAL_STATUSES: ReceiptStatus[] = ["settled", "turned_away", "rejected"];

// ─────────────────────────── Quality standards ───────────────────────────

/** Which way a reading is bad: moisture too high, protein too low. */
export const specDirection = pgEnum("spec_direction", ["max", "min"]);

/**
 * The quality bands for one material, as a whole.
 *
 * Versioned, and that is the entire reason it is not a handful of columns on
 * `items`. If the moisture limit for maize moves from 14% to 12% next March,
 * every receipt judged last year must keep the verdict it was actually given —
 * otherwise a year of accepted loads silently becomes a year of loads that
 * should have been refused. A receipt line records the spec version that judged
 * it, so a past verdict is always readable against the rule of its day.
 *
 * Superseding a spec creates a new version and deactivates the old one; nothing
 * is edited in place.
 */
export const qcSpecs = pgTable(
  "qc_specs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id),
    version: integer("version").notNull().default(1),
    /** How many samples this material expects, for the technician's benefit. */
    sampleCount: integer("sample_count").notNull().default(3),
    effectiveFrom: date("effective_from").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    notes: text("notes"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_qc_spec_version").on(t.itemId, t.version),
    // At most one live spec per material: two would make the verdict a coin toss.
    uniqueIndex("uq_qc_spec_active").on(t.itemId).where(sql`is_active`),
  ],
);

/**
 * One measurable parameter within a spec.
 *
 * A row per parameter rather than fixed columns, because materials do not agree
 * on what matters: maize is judged on moisture, a protein meal on protein and
 * aflatoxin, limestone on almost nothing. `direction` makes one shape serve
 * both — moisture is a max, protein is a min.
 *
 * Three bands, not two. Between `warnAt` and `rejectAt` the load is accepted
 * but flagged, which is where most real deliveries sit: good enough to take,
 * not good enough to pay full price for.
 */
export const qcSpecParams = pgTable(
  "qc_spec_params",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    specId: uuid("spec_id")
      .notNull()
      .references(() => qcSpecs.id, { onDelete: "cascade" }),
    /** moisture | protein | fiber | fat | aflatoxin | anything the lab reports. */
    parameter: varchar("parameter", { length: 30 }).notNull(),
    label: text("label"),
    /**
     * How the reading is expressed — "%", "ppb", "mg/kg".
     *
     * Nullable rather than defaulting to "%", because a default is exactly the
     * trap: the purchase order prints this figure for a vendor to read, and
     * "Aflatoxin : Max 20%" for a limit that is 20 parts per BILLION is off by
     * seven orders of magnitude and looks perfectly ordinary. Null prints no
     * unit at all, which is uninformative but never wrong.
     */
    unit: varchar("unit", { length: 12 }),
    direction: specDirection("direction").notNull(),
    /** What the material is supposed to be. Display only; nothing judges on it. */
    target: numeric("target", { precision: 10, scale: 4 }),
    /** Past this it is accepted with a flag. Null means no warning band. */
    warnAt: numeric("warn_at", { precision: 10, scale: 4 }),
    /** Past this the line is refused. Null means this parameter never rejects. */
    rejectAt: numeric("reject_at", { precision: 10, scale: 4 }),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [uniqueIndex("uq_qc_spec_param").on(t.specId, t.parameter)],
);

// ──────────────────────────── Deduction rules ────────────────────────────

/**
 * Whether a rule reads one material or the whole vehicle.
 *
 * Most read a line: moisture is a property of the maize, not of the truck.
 * Shortage is the exception — a lorry loses weight in transit as a vehicle,
 * so the allowance belongs to the trip and is consumed once across every
 * material aboard, not granted afresh to each.
 */
export const deductionScope = pgEnum("deduction_scope", ["line", "vehicle"]);

/** What a deduction is computed from. */
export const deductionBasis = pgEnum("deduction_basis", [
  /** excess over the threshold, in points, × net × rate ÷ 100 */
  "pct_of_value",
  /** excess in points × net × a rupee figure per point per kg */
  "per_point_per_kg",
  /** the whole shortfall × rate — used by weight shortage */
  "shortfall_value",
  /** a flat rupee amount whenever the rule fires */
  "flat",
]);

/**
 * When money comes off, and how much.
 *
 * Deliberately separate from the spec, because the two answer different
 * questions and rarely share a number. A load may be *refused* above 16%
 * moisture but *charged for* above 14% — reject is a quality decision, deduct
 * is a commercial one, and the gap between them is where most deliveries land.
 *
 * Versioned like a spec: what a vendor was charged last March must stay
 * explicable under the rule that was live in March.
 */
export const deductionRules = pgTable(
  "deduction_rules",
  {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  /**
   * What it reads. A QC parameter name (moisture, protein), or one of the
   * physical facts the flow produces: "damage" from unloading, "shortage" from
   * the weighbridge.
   */
  parameter: varchar("parameter", { length: 30 }).notNull(),
  direction: specDirection("direction").notNull().default("max"),
  scope: deductionScope("scope").notNull().default("line"),
  /** Null narrows nothing: the rule applies to every material, every vendor. */
  itemId: uuid("item_id").references(() => items.id),
  vendorId: uuid("vendor_id").references(() => contacts.id),
  /** Money starts coming off beyond this reading. Its own number, not the spec's. */
  threshold: numeric("threshold", { precision: 10, scale: 4 }),
  basis: deductionBasis("basis").notNull(),
  /** Rate per point for per_point_per_kg; ignored by the others. */
  ratePerPoint: numeric("rate_per_point", { precision: 12, scale: 4 }),
  /** Flat rupee amount for the flat basis. */
  flatAmount: numeric("flat_amount", { precision: 14, scale: 2 }),
  /** Nothing is deducted below this, however the arithmetic lands. */
  minAmount: numeric("min_amount", { precision: 14, scale: 2 }),
  version: integer("version").notNull().default(1),
  effectiveFrom: date("effective_from").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  () => [
    /**
     * One live rule per parameter per material per vendor.
     *
     * `computeDeductions` keeps one rule per parameter and picks the most
     * specific. Two live rules at the SAME specificity leave it choosing by
     * whatever order the rows came back in — which quietly makes a vendor's
     * deduction depend on the query plan. Written by hand rather than by
     * drizzle-kit because the COALESCE is the whole point: a plain unique
     * index treats two NULL item_ids as distinct, so the blanket rules that
     * actually collide would sail through it.
     */
    sql`create unique index "uq_deduction_rule_live" on "deduction_rules" (
      "parameter",
      coalesce("item_id", '00000000-0000-0000-0000-000000000000'::uuid),
      coalesce("vendor_id", '00000000-0000-0000-0000-000000000000'::uuid)
    ) where "is_active"`,
  ],
);

export type QcSpec = typeof qcSpecs.$inferSelect;
export type QcSpecParam = typeof qcSpecParams.$inferSelect;
export type DeductionRule = typeof deductionRules.$inferSelect;
