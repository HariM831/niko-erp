/**
 * Office — goods receiving.
 *
 * P0 exposes only what the station shells need. The receipt lifecycle, the
 * station queues and settlement arrive in P2 onwards; see
 * docs/office-plan.md for the full API surface.
 */
import { Router } from "express";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { copyFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import multer from "multer";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  RECEIPT_TRANSITIONS,
  TERMINAL_STATUSES,
  type ReceiptStatus,
  contacts,
  documentSeries,
  items,
  locations,
  numberSeries,
  orgProfile,
  officeReceiptLines,
  officeReceipts,
  purchaseOrderLines,
  bills,
  attachments,
} from "@shared/schema";
import { db, type Tx } from "../db";
import { holds, requireAnyPermission, requirePermission } from "../lib/rbac";
import { istDate } from "../services/day-resolution";
import { validateBody } from "../lib/validate";
import { nextDocumentNumber, resyncDocumentNumber } from "../lib/numbering";
import { PostingError, assertPeriodOpen } from "../services/posting";
import { createBill, loadVendor } from "../services/purchases";
import {
  ALLOWED_MIME,
  type ImageInput,
  MAX_IMAGES,
  MAX_IMAGE_BYTES,
  crossCheckGateDocs,
  extractBill,
  extractGateDocs,
} from "../services/ocr";
import { type CaptureKind, encodeForCapture } from "../services/capture";
import { resolvePlace } from "../services/geo";
import { type LineToMatch, matchPurchaseOrderLines } from "../services/po-match";
import { resolveVendor } from "../services/vendor-match";
import { normalisePlate } from "../services/ocr";
import { computeDeductions, judgeLine, loadDeductionRules, loadSpecs } from "../services/qc";
import { learnAlias } from "../services/item-names";

export const officeRouter = Router();

const qtyStr = z.string().regex(/^\d+(\.\d{1,3})?$/);
const moneyStr = z.string().regex(/^\d+(\.\d{1,2})?$/);
const rateStr = z.string().regex(/^\d+(\.\d{1,6})?$/);
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

function fail(err: unknown, res: { status: (n: number) => { json: (b: unknown) => unknown } }) {
  if (err instanceof PostingError) {
    res.status(422).json({ error: err.message });
    return true;
  }
  return false;
}

/** Postgres codes for the guarantees the database owns, not the route. */
function constraintMessage(err: unknown): string | null {
  const e = err as { code?: string; constraint?: string };
  if (e?.code !== "23505") return null;
  switch (e.constraint) {
    case "uq_or_active_vehicle":
      return "That vehicle already has a receipt open — finish or close it first";
    case "uq_or_vendor_bill":
      return "This vendor's bill number has already been received";
    case "uq_orl_po_line":
      return "Two lines cannot claim the same purchase order line";
    case "office_receipts_number_unique":
      return "That receipt number is already taken — try again";
    default:
      return null;
  }
}

/**
 * Move a receipt from one status to the next, or refuse.
 *
 * Six operators who never speak to each other cannot be trusted to arrive in
 * order. A PATCH that does not match a legal move is a 409 rather than a
 * silent write, because a receipt that skipped a station is one nobody can
 * account for afterwards.
 */
export function assertTransition(from: ReceiptStatus, to: ReceiptStatus): void {
  if (TERMINAL_STATUSES.includes(from)) {
    throw new TransitionError(`This receipt is ${from.replace(/_/g, " ")} and cannot be changed`);
  }
  if (!RECEIPT_TRANSITIONS[from].includes(to)) {
    throw new TransitionError(
      `A receipt cannot go from ${from.replace(/_/g, " ")} to ${to.replace(/_/g, " ")}`,
    );
  }
}

export class TransitionError extends Error {}

/**
 * What the next goods receipt will be called, per number series.
 *
 * Read-only view of the counter. Shown at the gate so an operator can tell at a
 * glance that numbering is configured — and, once receipts can be deleted, that
 * the counter rolled back with them.
 */
officeRouter.get("/numbering", requirePermission("office", "view"), async (_req, res) => {
  const rows = await db
    .select({
      entity: documentSeries.entity,
      prefix: documentSeries.prefix,
      nextNumber: documentSeries.nextNumber,
      padding: documentSeries.padding,
      seriesName: numberSeries.name,
      isDefault: numberSeries.isDefault,
    })
    .from(documentSeries)
    .innerJoin(numberSeries, eq(numberSeries.id, documentSeries.seriesId))
    .where(eq(documentSeries.entity, "office_receipt"))
    .orderBy(asc(numberSeries.name));

  // Default series first: it is the one a receipt draws from when the capture
  // form does not name one, which is every receipt until series are in use.
  rows.sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  res.json(rows);
});

// ───────────────────────────── Extraction ─────────────────────────────

const extractBillSchema = z.object({
  /** Base64 images, with or without a data: prefix. */
  images: z.array(z.string().min(1)).min(1).max(MAX_IMAGES),
});

/**
 * Naive per-user throttle on the vision endpoint.
 *
 * The key is metered and billed. This route is behind auth and a permission,
 * but a stuck retry loop on one gate phone would still run up a bill, so the
 * ceiling is per user rather than global.
 */
const ocrCalls = new Map<string, number[]>();
const OCR_WINDOW_MS = 60_000;
const OCR_MAX_PER_WINDOW = 12;

/**
 * Retry a vision call through a quota bounce.
 *
 * Free-tier quota is per minute. Two trucks arriving a minute apart should not
 * show a guard "could not read the bill" when the model was never asked — that
 * teaches people to stop trusting the camera and start typing everything.
 */
async function withOcrRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = String((err as Error)?.message ?? "");
      if (!/429|503|500|quota|rate|overloaded|unavailable/i.test(msg) || attempt === 3) break;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  throw lastErr;
}

function overOcrLimit(userId: string): boolean {
  const now = Date.now();
  const recent = (ocrCalls.get(userId) ?? []).filter((t) => now - t < OCR_WINDOW_MS);
  recent.push(now);
  ocrCalls.set(userId, recent);
  return recent.length > OCR_MAX_PER_WINDOW;
}

officeRouter.post(
  "/extract-bill",
  requirePermission("office", "gate_in"),
  validateBody(extractBillSchema),
  async (req, res) => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(503).json({
        error: "Reading bills automatically needs GEMINI_API_KEY — type the figures for now",
      });
    }
    if (overOcrLimit(req.session.user!.id)) {
      return res.status(429).json({ error: "Too many bill reads — wait a moment and try again" });
    }

    const parsed: ImageInput[] = [];
    for (const img of (req.body as z.infer<typeof extractBillSchema>).images) {
      const m = img.match(/^data:([a-z/+.-]+);base64,(.*)$/i);
      const mimeType = (m?.[1] ?? "image/jpeg").toLowerCase();
      const data = m?.[2] ?? img;
      if (!(ALLOWED_MIME as readonly string[]).includes(mimeType)) {
        return res.status(415).json({ error: `Unsupported image type: ${mimeType}` });
      }
      // Checked before the model ever sees it, not after.
      if (Math.floor((data.length * 3) / 4) > MAX_IMAGE_BYTES) {
        return res.status(413).json({ error: "Each image must be under 2 MB" });
      }
      parsed.push({ data, mimeType });
    }

    const master = await db
      .select({ id: items.id, name: items.name, aliases: items.aliases })
      .from(items)
      .where(and(eq(items.isActive, true), eq(items.isPurchased, true)));

    try {
      const bill = await withOcrRetry(() => extractBill(parsed, master, apiKey));
      // The letterhead is a string; the form needs a contact. Resolved here so
      // the guard is not left picking from four hundred names at the barrier.
      const vendorMatch = await resolveVendor(db, {
        name: bill.vendor,
        pan: bill.vendorPan,
        gstin: bill.vendorGstin,
      });
      res.json({ ...bill, vendorMatch });
    } catch (err) {
      console.error("[ocr] extract-bill failed:", err);
      res.status(502).json({ error: "Could not read the bill — enter the figures by hand" });
    }
  },
);

const gateDocsSchema = z.object({
  vehicle: z.string().min(1).optional(),
  weighslip: z.string().min(1).optional(),
  /** Sent back so the plate and slip can be checked against what the bill said. */
  bill: z.any().optional(),
});

/**
 * Read the vehicle photo and the weigh slip together, and say what they prove
 * about the bill. One call rather than two: both are trivial reads next to a
 * handwritten bill.
 */
officeRouter.post(
  "/extract-gate-docs",
  requirePermission("office", "gate_in"),
  validateBody(gateDocsSchema),
  async (req, res) => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(503).json({ error: "Reading photos automatically needs GEMINI_API_KEY" });
    }
    if (overOcrLimit(req.session.user!.id)) {
      return res.status(429).json({ error: "Too many reads — wait a moment and try again" });
    }
    const body = req.body as z.infer<typeof gateDocsSchema>;
    if (!body.vehicle && !body.weighslip) {
      return res.status(400).json({ error: "Send a vehicle photo, a weigh slip, or both" });
    }

    const decode = (img?: string): ImageInput | undefined => {
      if (!img) return undefined;
      const m = img.match(/^data:([a-z/+.-]+);base64,(.*)$/i);
      return { data: m?.[2] ?? img, mimeType: (m?.[1] ?? "image/jpeg").toLowerCase() };
    };

    try {
      const { plate, weighslip, usage } = await withOcrRetry(() =>
        extractGateDocs({ vehicle: decode(body.vehicle), weighslip: decode(body.weighslip) }, apiKey),
      );
      const checks = crossCheckGateDocs({
        bill: body.bill ?? null,
        slip: weighslip,
        plate: plate.plate,
      });
      res.json({ plate, weighslip, checks, usage });
    } catch (err) {
      console.error("[ocr] extract-gate-docs failed:", err);
      res.status(502).json({ error: "Could not read the photos — enter the figures by hand" });
    }
  },
);

/**
 * Which open order does this delivery belong to?
 *
 * Asked at the gate, before the boom lifts, because the answer decides whether
 * the truck comes in at all.
 */
officeRouter.post(
  "/match-po-lines",
  requirePermission("office", "gate_in"),
  validateBody(
    z.object({
      vendorId: z.string().uuid().nullable().optional(),
      billDate: dateStr.nullable().optional(),
      lines: z
        .array(
          z.object({
            itemId: z.string().uuid().nullable().optional(),
            itemName: z.string().nullable().optional(),
            quantityKg: z.number().nullable().optional(),
            ratePerKg: z.number().nullable().optional(),
          }),
        )
        .min(1)
        .max(50),
    }),
  ),
  async (req, res) => {
    const body = req.body as {
      vendorId?: string | null;
      billDate?: string | null;
      lines: LineToMatch[];
    };
    const matches = await matchPurchaseOrderLines(db, {
      vendorId: body.vendorId ?? null,
      billDate: body.billDate ?? null,
      lines: body.lines,
    });
    res.json({
      matches,
      /** Every line has an order behind it — the gate may open. */
      allMatched: matches.length > 0 && matches.every((m) => m.chosen != null),
    });
  },
);

// ───────────────────────────── Gate photos ─────────────────────────────

const UPLOAD_DIR = path.resolve(process.cwd(), "uploads");
if (!existsSync(UPLOAD_DIR)) mkdirSync(UPLOAD_DIR, { recursive: true });

/** Held in memory: every photo is re-encoded before it reaches disk. */
const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) =>
    cb(null, (ALLOWED_MIME as readonly string[]).includes(file.mimetype)),
});

const CAPTURE_KINDS: Record<string, CaptureKind> = {
  gate_in_bill: "bill",
  gate_in_vehicle: "vehicle",
  gate_in_weighslip: "weighslip",
  weighbridge_gross: "vehicle",
  weighbridge_tare: "vehicle",
  qc: "vehicle",
  unloading: "vehicle",
  gate_out_vehicle: "vehicle",
};

/**
 * Store a photo taken at a station.
 *
 * Re-encoded server-side even though the client already did it: a client can be
 * modified, and an unbounded image is both a storage problem and a bill from the
 * vision API. The provenance band is burnt in here rather than on the device so
 * the place name comes from our own gates table and not from whatever the phone
 * happened to believe.
 */
officeRouter.post(
  "/receipts/:id/photos",
  requirePermission("office", "gate_in"),
  photoUpload.single("file"),
  async (req, res) => {
    const file = (req as unknown as { file?: Express.Multer.File }).file;
    if (!file) return res.status(400).json({ error: "No photo was uploaded" });

    const kindKey = String(req.body.kind ?? "gate_in_bill");
    const kind = CAPTURE_KINDS[kindKey];
    if (!kind) return res.status(400).json({ error: `Unknown photo kind: ${kindKey}` });

    const receipt = await db.query.officeReceipts.findFirst({
      where: eq(officeReceipts.id, req.params.id!),
    });
    if (!receipt) return res.status(404).json({ error: "Goods receipt not found" });

    const lat = Number(req.body.latitude);
    const lng = Number(req.body.longitude);
    const accuracyM = Number(req.body.accuracyM);
    const fix =
      Number.isFinite(lat) && Number.isFinite(lng)
        ? { latitude: lat, longitude: lng, accuracyM: Number.isFinite(accuracyM) ? accuracyM : undefined }
        : null;
    const place = await resolvePlace(db, fix);

    const capturedAt = req.body.capturedAt ? new Date(String(req.body.capturedAt)) : new Date();

    const encoded = await encodeForCapture(file.buffer, kind, {
      place: place.label,
      capturedAt,
      accuracyM: fix?.accuracyM ?? null,
      reference: receipt.number,
    });

    const storedName = `${randomBytes(16).toString("hex")}.jpg`;
    await writeFile(path.join(UPLOAD_DIR, storedName), encoded);

    const [row] = await db
      .insert(attachments)
      .values({
        entityType: "office_receipt",
        entityId: receipt.id,
        fileName: file.originalname || `${kindKey}.jpg`,
        storedName,
        mimeType: "image/jpeg",
        sizeBytes: encoded.length,
        uploadedBy: req.session.user!.id,
        kind: kindKey,
        capturedAt,
        latitude: fix ? String(fix.latitude) : null,
        longitude: fix ? String(fix.longitude) : null,
        accuracyM: fix?.accuracyM != null ? String(fix.accuracyM) : null,
        locationId: place.locationId,
      })
      .returning();

    res.status(201).json({ ...row, place: place.label, geofence: place.verdict });
  },
);

// ─────────────────────────── Reference data ───────────────────────────

officeRouter.get("/context", requirePermission("office", "view"), async (_req, res) => {
  const [locs, vendors, purchasable] = await Promise.all([
    db
      .select({ id: locations.id, name: locations.name, code: locations.code })
      .from(locations)
      .where(eq(locations.isActive, true))
      .orderBy(asc(locations.name)),
    db
      .select({ id: contacts.id, name: contacts.displayName })
      .from(contacts)
      .where(and(inArray(contacts.type, ["vendor", "both"]), eq(contacts.isActive, true)))
      .orderBy(asc(contacts.displayName)),
    db
      .select({ id: items.id, name: items.name, unit: items.unit, hsnOrSac: items.hsnOrSac })
      .from(items)
      .where(and(eq(items.isActive, true), eq(items.isPurchased, true)))
      .orderBy(asc(items.name)),
  ]);
  res.json({ locations: locs, vendors, items: purchasable });
});

// ───────────────────────────── Receipts ─────────────────────────────

const receiptLineSchema = z.object({
  itemId: z.string().uuid().optional(),
  itemName: z.string().min(1),
  billDescription: z.string().optional(),
  billHsnCode: z.string().max(10).optional(),
  billQuantityKg: qtyStr,
  billRatePerKg: rateStr.optional(),
  billRateBasis: z.enum(["kg", "quintal", "mt"]).optional(),
  billAmount: moneyStr.optional(),
  billBagCount: z.number().int().nonnegative().optional(),
  purchaseOrderId: z.string().uuid().optional(),
  poLineId: z.string().uuid().optional(),
});

const createReceiptSchema = z.object({
  seriesId: z.string().uuid().optional(),
  locationId: z.string().uuid(),
  gateId: z.string().uuid().optional(),
  /**
   * The device's fix at the moment of gate-in.
   *
   * Optional, and never blocking: a phone indoors or with location refused
   * still has to be able to let a truck in. What it changes is whether the
   * receipt can say WHERE it was raised — without it, `gate_in_geofence`
   * records `no_fix`, which is the honest answer rather than a silent null.
   */
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  accuracyM: z.number().nonnegative().optional(),
  /** The gate's one decision. A turn-away is a record, not an absence of one. */
  decision: z.enum(["allow", "turn_away"]).default("allow"),
  exitReason: z.string().optional(),
  vendorId: z.string().uuid().optional(),
  vehicleNumber: z.string().min(4).max(20),
  vendorBillNumber: z.string().optional(),
  vendorBillDate: dateStr.optional(),
  billDocumentType: z.enum(["tax_invoice", "bill_of_supply", "delivery_challan", "unknown"]).optional(),
  billTotalAmount: moneyStr.optional(),
  billTaxAmount: moneyStr.optional(),
  paymentTermsDays: z.number().int().min(0).max(365).optional(),
  deviceCapturedAt: z.string().datetime().optional(),
  lines: z.array(receiptLineSchema).min(1).max(50),
});

officeRouter.post(
  "/receipts",
  requirePermission("office", "gate_in"),
  validateBody(createReceiptSchema),
  async (req, res) => {
    const body = req.body as z.infer<typeof createReceiptSchema>;
    if (body.decision === "turn_away" && !body.exitReason?.trim()) {
      return res.status(422).json({ error: "Turning a truck away needs a reason" });
    }
    try {
      const result = await db.transaction(async (tx) => {
        const number = await nextDocumentNumber(tx, "office_receipt", body.seriesId);
        const turnedAway = body.decision === "turn_away";

        // Resolved against the live gates, so the receipt records where it was
        // raised rather than only where somebody said it was. Returns a no_fix
        // verdict when the device gave nothing, which never blocks the gate.
        const fix =
          body.latitude != null && body.longitude != null
            ? { latitude: body.latitude, longitude: body.longitude, accuracyM: body.accuracyM }
            : null;
        const place = await resolvePlace(tx, fix);

        const [receipt] = await tx
          .insert(officeReceipts)
          .values({
            number,
            status: turnedAway ? "turned_away" : "gate_in",
            locationId: body.locationId,
            // The gate the fix actually lands at wins over the one the client
            // named: a phone knows where it is, a dropdown knows what was last
            // selected. An explicit choice still stands when there is no fix.
            gateId: place.gateId ?? body.gateId,
            gateInLatitude: fix ? String(fix.latitude) : null,
            gateInLongitude: fix ? String(fix.longitude) : null,
            gateInAccuracyM: fix?.accuracyM != null ? String(fix.accuracyM) : null,
            gateInDistanceM: place.distanceM != null ? place.distanceM.toFixed(2) : null,
            gateInGeofence: place.verdict,
            vendorId: body.vendorId,
            vehicleNumber: normalisePlate(body.vehicleNumber) ?? body.vehicleNumber,
            vendorBillNumber: body.vendorBillNumber,
            vendorBillDate: body.vendorBillDate,
            billDocumentType: body.billDocumentType,
            billTotalAmount: body.billTotalAmount,
            billTaxAmount: body.billTaxAmount,
            paymentTermsDays: body.paymentTermsDays,
            deviceCapturedAt: body.deviceCapturedAt ? new Date(body.deviceCapturedAt) : undefined,
            gateInBy: req.session.user!.id,
            exitStage: turnedAway ? "gate" : undefined,
            exitReason: turnedAway ? body.exitReason : undefined,
            exitAt: turnedAway ? new Date() : undefined,
            exitBy: turnedAway ? req.session.user!.id : undefined,
          })
          .returning();

        // The gate is where the vendor's vocabulary meets ours. A wording that
        // resolved to an item but is not yet its name or alias is LEARNED here,
        // so the next bill from this vendor matches with nobody retyping it.
        for (const l of body.lines) {
          if (l.itemId && l.itemName) await learnAlias(tx, l.itemId, l.itemName);
        }

        await tx.insert(officeReceiptLines).values(
          body.lines.map((l, i) => ({
            receiptId: receipt!.id,
            lineNo: i + 1,
            itemId: l.itemId,
            itemName: l.itemName,
            billDescription: l.billDescription,
            billHsnCode: l.billHsnCode,
            billQuantityKg: l.billQuantityKg,
            billRatePerKg: l.billRatePerKg,
            billRateBasis: l.billRateBasis,
            billAmount: l.billAmount,
            billBagCount: l.billBagCount,
            bagCountExpected: l.billBagCount,
            purchaseOrderId: l.purchaseOrderId,
            poLineId: l.poLineId,
            // The rate we will pay on, snapshotted. Falls back to the bill's
            // own rate until PO matching lands in P8.
            agreedRatePerKg: l.billRatePerKg,
          })),
        );
        return receipt!;
      });
      res.status(201).json(result);
    } catch (err) {
      const msg = constraintMessage(err);
      if (msg) return res.status(409).json({ error: msg });
      if (!fail(err, res)) throw err;
    }
  },
);

officeRouter.get("/receipts", requirePermission("office", "view"), async (req, res) => {
  const { status, vendorId, locationId } = req.query as Record<string, string | undefined>;
  const where = [];
  if (status) where.push(eq(officeReceipts.status, status as ReceiptStatus));
  if (vendorId) where.push(eq(officeReceipts.vendorId, vendorId));
  if (locationId) where.push(eq(officeReceipts.locationId, locationId));

  const rows = await db
    .select({
      id: officeReceipts.id,
      number: officeReceipts.number,
      status: officeReceipts.status,
      vehicleNumber: officeReceipts.vehicleNumber,
      vendorName: contacts.displayName,
      vendorBillNumber: officeReceipts.vendorBillNumber,
      arrivalAt: officeReceipts.arrivalAt,
      locationName: locations.name,
      lineCount: sql<number>`(
        SELECT COUNT(*)::int FROM office_receipt_lines l
        WHERE l.receipt_id = ${officeReceipts.id}
      )`,
      billQuantityKg: sql<string>`(
        SELECT COALESCE(SUM(l.bill_quantity_kg), 0)::numeric(14,3) FROM office_receipt_lines l
        WHERE l.receipt_id = ${officeReceipts.id}
      )`,
    })
    .from(officeReceipts)
    .leftJoin(contacts, eq(contacts.id, officeReceipts.vendorId))
    .leftJoin(locations, eq(locations.id, officeReceipts.locationId))
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(officeReceipts.arrivalAt))
    .limit(200);
  res.json(rows);
});

officeRouter.get("/receipts/:id", requirePermission("office", "view"), async (req, res) => {
  const receipt = await db.query.officeReceipts.findFirst({
    where: eq(officeReceipts.id, req.params.id!),
  });
  if (!receipt) return res.status(404).json({ error: "Goods receipt not found" });
  const lines = await db
    .select()
    .from(officeReceiptLines)
    .where(eq(officeReceiptLines.receiptId, receipt.id))
    .orderBy(asc(officeReceiptLines.lineNo));
  res.json({ ...receipt, lines });
});

// ──────────────────────────── The stations ────────────────────────────

/** Which receipts each station is waiting on. */
const QUEUE_STATUSES: Record<string, ReceiptStatus[]> = {
  gross: ["gate_in"],
  qc: ["weighed_in"],
  unloading: ["qc_passed", "unloading"],
  // Unloading is not a station of its own: bags are counted at the weighbridge
  // as the truck empties, so a QC-passed truck queues here directly.
  tare: ["qc_passed", "unloading", "unloading_complete"],
  settlement: ["gate_out"],
};

officeRouter.get(
  "/queue/:station",
  requirePermission("office", "view"),
  async (req, res) => {
    const statuses = QUEUE_STATUSES[req.params.station!];
    if (!statuses) return res.status(404).json({ error: "No such station" });

    const rows = await db
      .select({
        id: officeReceipts.id,
        number: officeReceipts.number,
        status: officeReceipts.status,
        vehicleNumber: officeReceipts.vehicleNumber,
        vendorName: contacts.displayName,
        arrivalAt: officeReceipts.arrivalAt,
        grossWeightKg: officeReceipts.grossWeightKg,
        netWeightKg: officeReceipts.netWeightKg,
        vendorSlipGrossKg: officeReceipts.vendorSlipGrossKg,
        lineCount: sql<number>`(SELECT COUNT(*)::int FROM office_receipt_lines l WHERE l.receipt_id = ${officeReceipts.id})`,
        lineSummary: sql<string>`(SELECT string_agg(l.item_name, ', ' ORDER BY l.line_no) FROM office_receipt_lines l WHERE l.receipt_id = ${officeReceipts.id})`,
        linesRejected: sql<number>`(SELECT COUNT(*)::int FROM office_receipt_lines l WHERE l.receipt_id = ${officeReceipts.id} AND l.status = 'qc_rejected')`,
        billQuantityKg: sql<string>`(SELECT COALESCE(SUM(l.bill_quantity_kg),0)::numeric(14,3) FROM office_receipt_lines l WHERE l.receipt_id = ${officeReceipts.id})`,
        // Computed in SQL, not from the JSON timestamp. arrival_at is a naive
        // `timestamp`, so a client that parses it as UTC reads a truck as having
        // arrived hours in the future and shows a negative wait.
        ageMinutes: sql<number>`GREATEST(0, EXTRACT(EPOCH FROM (NOW() - ${officeReceipts.arrivalAt})) / 60)::int`,
      })
      .from(officeReceipts)
      .leftJoin(contacts, eq(contacts.id, officeReceipts.vendorId))
      .where(inArray(officeReceipts.status, statuses))
      .orderBy(asc(officeReceipts.arrivalAt));

    res.json(rows);
  },
);

/** Load a receipt and refuse the move up front, before anything is written. */
async function forTransition(tx: Tx, id: string, to: ReceiptStatus) {
  const receipt = await tx.query.officeReceipts.findFirst({
    where: eq(officeReceipts.id, id),
  });
  if (!receipt) throw new PostingError("Goods receipt not found");
  assertTransition(receipt.status, to);
  return receipt;
}

/** Station 2 — the platform records a fact. It judges nothing. */
officeRouter.patch(
  "/receipts/:id/gross-weight",
  requirePermission("office", "weighbridge"),
  validateBody(
    z.object({
      grossWeightKg: qtyStr,
      weighbridgeId: z.string().uuid().optional(),
      varianceReason: z.string().optional(),
    }),
  ),
  async (req, res) => {
    const body = req.body as { grossWeightKg: string; weighbridgeId?: string; varianceReason?: string };
    try {
      const out = await db.transaction(async (tx) => {
        const receipt = await forTransition(tx, req.params.id!, "weighed_in");
        const gross = Number(body.grossWeightKg);

        // Their slip against our platform. Beyond half a percent somebody has
        // to say why before the truck moves on.
        const slip = Number(receipt.vendorSlipGrossKg ?? 0);
        let variancePct: number | null = null;
        if (slip > 0) {
          variancePct = Number((((gross - slip) / slip) * 100).toFixed(3));
          if (Math.abs(variancePct) > 0.5 && !body.varianceReason?.trim()) {
            throw new PostingError(
              `Our gross is ${variancePct.toFixed(2)}% off the vendor's slip — a reason is needed`,
            );
          }
        }

        const [updated] = await tx
          .update(officeReceipts)
          .set({
            grossWeightKg: body.grossWeightKg,
            grossWeighedAt: new Date(),
            grossWeighedBy: req.session.user!.id,
            grossWeighbridgeId: body.weighbridgeId,
            grossVariancePct: variancePct != null ? String(variancePct) : null,
            grossVarianceReason: body.varianceReason,
            status: "weighed_in",
            updatedAt: new Date(),
          })
          .where(eq(officeReceipts.id, receipt.id))
          .returning();
        return updated!;
      });
      res.json(out);
    } catch (err) {
      if (err instanceof TransitionError) return res.status(409).json({ error: err.message });
      if (!fail(err, res)) throw err;
    }
  },
);

/**
 * What the bench needs in front of it: the bands for each material, and how
 * whatever has been typed so far reads against them.
 */
/**
 * The mill at a glance: what is waiting, and what has been made today.
 *
 * Reachable by anyone who does one of the mill's jobs, because a weighbridge
 * operator and a mill manager share no single permission — but each section is
 * withheld unless the caller could open the page it links to. A count of
 * trucks awaiting settlement is itself information, so a gate operator with no
 * settlement rights is not told how many there are.
 */
officeRouter.get(
  "/overview",
  requireAnyPermission([
    ["office", "view"],
    ["office", "gate_in"],
    ["office", "weighbridge"],
    ["office", "settle"],
    ["feed_mill", "view"],
    ["feed_mill", "produce"],
  ]),
  async (req, res) => {
    const perms = req.session.user!.permissions;
    const may = (m: string, a: string) => holds(perms, m, a);
    const today = istDate();

    const countByStatus = async (statuses: ReceiptStatus[]) => {
      if (!statuses.length) return 0;
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(officeReceipts)
        .where(inArray(officeReceipts.status, statuses));
      return row?.n ?? 0;
    };

    const out: Record<string, unknown> = { day: today };

    if (may("office", "gate_in") || may("office", "view")) {
      out.atGate = await countByStatus(QUEUE_STATUSES.gross!);
    }
    if (may("office", "weighbridge") || may("office", "view")) {
      out.awaitingWeighment = await countByStatus(QUEUE_STATUSES.tare!);
      out.awaitingQc = await countByStatus(QUEUE_STATUSES.qc!);
    }
    if (may("office", "settle") || may("office", "view")) {
      out.awaitingSettlement = await countByStatus(QUEUE_STATUSES.settlement!);
    }
    if (may("office", "view")) {
      const [r] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(officeReceipts)
        .where(sql`(${officeReceipts.arrivalAt} AT TIME ZONE 'Asia/Kolkata')::date = ${today}`);
      out.receiptsToday = r?.n ?? 0;
    }
    if (may("feed_mill", "view") || may("feed_mill", "produce")) {
      const [prod] = await db.execute(sql`
        SELECT count(*)::int AS runs,
               coalesce(sum(batch_count), 0)::int AS batches
          FROM production_orders
         WHERE (created_at AT TIME ZONE 'Asia/Kolkata')::date = ${today}
      `).then((r) => r.rows as Array<{ runs: number; batches: number }>);
      out.productionToday = prod ?? { runs: 0, batches: 0 };

      const [sent] = await db.execute(sql`
        SELECT coalesce(sum(quantity_kg), 0)::float8 AS kg
          FROM feed_transfers
         WHERE transfer_date = ${today} AND status IS DISTINCT FROM 'void'
      `).then((r) => r.rows as Array<{ kg: number }>);
      out.feedSentTodayKg = sent?.kg ?? 0;
    }

    res.json(out);
  },
);

officeRouter.get(
  "/receipts/:id/qc-context",
  requirePermission("office", "quality_control"),
  async (req, res) => {
    const receipt = await db.query.officeReceipts.findFirst({
      where: eq(officeReceipts.id, req.params.id!),
    });
    if (!receipt) return res.status(404).json({ error: "Goods receipt not found" });

    const lines = await db
      .select()
      .from(officeReceiptLines)
      .where(eq(officeReceiptLines.receiptId, receipt.id))
      .orderBy(asc(officeReceiptLines.lineNo));

    const specs = await loadSpecs(db, lines.map((l) => l.itemId).filter(Boolean) as string[]);

    res.json({
      number: receipt.number,
      status: receipt.status,
      lines: lines.map((l) => {
        const spec = l.itemId ? specs.get(l.itemId) : undefined;
        const readings = readingsOf(l);
        return {
          id: l.id,
          lineNo: l.lineNo,
          itemName: l.itemName,
          status: l.status,
          billQuantityKg: l.billQuantityKg,
          sampleCount: spec?.spec.sampleCount ?? null,
          // The bands, so a technician sees what they are aiming at rather
          // than having to remember it.
          params: (spec?.params ?? []).map((p) => ({
            parameter: p.parameter,
            label: p.label ?? p.parameter,
            direction: p.direction,
            target: p.target,
            warnAt: p.warnAt,
            rejectAt: p.rejectAt,
          })),
          judged: judgeLine(readings, spec),
        };
      }),
    });
  },
);

/** The QC readings held on a line, keyed the way a spec names them. */
function readingsOf(l: typeof officeReceiptLines.$inferSelect): Record<string, number | null> {
  const other = (l.qcOtherParams ?? {}) as Record<string, number>;
  return {
    ...other,
    moisture: l.qcMoisturePct == null ? null : Number(l.qcMoisturePct),
    protein: l.qcProteinPct == null ? null : Number(l.qcProteinPct),
    fiber: l.qcFiberPct == null ? null : Number(l.qcFiberPct),
    fat: l.qcFatPct == null ? null : Number(l.qcFatPct),
  };
}

/**
 * Station 3 — QC. Every line is judged in one call.
 *
 * **The verdict is computed, never submitted.** A technician enters what the
 * instrument said; the spec decides what that means. Anything else lets a
 * reading and a verdict disagree on the same record, and the verdict is what
 * everyone downstream believes.
 *
 * Overriding is still possible — a supervisor can take a load the spec refuses,
 * or refuse one it allows — but it costs the `override` permission and a
 * reason, and is recorded as an override rather than dressed up as a pass.
 *
 * All verdicts commit together so the truck's status changes at once rather
 * than drifting through half-tested states while someone works down the trailer.
 */
officeRouter.patch(
  "/receipts/:id/qc",
  requirePermission("office", "quality_control"),
  validateBody(
    z.object({
      lines: z
        .array(
          z.object({
            lineId: z.string().uuid(),
            /** Whatever the instrument reported, keyed by parameter. */
            readings: z.record(z.string(), z.number().nullable()).default({}),
            /** Set only to disagree with the computed verdict. */
            override: z
              .object({
                verdict: z.enum(["accept", "reject"]),
                reason: z.string().min(3),
              })
              .optional(),
            /** Required when a material has no spec to judge it by. */
            manualVerdict: z.enum(["accept", "reject"]).optional(),
            rejectionReason: z.string().optional(),
            sampleCount: z.number().int().positive().optional(),
          }),
        )
        .min(1),
    }),
  ),
  async (req, res) => {
    const body = req.body as {
      lines: Array<{
        lineId: string;
        readings: Record<string, number | null>;
        override?: { verdict: "accept" | "reject"; reason: string };
        manualVerdict?: "accept" | "reject";
        rejectionReason?: string;
        sampleCount?: number;
      }>;
    };
    const mayOverride =
      req.session.user!.permissions["*"]?.includes("*") ||
      req.session.user!.permissions.office?.includes("*") ||
      req.session.user!.permissions.office?.includes("override");

    try {
      const out = await db.transaction(async (tx) => {
        const receipt = await tx.query.officeReceipts.findFirst({
          where: eq(officeReceipts.id, req.params.id!),
        });
        if (!receipt) throw new PostingError("Goods receipt not found");

        const lines = await tx
          .select()
          .from(officeReceiptLines)
          .where(eq(officeReceiptLines.receiptId, receipt.id));

        // Every line gets a verdict or none do: a truck cannot leave QC with a
        // material nobody looked at.
        const given = new Set(body.lines.map((l) => l.lineId));
        const missingLines = lines.filter((l) => !given.has(l.id));
        if (missingLines.length) {
          throw new PostingError(
            `${missingLines.length} line(s) still have no verdict — QC commits all of them together`,
          );
        }

        const specs = await loadSpecs(tx, lines.map((l) => l.itemId).filter(Boolean) as string[]);
        const decided: Array<{ line: typeof lines[number]; accepted: boolean }> = [];

        for (const input of body.lines) {
          const line = lines.find((l) => l.id === input.lineId);
          if (!line) throw new PostingError("That line does not belong to this receipt");
          const spec = line.itemId ? specs.get(line.itemId) : undefined;
          const judged = judgeLine(input.readings, spec);

          let verdict: "pass" | "warning" | "rejected" | "overridden" | "no_spec" = judged.verdict;
          let accepted: boolean;
          let overrideReason: string | null = null;
          let rejectionReason: string | null = null;

          if (judged.verdict === "no_spec") {
            // Nothing to judge by, so a person must say. Recorded as no_spec,
            // not as a pass — an unjudged load should never look tested.
            if (!input.manualVerdict) {
              throw new PostingError(
                `${line.itemName ?? "This material"} has no quality spec — accept or reject it by hand`,
              );
            }
            accepted = input.manualVerdict === "accept";
            verdict = "no_spec";
            if (!accepted) rejectionReason = input.rejectionReason ?? "Rejected by hand, no spec on file";
          } else {
            // A required reading left empty is not a pass (V14).
            if (judged.missing.length && !input.override) {
              throw new PostingError(
                `${line.itemName ?? "This line"} is missing ${judged.missing.join(", ")}`,
              );
            }
            accepted = judged.verdict !== "rejected";

            if (input.override) {
              const wanted = input.override.verdict === "accept";
              if (wanted !== accepted) {
                if (!mayOverride) {
                  throw new PostingError(
                    "Overriding a quality verdict needs the office override permission",
                  );
                }
                accepted = wanted;
                verdict = "overridden";
                overrideReason = input.override.reason;
              }
            }
            if (!accepted) {
              // Default the reason to what the spec actually objected to, so a
              // refusal is never recorded as a bare "rejected".
              const fromSpec = judged.params
                .filter((p) => p.verdict === "rejected")
                .map((p) => p.detail)
                .join("; ");
              rejectionReason = input.rejectionReason ?? (fromSpec || "Outside specification");
            }
          }

          const other = { ...input.readings };
          for (const k of ["moisture", "protein", "fiber", "fat"]) delete other[k];

          await tx
            .update(officeReceiptLines)
            .set({
              status: accepted ? "qc_accepted" : "qc_rejected",
              qcSpecId: judged.specId,
              qcVerdict: verdict,
              qcMoisturePct: num(input.readings.moisture),
              qcProteinPct: num(input.readings.protein),
              qcFiberPct: num(input.readings.fiber),
              qcFatPct: num(input.readings.fat),
              qcOtherParams: Object.keys(other).length ? other : null,
              qcSampleCount: input.sampleCount ?? null,
              qcOverrideReason: overrideReason,
              qcOverrideBy: overrideReason ? req.session.user!.id : null,
              qcRejectionReason: rejectionReason,
            })
            .where(eq(officeReceiptLines.id, line.id));

          // A rejected line still consumed its slot on the order: the vendor
          // discharged their obligation by sending it. Written now rather than
          // at settlement, because a wholly rejected truck never settles and
          // the order would otherwise stay open for ever.
          if (!accepted && line.poLineId) {
            await tx
              .update(purchaseOrderLines)
              .set({
                deliveredQuantity: sql`${purchaseOrderLines.deliveredQuantity} + ${line.billQuantityKg}`,
              })
              .where(eq(purchaseOrderLines.id, line.poLineId));
          }
          decided.push({ line, accepted });
        }

        const anyAccepted = decided.some((d) => d.accepted);
        const next: ReceiptStatus = anyAccepted ? "qc_passed" : "rejected";
        assertTransition(receipt.status, next);
        const rejected = decided.filter((d) => !d.accepted).length;

        const [updated] = await tx
          .update(officeReceipts)
          .set({
            status: next,
            qcAt: new Date(),
            qcBy: req.session.user!.id,
            qcRollupVerdict: rejected === 0 ? "all_passed" : anyAccepted ? "partial" : "all_rejected",
            // A truck with nothing accepted leaves loaded and skips the tare.
            exitStage: anyAccepted ? undefined : "qc",
            exitReason: anyAccepted ? undefined : "Every line failed quality control",
            exitAt: anyAccepted ? undefined : new Date(),
            exitBy: anyAccepted ? undefined : req.session.user!.id,
            updatedAt: new Date(),
          })
          .where(eq(officeReceipts.id, receipt.id))
          .returning();
        return updated!;
      });
      res.json(out);
    } catch (err) {
      if (err instanceof TransitionError) return res.status(409).json({ error: err.message });
      if (!fail(err, res)) throw err;
    }
  },
);

const num = (v: number | null | undefined) => (v == null ? null : String(v));

/** Station 4 — unloading, one line at a time. The header follows the lines. */
officeRouter.patch(
  "/receipts/:id/lines/:lineId/unloading",
  requirePermission("office", "unloading"),
  validateBody(
    z.object({
      warehouseLocationId: z.string().uuid().optional(),
      bagCountActual: z.number().int().nonnegative().optional(),
      damagePercent: z.number().min(0).max(100).optional(),
      damageType: z.string().max(12).optional(),
      damageRemarks: z.string().optional(),
      complete: z.boolean().default(false),
    }),
  ),
  async (req, res) => {
    const body = req.body as {
      warehouseLocationId?: string;
      bagCountActual?: number;
      damagePercent?: number;
      damageType?: string;
      damageRemarks?: string;
      complete: boolean;
    };
    try {
      const out = await db.transaction(async (tx) => {
        const receipt = await tx.query.officeReceipts.findFirst({
          where: eq(officeReceipts.id, req.params.id!),
        });
        if (!receipt) throw new PostingError("Goods receipt not found");
        if (receipt.status !== "qc_passed" && receipt.status !== "unloading") {
          throw new TransitionError(`Nothing can be unloaded while the receipt is ${receipt.status}`);
        }

        const line = await tx.query.officeReceiptLines.findFirst({
          where: eq(officeReceiptLines.id, req.params.lineId!),
        });
        if (!line || line.receiptId !== receipt.id) {
          throw new PostingError("That line does not belong to this receipt");
        }
        // Material QC refused stays on the truck. Giving it a bay would put
        // rejected goods into a silo.
        if (line.status === "qc_rejected") {
          throw new PostingError("This line was rejected at QC and must not be unloaded");
        }

        await tx
          .update(officeReceiptLines)
          .set({
            status: body.complete ? "unloaded" : "unloading",
            warehouseLocationId: body.warehouseLocationId,
            bagCountActual: body.bagCountActual,
            damagePercent: body.damagePercent != null ? String(body.damagePercent) : null,
            damageType: body.damageType,
            damageRemarks: body.damageRemarks,
            unloadingStartedAt: line.unloadingStartedAt ?? new Date(),
            unloadingCompletedAt: body.complete ? new Date() : null,
            unloadingBy: req.session.user!.id,
          })
          .where(eq(officeReceiptLines.id, line.id));

        // The header moves on only when every accepted line is off.
        const siblings = await tx
          .select({ status: officeReceiptLines.status })
          .from(officeReceiptLines)
          .where(eq(officeReceiptLines.receiptId, receipt.id));
        const accepted = siblings.filter((s) => s.status !== "qc_rejected");
        const allOff = accepted.every((s) => s.status === "unloaded");

        const [updated] = await tx
          .update(officeReceipts)
          .set({
            status: allOff ? "unloading_complete" : "unloading",
            unloadingStartedAt: receipt.unloadingStartedAt ?? new Date(),
            unloadingCompletedAt: allOff ? new Date() : null,
            updatedAt: new Date(),
          })
          .where(eq(officeReceipts.id, receipt.id))
          .returning();
        return updated!;
      });
      res.json(out);
    } catch (err) {
      if (err instanceof TransitionError) return res.status(409).json({ error: err.message });
      if (!fail(err, res)) throw err;
    }
  },
);

/**
 * Station 5 — tare, then split the net across the lines.
 *
 * The platform yields ONE net figure for a truck that may be carrying several
 * materials. Splitting it is the only genuinely new problem multi-line
 * introduces, and it happens here.
 */
officeRouter.patch(
  "/receipts/:id/tare-weight",
  requirePermission("office", "weighbridge"),
  validateBody(
    z.object({
      tareWeightKg: qtyStr,
      weighbridgeId: z.string().uuid().optional(),
      /**
       * Bags counted off the truck, per line. Recorded here because unloading
       * and weighing out are one act at the platform — the bags come off and
       * the empty vehicle goes on the weighbridge.
       */
      bags: z
        .array(
          z.object({
            lineId: z.string().uuid(),
            bagCountActual: z.number().int().nonnegative().nullable().optional(),
          }),
        )
        .max(50)
        .optional(),
      allocationMethod: z.enum(["pro_rata", "manual"]).default("pro_rata"),
      manualAllocation: z.array(z.object({ lineId: z.string().uuid(), allocatedNetKg: qtyStr })).optional(),
      shortageReason: z.string().optional(),
    }),
  ),
  async (req, res) => {
    const body = req.body as {
      tareWeightKg: string;
      weighbridgeId?: string;
      bags?: Array<{ lineId: string; bagCountActual?: number | null }>;
      allocationMethod: "pro_rata" | "manual";
      manualAllocation?: Array<{ lineId: string; allocatedNetKg: string }>;
      shortageReason?: string;
    };
    try {
      const out = await db.transaction(async (tx) => {
        const loaded = await tx.query.officeReceipts.findFirst({
          where: eq(officeReceipts.id, req.params.id!),
        });
        if (!loaded) throw new PostingError("Goods receipt not found");
        const gross = Number(loaded.grossWeightKg ?? 0);
        const tare = Number(body.tareWeightKg);
        if (!(gross > 0)) throw new PostingError("This truck has no gross weight recorded");
        if (tare >= gross) throw new PostingError("Tare cannot be heavier than gross");

        let lines = await tx
          .select()
          .from(officeReceiptLines)
          .where(eq(officeReceiptLines.receiptId, loaded.id))
          .orderBy(asc(officeReceiptLines.lineNo));

        /**
         * Take the goods off the truck, here.
         *
         * Unloading stopped being a station of its own: the bags are counted at
         * the platform as they come off, and the empty vehicle then goes on the
         * weighbridge — one operator, one act. The receipt still walks every
         * status it always did (qc_passed → unloading → unloading_complete →
         * gate_out), so nothing downstream sees a record that skipped a step;
         * it just walks them inside this one transaction.
         */
        if (loaded.status === "qc_passed" || loaded.status === "unloading") {
          const bagOf = new Map((body.bags ?? []).map((b) => [b.lineId, b.bagCountActual]));
          const now = new Date();
          for (const l of lines) {
            // QC refused it, so it never came off — it goes back with the truck.
            if (l.status === "qc_rejected" || l.status === "unloaded") continue;
            await tx
              .update(officeReceiptLines)
              .set({
                status: "unloaded",
                bagCountActual: bagOf.has(l.id) ? (bagOf.get(l.id) ?? null) : l.bagCountActual,
                unloadingStartedAt: l.unloadingStartedAt ?? now,
                unloadingCompletedAt: now,
                unloadingBy: req.session.user!.id,
              })
              .where(eq(officeReceiptLines.id, l.id));
          }
          assertTransition(loaded.status, "unloading");
          await tx
            .update(officeReceipts)
            .set({
              status: "unloading_complete",
              unloadingStartedAt: loaded.unloadingStartedAt ?? now,
              unloadingCompletedAt: now,
            })
            .where(eq(officeReceipts.id, loaded.id));
          lines = await tx
            .select()
            .from(officeReceiptLines)
            .where(eq(officeReceiptLines.receiptId, loaded.id))
            .orderBy(asc(officeReceiptLines.lineNo));
        }

        const receipt = await forTransition(tx, req.params.id!, "gate_out");

        const stillOn = lines.filter((l) => l.status === "unloading");
        if (stillOn.length) throw new PostingError("A line is still being unloaded");

        const unloaded = lines.filter((l) => l.status === "unloaded");
        if (!unloaded.length) {
          throw new PostingError("Every line was rejected at QC — nothing came off this truck");
        }

        const netKg = Number((gross - tare).toFixed(3));
        const allocations = new Map<string, number>();

        if (body.allocationMethod === "manual") {
          for (const a of body.manualAllocation ?? []) {
            allocations.set(a.lineId, Number(a.allocatedNetKg));
          }
          const sum = Number([...allocations.values()].reduce((s, v) => s + v, 0).toFixed(3));
          // Enforced rather than trusted: an allocation that does not add up to
          // what came off the truck pays somebody for weight nobody received.
          if (Math.abs(sum - netKg) > 0.001) {
            throw new PostingError(`Manual allocation adds to ${sum} kg but the net is ${netKg} kg`);
          }
        } else {
          // Pro rata by billed quantity, with the rounding remainder pushed
          // onto the largest line so the parts always sum back to the whole.
          const totalBilled = unloaded.reduce((s, l) => s + Number(l.billQuantityKg), 0);
          let assigned = 0;
          unloaded.forEach((l, i) => {
            const share =
              i === unloaded.length - 1
                ? Number((netKg - assigned).toFixed(3))
                : Number(((netKg * Number(l.billQuantityKg)) / totalBilled).toFixed(3));
            assigned = Number((assigned + share).toFixed(3));
            allocations.set(l.id, share);
          });
        }

        for (const l of lines) {
          // A rejected line never takes a share: it never came off, and its
          // weight is still sitting inside the tare.
          const share = l.status === "unloaded" ? (allocations.get(l.id) ?? 0) : 0;
          await tx
            .update(officeReceiptLines)
            .set({ allocatedNetKg: String(share) })
            .where(eq(officeReceiptLines.id, l.id));
        }

        const [updated] = await tx
          .update(officeReceipts)
          .set({
            tareWeightKg: body.tareWeightKg,
            tareWeighedAt: new Date(),
            tareWeighedBy: req.session.user!.id,
            tareWeighbridgeId: body.weighbridgeId,
            allocationMethod: body.allocationMethod,
            shortageReason: body.shortageReason,
            departedAt: new Date(),
            gateOutBy: req.session.user!.id,
            status: "gate_out",
            updatedAt: new Date(),
          })
          .where(eq(officeReceipts.id, receipt.id))
          .returning();
        return updated!;
      });
      res.json(out);
    } catch (err) {
      if (err instanceof TransitionError) return res.status(409).json({ error: err.message });
      if (!fail(err, res)) throw err;
    }
  },
);

// ──────────────────────────── Settlement ────────────────────────────

/**
 * What the vendor is owed, and what will be deducted.
 *
 * Computed in one place and used by both the preview and the commit, so the
 * figure an operator approves is the figure that is posted.
 */
async function settlementContext(tx: Tx | typeof db, receiptId: string) {
  const receipt = await tx.query.officeReceipts.findFirst({
    where: eq(officeReceipts.id, receiptId),
  });
  if (!receipt) throw new PostingError("Goods receipt not found");

  const lines = await tx
    .select({
      line: officeReceiptLines,
      purchaseAccountId: items.purchaseAccountId,
    })
    .from(officeReceiptLines)
    .leftJoin(items, eq(items.id, officeReceiptLines.itemId))
    .where(eq(officeReceiptLines.receiptId, receiptId))
    .orderBy(asc(officeReceiptLines.lineNo));

  // The vendor's printed tax, spread across the lines by value. Never posted to
  // a tax account — eggs are exempt, so it is part of what the goods cost.
  const billTax = Number(receipt.billTaxAmount ?? 0);
  const unloaded = lines.filter((l) => l.line.status === "unloaded");
  const goodsTotal = unloaded.reduce(
    (s, l) => s + Number(l.line.billAmount ?? Number(l.line.billQuantityKg) * Number(l.line.agreedRatePerKg ?? 0)),
    0,
  );

  /**
   * The vendor's own rounding, carried rather than recomputed.
   *
   * G K bill ₹21,79,499 + ₹1,08,974.95 IGST and then print ₹22,88,474.00 —
   * five paise of roundoff at the foot of the page. Arriving at our own
   * ₹22,88,473.95 leaves the payable permanently a few paise off the invoice
   * it is meant to pay, which is exactly the mismatch that makes a vendor
   * ledger impossible to agree at the year end.
   *
   * Only a rounding artefact is absorbed this way. Anything past a rupee is a
   * real disagreement about the figures, and billTotalVariance below asks a
   * person to explain it rather than quietly adopting the vendor's number.
   */
  const printedTotal = receipt.billTotalAmount == null ? null : Number(receipt.billTotalAmount);
  const rawTotal = goodsTotal + billTax;
  const vendorRoundOff =
    printedTotal != null && Math.abs(printedTotal - rawTotal) <= 1
      ? Number((printedTotal - rawTotal).toFixed(2))
      : 0;
  /** Everything the vendor adds to the goods: their tax and their rounding. */
  const extras = billTax + vendorRoundOff;

  /**
   * Their invoice, line for line.
   *
   * The goods sit at the vendor's own rate so our line equals the Amount
   * column on their paper to the paisa — fold the tax into a per-kilo rate
   * instead and 43,330 kg × six decimal places cannot reproduce their total
   * exactly, which leaves every bill a paisa adrift of the invoice it pays.
   *
   * Their tax and their rounding then follow as lines of their own, matching
   * the foot of their bill. Both are cost, not tax: they carry the goods'
   * purchase account, so the journal is still one debit and no input credit is
   * claimed anywhere. Neither carries an itemId — a positive line against an
   * item is read back as its purchase price, and ₹1,08,974.95 is not what a
   * kilo of de-oiled cake costs.
   */
  const [org] = await tx.select({ stateCode: orgProfile.stateCode }).from(orgProfile).limit(1);
  const [vendorRow] = receipt.vendorId
    ? await tx
        .select({ gstin: contacts.gstin })
        .from(contacts)
        .where(eq(contacts.id, receipt.vendorId))
        .limit(1)
    : [undefined];
  // A GSTIN opens with the state code, which is what decides the split their
  // bill prints: 27 Maharashtra selling to 29 Karnataka is IGST.
  const vendorState = vendorRow?.gstin?.slice(0, 2) ?? null;
  const interState = !!vendorState && !!org?.stateCode && vendorState !== org.stateCode;
  const taxLabel = interState ? "IGST on their bill" : "CGST + SGST on their bill";

  const goodsLines = unloaded.map((l) => {
    const qty = Number(l.line.billQuantityKg);
    const goods = Number(l.line.billAmount ?? qty * Number(l.line.agreedRatePerKg ?? 0));
    return {
      lineId: l.line.id,
      itemId: l.line.itemId,
      name: l.line.itemName ?? "Material",
      accountId: l.purchaseAccountId,
      quantityKg: qty,
      ratePerKg: qty > 0 ? goods / qty : 0,
      amount: goods,
      kind: "goods" as const,
    };
  });

  /** Charged to the biggest line's account — the one that bore most of the tax. */
  const anchor = [...goodsLines].sort((a, b) => b.amount - a.amount)[0];
  const extraLine = (name: string, amount: number) => ({
    lineId: anchor?.lineId ?? "",
    itemId: null as string | null,
    name,
    accountId: anchor?.accountId ?? null,
    quantityKg: 1,
    ratePerKg: amount,
    amount,
    // Not goods: it may legitimately be negative, and it is not priced per kilo.
    kind: "extra" as const,
  });

  const billLines = [
    ...goodsLines,
    ...(billTax > 0 ? [extraLine(taxLabel, Number(billTax.toFixed(2)))] : []),
    ...(vendorRoundOff !== 0 ? [extraLine("Round off on their bill", vendorRoundOff)] : []),
  ];

  /**
   * Deductions come off at the ALL-IN rate, the same one the goods are billed
   * at.
   *
   * The vendor charged tax on the whole consignment including the 200 kg that
   * never arrived. Deducting those kilos at the pre-tax rate would leave us
   * paying the GST on them — a small amount on one truck, and a standing
   * overpayment on every truck that ever runs short.
   */
  const allInRate = new Map(
    goodsLines.map((l) => [
      l.lineId,
      // The goods line is now pre-tax, so the all-in rate is derived rather
      // than read off it: a kilo that never arrived carried its tax too.
      l.quantityKg > 0 ? (l.amount + (goodsTotal > 0 ? (extras * l.amount) / goodsTotal : 0)) / l.quantityKg : 0,
    ]),
  );
  const rateOf = (l: (typeof unloaded)[number]) =>
    allInRate.get(l.line.id) ?? Number(l.line.agreedRatePerKg ?? 0);

  // What comes off, per line, from the rules in force. Everything a rule
  // might read is gathered here: the QC readings, the damage recorded at
  // unloading, and the shortfall the weighbridge produced.
  const allRules = await loadDeductionRules(tx);
  const rules = allRules.filter((r) => r.scope === "line");

  /**
   * Shortage is settled for the vehicle, not the material.
   *
   * A lorry loses weight in transit as a lorry — spillage, moisture off the
   * top, a bit left in the corners — so the allowance belongs to the trip and
   * is consumed once across everything aboard. Granting it per line would hand
   * a three-material truck three allowances for one journey.
   *
   * Whatever is short beyond the allowance is then split back across the lines
   * in proportion to how short each one ran, and charged at that line's own
   * rate — a kilo of maize and a kilo of rice bran are not worth the same.
   */
  const vehicleRules = allRules.filter((r) => r.scope === "vehicle");
  const shortByLine = new Map<string, number>();
  let totalShortKg = 0;
  for (const l of unloaded) {
    const short = Number(
      (Number(l.line.billQuantityKg) - Number(l.line.allocatedNetKg ?? 0)).toFixed(3),
    );
    if (short > 0) {
      shortByLine.set(l.line.id, short);
      totalShortKg = Number((totalShortKg + short).toFixed(3));
    }
  }

  const vehicleDeductions = vehicleRules.flatMap((rule) => {
    if (rule.parameter !== "shortage" || totalShortKg <= 0) return [];
    const allowanceKg = Number(rule.threshold ?? 0);
    const chargeableKg = Number(Math.max(0, totalShortKg - allowanceKg).toFixed(3));
    if (chargeableKg <= 0) return [];

    return unloaded.flatMap((l) => {
      const lineShort = shortByLine.get(l.line.id) ?? 0;
      if (lineShort <= 0) return [];
      const shareKg = Number(((lineShort / totalShortKg) * chargeableKg).toFixed(3));
      const rate = rateOf(l);
      const amount = Number((shareKg * rate).toFixed(2));
      if (amount <= 0) return [];
      const kgs = (v: number) => v.toLocaleString("en-IN", { maximumFractionDigits: 3 });
      return [
        {
          lineId: l.line.id,
          itemId: l.line.itemId,
          accountId: l.purchaseAccountId,
          ruleId: rule.id as string | null,
          ruleVersion: rule.version as number | null,
          parameter: rule.parameter,
          name: `${rule.name} — ${l.line.itemName ?? "material"}`,
          quantityKg: 1,
          ratePerKg: amount,
          amount,
          // Short, allowed, charged — the order the argument runs in when a
          // vendor queries it. The "of the" clause appears only on a truck
          // carrying more than one material, where this line takes a share of
          // the shortfall rather than all of it.
          basis:
            `${kgs(totalShortKg)} kg short, ${kgs(allowanceKg)} kg allowed, ` +
            (shareKg === chargeableKg
              ? `${kgs(shareKg)} kg`
              : `${kgs(shareKg)} kg of the ${kgs(chargeableKg)} kg`) +
            ` × ₹${rate.toFixed(3)}/kg`,
        },
      ];
    });
  });

  const deductions = unloaded.flatMap((l) => {
    const billed = Number(l.line.billQuantityKg);
    const net = Number(l.line.allocatedNetKg ?? 0);
    const rate = rateOf(l);
    const readings: Record<string, number | null> = {
      ...((l.line.qcOtherParams ?? {}) as Record<string, number>),
      moisture: l.line.qcMoisturePct == null ? null : Number(l.line.qcMoisturePct),
      protein: l.line.qcProteinPct == null ? null : Number(l.line.qcProteinPct),
      fiber: l.line.qcFiberPct == null ? null : Number(l.line.qcFiberPct),
      fat: l.line.qcFatPct == null ? null : Number(l.line.qcFatPct),
      damage: l.line.damagePercent == null ? null : Number(l.line.damagePercent),
      // No shortage here: it is settled for the vehicle as a whole, above.
    };
    return computeDeductions(rules, {
      itemId: l.line.itemId,
      vendorId: receipt.vendorId,
      // Charged against what actually came off, not what was billed.
      netKg: net,
      ratePerKg: rate,
      readings,
    }).map((d) => ({
      lineId: l.line.id,
      itemId: l.line.itemId,
      accountId: l.purchaseAccountId,
      ruleId: d.ruleId as string | null,
      ruleVersion: d.ruleVersion as number | null,
      parameter: d.parameter,
      name: `${d.name} — ${l.line.itemName ?? "material"}`,
      quantityKg: 1,
      ratePerKg: d.amount,
      amount: d.amount,
      basis: d.basis,
    }));
  });

  const goodsValue = billLines.reduce((s, l) => s + l.amount, 0);
  const allDeductions = [...deductions, ...vehicleDeductions];
  const deductionTotal = allDeductions.reduce((s, d) => s + d.amount, 0);

  return {
    receipt,
    lines,
    rejected: lines.filter((l) => l.line.status === "qc_rejected"),
    billLines,
    deductions: allDeductions,
    goodsValue: Number(goodsValue.toFixed(2)),
    deductionTotal: Number(deductionTotal.toFixed(2)),
    netPayable: Number((goodsValue - deductionTotal).toFixed(2)),
    /**
     * The gap against what the vendor printed, once rejects are excluded.
     * Null when the printed total was never captured — comparing against zero
     * would demand an explanation for the whole value of the load.
     */
    billTotalVariance:
      receipt.billTotalAmount == null
        ? null
        : Number((Number(receipt.billTotalAmount) - goodsValue).toFixed(2)),
  };
}

officeRouter.get(
  "/receipts/:id/settlement-context",
  requirePermission("office", "settle"),
  async (req, res) => {
    try {
      const ctx = await settlementContext(db, req.params.id!);
      res.json({
        ...ctx,
        lines: ctx.lines.map((l) => l.line),
      });
    } catch (err) {
      if (!fail(err, res)) throw err;
    }
  },
);

/**
 * Turn a gated-out truck into a payable.
 *
 * The bill carries the vendor's own quantities, so it reconciles line for line
 * against the paper they handed over. Anything we are not paying for comes off
 * as a vendor credit applied to that bill — which is how a deduction stays
 * visible and auditable instead of silently shrinking an invoice.
 *
 * Lines rejected at QC never reach the bill at all: we did not take the goods,
 * so there is nothing to owe and nothing to credit back.
 */
officeRouter.post(
  "/receipts/:id/settle",
  requirePermission("office", "settle"),
  validateBody(
    z.object({
      billTotalVarianceReason: z.string().optional(),
      /**
       * What is actually being deducted, as approved on screen.
       *
       * The rules propose; a person disposes. Sent back edited — amounts
       * changed, lines dropped, one-offs added — because a rule cannot know
       * about the phone call where a shortage was waived. Omit entirely to
       * accept the computed set unchanged.
       */
      deductions: z
        .array(
          z.object({
            lineId: z.string().uuid(),
            name: z.string().min(1),
            amount: moneyStr,
            basis: z.string().optional(),
            ruleId: z.string().uuid().nullable().optional(),
            ruleVersion: z.number().int().nullable().optional(),
          }),
        )
        .max(50)
        .optional(),
    }),
  ),
  async (req, res) => {
    const body = req.body as {
      billTotalVarianceReason?: string;
      deductions?: Array<{
        lineId: string; name: string; amount: string; basis?: string;
        ruleId?: string | null; ruleVersion?: number | null;
      }>;
    };
    try {
      const out = await db.transaction(async (tx) => {
        const ctx = await settlementContext(tx, req.params.id!);
        const { receipt } = ctx;
        assertTransition(receipt.status, "settled");

        if (!receipt.vendorId) throw new PostingError("This receipt has no vendor");
        if (!ctx.billLines.length) throw new PostingError("Nothing was unloaded — there is nothing to bill");
        // A line with no rate would post a bill for nothing at all, quietly.
        // Better to refuse than to raise a payable a vendor will dispute.
        // Only the goods have to be priced. The vendor's rounding line is
        // allowed to be negative, and is not a material anybody can quote.
        const unpriced = ctx.billLines.filter((l) => l.kind === "goods" && !(l.amount > 0));
        if (unpriced.length) {
          throw new PostingError(
            `${unpriced.map((l) => l.name).join(", ")} has no rate — a bill cannot be raised for nothing`,
          );
        }

        // Every line must sit against an order before money moves. The gate
        // already enforces this, but a line can be edited afterwards.
        const unmatched = ctx.lines.filter(
          (l) => l.line.status === "unloaded" && !l.line.poLineId,
        );
        if (unmatched.length) {
          throw new PostingError(`${unmatched.length} line(s) have no purchase order behind them`);
        }

        const vendor = await loadVendor(tx, receipt.vendorId);
        const billDate = receipt.vendorBillDate ?? new Date().toISOString().slice(0, 10);
        await assertPeriodOpen(tx, billDate, "bill");

        // What the rules proposed, overlaid with whatever was approved on
        // screen. An edited amount keeps the rule's own basis alongside the
        // new figure, so the record shows both what was computed and what a
        // person decided instead.
        const approved = (body.deductions ?? []).map((d) => {
          const computed = ctx.deductions.find(
            (c) => c.lineId === d.lineId && (d.ruleId ? c.ruleId === d.ruleId : c.name === d.name),
          );
          const amount = Number(d.amount);
          const line = ctx.lines.find((l) => l.line.id === d.lineId);
          const changed = computed && Math.abs(computed.amount - amount) > 0.005;
          return {
            lineId: d.lineId,
            itemId: computed?.itemId ?? line?.line.itemId ?? null,
            accountId: computed?.accountId ?? line?.purchaseAccountId ?? null,
            ruleId: d.ruleId ?? computed?.ruleId ?? null,
            ruleVersion: d.ruleVersion ?? computed?.ruleVersion ?? null,
            parameter: computed?.parameter ?? "manual",
            name: d.name,
            quantityKg: 1,
            ratePerKg: amount,
            amount,
            basis: changed
              ? `${computed!.basis} = ₹${computed!.amount.toLocaleString("en-IN")}, adjusted to ₹${amount.toLocaleString("en-IN")}`
              : (d.basis ?? computed?.basis ?? "entered by hand"),
          };
        });
        const charging = body.deductions ? approved : ctx.deductions;
        const deductionTotal = Number(charging.reduce((s, d) => s + d.amount, 0).toFixed(2));

        const rupees = (v: number) =>
          `₹${v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        /** 2026-08-18 → 18-08-2026, the way the date reads on their paper. */
        const asDate = (d: string) => d.split("-").reverse().join("-");
        /**
         * The note explains the DIFFERENCE, and nothing else.
         *
         * A vendor querying this bill six months on wants one thing: why it is
         * not their figure. So the note names the truck and their bill, then
         * each deduction with its own arithmetic — short, allowed, charged.
         *
         * Gross, tare and net are deliberately absent. They are on the goods
         * receipt for anyone who needs them, and printing three weights nobody
         * asked about only buries the one sentence that answers the question.
         */
        const explanation = [
          [
            receipt.number,
            receipt.vehicleNumber,
            receipt.vendorBillNumber ? `their bill ${receipt.vendorBillNumber}` : null,
            receipt.vendorBillDate ? `dated ${asDate(receipt.vendorBillDate)}` : null,
          ]
            .filter(Boolean)
            .join(" · "),
          ...(charging.length
            ? [
                "",
                "Deducted",
                ...charging.map((d) => `  ${d.name}  ${rupees(d.amount)}\n  ${d.basis}`),
                // Only worth adding up when there is more than one.
                ...(charging.length > 1 ? [`  Total ${rupees(deductionTotal)}`] : []),
              ]
            : []),
        ].join("\n");

        /**
         * One bill: the goods at the vendor's own figure, then a negative line
         * for each thing we are not paying for.
         *
         * Deliberately not a bill plus a vendor credit. A credit was never
         * countersigned or returned, so the second document bought nothing a
         * line on this one does not — and this way the goods line still ties to
         * the vendor's invoice figure for figure, with the difference explained
         * one row below it rather than in another document.
         */
        const bill = await createBill(tx, {
          vendor,
          billDate,
          vendorBillNumber: receipt.vendorBillNumber ?? undefined,
          // Their figure, not ours: our total is theirs less what we deducted.
          vendorBillTotal: receipt.billTotalAmount ?? undefined,
          reference: receipt.number,
          notes: explanation,
          // Only when the whole truck came from one order; a multi-PO receipt
          // keeps its links on the receipt lines instead.
          purchaseOrderId:
            new Set(ctx.lines.map((l) => l.line.purchaseOrderId).filter(Boolean)).size === 1
              ? (ctx.lines.find((l) => l.line.purchaseOrderId)?.line.purchaseOrderId ?? undefined)
              : undefined,
          lines: [
            ...ctx.billLines.map((l) => ({
              itemId: l.itemId ?? undefined,
              accountId: l.accountId ?? undefined,
              name: l.name,
              quantity: l.quantityKg.toFixed(3),
              // Only the goods are weighed. The vendor's tax and rounding are
              // sums of money, and "1.00 kg of IGST" is not a thing.
              unit: l.kind === "goods" ? "kg" : undefined,
              rate: l.ratePerKg.toFixed(6),
              // No taxId anywhere: their tax is a cost line, not a tax line,
              // because there is no input credit to claim against it.
            })),
            ...charging.map((d) => ({
              itemId: d.itemId ?? undefined,
              // The same purchase account as the goods it reduces, so the
              // journal nets to one debit instead of a pair that cancel.
              accountId: d.accountId ?? undefined,
              name: d.name,
              // One unit at the deduction's own value: a deduction is a sum of
              // money, not a quantity of goods going back.
              quantity: "1.000",
              rate: (-d.amount).toFixed(6),
              description: d.basis,
              // Which rule charged this, and which version of it. Null where a
              // person entered the figure by hand, which is the truth of it.
              ruleId: d.ruleId,
              ruleVersion: d.ruleVersion,
            })),
          ],
          postedBy: req.session.user!.id,
        });

        // Counters. An unloaded line discharges the order by what the vendor
        // sent, and is billed for the same — QC rejections were counted at
        // station 3 and must not be counted again here.
        for (const l of ctx.lines) {
          if (l.line.status !== "unloaded" || !l.line.poLineId) continue;
          await tx
            .update(purchaseOrderLines)
            .set({
              deliveredQuantity: sql`${purchaseOrderLines.deliveredQuantity} + ${l.line.billQuantityKg}`,
              billedQuantity: sql`${purchaseOrderLines.billedQuantity} + ${l.line.billQuantityKg}`,
            })
            .where(eq(purchaseOrderLines.id, l.line.poLineId));
        }

        await tx
          .update(officeReceiptLines)
          .set({ status: "settled" })
          .where(
            and(
              eq(officeReceiptLines.receiptId, receipt.id),
              eq(officeReceiptLines.status, "unloaded"),
            ),
          );

        const [updated] = await tx
          .update(officeReceipts)
          .set({
            status: "settled",
            billId: bill.id,
            // Stays null: deductions are lines on the bill now. The column
            // remains for a credit raised by hand against this receipt.
            vendorCreditId: null,
            billTotalVarianceReason: body.billTotalVarianceReason,
            settledAt: new Date(),
            settledBy: req.session.user!.id,
            updatedAt: new Date(),
          })
          .where(eq(officeReceipts.id, receipt.id))
          .returning();

        // Carry the gate photos onto the bill.
        //
        // Whoever queries a payable months later needs the bill, the truck and
        // the weigh slip in front of them without knowing a receipt exists. The
        // file is COPIED rather than the row re-pointed: two documents each
        // owning their own file means deleting an attachment from the bill can
        // never blank the evidence on the receipt.
        const photos = await tx
          .select()
          .from(attachments)
          .where(
            and(
              eq(attachments.entityType, "office_receipt"),
              eq(attachments.entityId, receipt.id),
            ),
          );
        for (const p of photos) {
          const copyName = `${randomBytes(16).toString("hex")}${path.extname(p.storedName)}`;
          try {
            await copyFile(path.join(UPLOAD_DIR, p.storedName), path.join(UPLOAD_DIR, copyName));
          } catch {
            continue; // a missing file must not stop a payable being raised
          }
          await tx.insert(attachments).values({
            entityType: "bill",
            entityId: bill.id,
            fileName: p.fileName,
            storedName: copyName,
            mimeType: p.mimeType,
            sizeBytes: p.sizeBytes,
            uploadedBy: req.session.user!.id,
            kind: p.kind,
            capturedAt: p.capturedAt,
            latitude: p.latitude,
            longitude: p.longitude,
            accuracyM: p.accuracyM,
            locationId: p.locationId,
          });
        }

        return {
          receipt: updated!,
          bill,
          // What came off, and what is left to pay. The bill total IS the net
          // now, so there is no second document to reconcile it against.
          deducted: deductionTotal.toFixed(2),
          photosAttached: photos.length,
          summary: ctx,
        };
      });
      res.json(out);
    } catch (err) {
      if (err instanceof TransitionError) return res.status(409).json({ error: err.message });
      if (!fail(err, res)) throw err;
    }
  },
);

/**
 * Correct a receipt.
 *
 * Six stations, one form. A guard mistypes a plate, a weighbridge operator
 * transposes two digits, or a whole truck is keyed in the next morning from
 * paper — all of it is the same act of correction, and none of it should mean
 * deleting a record and burning its number.
 *
 * Everything a station writes can be set here, so a direct entry can be made
 * complete in one pass without walking the queues. What cannot be set is the
 * status: it is derived from the facts, so a receipt cannot be parked in a
 * state its own data contradicts.
 */
const editReceiptSchema = z.object({
  vendorId: z.string().uuid().nullable().optional(),
  vehicleNumber: z.string().min(4).max(20).optional(),
  vendorBillNumber: z.string().nullable().optional(),
  vendorBillDate: dateStr.nullable().optional(),
  billTotalAmount: moneyStr.nullable().optional(),
  billTaxAmount: moneyStr.nullable().optional(),
  arrivalAt: z.string().datetime().optional(),
  grossWeightKg: qtyStr.nullable().optional(),
  tareWeightKg: qtyStr.nullable().optional(),
  vendorSlipGrossKg: qtyStr.nullable().optional(),
  vendorSlipTareKg: qtyStr.nullable().optional(),
  vendorSlipNetKg: qtyStr.nullable().optional(),
  shortageReason: z.string().nullable().optional(),
  grossVarianceReason: z.string().nullable().optional(),
  lines: z
    .array(
      z.object({
        id: z.string().uuid().optional(),
        itemId: z.string().uuid().nullable().optional(),
        itemName: z.string().min(1),
        billQuantityKg: qtyStr,
        billRatePerKg: rateStr.nullable().optional(),
        billAmount: moneyStr.nullable().optional(),
        billBagCount: z.number().int().nonnegative().nullable().optional(),
        purchaseOrderId: z.string().uuid().nullable().optional(),
        poLineId: z.string().uuid().nullable().optional(),
        qcVerdict: z.enum(["pass", "rejected"]).nullable().optional(),
        qcMoisturePct: z.number().nullable().optional(),
        qcProteinPct: z.number().nullable().optional(),
        qcRejectionReason: z.string().nullable().optional(),
        warehouseLocationId: z.string().uuid().nullable().optional(),
        bagCountActual: z.number().int().nonnegative().nullable().optional(),
        damagePercent: z.number().min(0).max(100).nullable().optional(),
        allocatedNetKg: qtyStr.nullable().optional(),
      }),
    )
    .min(1)
    .max(50),
});

/** The status a receipt's own facts imply. Never taken from the client. */
function deriveStatus(
  header: { grossWeightKg: string | null; tareWeightKg: string | null },
  lines: Array<{ qcVerdict: string | null; allocatedNetKg: string | null }>,
): ReceiptStatus {
  const judged = lines.filter((l) => l.qcVerdict);
  const accepted = judged.filter((l) => l.qcVerdict !== "rejected");
  if (judged.length === lines.length && accepted.length === 0) return "rejected";
  if (header.tareWeightKg != null) return "gate_out";
  if (accepted.length && accepted.every((l) => l.allocatedNetKg != null)) return "unloading_complete";
  if (judged.length === lines.length) return "qc_passed";
  if (header.grossWeightKg != null) return "weighed_in";
  return "gate_in";
}

officeRouter.patch(
  "/receipts/:id",
  requirePermission("office", "gate_in"),
  validateBody(editReceiptSchema),
  async (req, res) => {
    const body = req.body as z.infer<typeof editReceiptSchema>;
    try {
      const out = await db.transaction(async (tx) => {
        const receipt = await tx.query.officeReceipts.findFirst({
          where: eq(officeReceipts.id, req.params.id!),
        });
        if (!receipt) throw new PostingError("Goods receipt not found");
        // Once a payable exists the receipt is what it was billed against.
        // Correcting it afterwards would silently disagree with the ledger.
        if (receipt.status === "settled" || receipt.billId) {
          throw new PostingError(
            "This receipt has been settled into a bill — void the bill before correcting it",
          );
        }
        if (receipt.status === "turned_away") {
          throw new PostingError("A turned-away truck is a closed record");
        }

        const existing = await tx
          .select()
          .from(officeReceiptLines)
          .where(eq(officeReceiptLines.receiptId, receipt.id));
        const keep = new Set(body.lines.map((l) => l.id).filter(Boolean));
        const dropped = existing.filter((l) => !keep.has(l.id));
        if (dropped.length) {
          await tx.delete(officeReceiptLines).where(
            inArray(
              officeReceiptLines.id,
              dropped.map((l) => l.id),
            ),
          );
        }

        const written: Array<{ qcVerdict: string | null; allocatedNetKg: string | null }> = [];
        for (const [i, l] of body.lines.entries()) {
          // An edit is often exactly the moment a person fixes the pairing —
          // the bill said one thing, the right item is another. Learn it.
          if (l.itemId && l.itemName) await learnAlias(tx, l.itemId, l.itemName);
          const status = l.qcVerdict === "rejected" ? "qc_rejected" : l.allocatedNetKg != null ? "unloaded" : l.qcVerdict ? "qc_accepted" : "pending";
          const values = {
            receiptId: receipt.id,
            lineNo: i + 1,
            status: status as (typeof officeReceiptLines.$inferInsert)["status"],
            itemId: l.itemId ?? null,
            itemName: l.itemName,
            billQuantityKg: l.billQuantityKg,
            billRatePerKg: l.billRatePerKg ?? null,
            agreedRatePerKg: l.billRatePerKg ?? null,
            billAmount: l.billAmount ?? null,
            billBagCount: l.billBagCount ?? null,
            bagCountExpected: l.billBagCount ?? null,
            purchaseOrderId: l.purchaseOrderId ?? null,
            poLineId: l.poLineId ?? null,
            qcVerdict: (l.qcVerdict ?? null) as (typeof officeReceiptLines.$inferInsert)["qcVerdict"],
            qcMoisturePct: l.qcMoisturePct != null ? String(l.qcMoisturePct) : null,
            qcProteinPct: l.qcProteinPct != null ? String(l.qcProteinPct) : null,
            qcRejectionReason: l.qcRejectionReason ?? null,
            warehouseLocationId: l.warehouseLocationId ?? null,
            bagCountActual: l.bagCountActual ?? null,
            damagePercent: l.damagePercent != null ? String(l.damagePercent) : null,
            // A rejected line never takes a share of the net; the check
            // constraint enforces it, this keeps the write honest.
            allocatedNetKg: l.qcVerdict === "rejected" ? null : (l.allocatedNetKg ?? null),
          };
          if (l.id && existing.some((e) => e.id === l.id)) {
            await tx.update(officeReceiptLines).set(values).where(eq(officeReceiptLines.id, l.id));
          } else {
            await tx.insert(officeReceiptLines).values(values);
          }
          written.push({ qcVerdict: values.qcVerdict ?? null, allocatedNetKg: values.allocatedNetKg });
        }

        const gross = body.grossWeightKg !== undefined ? body.grossWeightKg : receipt.grossWeightKg;
        const tare = body.tareWeightKg !== undefined ? body.tareWeightKg : receipt.tareWeightKg;
        if (gross != null && tare != null && Number(tare) >= Number(gross)) {
          throw new PostingError("Tare cannot be heavier than gross");
        }

        const [updated] = await tx
          .update(officeReceipts)
          .set({
            vendorId: body.vendorId !== undefined ? body.vendorId : receipt.vendorId,
            vehicleNumber: body.vehicleNumber
              ? (normalisePlate(body.vehicleNumber) ?? body.vehicleNumber)
              : receipt.vehicleNumber,
            vendorBillNumber: body.vendorBillNumber !== undefined ? body.vendorBillNumber : receipt.vendorBillNumber,
            vendorBillDate: body.vendorBillDate !== undefined ? body.vendorBillDate : receipt.vendorBillDate,
            billTotalAmount: body.billTotalAmount !== undefined ? body.billTotalAmount : receipt.billTotalAmount,
            billTaxAmount: body.billTaxAmount !== undefined ? body.billTaxAmount : receipt.billTaxAmount,
            arrivalAt: body.arrivalAt ? new Date(body.arrivalAt) : receipt.arrivalAt,
            grossWeightKg: gross,
            tareWeightKg: tare,
            vendorSlipGrossKg: body.vendorSlipGrossKg !== undefined ? body.vendorSlipGrossKg : receipt.vendorSlipGrossKg,
            vendorSlipTareKg: body.vendorSlipTareKg !== undefined ? body.vendorSlipTareKg : receipt.vendorSlipTareKg,
            vendorSlipNetKg: body.vendorSlipNetKg !== undefined ? body.vendorSlipNetKg : receipt.vendorSlipNetKg,
            shortageReason: body.shortageReason !== undefined ? body.shortageReason : receipt.shortageReason,
            grossVarianceReason: body.grossVarianceReason !== undefined ? body.grossVarianceReason : receipt.grossVarianceReason,
            status: deriveStatus({ grossWeightKg: gross, tareWeightKg: tare }, written),
            updatedAt: new Date(),
          })
          .where(eq(officeReceipts.id, receipt.id))
          .returning();
        return updated!;
      });
      res.json(out);
    } catch (err) {
      const msg = constraintMessage(err);
      if (msg) return res.status(409).json({ error: msg });
      if (!fail(err, res)) throw err;
    }
  },
);

/**
 * Delete a receipt and hand its number back to the series.
 *
 * Only ever a pre-settlement record: once a receipt has produced a bill it is
 * an accounting document, and deleting it would orphan a posted journal.
 */
officeRouter.delete(
  "/receipts/:id",
  requirePermission("office", "override"),
  async (req, res) => {
    try {
      const done = await db.transaction(async (tx) => {
        const receipt = await tx.query.officeReceipts.findFirst({
          where: eq(officeReceipts.id, req.params.id!),
        });
        if (!receipt) return null;
        if (receipt.status === "settled" || receipt.billId) {
          throw new PostingError(
            "This receipt has been settled into a bill — void the bill instead of deleting the receipt",
          );
        }
        // Photos do not cascade: attachments are entity-scoped by a string
        // pair, not a foreign key, so deleting the receipt would otherwise
        // leave rows pointing at nothing and files nobody can reach.
        const photos = await tx
          .select({ id: attachments.id, storedName: attachments.storedName })
          .from(attachments)
          .where(
            and(
              eq(attachments.entityType, "office_receipt"),
              eq(attachments.entityId, receipt.id),
            ),
          );
        for (const p of photos) {
          await unlink(path.join(UPLOAD_DIR, p.storedName)).catch(() => {
            /* already gone — the row still goes */
          });
        }
        if (photos.length) {
          await tx.delete(attachments).where(
            inArray(
              attachments.id,
              photos.map((p) => p.id),
            ),
          );
        }

        // Lines cascade on the foreign key.
        await tx.delete(officeReceipts).where(eq(officeReceipts.id, receipt.id));
        await resyncDocumentNumber(tx, "office_receipt");
        return receipt.number;
      });
      if (!done) return res.status(404).json({ error: "Goods receipt not found" });
      res.json({ deleted: done });
    } catch (err) {
      if (!fail(err, res)) throw err;
    }
  },
);
