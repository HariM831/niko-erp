import { Router } from "express";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { documentSeries, financialYears, orgProfile } from "@shared/schema";
import { db } from "../db";
import { requirePermission } from "../lib/rbac";
import { validateBody } from "../lib/validate";

export const settingsRouter = Router();

// ---------- Organisation profile ----------

const orgSchema = z.object({
  name: z.string().min(1),
  legalName: z.string().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  stateCode: z.string().max(4).optional(),
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

settingsRouter.get("/series", requirePermission("settings", "view"), async (_req, res) => {
  const rows = await db.select().from(documentSeries).orderBy(asc(documentSeries.entity));
  res.json(rows);
});

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
      name: z.string().min(1),
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }),
  ),
  async (req, res) => {
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
    const [row] = await db
      .update(financialYears)
      .set(req.body)
      .where(eq(financialYears.id, req.params.id!))
      .returning();
    if (!row) return res.status(404).json({ error: "Financial year not found" });
    res.json(row);
  },
);
