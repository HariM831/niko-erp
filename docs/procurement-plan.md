# Procurement — execution plan

Mounting the six-station goods-receiving flow onto niko's Purchases module.

**Design source:** `Amino farms/docs/receiving-six-station-flow.md`
**Written:** 2026-08-15

The design doc calls itself greenfield. It is not, here. niko already owns
contacts, items, purchase orders, bills, vendor credits, payments, taxes,
locations, numbering, RBAC, attachments and the posting engine. This plan keeps
all of it and adds only what genuinely does not exist: the receipt record, the
six station screens, and the rules that turn a truck into a bill.

---

## Contents

1. [Decisions](#1-decisions)
2. [What this module owns](#2-what-this-module-owns)
3. [Accounting model](#3-accounting-model)
4. [Reuse map](#4-reuse-map)
5. [New schema](#5-new-schema)
6. [Changes to existing code](#6-changes-to-existing-code)
7. [API surface](#7-api-surface)
8. [The settlement transaction](#8-the-settlement-transaction)
9. [Screens](#9-screens)
10. [Validation matrix](#10-validation-matrix)
11. [Phases](#11-phases)
12. [Open items](#12-open-items)

---

## 1. Decisions

| # | Decision | Consequence |
|---|---|---|
| 1 | **Deductions become a Vendor Credit** applied to the bill | The bill mirrors the vendor's paper exactly; net payable falls out of `bills.balanceDue`. No payable tables, no negative lines. |
| 2 | **Procurement does not move stock.** Feed Mill owns feed-item inventory, Farms owns birds and eggs; each posts a day-end inventory value | Periodic inventory, not perpetual. `moveStock()` is never called from here. No GRNI account. |
| 3 | **Two counters on PO lines** — `billedQuantity` and `deliveredQuantity` | The vendor discharges the order by sending the vehicle. `deliveredQuantity` rises by the full sent quantity whatever we then do with it. |
| 4 | **`procurement` permission module with custom actions** | A weighbridge operator cannot settle. Requires a real fix to `sanitisePermissions` — see §6. |
| 5 | **niko theme throughout** | No second design system. Same tokens, same components, responsive down to a phone. |
| 6 | **Shortage tolerance is per material** | `items.shortageTolerancePct`, not per vendor. |
| 7 | **No offline mode.** The gate is capture-and-forward | Work is never lost and a truck is never held, but OCR and live matching need signal. See §9.1. |
| 8 | **No GST, anywhere** | Eggs are exempt, so tax is folded into cost. No tax account is ever touched and bill lines carry no `taxId`. Settled for niko before this module. |
| 9 | **Deleting a receipt rolls the number back** | So test entries leave no gap in the series. `resyncDocumentNumber()` recomputes the counter from the surviving documents — see §6. |
| 10 | **Test data stays** | Nothing created while testing is cleaned up afterwards. Records are left in place for inspection unless you ask for them to go. |

### The PO obligation rule

**The vendor's responsibility ends when the vehicle arrives.** What we do next —
accept it, reject it at QC, unload only part of it — is our decision about
quality and our decision about what to pay. It does not revive their obligation
to deliver more.

So `deliveredQuantity` rises by **`billQuantityKg`, the quantity sent**, on every
line, in every outcome. `billedQuantity` rises only by what reached a bill.
The two answer different questions and must never be conflated:

| Question | Column |
|---|---|
| Has the vendor finished delivering this order? | `deliveredQuantity` |
| How much of this order have we been invoiced for? | `billedQuantity` |

A line rejected at QC therefore closes its slot on the PO and contributes
nothing to the bill. A short load closes its slot in full and is billed at the
vendor's figure less a shortage credit.

**This resolves partial acceptance without a partial-acceptance concept.**
Material left on the truck raises the tare, which lowers the net, which lowers
that line's allocated net, which lowers what is paid — the physics does the
arithmetic. Note the one caveat: when several lines are unloaded and only one
was partly refused, pro-rata allocation spreads the shortfall across all of
them. That is what `allocationMethod = 'manual'` exists for.

---

## 2. What this module owns

**Owns:** the physical record of a truck — who arrived, what the paper claimed,
what the platform weighed, what QC found, what came off, where it went, and what
we finally agreed to pay for.

**Does not own:** stock quantities, stock valuation, the general ledger. It
produces a Bill and (when deducted) a Vendor Credit, and stops. Everything
financial happens through the existing `createBill` path and `postJournal`.

**Hands downstream:** a settled receipt line carries `itemId`, allocated net
quantity, `locationId`, receipt date and a link to its `bill_lines` row — which
already holds `landedUnitCost` including allocated freight. Feed Mill and Farms
read that seam to build their own stock and their day-end valuation entry.

---

## 3. Accounting model

### Tax is folded into cost

**Eggs are exempt, so there is no output tax and no recoverable input credit.**
Any GST a registered vendor charges is simply part of what the goods cost. This
was settled for niko before this module existed — `scripts/zoho/map-accounts.ts`
maps `input_gst`, `cgst_payable`, `sgst_payable` and `igst_payable` with the note
*"unused once tax is folded into cost"*.

So procurement bill lines carry **no `taxId`**. Nothing here ever touches a tax
account, in either direction, and `computeDocumentTotals` returns zero cgst /
sgst / igst because there is no tax to compute.

Where the vendor's paper does show tax, it is captured on the receipt for the
footing check and then **allocated across the lines by value** at settlement, so
each bill line's rate is the all-in rate:

```
rate = (line goods value + line's share of printed tax) ÷ quantity
```

Same allocation function as freight. The bill total then equals the vendor's
printed grand total exactly, and `bill_lines.landedUnitCost` means what it says.

### At settlement

```
Bill (vendor's billed quantities × all-in rates)
    Dr  item.purchaseAccountId        total
        Cr  ap                        total
```

Two lines. Unchanged from what `createBill` already does when no tax is set.

### Deductions

```
Vendor Credit (one line per deduction)
    Dr  ap                            deduction total
        Cr  item.purchaseAccountId    cost reduction
  → applied to the bill via vendor_credit_applications
```

Each deduction line carries **the receipt line's own `itemId`** and no `taxId`,
so it credits back exactly the head the bill debited.

`billDocumentType` (`tax_invoice` / `bill_of_supply` / `delivery_challan`) is
still captured, because it tells the OCR footing check whether to expect a tax
row. It drives no accounting.

### Rejected lines are not billed

A line rejected at QC never came off the truck. It does **not** appear on the
bill, and no vendor credit is raised for it.

We never took the goods, so there is nothing to owe and nothing to reduce.
Billing it and crediting it straight back would put two documents on the ledger
where zero belongs, and inflate purchase turnover in both directions. The
settlement screen shows the gap between the bill total and the vendor's printed
total and requires a reason, so the difference is recorded rather than silent.

This is the one place the plan departs from the design doc, which shows rejected
lines at ₹0 on the settlement screen. They still *display* at ₹0 — they just
don't reach `bill_lines`.

### Inventory

Nothing here writes `inventory_transactions`. Consequence to accept knowingly:
**feed materials stay `trackInventory = false`**, so they will not appear on
Items → Stock on Hand. Their stock lives in the Feed Mill module. If that page
should show them later, the fix is for Feed Mill to write the ledger — not for
procurement to start.

---

## 4. Reuse map

| Need | Use | Change needed |
|---|---|---|
| Material master | `items` | add `aliases text[]`, `unitBagWeightKg`, `shortageTolerancePct` |
| Vendor master | `contacts` | none |
| Purchase orders | `purchase_orders` / `purchase_order_lines` | add `deliveredQuantity` |
| Payable | `bills` / `bill_lines` via `createBill` | export it — see §6 |
| Deductions | `vendor_credits` / `vendor_credit_applications` | extract a service — see §6 |
| Site / godown / bay | `locations` | add `parentLocationId` for bays |
| Photos | `attachments` | register two entities — see §6 |
| Audit trail | `activity_log` | none |
| Numbering | `nextDocumentNumber(tx, "procurement_receipt")` | seed `document_series` rows |
| Document totals | `computeDocumentTotals` | none — returns zero tax, since no line carries a `taxId` |
| Period guard | `assertPeriodOpen` | none |

Open PO lines for matching are `status IN ('issued', 'partially_billed')` with
`deliveredQuantity < quantity`.

---

## 5. New schema

One new file, `shared/schema/procurement.ts`, exported from `shared/schema/index.ts`.

Precision follows the house rules and the existing `lineColumns`: money
`numeric(14,2)`, quantity `numeric(14,3)`, rate `numeric(18,6)`. The design doc
says `numeric(12,4)` for rates — use 18,6 so a receipt line and its bill line
cannot disagree.

### Enums

```ts
export const receiptStatus = pgEnum("receipt_status", [
  "gate_in", "weighed_in", "qc_passed", "unloading",
  "unloading_complete", "gate_out", "settled",
  "turned_away", "rejected",
]);

export const receiptLineStatus = pgEnum("receipt_line_status", [
  "pending", "qc_accepted", "qc_rejected", "unloading", "unloaded", "settled",
]);

export const qcVerdict = pgEnum("qc_verdict", [
  "pass", "warning", "rejected", "overridden", "no_spec",
]);

export const poMatchMethod = pgEnum("po_match_method", [
  "auto", "chosen_from_list", "manual", "unmatched",
]);

export const vendorMatchMethod = pgEnum("vendor_match_method", [
  "gstin", "pan", "exact", "fuzzy", "manual", "none",
]);

export const allocationMethod = pgEnum("allocation_method", ["pro_rata", "manual"]);

export const deductionType = pgEnum("deduction_type", [
  "shortage", "moisture", "damage", "quality", "freight", "other",
]);

export const deductionCalcMethod = pgEnum("deduction_calc_method", [
  "pct_of_excess", "pct_of_value", "per_kg", "flat",
]);
```

### Reference tables

```ts
export const gates = pgTable("gates", {
  id: uuid("id").primaryKey().defaultRandom(),
  locationId: uuid("location_id").notNull().references(() => locations.id),
  name: text("name").notNull(),
  latitude: numeric("latitude", { precision: 10, scale: 7 }),
  longitude: numeric("longitude", { precision: 10, scale: 7 }),
  /** 200 m, not kilometres — a radius sized for attendance passes the next village. */
  radiusM: integer("radius_m").notNull().default(200),
  isActive: boolean("is_active").notNull().default(true),
});

export const weighbridges = pgTable("weighbridges", {
  id: uuid("id").primaryKey().defaultRandom(),
  locationId: uuid("location_id").notNull().references(() => locations.id),
  name: text("name").notNull(),
  capacityKg: numeric("capacity_kg", { precision: 14, scale: 3 }),
  isActive: boolean("is_active").notNull().default(true),
});
```

### QC specs

Versioned, because a spec change must not retroactively alter a past verdict.

```ts
export const qcSpecs = pgTable("qc_specs", {
  id: uuid("id").primaryKey().defaultRandom(),
  itemId: uuid("item_id").notNull().references(() => items.id),
  version: integer("version").notNull(),
  moistureMax: numeric("moisture_max", { precision: 6, scale: 3 }),
  proteinMin: numeric("protein_min", { precision: 6, scale: 3 }),
  fiberMax: numeric("fiber_max", { precision: 6, scale: 3 }),
  fatMin: numeric("fat_min", { precision: 6, scale: 3 }),
  fatMax: numeric("fat_max", { precision: 6, scale: 3 }),
  otherLimits: jsonb("other_limits").$type<Record<string, { max?: number; min?: number }>>(),
  warningBandPct: numeric("warning_band_pct", { precision: 5, scale: 2 }).notNull().default("0"),
  sampleCount: integer("sample_count").notNull().default(3),
  effectiveFrom: date("effective_from").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("uq_qc_spec_version").on(t.itemId, t.version),
  uniqueIndex("uq_qc_spec_active").on(t.itemId).where(sql`is_active`),
]);
```

An item with no active spec yields `no_spec` — free entry, manual verdict,
recorded as such. A fabricated default limit is worse than none.

### Deduction rules

```ts
export const deductionRules = pgTable("deduction_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  type: deductionType("type").notNull(),
  version: integer("version").notNull().default(1),
  itemId: uuid("item_id").references(() => items.id),        // null = all items
  vendorId: uuid("vendor_id").references(() => contacts.id), // null = all vendors
  /** Line field the rule reads, e.g. "qcMoisturePct", "shortageKg". */
  triggerField: varchar("trigger_field", { length: 40 }),
  triggerAbove: numeric("trigger_above", { precision: 12, scale: 4 }),
  calcMethod: deductionCalcMethod("calc_method").notNull(),
  calcValue: numeric("calc_value", { precision: 12, scale: 4 }).notNull().default("0"),
  effectiveFrom: date("effective_from").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
```

Rules evaluate **against a line**, never a receipt. A moisture deduction
computed from wet rice bran must not reduce what is paid for the dry maize
beside it.

### The receipt

```ts
export const procurementReceipts = pgTable("procurement_receipts", {
  id: uuid("id").primaryKey().defaultRandom(),
  number: varchar("number", { length: 30 }).notNull().unique(),
  status: receiptStatus("status").notNull().default("gate_in"),
  locationId: uuid("location_id").notNull().references(() => locations.id),

  // Vendor and bill — one bill, one vendor; materials live on the lines
  vendorId: uuid("vendor_id").references(() => contacts.id),
  vendorBillNumber: text("vendor_bill_number"),
  vendorBillDate: date("vendor_bill_date"),
  billDocumentType: varchar("bill_document_type", { length: 20 }),
  billTotalAmount: money("bill_total_amount"),     // grand total as printed — footing check
  /** Tax as printed on the vendor's paper. Recorded, folded into cost, never
      posted to a tax account. Null on a bill of supply. */
  billTaxAmount: money("bill_tax_amount"),
  billVendorPan: varchar("bill_vendor_pan", { length: 10 }),
  billVendorGstin: varchar("bill_vendor_gstin", { length: 15 }),
  paymentTermsDays: integer("payment_terms_days"),
  vendorMatchMethod: vendorMatchMethod("vendor_match_method"),

  // OCR provenance — what the machine read, before any human correction
  ocrRaw: jsonb("ocr_raw"),
  ocrConfidence: jsonb("ocr_confidence"),
  ocrFootingOk: boolean("ocr_footing_ok"),
  ocrCorrectedFields: text("ocr_corrected_fields").array(),
  ocrModel: text("ocr_model"),
  ocrExtractedAt: timestamp("ocr_extracted_at"),

  // Station 1 — gate
  vehicleNumber: varchar("vehicle_number", { length: 20 }).notNull(),
  gateId: uuid("gate_id").references(() => gates.id),
  arrivalAt: timestamp("arrival_at").notNull().defaultNow(),
  /**
   * When the guard's device recorded the arrival, from the device clock. Equals
   * arrivalAt on a live capture; differs when the record was queued offline and
   * forwarded later. Present from day one — retrofitting a time dimension onto
   * posted documents is the expensive way to do it. See §9.1.
   */
  deviceCapturedAt: timestamp("device_captured_at"),
  gateInBy: uuid("gate_in_by").references(() => users.id),
  gateInLatitude: numeric("gate_in_latitude", { precision: 10, scale: 7 }),
  gateInLongitude: numeric("gate_in_longitude", { precision: 10, scale: 7 }),
  gateInAccuracyM: numeric("gate_in_accuracy_m", { precision: 8, scale: 2 }),
  gateInDistanceM: numeric("gate_in_distance_m", { precision: 10, scale: 2 }),
  gateInGeofence: varchar("gate_in_geofence", { length: 10 }),
  plateOcrText: text("plate_ocr_text"),
  plateMatchesBill: boolean("plate_matches_bill"),
  vendorSlipGrossKg: qty("vendor_slip_gross_kg"),
  vendorSlipTareKg: qty("vendor_slip_tare_kg"),
  vendorSlipNetKg: qty("vendor_slip_net_kg"),

  // Station 2 — gross
  grossWeightKg: qty("gross_weight_kg"),
  grossWeighedAt: timestamp("gross_weighed_at"),
  grossWeighedBy: uuid("gross_weighed_by").references(() => users.id),
  grossWeighbridgeId: uuid("gross_weighbridge_id").references(() => weighbridges.id),
  grossVariancePct: numeric("gross_variance_pct", { precision: 6, scale: 3 }),
  grossVarianceReason: text("gross_variance_reason"),

  // Station 3 — QC roll-up
  qcAt: timestamp("qc_at"),
  qcBy: uuid("qc_by").references(() => users.id),
  qcRollupVerdict: varchar("qc_rollup_verdict", { length: 15 }),

  // Station 4 — unloading roll-up
  unloadingStartedAt: timestamp("unloading_started_at"),
  unloadingCompletedAt: timestamp("unloading_completed_at"),

  // Station 5 — tare
  tareWeightKg: qty("tare_weight_kg"),
  tareWeighedAt: timestamp("tare_weighed_at"),
  tareWeighedBy: uuid("tare_weighed_by").references(() => users.id),
  tareWeighbridgeId: uuid("tare_weighbridge_id").references(() => weighbridges.id),
  netWeightKg: qty("net_weight_kg"),   // GENERATED ALWAYS AS (gross - tare) STORED
  allocationMethod: allocationMethod("allocation_method").default("pro_rata"),
  shortageReason: text("shortage_reason"),
  departedAt: timestamp("departed_at"),
  gateOutBy: uuid("gate_out_by").references(() => users.id),

  // Station 6 — settlement outputs
  billId: uuid("bill_id").references(() => bills.id),
  vendorCreditId: uuid("vendor_credit_id").references(() => vendorCredits.id),
  billTotalVarianceReason: text("bill_total_variance_reason"),
  settledAt: timestamp("settled_at"),
  settledBy: uuid("settled_by").references(() => users.id),

  // Exit
  exitStage: varchar("exit_stage", { length: 12 }),
  exitReason: text("exit_reason"),
  exitAt: timestamp("exit_at"),
  exitBy: uuid("exit_by").references(() => users.id),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
```

`netWeightKg` is a generated column, written in the migration by hand — Drizzle
does not emit `GENERATED ALWAYS AS`. Net weight decides what a vendor is paid;
it must not be able to drift from its inputs.

### The lines

```ts
export const procurementReceiptLines = pgTable("procurement_receipt_lines", {
  id: uuid("id").primaryKey().defaultRandom(),
  receiptId: uuid("receipt_id").notNull()
    .references(() => procurementReceipts.id, { onDelete: "cascade" }),
  lineNo: integer("line_no").notNull(),
  status: receiptLineStatus("status").notNull().default("pending"),

  // Link and snapshot — the PO link lives here; one truck, several POs
  purchaseOrderId: uuid("purchase_order_id").references(() => purchaseOrders.id),
  poLineId: uuid("po_line_id").references(() => purchaseOrderLines.id),
  itemId: uuid("item_id").references(() => items.id),
  itemName: text("item_name"),                          // snapshot
  agreedRatePerKg: numeric("agreed_rate_per_kg", { precision: 18, scale: 6 }),
  // No taxId. Tax is folded into cost — see §3.

  // From the bill
  billDescription: text("bill_description"),
  billHsnCode: varchar("bill_hsn_code", { length: 10 }),
  billQuantityKg: qty("bill_quantity_kg").notNull(),
  billRatePerKg: numeric("bill_rate_per_kg", { precision: 18, scale: 6 }),
  billRateBasis: varchar("bill_rate_basis", { length: 10 }),  // kg | quintal | mt
  billAmount: money("bill_amount"),
  /** This line's tax, when the paper itemises it. Null means allocate the
      header's billTaxAmount across lines by value instead. */
  billTaxAmount: money("bill_tax_amount"),
  billBagCount: integer("bill_bag_count"),

  // PO matching
  poMatchScore: numeric("po_match_score", { precision: 5, scale: 2 }),
  poMatchMethod: poMatchMethod("po_match_method").default("unmatched"),
  poMatchReasons: jsonb("po_match_reasons"),
  rateVarianceReason: text("rate_variance_reason"),

  // Station 3 — QC per line
  qcSpecId: uuid("qc_spec_id").references(() => qcSpecs.id),
  qcVerdict: qcVerdict("qc_verdict"),
  qcMoisturePct: numeric("qc_moisture_pct", { precision: 6, scale: 3 }),
  qcProteinPct: numeric("qc_protein_pct", { precision: 6, scale: 3 }),
  qcFiberPct: numeric("qc_fiber_pct", { precision: 6, scale: 3 }),
  qcFatPct: numeric("qc_fat_pct", { precision: 6, scale: 3 }),
  qcOtherParams: jsonb("qc_other_params").$type<Record<string, number>>(),
  qcSampleCount: integer("qc_sample_count"),
  qcOverrideReason: text("qc_override_reason"),
  qcOverrideBy: uuid("qc_override_by").references(() => users.id),
  qcRejectionReason: text("qc_rejection_reason"),

  // Station 4 — unloading per line
  warehouseLocationId: uuid("warehouse_location_id").references(() => locations.id),
  unloadingStartedAt: timestamp("unloading_started_at"),
  unloadingCompletedAt: timestamp("unloading_completed_at"),
  unloadingBy: uuid("unloading_by").references(() => users.id),
  bagCountExpected: integer("bag_count_expected"),
  bagCountActual: integer("bag_count_actual"),
  unitCount: integer("unit_count"),
  damagePercent: numeric("damage_percent", { precision: 5, scale: 2 }),
  damageType: varchar("damage_type", { length: 12 }),
  damageRemarks: text("damage_remarks"),

  // Station 5 — allocation
  allocatedNetKg: qty("allocated_net_kg"),
  shortageKg: qty("shortage_kg"),      // GENERATED: billQuantityKg - coalesce(allocated, 0)

  // Station 6 — the seam downstream
  billLineId: uuid("bill_line_id").references(() => billLines.id),
});
```

### Constraints

Written by hand into the migration.

```sql
CREATE UNIQUE INDEX uq_prl_line_no ON procurement_receipt_lines (receipt_id, line_no);

-- One PO line cannot be claimed twice on the same receipt.
CREATE UNIQUE INDEX uq_prl_po_line ON procurement_receipt_lines (receipt_id, po_line_id)
  WHERE po_line_id IS NOT NULL;

-- A rejected line never takes a share of net.
ALTER TABLE procurement_receipt_lines ADD CONSTRAINT ck_prl_rejected_no_allocation
  CHECK (status <> 'qc_rejected' OR COALESCE(allocated_net_kg, 0) = 0);

ALTER TABLE procurement_receipt_lines ADD CONSTRAINT ck_prl_qty_positive
  CHECK (bill_quantity_kg > 0);

-- A re-scanned bill must never become a second payable.
CREATE UNIQUE INDEX uq_pr_vendor_bill ON procurement_receipts (vendor_id, lower(vendor_bill_number))
  WHERE vendor_bill_number IS NOT NULL AND status <> 'turned_away';

-- One live receipt per plate. Makes double entry impossible at the database
-- level rather than via a pre-insert SELECT that races.
CREATE UNIQUE INDEX uq_pr_active_vehicle ON procurement_receipts (vehicle_number)
  WHERE status IN ('gate_in','weighed_in','qc_passed','unloading','unloading_complete');

ALTER TABLE procurement_receipts ADD CONSTRAINT ck_pr_tare_below_gross
  CHECK (tare_weight_kg IS NULL OR gross_weight_kg IS NULL OR tare_weight_kg < gross_weight_kg);

CREATE INDEX ix_pr_queue ON procurement_receipts (status, location_id, arrival_at);
CREATE INDEX ix_prl_po_line ON procurement_receipt_lines (po_line_id);
```

### Deduction audit

The money lives on the vendor credit. This table records *why*, frozen at the
rule version that fired.

```ts
export const receiptDeductions = pgTable("receipt_deductions", {
  id: uuid("id").primaryKey().defaultRandom(),
  receiptId: uuid("receipt_id").notNull().references(() => procurementReceipts.id),
  lineId: uuid("line_id").notNull().references(() => procurementReceiptLines.id),
  ruleId: uuid("rule_id").references(() => deductionRules.id),
  ruleVersion: integer("rule_version"),
  type: deductionType("type").notNull(),
  name: text("name").notNull(),
  /** Shown verbatim: "2.9% excess × 24,290 kg × ₹23.10". */
  basis: text("basis"),
  amount: money("amount").notNull(),
  isCustom: boolean("is_custom").notNull().default(false),
  vendorCreditLineId: uuid("vendor_credit_line_id").references(() => vendorCreditLines.id),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
```

---

## 6. Changes to existing code

Precise list. Everything else is additive.

### `shared/permissions.ts` — module-aware actions

Custom actions are currently stripped. `ACTION_KEYS` is a single global set, so
`sanitisePermissions` would drop `gate_in` on save, and `effectiveActions`
returns the standard four on a wildcard.

Both need to resolve actions **per module**:

```ts
const actionsFor = (moduleKey: string): string[] => {
  const m = PERMISSION_MODULES.find((x) => x.key === moduleKey);
  return m?.actions ?? PERMISSION_ACTIONS.map((a) => a.key);
};
```

`sanitisePermissions` filters against `actionsFor(module)`; `effectiveActions`
expands `*` to `actionsFor(module)`. Then add:

```ts
{
  key: "procurement",
  label: "Procurement",
  description: "Goods receipts: gate in, weighbridge, QC, unloading, settlement",
  actions: ["view", "gate_in", "weighbridge", "quality_control",
            "unloading", "settle", "override"],
}
```

`override` is a permission, not a role name. "Needs a supervisor" must be a
concrete check or it degrades into whoever is holding the tablet.

The role editor renders `PERMISSION_ACTIONS` today — it must render each
module's own action list. One component change.

### `shared/entities.ts` — two entities

```ts
{ key: "procurement_receipt", label: "Goods Receipt", plural: "Goods Receipts",
  module: "procurement", numbered: true, lookupTarget: false },
{ key: "procurement_receipt_line", label: "Receipt Line", plural: "Receipt Lines",
  module: "procurement", numbered: false, lookupTarget: false },
```

The line entity exists so QC and unloading photos attach to a line rather than
the truck — `attachments` is entity-scoped and needs nothing else. Both become
attachable automatically via `ATTACHABLE_ENTITIES`.

### `server/routes/purchases.ts` — extract two functions

`createBill` (line 714) is private to the routes file. `vendor-credits` creation
is inline in its handler. Both must become callable from procurement.

Move to `server/services/purchases.ts`:

- `createBill(tx, args)` — already transaction-scoped, just export it
- `createVendorCredit(tx, args)` — extract from the POST handler
- `applyVendorCredit(tx, { vendorCreditId, applications })` — extract from the apply handler
- their helpers: `resolveLineAccounts`, `computeBill`, `billLineValues`,
  `billGoodsJeLines`, `allocateFreight`, `loadVendor`, `computeDueDate`

The route handlers become thin callers. **This refactor lands before any
procurement code depends on it, as its own commit, with the purchases behaviour
unchanged.** Verify by running the existing purchases flows before and after.

### Schema additions to existing tables

| Table | Column | Why |
|---|---|---|
| `items` | `aliases text[] not null default '{}'` | `DORB`, `D.O.R.B.` — data, not a hardcoded map |
| `items` | `unitBagWeightKg numeric(8,3)` | sanity-checks bags against weight |
| `items` | `shortageTolerancePct numeric(5,2) not null default 0` | drives V21; tolerance is a property of the material, not the seller |
| `purchase_order_lines` | `deliveredQuantity numeric(14,3) not null default '0'` | the vendor's obligation counter |
| `locations` | `parentLocationId uuid references locations(id)` | bays inside a godown |

`purchase_order_status` enum is **not** touched. Status stays about billing,
which is what the accounting core reasons about; delivery progress is derived
from `deliveredQuantity` in queries.

**One trap.** `POST /orders/:id/convert-to-bill` sets `billedQuantity = quantity`
outright and marks the PO `billed`. If a PO is being received against, that
manual path would double-count. Block it: `convert-to-bill` returns 409 when any
`procurement_receipt_lines` row references a line of that PO.

### Client

- `client/src/components/layout.tsx` — new `Procurement` nav group with the six
  station paths, placed between Sales and Purchases.
- `client/src/components/status-badge.tsx` — add the nine receipt statuses to
  `STATUS_TEXT`.
- `client/src/App.tsx` — six routes plus the QC spec admin route.

### Migration

One migration for the lot, generated with `npm run db:generate`, then hand-edited
to add the generated columns, partial unique indexes and check constraints
Drizzle does not emit. Plus a seed for `document_series` rows
(`entity = 'procurement_receipt'`, prefix `GR-`) against every existing series.

---

## 7. API surface

`server/routes/procurement.ts`, mounted at `/api/procurement`. Every route
carries `requirePermission("procurement", <action>)` and every write carries
`validateBody`.

### Queues

`GET /queue/:station` where `station ∈ gross | qc | unloading | tare | settlement`.

One shape for all five so one component serves every station:

```ts
interface QueueRow {
  id: string;
  number: string;
  vehicleNumber: string;
  vendorName: string | null;
  status: ReceiptStatus;
  enteredStageAt: string;
  ageMinutes: number;
  lineCount: number;
  lineSummary: string;          // "Maize, DORB" or "3 lines"
  linesOpen: number;
  linesRejected: number;
  billQuantityKg: string | null;
  vendorSlipGrossKg: string | null;
  grossWeightKg: string | null;
  netWeightKg: string | null;
  estimatedPayable: string | null;
  flags: QueueFlag[];
}
```

Flags are computed server-side. Two clients must never disagree about whether a
load is short.

### Lifecycle

| Endpoint | Action | Effect |
|---|---|---|
| `POST /receipts` | `gate_in` | Header **and** lines in one transaction → `gate_in` or `turned_away` |
| `GET /receipts/:id` | `view` | Header + lines + attachments + deductions |
| `PATCH /receipts/:id/gross-weight` | `weighbridge` | → `weighed_in` |
| `PATCH /receipts/:id/qc` | `quality_control` | All line verdicts in one call → `qc_passed` or `rejected` |
| `PATCH /receipts/:id/lines/:lineId/unloading` | `unloading` | Per line; rolls the header up |
| `PATCH /receipts/:id/tare-weight` | `weighbridge` | Tare + allocation → `gate_out` |
| `GET /receipts/:id/settlement-context` | `settle` | Per-line deduction preview, bill preview, footing gap |
| `POST /receipts/:id/settle` | `settle` | → `settled`; creates bill (+ credit) |
| `PATCH /receipts/:id/reject` | `override` | Supervisor exit |
| `PATCH /receipts/:id/lines/:lineId` | `gate_in` | Correct a line pre-QC, audited |

Legal transitions are enforced server-side from a single table; any PATCH that
does not match returns **409**.

### Matching and reference

| Endpoint | Purpose |
|---|---|
| `POST /resolve-vendor` | GSTIN → PAN → exact → fuzzy on a normalised name |
| `POST /match-po-lines` | Whole line array in, candidates per line out |
| `GET /purchase-orders/open?vendorId=&locationId=` | Manual picker fallback |
| `GET /gates?locationId=` · `GET /weighbridges?locationId=` | Station context |
| `GET /qc-specs` · `POST /qc-specs` | Spec admin (`override`) |
| `GET /deduction-rules` · `POST /deduction-rules` | Rule admin (`override`) |

### Extraction

| Endpoint | Returns |
|---|---|
| `POST /api/ocr/extract-bill` | Header + **line array**, both reconciliation checks. Tax is read as **one number**, not split CGST/SGST — only so the lines reconcile to the printed grand total |
| `POST /api/ocr/extract-weighslip` | `{ grossKg, tareKg, netKg, slipNumber }` |
| `POST /api/ocr/extract-plate` | `{ plate, confidence }` |

Auth required, rate-limited per user, 5 images, 2 MB each, content-type
allowlist enforced before the model sees anything. An unauthenticated vision
endpoint is a metered API key exposed to the internet.

### Downstream seam

`GET /goods-in?from=&to=&itemId=&locationId=` — settled receipt lines with
item, allocated net, location, date and the linked `bill_lines.landedUnitCost`.
This is what Feed Mill and Farms read. Additive, stable, and the only contract
those modules depend on.

---

## 8. The settlement transaction

`POST /receipts/:id/settle`, entirely inside `db.transaction()`.

1. **Guards.** Status is `gate_out`. Not already settled. Every unloaded line has
   a `poLineId` (V22). `assertPeriodOpen(tx, billDate, "purchases")`.
2. **Bill lines** from lines with `status = 'unloaded'`, carrying `itemId`, HSN
   and the description, at the **all-in rate**:
   `(billAmount + line's share of printed tax) ÷ billQuantityKg`. Line tax is
   used when the paper itemises it, otherwise the header's `billTaxAmount` is
   allocated across lines by value. No `taxId` is set (§3). Rejected lines are
   excluded.
3. **`createBill(tx, …)`** with `vendorBillNumber`, `billDate = vendorBillDate ?? arrivalAt`,
   due date from `paymentTermsDays` falling back to the vendor's terms.
   `purchaseOrderId` is set **only when every line came from one PO**; a
   multi-PO receipt leaves it null and keeps the links on the receipt lines.
4. **Evaluate deduction rules** per unloaded line against the active rule set,
   freezing `version`. Compute `basis` strings for display.
5. **If any deduction fired**, `createVendorCredit(tx, …)` with one line per
   deduction, each carrying the receipt line's `itemId` and no `taxId`, then
   `applyVendorCredit(tx, …)` against the new bill.
6. **Write `receipt_deductions`** rows linked to their vendor credit lines.
7. **Counters.** For each **unloaded** line, `deliveredQuantity += billQuantityKg`
   and `billedQuantity += billQuantityKg` on its PO line. Recompute each
   affected PO's status.

`deliveredQuantity` is incremented exactly once per line, at the moment that
line's fate is sealed:

| Outcome | Incremented at | By |
|---|---|---|
| QC-rejected | station 3, `PATCH /qc` | `billQuantityKg` |
| Unloaded (in full or short) | station 6, settle | `billQuantityKg` |
| Whole receipt turned away | never | — |

QC rejections cannot wait for settlement: a truck with every line rejected skips
tare and never settles, so deferring the write would leave the PO open forever.
A turn-away leaves the PO untouched — the truck was refused at the boom before
anyone looked at the goods, so nothing was delivered.
8. **Link back.** Receipt gets `billId`, `vendorCreditId`, `settledAt`,
   `settledBy`, `status = 'settled'`; each line gets its `billLineId` and
   `status = 'settled'`. The record becomes read-only.
9. **Activity log**, best-effort — never fails the operation it describes.

`turn_away` touches no counter and creates no document.

### Net weight allocation (station 5)

```
net_unloaded = gross − tare

qc_rejected lines:  allocated_net_kg = 0
                    (the material never came off; its weight is inside tare)

unloaded lines:     allocated_net_kg =
                      net_unloaded × billQuantityKg / Σ billQuantityKg of unloaded lines
```

Round each to 3 dp and add the remainder to the largest line so allocations sum
exactly to net. A manual allocation must also sum exactly — reject otherwise.

---

## 9. Screens

**niko theme throughout.** Inter at 13px, `--color-brand-500` for primary,
`.card` / `.input` / `.label` / `.btn-primary` / `.btn-secondary` /
`.table-head`, `StatusBadge` as uppercase coloured text. No pills, no second
palette, no separate mobile design system.

The station screens are used one-handed at a boom barrier and in a weighbridge
cabin, so they are **single-column and responsive** — the same components,
stacked on a phone and centred at `max-w-2xl` on a desk. That is a layout
choice inside the existing kit, not a new one.

| Path | Screen | Action | Layout |
|---|---|---|---|
| `/procurement/gate` | 1 — Gate In | `gate_in` | Capture → confirm; no queue, records are born here |
| `/procurement/weighbridge` | 2 — Gross | `weighbridge` | Queue + weigh card |
| `/procurement/qc` | 3 — QC | `quality_control` | Queue + per-line test card |
| `/procurement/unloading` | 4 — Unloading | `unloading` | Queue + per-line bay card |
| `/procurement/weigh-out` | 5 — Tare | `weighbridge` | Queue + tare and allocation card |
| `/procurement/settlement` | 6 — Settlement | `settle` | `DocumentSplitView`, like Bills |
| `/procurement/qc-specs` | Spec admin | `override` | Standard `ListPage` |

Station 6 is a desk screen and uses the existing document kit unchanged.
Stations 1–5 share one queue component driven by `QueueRow`, polling every 30 s.

Rejected lines are shown greyed and locked, never hidden — a line that vanishes
reads as a mistake.

---

### 9.1 Connectivity at the gate

The boom has the worst signal on site. Two things could be built. They are not
the same size, and only one of them is worth building now.

#### What full offline would actually require

| # | Piece | Cost | Note |
|---|---|---|---|
| 1 | PWA shell — service worker, cached app bundle | Small | `vite-plugin-pwa`, roughly a day |
| 2 | Cached masters in IndexedDB — vendors, items, open PO lines, gates | Small | A few hundred rows each; refreshed when online |
| 3 | Local receipt queue with photo blobs | Small | 3–10 photos ≈ 4 MB per truck; IndexedDB is fine |
| 4 | **Numbering** | Medium | `nextDocumentNumber` is an atomic DB counter. An offline device cannot claim one. The record needs a client UUID identity and gets its `GR-` number at sync |
| 5 | **Duplicate protection breaks** | Large | `uq_pr_active_vehicle` and `uq_pr_vendor_bill` are database-enforced. Two offline devices can both admit the same truck. On sync one insert wins and the other 409s — with a truck already inside the yard. Needs a conflict-resolution screen and someone trained to use it |
| 6 | **Stale PO matching** | Small | Another truck may have consumed the cached PO line. Tolerable: matching is advisory (V6), so re-run it server-side at sync and flag |
| 7 | **Offline auth** | Medium | Sessions live in Postgres. Offline means trusting a cached session — a stolen phone keeps working until it expires |
| 8 | **Clock drift** | Small | Device time is the only time available. Store both (`deviceCapturedAt` vs `arrivalAt`) |

**And the part that cannot be solved.** OCR needs Gemini, vendor resolution and
PO matching need the database. Offline gate-in is therefore *always* the manual
path: hand-type a multi-line bill on a phone at a boom barrier. That is slower
than the paper process it replaces. The camera-first design that makes station 1
fast is precisely the thing that does not survive going offline.

So full offline costs roughly a week and a half, adds a permanent conflict
surface, and delivers a degraded experience in exactly the conditions it exists
for.

#### What to build instead — capture and forward

The gate screen keeps its working state in IndexedDB as the guard fills it in,
photos included. `Allow in` posts immediately when there is signal. When there
is not, the record joins a local queue, the truck goes in, and it posts on
reconnect. The guard sees a `1 pending` chip; tapping it lists what has not
gone through.

| Property | Result |
|---|---|
| Work lost when the tab dies or signal drops | None |
| Truck held at the boom | Never |
| OCR while offline | No — guard types, as they would anyway with no signal |
| Duplicate protection | Intact; the unique indexes still arbitrate at insert |
| Conflict resolution UI | Not needed — the queue is per device and short-lived |
| Cost | 1–2 days |

The difference from full offline is that this does not pretend the app works
without a server. It assumes signal is **intermittent**, not absent, which is
what a 4G phone at a boom barrier actually experiences.

#### Decided

**No offline mode.** Capture-and-forward only, in P4 — it is a retry queue, not
an offline app, and it is the floor below which a dropped signal starts costing
retyped work.

`deviceCapturedAt` ships in P2 regardless, because a time dimension is the one
thing that is expensive to retrofit onto posted documents.

Then measure before revisiting: log failed-request counts and `navigator.onLine`
transitions from the gate device for a fortnight. If the boom turns out to be
genuinely dark for long stretches rather than flaky, reopen this — with real
numbers, and knowing item 5 above is the bill.

---

## 10. Validation matrix

Carried over from the design doc, with the niko mechanism named.

| # | Station | Condition | Behaviour | Mechanism |
|---|---|---|---|---|
| V1 | 1 | Bill number reused by this vendor | Block | partial unique index |
| V2 | 1 | Live receipt open for this plate | Block | partial unique index |
| V3 | 1 | Zero lines | Block | zod `.min(1)` |
| V4 | 1 | Two lines on one PO line | Block | partial unique index |
| V5 | 1 | Σ line amounts + printed tax ≠ printed grand total | Confirm + reason + `override` | route |
| V6 | 1 | Line unmatched to a PO line | Flag only | queue flag |
| V7 | 1 | Rate off PO rate by > ₹0.05/kg | Confirm + reason | route |
| V8 | 1 | Quantity pushes PO line > 5% over remaining | Confirm + reason | route |
| V9 | 1 | Plate read ≠ bill | Confirm | route |
| V10 | 1 | Outside gate radius / no fix | **Flag, never block** | route |
| V11 | 2 | Gross vs slip > 0.5% | Confirm + reason | route |
| V12 | 2 | Gross ≤ slip tare, or > capacity | Block | route |
| V13 | 3 | Confirm QC with a line lacking a verdict | Block | route |
| V14 | 3 | Accept with a spec-required reading empty | Block | route |
| V15 | 3 | Accept a reading outside the band | Confirm + reason + `override` | route |
| V16 | 4 | Bay assigned to a rejected line | Block | route |
| V17 | 4 | Actual bags ≠ expected | Flag, never overwrite expected | route |
| V18 | 5 | Tare ≥ gross | Block | check constraint |
| V19 | 5 | Weigh out while a line still unloading | Block | route |
| V20 | 5 | Manual allocation ≠ net | Block | route |
| V21 | 5 | Line short beyond vendor tolerance | Confirm + reason | route |
| V22 | 6 | Any unloaded line unmatched to a PO line | Block | route |
| V23 | 6 | Already settled | Block | route |
| V24 | 6 | Period locked | Block | `assertPeriodOpen` |

**V10 is deliberate.** A phone beside a steel shed reports ±80 m routinely.
Blocking a gate entry on a drifted fix strands a loaded truck at the boom.

**V6 and V22 together** let a truck through on incomplete paperwork while
guaranteeing no bill is raised until every line has a purchase order behind it.

---

## 11. Phases

Each ends somewhere shippable.

**P0 — Foundations.** Module-aware permissions + role editor. Entity registry.
Column additions to `items`, `contacts`, `purchase_order_lines`, `locations`.
`gates`, `weighbridges`. Migration + `document_series` seed. Nav group.
*Exit: a role can be granted `procurement.gate_in` and it survives a save.*

**P1 — Purchases refactor.** Extract `createBill`, `createVendorCredit`,
`applyVendorCredit` and helpers into `server/services/purchases.ts`. No
behaviour change. *Exit: existing bill / vendor-credit / apply flows behave
identically.*

**P2 — The record.** `procurement_receipts`, `procurement_receipt_lines`,
generated columns, constraints, partial indexes. State machine with 409
enforcement. Roll-up rules. Activity log. Attachments wired to both entities.
*Exit: a receipt can be driven through every state by API.*

**P3 — Stations 2 to 5.** `GET /queue/:station`, the shared queue component,
four station screens, the lifecycle PATCHes, the allocation engine.
*Exit: the middle of the flow runs end to end, multi-line, typed by hand.*

**P4 — Station 1.** Gate In with a manual vendor picker and hand-added lines.
Photo capture, GPS and geofence, turn-away path. Capture-and-forward queue
(§9.1) and the connectivity logging that decides whether more is warranted.
*Exit: the whole flow is usable with no OCR at all, and a dropped signal at the
boom costs nothing.*

**P5 — QC specs.** `qc_specs`, versioning, the admin screen, evaluation against
the active spec, `no_spec` handling.
*Exit: QC verdicts are computed, not typed.*

**P6 — Settlement.** `deduction_rules` and the rule engine, settlement context,
the settle transaction, bill + vendor credit, counters, the chain card.
*Exit: a truck becomes a bill with the right net payable.*

**P7 — Extraction.** The three OCR endpoints, line splitting, both
reconciliation checks, rate-basis and date rules. Fixtures including bill 517
and at least one genuine multi-row bill.

**P8 — Matching.** `resolveVendor`, `matchPurchaseOrderLine` with
`excludePoLineIds`, confidence UI, provenance chips. Station 1 becomes
camera-first with the manual path as fallback.

**P9 — Downstream seam.** `GET /goods-in` for Feed Mill and Farms.

P7 and P8 are additive. If extraction underperforms on handwritten bills,
everything through P6 still stands.

### The OCR fixture that must pass

Shayan Enterprise bill of supply 517, single line. `401 PM` in the quantity
column is a **bag count**; the billed weight is a handwritten `wt 24380`.
Reconciliation resolves it: `24,380 kg = 243.80 qtl × ₹2,310 = ₹5,63,178`,
exact. Read naively, `401` lands in quantity and the receipt is wrong by a
factor of sixty. This case must pass before the OCR layer ships.

---

## 12. Open items

### Still open

1. **Gate coordinates.** Someone must stand at each boom with a phone and record
   the point. Until then V10 is inert and `gateInGeofence` is always `no_fix`.
2. **QC spec bands.** Real limits per material from whoever owns quality. Items
   without an active spec fall back to free entry and a manual verdict.
3. **Weighbridge count** per location — one platform or several? Decides whether
   the operator picks one or it is implied.
4. **Vision model.** Benchmark candidates on real handwritten regional bills
   before P7. Store `ocrModel` from day one so a regression is attributable.

### Settled

| Question | Answer |
|---|---|
| GST handling? | None. Eggs are exempt, so tax is folded into cost — settled for niko before this module (§3) |
| Rejected lines on the bill? | No. We never took the goods (§3) |
| Payable weight when short? | Bill at the vendor's quantity, credit the shortage. It is `deduction_rules` data, not code |
| Shortage tolerance — vendor or material? | Material: `items.shortageTolerancePct` |
| Partial line acceptance? | Not a concept. Material left aboard raises tare, lowers net, lowers allocation, lowers payment (§1) |
| PO quantity on rejection? | Reduced in full. The vendor discharged the order by sending the vehicle (§1) |
| Offline at the gate? | Capture-and-forward, not full offline. Measure before going further (§9.1) |
