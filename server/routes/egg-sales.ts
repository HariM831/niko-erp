/**
 * Egg sales, over HTTP. The thinking lives in services/egg-sales.ts;
 * this file validates, authorises, and answers.
 */
import { Router } from "express";
import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";
import { z } from "zod";
import {
  contacts,
  eggAgreementExceptions,
  inventoryTransactions,
  eggAgreements,
  eggBenchmarkPrices,
  eggDispatches,
  eggSizeOffsets,
  eggSpotOrders,
  invoices,
} from "@shared/schema";
import { db } from "../db";
import { requirePermission } from "../lib/rbac";
import { validateBody } from "../lib/validate";
import { PostingError } from "../services/posting";
import {
  EGG_SIZES,
  actualBoxesOn,
  ledgerAvailable,
  benchmarkHistory,
  benchmarkOn,
  dayOrders,
  eggPrefs,
  expectedBoxesPerDay,
  loadAndInvoice,
  sizeOffsetsOn,
} from "../services/egg-sales";

export const eggSalesRouter = Router();

const view = requirePermission("sales", "view");
const create = requirePermission("sales", "create");

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const spread = z.coerce.number().min(-50).max(50);

const fail = (err: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) => {
  if (err instanceof PostingError) {
    res.status(422).json({ error: err.message });
    return true;
  }
  return false;
};

/* ── Agreements ──────────────────────────────────────────────────────────── */

eggSalesRouter.get("/agreements", view, async (_req, res) => {
  const rows = await db
    .select({
      id: eggAgreements.id,
      customerId: eggAgreements.customerId,
      customerName: contacts.displayName,
      schedule: eggAgreements.schedule,
      daysOfWeek: eggAgreements.daysOfWeek,
      boxes: eggAgreements.boxes,
      spreadPerEgg: eggAgreements.spreadPerEgg,
      startDate: eggAgreements.startDate,
      endDate: eggAgreements.endDate,
      status: eggAgreements.status,
      notes: eggAgreements.notes,
    })
    .from(eggAgreements)
    .innerJoin(contacts, eq(contacts.id, eggAgreements.customerId))
    .orderBy(
      // The live ones first, the dead ones under them.
      sql`CASE ${eggAgreements.status} WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END`,
      asc(contacts.displayName),
    );
  res.json({ agreements: rows });
});

const agreementBody = z.object({
  customerId: z.string().uuid(),
  schedule: z.enum(["daily", "weekdays"]),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  boxes: z.coerce.number().int().positive(),
  spreadPerEgg: spread,
  startDate: dateStr,
  notes: z.string().max(500).optional(),
});

eggSalesRouter.post("/agreements", create, validateBody(agreementBody), async (req, res) => {
  const b = req.body as z.infer<typeof agreementBody>;
  if (b.schedule === "weekdays" && !b.daysOfWeek?.length) {
    return res.status(422).json({ error: "A weekday schedule needs at least one day named" });
  }
  const [row] = await db
    .insert(eggAgreements)
    .values({
      customerId: b.customerId,
      schedule: b.schedule,
      daysOfWeek: b.schedule === "daily" ? null : b.daysOfWeek!,
      boxes: b.boxes,
      spreadPerEgg: b.spreadPerEgg.toFixed(4),
      startDate: b.startDate,
      notes: b.notes || null,
      createdBy: req.session.user!.id,
    })
    .returning();
  res.status(201).json(row);
});

const agreementPatch = z.object({
  schedule: z.enum(["daily", "weekdays"]).optional(),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).max(7).nullish(),
  boxes: z.coerce.number().int().positive().optional(),
  spreadPerEgg: spread.optional(),
  status: z.enum(["active", "paused"]).optional(),
  /** Setting this ends the agreement — the void that keeps its history. */
  endDate: dateStr.nullish(),
  notes: z.string().max(500).nullish(),
});

eggSalesRouter.patch("/agreements/:id", create, validateBody(agreementPatch), async (req, res) => {
  const b = req.body as z.infer<typeof agreementPatch>;
  const [existing] = await db.select().from(eggAgreements).where(eq(eggAgreements.id, req.params.id!));
  if (!existing) return res.status(404).json({ error: "No such agreement" });
  if (existing.status === "ended" && b.endDate !== null) {
    return res.status(422).json({ error: "This agreement has ended — start a new one instead of editing it" });
  }
  const [row] = await db
    .update(eggAgreements)
    .set({
      ...(b.schedule !== undefined && { schedule: b.schedule }),
      ...(b.daysOfWeek !== undefined && { daysOfWeek: b.schedule === "daily" ? null : b.daysOfWeek }),
      ...(b.boxes !== undefined && { boxes: b.boxes }),
      ...(b.spreadPerEgg !== undefined && { spreadPerEgg: b.spreadPerEgg.toFixed(4) }),
      ...(b.notes !== undefined && { notes: b.notes }),
      ...(b.status !== undefined && { status: b.status }),
      ...(b.endDate !== undefined && {
        endDate: b.endDate,
        status: b.endDate === null ? "active" : "ended",
      }),
    })
    .where(eq(eggAgreements.id, req.params.id!))
    .returning();
  res.json(row);
});

/* ── Exceptions: the per-day void for standing orders ────────────────────── */

const exceptionBody = z.object({
  onDate: dateStr,
  kind: z.enum(["skip", "qty_override"]),
  boxes: z.coerce.number().int().positive().optional(),
  reason: z.string().max(300).optional(),
});

eggSalesRouter.post("/agreements/:id/exceptions", create, validateBody(exceptionBody), async (req, res) => {
  const b = req.body as z.infer<typeof exceptionBody>;
  if (b.kind === "qty_override" && !b.boxes) {
    return res.status(422).json({ error: "An override needs the new box count" });
  }
  // A day already loaded is answered by its invoice, not by an exception.
  const [loaded] = await db
    .select({ id: eggDispatches.id })
    .from(eggDispatches)
    .where(
      and(
        eq(eggDispatches.agreementId, req.params.id!),
        eq(eggDispatches.dispatchDate, b.onDate),
        sql`${eggDispatches.status} != 'void'`,
      ),
    );
  if (loaded) {
    return res
      .status(422)
      .json({ error: "That day is already loaded and invoiced — void the invoice instead" });
  }
  const [row] = await db
    .insert(eggAgreementExceptions)
    .values({
      agreementId: req.params.id!,
      onDate: b.onDate,
      kind: b.kind,
      boxes: b.kind === "qty_override" ? b.boxes! : null,
      reason: b.reason || null,
      createdBy: req.session.user!.id,
    })
    .onConflictDoUpdate({
      target: [eggAgreementExceptions.agreementId, eggAgreementExceptions.onDate],
      set: {
        kind: b.kind,
        boxes: b.kind === "qty_override" ? b.boxes! : null,
        reason: b.reason || null,
        createdBy: req.session.user!.id,
      },
    })
    .returning();
  res.status(201).json(row);
});

eggSalesRouter.delete("/agreements/:id/exceptions/:date", create, async (req, res) => {
  await db
    .delete(eggAgreementExceptions)
    .where(
      and(
        eq(eggAgreementExceptions.agreementId, req.params.id!),
        eq(eggAgreementExceptions.onDate, req.params.date!),
      ),
    );
  res.json({ ok: true });
});

/* ── Spot orders ─────────────────────────────────────────────────────────── */

const spotBody = z.object({
  customerId: z.string().uuid(),
  orderDate: dateStr,
  boxes: z.coerce.number().int().positive(),
  spreadPerEgg: spread.nullish(),
  notes: z.string().max(500).optional(),
});

eggSalesRouter.post("/spot-orders", create, validateBody(spotBody), async (req, res) => {
  const b = req.body as z.infer<typeof spotBody>;
  const [row] = await db
    .insert(eggSpotOrders)
    .values({
      customerId: b.customerId,
      orderDate: b.orderDate,
      boxes: b.boxes,
      spreadPerEgg: b.spreadPerEgg == null ? null : b.spreadPerEgg.toFixed(4),
      notes: b.notes || null,
      createdBy: req.session.user!.id,
    })
    .returning();
  res.status(201).json(row);
});

eggSalesRouter.post(
  "/spot-orders/:id/void",
  create,
  validateBody(z.object({ reason: z.string().max(300).optional() })),
  async (req, res) => {
    const [spot] = await db.select().from(eggSpotOrders).where(eq(eggSpotOrders.id, req.params.id!));
    if (!spot) return res.status(404).json({ error: "No such spot order" });
    if (spot.status === "voided") return res.status(422).json({ error: "Already voided" });
    const [loaded] = await db
      .select({ id: eggDispatches.id })
      .from(eggDispatches)
      .where(and(eq(eggDispatches.spotOrderId, spot.id), sql`${eggDispatches.status} != 'void'`));
    if (loaded) {
      return res
        .status(422)
        .json({ error: "This order is loaded and invoiced — void the invoice instead" });
    }
    const [row] = await db
      .update(eggSpotOrders)
      .set({
        status: "voided",
        voidedReason: req.body.reason || null,
        voidedBy: req.session.user!.id,
        voidedAt: new Date(),
      })
      .where(eq(eggSpotOrders.id, spot.id))
      .returning();
    res.json(row);
  },
);

/* ── Benchmark and size differentials ────────────────────────────────────── */

eggSalesRouter.get("/benchmark", view, async (_req, res) => {
  const history = await benchmarkHistory(db);
  const offsets = await db.select().from(eggSizeOffsets).orderBy(desc(eggSizeOffsets.effectiveFrom)).limit(12);
  const prefs = await eggPrefs(db);
  res.json({ history, offsets, eggsPerBox: prefs.eggsPerBox });
});

const benchmarkBody = z.object({
  effectiveFrom: dateStr,
  ratePerEgg: z.coerce.number().positive().max(100),
  note: z.string().max(300).optional(),
});

eggSalesRouter.post("/benchmark", create, validateBody(benchmarkBody), async (req, res) => {
  const b = req.body as z.infer<typeof benchmarkBody>;
  const [row] = await db
    .insert(eggBenchmarkPrices)
    .values({
      effectiveFrom: b.effectiveFrom,
      ratePerEgg: b.ratePerEgg.toFixed(4),
      source: "sales",
      note: b.note || null,
      createdBy: req.session.user!.id,
    })
    // Setting the same day again is a correction, not an error.
    .onConflictDoUpdate({
      target: [eggBenchmarkPrices.effectiveFrom],
      set: { ratePerEgg: b.ratePerEgg.toFixed(4), note: b.note || null, createdBy: req.session.user!.id },
    })
    .returning();
  res.status(201).json(row);
});

const offsetsBody = z.object({
  effectiveFrom: dateStr,
  small: spread,
  medium: spread,
  large: spread,
  xl: spread,
  jumbo: spread,
  dirty: spread,
});

eggSalesRouter.post("/size-offsets", create, validateBody(offsetsBody), async (req, res) => {
  const b = req.body as z.infer<typeof offsetsBody>;
  const [row] = await db
    .insert(eggSizeOffsets)
    .values({
      effectiveFrom: b.effectiveFrom,
      small: b.small.toFixed(4),
      medium: b.medium.toFixed(4),
      large: b.large.toFixed(4),
      xl: b.xl.toFixed(4),
      jumbo: b.jumbo.toFixed(4),
      dirty: b.dirty.toFixed(4),
      createdBy: req.session.user!.id,
    })
    .onConflictDoUpdate({
      target: [eggSizeOffsets.effectiveFrom],
      set: {
        small: b.small.toFixed(4),
        medium: b.medium.toFixed(4),
        large: b.large.toFixed(4),
        xl: b.xl.toFixed(4),
        jumbo: b.jumbo.toFixed(4),
        dirty: b.dirty.toFixed(4),
        createdBy: req.session.user!.id,
      },
    })
    .returning();
  res.status(201).json(row);
});

/* ── The calendar ────────────────────────────────────────────────────────── */

/**
 * One month, one row per day: boxes due against boxes expected.
 *
 * Derived on the way out — nothing is populated, so an agreement edited this
 * morning is already right for every day of the month.
 */
eggSalesRouter.get("/calendar/:month", view, async (req, res) => {
  const m = /^(\d{4})-(\d{2})$/.exec(req.params.month!);
  if (!m) return res.status(400).json({ error: "Month must be YYYY-MM" });
  const [year, month] = [Number(m[1]), Number(m[2])];
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const dayStr = (d: number) => `${m[1]}-${m[2]}-${String(d).padStart(2, "0")}`;
  const from = dayStr(1);
  const to = dayStr(daysInMonth);

  // Actual production for the days that have records; the rolling average
  // stands in for the days that do not (today included, until it is entered).
  const actual = await actualBoxesOn(db, from, to);
  const expected = await expectedBoxesPerDay(db);

  const benchmarks = await db
    .select({ effectiveFrom: eggBenchmarkPrices.effectiveFrom, ratePerEgg: eggBenchmarkPrices.ratePerEgg })
    .from(eggBenchmarkPrices)
    .where(and(gte(eggBenchmarkPrices.effectiveFrom, from), lte(eggBenchmarkPrices.effectiveFrom, to)));
  const bmOf = new Map(benchmarks.map((b) => [b.effectiveFrom, b.ratePerEgg]));

  const days = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const on = dayStr(d);
    const lines = await dayOrders(db, on);
    const standing = lines
      .filter((l) => l.kind === "standing" && !l.exception)
      .reduce((a, l) => a + l.boxes, 0);
    const overridden = lines
      .filter((l) => l.kind === "standing" && l.exception?.kind === "qty_override")
      .reduce((a, l) => a + l.boxes, 0);
    const spot = lines.filter((l) => l.kind === "spot" && !l.voided).reduce((a, l) => a + l.boxes, 0);
    const dispatched = lines.reduce((a, l) => a + (l.dispatch?.loadedBoxes ?? 0), 0);
    days.push({
      date: on,
      committed: standing + overridden + spot,
      standing: standing + overridden,
      spot,
      skipped: lines.filter((l) => l.exception?.kind === "skip").length,
      dispatched,
      production: actual.get(on) ?? null,
      expected,
      benchmark: bmOf.get(on) ?? null,
    });
  }
  res.json({ days, expected });
});

/** One day's order book, fully resolved — the calendar's drill-down. */
eggSalesRouter.get("/day/:date", view, async (req, res) => {
  const on = req.params.date!;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(on)) return res.status(400).json({ error: "Bad date" });
  const [lines, bm, offsets, prefs] = await Promise.all([
    dayOrders(db, on),
    benchmarkOn(db, on),
    sizeOffsetsOn(db, on),
    eggPrefs(db),
  ]);

  /**
   * What the store holds right now, in boxes — the bay's own headroom figure.
   * Summed from the ledger like every stock number: production in, invoices
   * out, voids back.
   */
  let stockBoxes: number | null = null;
  if (prefs.eggItemId) {
    const [held] = await db
      .select({ eggs: sql<string>`coalesce(sum(${inventoryTransactions.quantity}), 0)` })
      .from(inventoryTransactions)
      .where(eq(inventoryTransactions.itemId, prefs.eggItemId));
    stockBoxes = Math.floor(Number(held?.eggs ?? 0) / prefs.eggsPerBox);
  }

  res.json({
    stockBoxes,
    date: on,
    lines,
    benchmark: bm ? { ratePerEgg: bm.ratePerEgg, setFor: bm.effectiveFrom } : null,
    offsets: offsets
      ? Object.fromEntries(EGG_SIZES.map((s) => [s, offsets[s]]))
      : null,
    eggsPerBox: prefs.eggsPerBox,
  });
});

/** Customers for the pickers: anyone the books can invoice. */
eggSalesRouter.get("/customers", view, async (_req, res) => {
  const rows = await db
    .select({ id: contacts.id, name: contacts.displayName })
    .from(contacts)
    .where(and(sql`${contacts.type} IN ('customer', 'both')`, eq(contacts.isActive, true)))
    .orderBy(asc(contacts.displayName));
  res.json({ customers: rows });
});

/* ── The loading bay ─────────────────────────────────────────────────────── */

const loadBody = z.object({
  dispatchDate: dateStr,
  customerId: z.string().uuid(),
  agreementId: z.string().uuid().optional(),
  spotOrderId: z.string().uuid().optional(),
  loaded: z.object(
    Object.fromEntries(EGG_SIZES.map((s) => [s, z.coerce.number().int().min(0).default(0)])) as Record<
      (typeof EGG_SIZES)[number],
      z.ZodDefault<z.ZodNumber>
    >,
  ),
  driverName: z.string().min(1).max(80),
  vehicleNumber: z.string().min(1).max(20),
  notes: z.string().max(500).optional(),
});

eggSalesRouter.post("/load", create, validateBody(loadBody), async (req, res) => {
  try {
    const out = await db.transaction((tx) =>
      loadAndInvoice(tx, req.body as z.infer<typeof loadBody>, req.session.user!.id),
    );
    res.status(201).json(out);
  } catch (err) {
    if (!fail(err, res)) throw err;
  }
});

/** The day's dispatches, for the bay's own list and the outstanding balance. */
eggSalesRouter.get("/dispatches/:date", view, async (req, res) => {
  const rows = await db
    .select({
      id: eggDispatches.id,
      customerId: eggDispatches.customerId,
      customerName: contacts.displayName,
      invoiceId: eggDispatches.invoiceId,
      invoiceNumber: invoices.number,
      invoiceTotal: invoices.total,
      status: eggDispatches.status,
      driverName: eggDispatches.driverName,
      vehicleNumber: eggDispatches.vehicleNumber,
      loadedSmall: eggDispatches.loadedSmall,
      loadedMedium: eggDispatches.loadedMedium,
      loadedLarge: eggDispatches.loadedLarge,
      loadedXl: eggDispatches.loadedXl,
      loadedJumbo: eggDispatches.loadedJumbo,
      loadedDirty: eggDispatches.loadedDirty,
      createdAt: eggDispatches.createdAt,
    })
    .from(eggDispatches)
    .innerJoin(contacts, eq(contacts.id, eggDispatches.customerId))
    .innerJoin(invoices, eq(invoices.id, eggDispatches.invoiceId))
    .where(eq(eggDispatches.dispatchDate, req.params.date!))
    .orderBy(desc(eggDispatches.createdAt));
  res.json({ dispatches: rows });
});

/**
 * The bay's gate figure: what the customer's ledger can pay for right now.
 * The server enforces the same number at invoice birth — this is the screen's
 * copy, not the check.
 */
eggSalesRouter.get("/customers/:id/ledger", view, async (req, res) => {
  res.json({ available: (await ledgerAvailable(db, req.params.id!)).toFixed(2) });
});
