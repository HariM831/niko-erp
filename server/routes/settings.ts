import { Router } from "express";
import { asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  documentSeries,
  financialYears,
  numberSeries,
  orgProfile,
  preferences,
} from "@shared/schema";
import { NUMBERED_ENTITIES } from "@shared/entities";
import { db } from "../db";
import { requirePermission } from "../lib/rbac";
import { gstStateCode, nonBlank, validateBody } from "../lib/validate";
import { PostingError } from "../services/posting";
import { getOpeningBalances, saveOpeningBalances } from "../services/opening-balances";
import { getPreferences } from "../services/preferences";

export const settingsRouter = Router();

// ---------- Organisation profile ----------

const orgSchema = z.object({
  name: nonBlank(),
  legalName: z.string().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  stateCode: gstStateCode.optional(),
  pincode: z.string().max(10).optional(),
  phone: z.string().max(20).optional(),
  email: z.string().email().optional().or(z.literal("")),
  gstin: z.string().length(15).optional().or(z.literal("")),
  pan: z.string().length(10).optional().or(z.literal("")),
  fiscalYearStart: z.string().regex(/^\d{2}-\d{2}$/).optional(),
});

settingsRouter.get("/org", requirePermission("settings", "view"), async (_req, res) => {
  const [row] = await db.select().from(orgProfile).limit(1);
  res.json(row ?? null);
});

settingsRouter.patch(
  "/org",
  requirePermission("settings", "edit"),
  validateBody(orgSchema.partial()),
  async (req, res) => {
    const patch = { ...req.body, updatedAt: new Date() };
    const [existing] = await db.select({ id: orgProfile.id }).from(orgProfile).limit(1);
    const [row] = existing
      ? await db.update(orgProfile).set(patch).where(eq(orgProfile.id, existing.id)).returning()
      : await db.insert(orgProfile).values({ id: "default", name: "", ...patch }).returning();
    res.json(row);
  },
);

// ---------- Document series ----------

/** Every named series with its per-module numbering, shaped for Zoho's grid. */
settingsRouter.get("/series", requirePermission("settings", "view"), async (_req, res) => {
  const [series, rows] = await Promise.all([
    db.select().from(numberSeries).orderBy(desc(numberSeries.isDefault), asc(numberSeries.name)),
    db.select().from(documentSeries).orderBy(asc(documentSeries.entity)),
  ]);
  const byId = new Map(series.map((s) => [s.id, [] as typeof rows]));
  for (const r of rows) byId.get(r.seriesId)?.push(r);
  res.json(series.map((s) => ({ ...s, entities: byId.get(s.id) ?? [] })));
});

/** The document types a series must define numbering for. */
const SERIES_ENTITIES = NUMBERED_ENTITIES;

/** Prefix a new series uses for each module before the user edits it. */
const DEFAULT_PREFIX: Record<string, string> = {
  invoice: "INV-", credit_note: "CN-", customer_payment: "CP-",
  bill: "BILL-", purchase_order: "PO-", vendor_credit: "VCN-",
  vendor_payment: "VP-", expense: "EXP-", journal_entry: "JE-",
  fixed_asset: "FA-", inventory_adjustment: "IA-", attachment: "DOC-",
};

const newSeriesSchema = z.object({
  name: nonBlank(60),
  /** Inserted between each module's prefix and its number, e.g. "EG-" → "A-INV-EG-". */
  prefixTag: z.string().max(12).optional(),
});

settingsRouter.post(
  "/series",
  requirePermission("settings", "create"),
  validateBody(newSeriesSchema),
  async (req, res) => {
    const body = req.body as z.infer<typeof newSeriesSchema>;
    const created = await db.transaction(async (tx) => {
      const [series] = await tx.insert(numberSeries).values({ name: body.name }).returning();
      await tx.insert(documentSeries).values(
        SERIES_ENTITIES.map((entity) => ({
          seriesId: series!.id,
          entity,
          prefix: `${DEFAULT_PREFIX[entity]}${body.prefixTag ?? ""}`,
        })),
      );
      return series!;
    });
    res.status(201).json(created);
  },
);

settingsRouter.patch(
  "/series-group/:id",
  requirePermission("settings", "edit"),
  validateBody(
    z.object({
      name: nonBlank(60).optional(),
      isActive: z.boolean().optional(),
      isDefault: z.boolean().optional(),
    }),
  ),
  async (req, res) => {
    const body = req.body as { name?: string; isActive?: boolean; isDefault?: boolean };
    const row = await db.transaction(async (tx) => {
      // Exactly one series is the default, so promoting one demotes the rest.
      if (body.isDefault) {
        await tx.update(numberSeries).set({ isDefault: false });
      }
      const [updated] = await tx
        .update(numberSeries)
        .set(body)
        .where(eq(numberSeries.id, req.params.id!))
        .returning();
      return updated;
    });
    if (!row) return res.status(404).json({ error: "Series not found" });
    res.json(row);
  },
);

settingsRouter.delete(
  "/series-group/:id",
  requirePermission("settings", "delete"),
  async (req, res) => {
    const [series] = await db
      .select()
      .from(numberSeries)
      .where(eq(numberSeries.id, req.params.id!))
      .limit(1);
    if (!series) return res.status(404).json({ error: "Series not found" });
    if (series.isDefault) {
      return res.status(422).json({ error: "The default series cannot be deleted" });
    }
    await db.delete(numberSeries).where(eq(numberSeries.id, series.id));
    res.json({ ok: true });
  },
);

settingsRouter.patch(
  "/series/:id",
  requirePermission("settings", "edit"),
  validateBody(
    z.object({
      prefix: z.string().min(1).max(20).optional(),
      padding: z.number().int().min(1).max(10).optional(),
    }),
  ),
  async (req, res) => {
    const [row] = await db
      .update(documentSeries)
      .set(req.body)
      .where(eq(documentSeries.id, req.params.id!))
      .returning();
    if (!row) return res.status(404).json({ error: "Series not found" });
    res.json(row);
  },
);

// ---------- Financial years / transaction locking ----------

settingsRouter.get("/financial-years", requirePermission("settings", "view"), async (_req, res) => {
  const rows = await db.select().from(financialYears).orderBy(asc(financialYears.startDate));
  res.json(rows);
});

settingsRouter.post(
  "/financial-years",
  requirePermission("settings", "create"),
  validateBody(
    z.object({
      name: nonBlank(),
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }),
  ),
  async (req, res) => {
    const { startDate, endDate } = req.body as { startDate: string; endDate: string };
    if (endDate <= startDate) {
      return res.status(422).json({ error: "The end date must be after the start date" });
    }
    // A year that shares even one day with an existing one would double-count
    // that day's postings in whichever report groups by financial year.
    const existing = await db.select().from(financialYears);
    const overlaps = existing.find((y) => startDate <= y.endDate && endDate >= y.startDate);
    if (overlaps) {
      return res.status(422).json({
        error: `Overlaps ${overlaps.name} (${overlaps.startDate} to ${overlaps.endDate})`,
      });
    }
    const [row] = await db.insert(financialYears).values(req.body).returning();
    res.status(201).json(row);
  },
);

settingsRouter.patch(
  "/financial-years/:id",
  requirePermission("settings", "edit"),
  validateBody(
    z.object({
      isActive: z.boolean().optional(),
      lockedThrough: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    }),
  ),
  async (req, res) => {
    const body = req.body as { isActive?: boolean; lockedThrough?: string | null };
    if (body.lockedThrough) {
      const [year] = await db
        .select()
        .from(financialYears)
        .where(eq(financialYears.id, req.params.id!));
      if (!year) return res.status(404).json({ error: "Financial year not found" });
      if (body.lockedThrough < year.startDate) {
        return res.status(422).json({ error: "The lock date is before this year even starts" });
      }
    }
    const [row] = await db
      .update(financialYears)
      .set(body)
      .where(eq(financialYears.id, req.params.id!))
      .returning();
    if (!row) return res.status(404).json({ error: "Financial year not found" });
    res.json(row);
  },
);

// ---------- Opening balances ----------

settingsRouter.get(
  "/opening-balances",
  requirePermission("settings", "view"),
  async (_req, res) => {
    res.json(await getOpeningBalances(db));
  },
);

const openingSchema = z.object({
  migrationDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  lines: z
    .array(
      z.object({
        accountId: z.string().uuid(),
        debit: z.string().regex(/^\d+(\.\d{1,2})?$/).default("0"),
        credit: z.string().regex(/^\d+(\.\d{1,2})?$/).default("0"),
      }),
    )
    .max(500),
});

settingsRouter.put(
  "/opening-balances",
  requirePermission("settings", "edit"),
  validateBody(openingSchema),
  async (req, res) => {
    const body = req.body as z.infer<typeof openingSchema>;
    try {
      const result = await db.transaction((tx) =>
        saveOpeningBalances(tx, {
          migrationDate: body.migrationDate,
          lines: body.lines,
          postedBy: req.session.user!.id,
        }),
      );
      res.json(result);
    } catch (err) {
      if (err instanceof PostingError) return res.status(422).json({ error: err.message });
      throw err;
    }
  },
);

// ---------- Preferences ----------

settingsRouter.get("/preferences", requirePermission("settings", "view"), async (_req, res) => {
  res.json(await getPreferences(db));
});

const preferencesSchema = z.object({
  discountLevel: z.enum(["none", "line", "transaction"]).optional(),
  discountBeforeTax: z.boolean().optional(),
  enableAdjustment: z.boolean().optional(),
  enableShippingCharge: z.boolean().optional(),
  taxTreatment: z.enum(["exclusive", "inclusive", "both"]).optional(),
  roundingMode: z.enum(["none", "whole", "increment"]).optional(),
  roundingIncrement: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
  quantityDecimals: z.number().int().min(0).max(4).optional(),
  allowDuplicateItemNames: z.boolean().optional(),
  preventNegativeStock: z.boolean().optional(),
  showOutOfStockWarning: z.boolean().optional(),
  notifyOnReorderLevel: z.boolean().optional(),
  allowDuplicateContactNames: z.boolean().optional(),
  defaultCustomerType: z.enum(["business", "individual"]).optional(),
  enableCreditLimit: z.boolean().optional(),
  allowEditingSentInvoice: z.boolean().optional(),
  hideZeroValueLines: z.boolean().optional(),
  defaultInvoiceTerms: z.string().max(2000).nullable().optional(),
  defaultInvoiceNotes: z.string().max(2000).nullable().optional(),
  /**
   * Capped at 10%: past that the figure stops being weighbridge slack and
   * becomes an order nobody is really controlling.
   */
  poOverDeliveryPct: z
    .string()
    .regex(/^\d+(\.\d{1,3})?$/)
    .refine((v) => Number(v) <= 10, "An over-delivery allowance above 10% is not a control")
    .optional(),
});

settingsRouter.patch(
  "/preferences",
  requirePermission("settings", "edit"),
  validateBody(preferencesSchema),
  async (req, res) => {
    const patch = { ...req.body, updatedAt: new Date() };
    const [existing] = await db.select({ id: preferences.id }).from(preferences).limit(1);
    const [row] = existing
      ? await db
          .update(preferences)
          .set(patch)
          .where(eq(preferences.id, existing.id))
          .returning()
      : await db
          .insert(preferences)
          .values({ id: "default", ...patch })
          .returning();
    res.json(row);
  },
);
