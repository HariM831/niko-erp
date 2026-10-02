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
  eggStockCount,
  houses,
  inventoryTransactions,
  eggAgreements,
  eggBenchmarkPrices,
  eggBoxRates,
  eggDispatches,
  eggMarketRates,
  eggSalesPreferences,
  eggSizeOffsets,
  eggSpotOrders,
  invoices,
  orgProfile,
} from "@shared/schema";
import { db } from "../db";
import { eggDaySpec, renderEggDay } from "../services/egg-day-pdf";
import { latestForecast, nudgePriceForecast } from "../services/egg-price-forecast";
import { istDate } from "../services/day-resolution";
import { requireAnyPermission, requirePermission } from "../lib/rbac";
import { looseNumber, validateBody } from "../lib/validate";
import { DIRECT_RATE_SIZES, EGG_SIZE_LABEL, HIDDEN_EGG_SIZES, type EggSize } from "@shared/egg-sizes";
import { PostingError } from "../services/posting";
import { ALLOWED_MIME, MAX_IMAGE_BYTES, extractEggSheet, withOcrRetry } from "../services/ocr";
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
  boxRateHistory,
  boxRateOn,
  eggsInBox,
  dayOrders,
  eggPrefs,
  loadAndInvoice,
  sizeOffsetsOn,
} from "../services/egg-sales";
import { WHATSAPP_PLACEHOLDERS } from "@shared/egg-whatsapp";
import { dayWhatsapp } from "../services/egg-whatsapp";

export const eggSalesRouter = Router();

const view = requirePermission("sales", "view");
/**
 * The Egg stock page — the day's grading and the closing count. Its own right
 * (farms.egg_stock), so the packing room can enter them without Sales or the
 * rest of Farms. Reading the day's sheet is also open to Sales, which prices
 * from it. Saving used to ask for farms.create, which no role could be given:
 * Farms has no such action, so only a wildcard role could save a count.
 */
const eggStockRead = requireAnyPermission([["sales", "view"], ["farms", "egg_stock"]]);
const eggStockWrite = requirePermission("farms", "egg_stock");
const create = requirePermission("sales", "create");

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const spread = looseNumber(z.number().min(-50).max(50));

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
  boxes: looseNumber(z.number().int().positive()),
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
  boxes: looseNumber(z.number().int().positive()).optional(),
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
  boxes: looseNumber(z.number().int().positive()).optional(),
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
  Object.fromEntries(EGG_SIZES.map((s) => [s, looseNumber(z.number().int().min(0)).default(0)])) as Record<
    (typeof EGG_SIZES)[number],
    z.ZodDefault<z.ZodEffects<z.ZodNumber, number, unknown>>
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
  // The grades sold by the box, with their own history — Niko today.
  const boxRates: Record<string, Awaited<ReturnType<typeof boxRateHistory>>> = {};
  for (const size of DIRECT_RATE_SIZES) boxRates[size] = await boxRateHistory(db, size);
  // The newest Kolkata reading, so the form opens on it as it does the benchmark.
  const [kolkata] = await db
    .select({ rateDate: eggMarketRates.rateDate, ratePerEgg: eggMarketRates.ratePerEgg })
    .from(eggMarketRates)
    .where(eq(eggMarketRates.market, "kolkata"))
    .orderBy(desc(eggMarketRates.rateDate))
    .limit(1);
  res.json({
    history,
    kolkata: kolkata ?? null,
    offsets,
    eggsPerBox: prefs.eggsPerBox,
    boxSizes: Object.fromEntries(EGG_SIZES.map((z) => [z, eggsInBox(z, prefs)])),
    boxRates,
    // The model's latest run, so the page that sets the rate can show where it
    // is expected to go — the same figures the home page tile draws.
    forecast: await latestForecast(db),
  });
});

const boxRateBody = z.object({
  size: z.enum(DIRECT_RATE_SIZES as [EggSize, ...EggSize[]]),
  effectiveFrom: dateStr,
  ratePerBox: looseNumber(z.number().positive().max(100_000)),
  note: z.string().max(300).optional(),
});

/** A rate per box for a grade sold that way. Setting the same day again is a correction. */
eggSalesRouter.post("/box-rate", create, validateBody(boxRateBody), async (req, res) => {
  const b = req.body as z.infer<typeof boxRateBody>;
  const [row] = await db
    .insert(eggBoxRates)
    .values({
      size: b.size,
      effectiveFrom: b.effectiveFrom,
      ratePerBox: b.ratePerBox.toFixed(2),
      note: b.note || null,
      createdBy: req.session.user!.id,
    })
    .onConflictDoUpdate({
      target: [eggBoxRates.size, eggBoxRates.effectiveFrom],
      set: { ratePerBox: b.ratePerBox.toFixed(2), note: b.note || null, createdBy: req.session.user!.id },
    })
    .returning();
  res.status(201).json(row);
});

const benchmarkBody = z.object({
  effectiveFrom: dateStr,
  ratePerEgg: looseNumber(z.number().positive().max(100)),
  note: z.string().max(300).optional(),
  /** Kolkata's rate, kept beside the benchmark for the forecast and the eye. */
  kolkataRate: looseNumber(z.number().positive().max(100)).optional(),
  /** Kolkata's own day — decided at 7 am, so usually today, not the benchmark's tomorrow. */
  kolkataDate: dateStr.optional(),
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
  if (b.kolkataRate != null) await saveKolkata(b.kolkataDate ?? istDate(), b.kolkataRate, req.session.user!.id);
  res.status(201).json(row);
});

/** Kolkata's 7 am rate, kept by its own day; a correction on the same day replaces it. */
async function saveKolkata(on: string, rate: number, userId: string) {
  await db
    .insert(eggMarketRates)
    .values({ market: "kolkata", rateDate: on, ratePerEgg: rate.toFixed(4), source: "sales", createdBy: userId })
    .onConflictDoUpdate({
      target: [eggMarketRates.market, eggMarketRates.rateDate],
      set: { ratePerEgg: rate.toFixed(4), source: "sales", createdBy: userId },
    });
  // The forecast's first days ride on Kolkata's latest move: rerun now, not at the evening's benchmark.
  nudgePriceForecast();
}

const kolkataBody = z.object({ rateDate: dateStr, ratePerEgg: looseNumber(z.number().positive().max(100)) });

/** Kolkata on its own, at 7 am, before the evening's benchmark. */
eggSalesRouter.post("/kolkata", create, validateBody(kolkataBody), async (req, res) => {
  const b = req.body as z.infer<typeof kolkataBody>;
  await saveKolkata(b.rateDate, b.ratePerEgg, req.session.user!.id);
  res.status(201).json({ ok: true });
});

/**
 * Every size optional: the screen sends the grades it shows, and a hidden or
 * box-priced grade simply keeps a zero differential.
 */
const offsetsBody = z.object({
  effectiveFrom: dateStr,
  ...(Object.fromEntries(EGG_SIZES.map((z) => [z, spread.optional()])) as Record<EggSize, z.ZodOptional<typeof spread>>),
});

eggSalesRouter.post("/size-offsets", create, validateBody(offsetsBody), async (req, res) => {
  const b = req.body as z.infer<typeof offsetsBody>;
  const off = Object.fromEntries(EGG_SIZES.map((z) => [z, Number(b[z] ?? 0).toFixed(4)])) as Record<EggSize, string>;
  const [row] = await db
    .insert(eggSizeOffsets)
    .values({ effectiveFrom: b.effectiveFrom, ...off, createdBy: req.session.user!.id })
    .onConflictDoUpdate({
      target: [eggSizeOffsets.effectiveFrom],
      set: { ...off, createdBy: req.session.user!.id },
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

  /** The box-priced grades' rates for the day, so the bay estimates as the server will invoice. */
  const boxRates: Record<string, string | null> = {};
  for (const size of DIRECT_RATE_SIZES) boxRates[size] = (await boxRateOn(db, size, on))?.ratePerBox ?? null;

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
    boxSizes: Object.fromEntries(EGG_SIZES.map((s) => [s, eggsInBox(s, prefs)])),
    boxRates,
  });
});

/**
 * The day's WhatsApp messages, one per customer — only once the benchmark is
 * set for this very day. The calendar puts an icon beside each order it covers.
 */
eggSalesRouter.get("/day/:date/whatsapp", view, async (req, res) => {
  const on = req.params.date!;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(on)) return res.status(400).json({ error: "Bad date" });
  res.json(await dayWhatsapp(db, on));
});

/** Settings › Sales › WhatsApp message. */
eggSalesRouter.get("/message-settings", view, async (_req, res) => {
  const prefs = await eggPrefs(db);
  res.json({
    template: prefs.whatsappTemplate,
    paymentInstructions: prefs.paymentInstructions ?? "",
    placeholders: WHATSAPP_PLACEHOLDERS,
  });
});

const messageSettingsBody = z.object({
  template: z.string().trim().min(1, "The message cannot be empty").max(4000),
  paymentInstructions: z.string().trim().max(500),
});

eggSalesRouter.put("/message-settings", create, validateBody(messageSettingsBody), async (req, res) => {
  const b = req.body as z.infer<typeof messageSettingsBody>;
  await db
    .update(eggSalesPreferences)
    .set({ whatsappTemplate: b.template, paymentInstructions: b.paymentInstructions || null });
  res.json({ ok: true });
});

/**
 * The day's sheet as a PDF: Orders (boxes) or Sales (boxes, rates, amounts),
 * one row per customer and a column per grade — the Benchmark page's two
 * printouts, as Amino's page had.
 */
eggSalesRouter.get("/day/:date/sheet.pdf", view, async (req, res) => {
  const on = req.params.date!;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(on)) return res.status(400).json({ error: "Bad date" });
  const kind = req.query.kind === "sales" ? "sales" : "orders";
  const [org] = await db.select({ name: orgProfile.name }).from(orgProfile).limit(1);
  const pdf = await renderEggDay(await eggDaySpec(db, on, kind, org?.name ?? "Niko"));
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${kind === "sales" ? "Sales" : "Orders"}-${on}.pdf"`);
  res.send(pdf);
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
eggSalesRouter.get("/grading/:date", eggStockRead, async (req, res) => {
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
   * The evening count: one total per size, as the packing room counts its
   * shelves. Null until somebody counts.
   */
  const [countRow] = await db.select().from(eggStockCount).where(eq(eggStockCount.countedOn, on));

  const sized = (row: Record<string, unknown> | undefined) =>
    Object.fromEntries(EGG_SIZES.map((s) => [s, Number(row?.[s] ?? 0)])) as Record<(typeof EGG_SIZES)[number], number>;

  const rows = houseRows.map((h) => ({
    houseId: h.id,
    code: h.code,
    purpose: h.purpose,
    boxes: sized(byHouse.get(h.id)),
    entered: byHouse.has(h.id),
  }));

  const summary = await stockSummaryOn(on);

  /**
   * The variance: the ledger's closing against the count. Zero means the
   * sheets, the bay and the shelves all agree; anything else is the day's
   * question, and an adjustment's job to answer.
   */
  const count = countRow ? sized(countRow as unknown as Record<string, unknown>) : null;
  const variance = count
    ? (Object.fromEntries(EGG_SIZES.map((s) => [s, count[s] - (summary[s]?.closing ?? 0)])) as Record<string, number>)
    : null;

  res.json({
    date: on,
    rows,
    summary,
    count,
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
  boxes: z.object(
    Object.fromEntries(EGG_SIZES.map((s) => [s, looseNumber(z.number().int().min(0)).default(0)])) as Record<
      (typeof EGG_SIZES)[number],
      z.ZodDefault<z.ZodEffects<z.ZodNumber, number, unknown>>
    >,
  ),
});

/**
 * The evening count, saved in place — and then the ledger is brought to it.
 * The count is what is on the shelves; the adjustment it posts is the record
 * of the ledger having been wrong by that much.
 */
eggSalesRouter.post("/closing", eggStockWrite, validateBody(closingBody), async (req, res) => {
  const b = req.body as z.infer<typeof closingBody>;
  try {
    const out = await db.transaction(async (tx) => {
      await tx
        .insert(eggStockCount)
        .values({ countedOn: b.countedOn, ...b.boxes, recordedBy: req.session.user!.id })
        .onConflictDoUpdate({
          target: [eggStockCount.countedOn],
          set: { ...b.boxes, recordedBy: req.session.user!.id, updatedAt: new Date() },
        });
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
          Object.fromEntries(EGG_SIZES.map((s) => [s, looseNumber(z.number().int().min(0)).default(0)])) as Record<
            (typeof EGG_SIZES)[number],
            z.ZodDefault<z.ZodEffects<z.ZodNumber, number, unknown>>
          >,
        ),
      }),
    )
    .min(1)
    .max(50),
});

/** Save the sheet: every row in one transaction, re-stated in place. */
eggSalesRouter.post("/grading", eggStockWrite, validateBody(gradingBody), async (req, res) => {
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

/* ── Reading the paper sheet ─────────────────────────────────────────────── */

const readSheetBody = z.object({
  /** One photograph of the day sheet, base64 with or without a data: prefix. */
  image: z.string().min(1),
});

/** Per-user ceiling on the vision endpoint — the key is metered. */
const sheetReads = new Map<string, number[]>();
const overSheetReadLimit = (userId: string) => {
  const now = Date.now();
  const recent = (sheetReads.get(userId) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  sheetReads.set(userId, recent);
  return recent.length > 12;
};

/**
 * Read a photograph of the handwritten day sheet into the grading grid.
 *
 * Suggestions only: nothing is saved here. The route resolves the sheet's
 * shed labels to houses and returns every check the reader made — the paper's
 * own totals against the shed rows, headings niko has no grade for, sheds it
 * has no house for — so the person saving sees what the photo did and did
 * not establish. The photograph is not kept; the paper is.
 */
eggSalesRouter.post(
  "/grading/read",
  eggStockWrite,
  validateBody(readSheetBody),
  async (req, res) => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(503).json({ error: "Reading sheets needs GEMINI_API_KEY — type the figures for now" });
    }
    if (overSheetReadLimit(req.session.user!.id)) {
      return res.status(429).json({ error: "Too many reads — wait a moment and try again" });
    }
    const img = (req.body as z.infer<typeof readSheetBody>).image;
    const m = img.match(/^data:([a-z/+.-]+);base64,(.*)$/i);
    const mimeType = (m?.[1] ?? "image/jpeg").toLowerCase();
    const data = m?.[2] ?? img;
    if (!(ALLOWED_MIME as readonly string[]).includes(mimeType)) {
      return res.status(415).json({ error: `Unsupported image type: ${mimeType}` });
    }
    if (Math.floor((data.length * 3) / 4) > MAX_IMAGE_BYTES) {
      return res.status(413).json({ error: "The photo must be under 2 MB" });
    }

    let sheet;
    try {
      sheet = await withOcrRetry(() => extractEggSheet([{ data, mimeType }], apiKey));
    } catch (err) {
      console.error("[ocr] grading/read failed:", err);
      return res.status(502).json({ error: "Could not read the sheet — enter the figures by hand" });
    }

    // The paper says L2; the grid wants a house. Matched on code, and a shed
    // the farm has no house for is reported rather than dropped.
    const houseRows = await db
      .select({ id: houses.id, code: houses.code })
      .from(houses)
      .where(sql`${houses.isActive}`);
    const byCode = new Map(houseRows.map((h) => [h.code.toUpperCase().replace(/\s+/g, ""), h]));
    const rows = sheet.rows.map((r) => {
      const house = byCode.get(r.shed);
      return { ...r, houseId: house?.id ?? null, code: house?.code ?? null };
    });
    const unmatchedSheds = rows.filter((r) => !r.houseId).map((r) => r.shed);
    // A hidden grade's figure is reported and left out, never keyed unseen.
    for (const r of rows) {
      for (const h of HIDDEN_EGG_SIZES) {
        const n = r.boxes[h];
        if (!n) continue;
        delete r.boxes[h];
        sheet.warnings.push(`${EGG_SIZE_LABEL[h]} is hidden on this screen — ${r.shed}'s ${n} box(es) were not entered`);
      }
    }
    // A grade the sheet names that the sizes here do not: said, not silently dropped.
    const known = new Set<string>(EGG_SIZES);
    const warnings = [...sheet.warnings];
    for (const c of sheet.columns) {
      if (c.grade && !known.has(c.grade)) warnings.push(`"${c.header}" reads as ${c.grade}, which is not a size here`);
    }
    for (const shed of unmatchedSheds) warnings.push(`${shed} on the paper has no house here — its row was not entered`);

    res.json({ ...sheet, rows, unmatchedSheds, warnings });
  },
);

/* ── The loading bay ─────────────────────────────────────────────────────── */

const loadBody = z.object({
  dispatchDate: dateStr,
  customerId: z.string().uuid(),
  agreementId: z.string().uuid().optional(),
  spotOrderId: z.string().uuid().optional(),
  loaded: z.object(
    Object.fromEntries(EGG_SIZES.map((s) => [s, looseNumber(z.number().int().min(0)).default(0)])) as Record<
      (typeof EGG_SIZES)[number],
      z.ZodDefault<z.ZodEffects<z.ZodNumber, number, unknown>>
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
      loadedBrown: eggDispatches.loadedBrown,
      loadedNiko: eggDispatches.loadedNiko,
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
