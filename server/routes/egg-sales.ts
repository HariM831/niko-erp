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
  eggGrading,
  eggHouseClosing,
  houses,
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
  ledgerAvailable,
  saveGrading,
  settleCountAgainstLedger,
  sizeItems,
  stockBySize,
  supplyCascade,
  benchmarkHistory,
  benchmarkOn,
  dayOrders,
  eggPrefs,
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

const sizeBoxes = z.object(
  Object.fromEntries(EGG_SIZES.map((s) => [s, z.coerce.number().int().min(0).default(0)])) as Record<
    (typeof EGG_SIZES)[number],
    z.ZodDefault<z.ZodNumber>
  >,
);

const spotBody = z.object({
  customerId: z.string().uuid(),
  orderDate: dateStr,
  sizes: sizeBoxes,
  spreadPerEgg: spread.nullish(),
  notes: z.string().max(500).optional(),
});

const sumSizes = (s: Record<string, number>) => EGG_SIZES.reduce((a, z) => a + (s[z] ?? 0), 0);

eggSalesRouter.post("/spot-orders", create, validateBody(spotBody), async (req, res) => {
  const b = req.body as z.infer<typeof spotBody>;
  const total = sumSizes(b.sizes);
  if (total <= 0) return res.status(422).json({ error: "Book at least one box of some size" });
  const [row] = await db
    .insert(eggSpotOrders)
    .values({
      customerId: b.customerId,
      orderDate: b.orderDate,
      boxes: total,
      ...b.sizes,
      spreadPerEgg: b.spreadPerEgg == null ? null : b.spreadPerEgg.toFixed(4),
      notes: b.notes || null,
      createdBy: req.session.user!.id,
    })
    .returning();
  res.status(201).json(row);
});

const spotPatch = z.object({
  sizes: sizeBoxes.optional(),
  spreadPerEgg: spread.nullish(),
  notes: z.string().max(500).nullish(),
});

/** Edit a booking that has not been loaded. A loaded one is answered by its invoice. */
eggSalesRouter.patch("/spot-orders/:id", create, validateBody(spotPatch), async (req, res) => {
  const b = req.body as z.infer<typeof spotPatch>;
  const [spot] = await db.select().from(eggSpotOrders).where(eq(eggSpotOrders.id, req.params.id!));
  if (!spot) return res.status(404).json({ error: "No such spot order" });
  if (spot.status === "voided") return res.status(422).json({ error: "Voided — book a fresh one" });
  const [loaded] = await db
    .select({ id: eggDispatches.id })
    .from(eggDispatches)
    .where(and(eq(eggDispatches.spotOrderId, spot.id), sql`${eggDispatches.status} != 'void'`));
  if (loaded) return res.status(422).json({ error: "Already loaded and invoiced — the invoice is the document now" });
  if (b.sizes && sumSizes(b.sizes) <= 0) return res.status(422).json({ error: "Book at least one box of some size" });
  const [row] = await db
    .update(eggSpotOrders)
    .set({
      ...(b.sizes && { ...b.sizes, boxes: sumSizes(b.sizes) }),
      ...(b.spreadPerEgg !== undefined && { spreadPerEgg: b.spreadPerEgg == null ? null : b.spreadPerEgg.toFixed(4) }),
      ...(b.notes !== undefined && { notes: b.notes }),
    })
    .where(eq(eggSpotOrders.id, spot.id))
    .returning();
  res.json(row);
});

/**
 * The spread to pre-fill for a customer: their last spot order's, else their
 * standing agreement's, else nothing. A number the phone conversation starts
 * from, not a rule.
 */
eggSalesRouter.get("/customers/:id/last-spread", view, async (req, res) => {
  const [spot] = await db
    .select({ spread: eggSpotOrders.spreadPerEgg })
    .from(eggSpotOrders)
    .where(and(eq(eggSpotOrders.customerId, req.params.id!), sql`${eggSpotOrders.spreadPerEgg} IS NOT NULL`))
    .orderBy(desc(eggSpotOrders.createdAt))
    .limit(1);
  if (spot?.spread != null) return res.json({ spread: spot.spread, from: "spot" });
  const [ag] = await db
    .select({ spread: eggAgreements.spreadPerEgg })
    .from(eggAgreements)
    .where(and(eq(eggAgreements.customerId, req.params.id!), eq(eggAgreements.status, "active")))
    .orderBy(desc(eggAgreements.startDate))
    .limit(1);
  res.json({ spread: ag?.spread ?? null, from: ag ? "agreement" : null });
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
  const from = `${m[1]}-${m[2]}-01`;
  const to = `${m[1]}-${m[2]}-${String(daysInMonth).padStart(2, "0")}`;

  const [cascade, benchmarks] = await Promise.all([
    supplyCascade(db, from, to),
    db
      .select({ effectiveFrom: eggBenchmarkPrices.effectiveFrom, ratePerEgg: eggBenchmarkPrices.ratePerEgg })
      .from(eggBenchmarkPrices)
      .where(and(gte(eggBenchmarkPrices.effectiveFrom, from), lte(eggBenchmarkPrices.effectiveFrom, to))),
  ]);
  const bmOf = new Map(benchmarks.map((b) => [b.effectiveFrom, b.ratePerEgg]));
  res.json({
    days: cascade.map((d) => ({ ...d, graded: d.productionSource === "actual", benchmark: bmOf.get(d.date) ?? null })),
  });
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

  /** What the pile holds right now, by size — the bay's own headroom. */
  const held = await stockBySize(db);

  /**
   * The capacity breakdown: run the cascade from the first of the month so
   * a projected day's opening is the carried closing, not a guess.
   */
  const cascade = await supplyCascade(db, `${on.slice(0, 7)}-01`, on);
  const capacity = cascade[cascade.length - 1] ?? null;

  /** Each customer's headroom, once, so the bay can gate every row. */
  const ledger: Record<string, number> = {};
  for (const customerId of new Set(lines.map((l) => l.customerId))) {
    ledger[customerId] = await ledgerAvailable(db, customerId);
  }

  res.json({
    stockBySize: held,
    stockBoxes: EGG_SIZES.reduce((a, s) => a + held[s], 0),
    capacity,
    ledger,
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
    .where(
      and(
        sql`${contacts.type} IN ('customer', 'both')`,
        eq(contacts.isActive, true),
        // The owners' eggs are bought back through owner billing, never sold to them here.
        eq(contacts.isGroupCompany, false),
      ),
    )
    .orderBy(asc(contacts.displayName));
  res.json({ customers: rows });
});

/* ── Grading: the day sheet ──────────────────────────────────────────────── */

/** Per-size movement on one day, split the way the sheet splits it. */
async function stockSummaryOn(on: string) {
  const map = await sizeItems(db);
  const held = await stockBySize(db);
  const out: Record<string, { opening: number; production: number; sales: number; other: number; closing: number }> = {};
  for (const s of EGG_SIZES) {
    const itemId = map.get(s)!;
    const rows = await db
      .select({
        day: inventoryTransactions.transactionDate,
        source: inventoryTransactions.sourceType,
        q: sql<string>`sum(${inventoryTransactions.quantity})`,
      })
      .from(inventoryTransactions)
      .where(and(eq(inventoryTransactions.itemId, itemId), gte(inventoryTransactions.transactionDate, on)))
      .groupBy(inventoryTransactions.transactionDate, inventoryTransactions.sourceType);
    let since = 0;
    let production = 0;
    let sales = 0;
    let other = 0;
    for (const r of rows) {
      const q = Number(r.q);
      since += q;
      if (r.day !== on) continue;
      if (r.source === "egg_grading") production += q;
      else if (r.source === "invoice" || r.source === "invoice_void") sales -= q;
      else other += q;
    }
    const opening = held[s] - since;
    out[s] = { opening, production, sales, other, closing: opening + production - sales + other };
  }
  return out;
}

/** The sheet for one day: every laying house, what was graded, the evening count, and the stock summary. */
eggSalesRouter.get("/grading/:date", view, async (req, res) => {
  const on = req.params.date!;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(on)) return res.status(400).json({ error: "Bad date" });
  const prefs = await eggPrefs(db);
  const houseRows = await db
    .select({ id: houses.id, code: houses.code, purpose: houses.purpose })
    .from(houses)
    .where(sql`${houses.isActive}`)
    .orderBy(houses.displayOrder, houses.code);
  const entries = await db.select().from(eggGrading).where(eq(eggGrading.gradedOn, on));
  const byHouse = new Map(entries.map((e) => [e.houseId, e]));

  /**
   * The evening count, and the shed's opening — which is simply the previous
   * count taken for that shed, however many days back. A shed with no count
   * on record opens at nothing known.
   */
  const counts = await db.select().from(eggHouseClosing).where(eq(eggHouseClosing.countedOn, on));
  const countOf = new Map(counts.map((c) => [c.houseId, c]));
  const previous = await db
    .selectDistinctOn([eggHouseClosing.houseId])
    .from(eggHouseClosing)
    .where(sql`${eggHouseClosing.countedOn} < ${on}`)
    .orderBy(eggHouseClosing.houseId, desc(eggHouseClosing.countedOn));
  const prevOf = new Map(previous.map((c) => [c.houseId, c]));

  const sized = (row: Record<string, unknown> | undefined) =>
    Object.fromEntries(EGG_SIZES.map((s) => [s, Number(row?.[s] ?? 0)])) as Record<(typeof EGG_SIZES)[number], number>;

  const rows = houseRows.map((h) => {
    const graded = sized(byHouse.get(h.id));
    const opening = prevOf.has(h.id) ? sized(prevOf.get(h.id)) : null;
    const closing = countOf.has(h.id) ? sized(countOf.get(h.id)) : null;
    // What left the shed: opening + graded − counted. Only meaningful once
    // both ends of the day are known.
    const lifted =
      opening && closing
        ? (Object.fromEntries(EGG_SIZES.map((s) => [s, opening[s] + graded[s] - closing[s]])) as Record<string, number>)
        : null;
    return {
      houseId: h.id,
      code: h.code,
      purpose: h.purpose,
      boxes: graded,
      entered: byHouse.has(h.id),
      opening,
      openingFrom: prevOf.get(h.id)?.countedOn ?? null,
      closing,
      counted: countOf.has(h.id),
      lifted,
    };
  });

  const summary = await stockSummaryOn(on);

  /**
   * The variance: the ledger's closing against the sum of the sheds' counts.
   * Zero means the sheets, the bay and the rooms all agree; anything else is
   * the day's question, and an adjustment's job to answer.
   */
  const countedTotal = rows.some((r) => r.counted)
    ? (Object.fromEntries(
        EGG_SIZES.map((s) => [s, rows.reduce((a, r) => a + (r.closing?.[s] ?? 0), 0)]),
      ) as Record<string, number>)
    : null;
  const variance = countedTotal
    ? (Object.fromEntries(EGG_SIZES.map((s) => [s, countedTotal[s]! - (summary[s]?.closing ?? 0)])) as Record<string, number>)
    : null;

  res.json({
    date: on,
    rows,
    summary,
    countedTotal,
    variance,
    bands: {
      smallMaxKg: prefs.bandSmallMaxKg,
      mediumMaxKg: prefs.bandMediumMaxKg,
      largeMaxKg: prefs.bandLargeMaxKg,
    },
    stockFrom: prefs.stockFrom,
  });
});

const closingBody = z.object({
  countedOn: dateStr,
  rows: z
    .array(
      z.object({
        houseId: z.string().uuid(),
        boxes: z.object(
          Object.fromEntries(EGG_SIZES.map((s) => [s, z.coerce.number().int().min(0).default(0)])) as Record<
            (typeof EGG_SIZES)[number],
            z.ZodDefault<z.ZodNumber>
          >,
        ),
      }),
    )
    .min(1)
    .max(50),
});

/**
 * The evening count, saved in place — and then the ledger is brought to it.
 * The count is what is on the shelves; the adjustment it posts is the record
 * of the ledger having been wrong by that much.
 */
eggSalesRouter.post("/closing", requirePermission("farms", "create"), validateBody(closingBody), async (req, res) => {
  const b = req.body as z.infer<typeof closingBody>;
  try {
    const out = await db.transaction(async (tx) => {
      for (const r of b.rows) {
        await tx
          .insert(eggHouseClosing)
          .values({ houseId: r.houseId, countedOn: b.countedOn, ...r.boxes, recordedBy: req.session.user!.id })
          .onConflictDoUpdate({
            target: [eggHouseClosing.houseId, eggHouseClosing.countedOn],
            set: { ...r.boxes, recordedBy: req.session.user!.id, updatedAt: new Date() },
          });
      }
      return settleCountAgainstLedger(tx, b.countedOn, req.session.user!.id);
    });
    res.status(201).json(out);
  } catch (err) {
    if (!fail(err, res)) throw err;
  }
});

const gradingBody = z.object({
  gradedOn: dateStr,
  rows: z
    .array(
      z.object({
        houseId: z.string().uuid(),
        boxes: z.object(
          Object.fromEntries(EGG_SIZES.map((s) => [s, z.coerce.number().int().min(0).default(0)])) as Record<
            (typeof EGG_SIZES)[number],
            z.ZodDefault<z.ZodNumber>
          >,
        ),
      }),
    )
    .min(1)
    .max(50),
});

/** Save the sheet: every row in one transaction, re-stated in place. */
eggSalesRouter.post("/grading", requirePermission("farms", "create"), validateBody(gradingBody), async (req, res) => {
  const b = req.body as z.infer<typeof gradingBody>;
  try {
    await db.transaction(async (tx) => {
      for (const r of b.rows) {
        await saveGrading(tx, { houseId: r.houseId, gradedOn: b.gradedOn, boxes: r.boxes }, req.session.user!.id);
      }
    });
    res.status(201).json({ ok: true });
  } catch (err) {
    if (!fail(err, res)) throw err;
  }
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
