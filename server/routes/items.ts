import { Router } from "express";
import { and, asc, eq, ilike, or } from "drizzle-orm";
import { z } from "zod";
import { items, itemType, taxes } from "@shared/schema";
import { db } from "../db";
import { requirePermission } from "../lib/rbac";
import { validateBody } from "../lib/validate";

export const itemsRouter = Router();

const money = z.string().regex(/^\d+(\.\d{1,2})?$/);
const quantity = z.string().regex(/^\d+(\.\d{1,3})?$/);

const itemSchema = z.object({
  type: z.enum(itemType.enumValues).optional(),
  name: z.string().min(1),
  sku: z.string().max(60).optional(),
  unit: z.string().max(20).optional(),
  hsnOrSac: z.string().max(10).optional(),
  description: z.string().optional(),
  isSold: z.boolean().optional(),
  sellingPrice: money.optional(),
  salesAccountId: z.string().uuid().optional(),
  salesDescription: z.string().optional(),
  isPurchased: z.boolean().optional(),
  costPrice: money.optional(),
  purchaseAccountId: z.string().uuid().optional(),
  purchaseDescription: z.string().optional(),
  taxId: z.string().uuid().optional(),
  trackInventory: z.boolean().optional(),
  inventoryAccountId: z.string().uuid().optional(),
  openingStock: quantity.optional(),
  openingStockRate: money.optional(),
  reorderLevel: quantity.optional(),
});

itemsRouter.get("/", requirePermission("items", "view"), async (req, res) => {
  const { search, isActive } = req.query as Record<string, string | undefined>;
  const conditions = [];
  if (isActive !== undefined) conditions.push(eq(items.isActive, isActive === "true"));
  if (search) {
    conditions.push(
      or(ilike(items.name, `%${search}%`), ilike(items.sku, `%${search}%`)),
    );
  }
  const rows = await db
    .select()
    .from(items)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(asc(items.name))
    .limit(500);
  res.json(rows);
});

itemsRouter.get("/:id", requirePermission("items", "view"), async (req, res) => {
  const item = await db.query.items.findFirst({ where: eq(items.id, req.params.id!) });
  if (!item) return res.status(404).json({ error: "Item not found" });
  res.json(item);
});

itemsRouter.post(
  "/",
  requirePermission("items", "create"),
  validateBody(itemSchema),
  async (req, res) => {
    const body = req.body as z.infer<typeof itemSchema>;
    if (body.trackInventory && !body.inventoryAccountId) {
      return res
        .status(422)
        .json({ error: "Inventory-tracked items need an inventory account" });
    }
    const [row] = await db.insert(items).values(body).returning();
    res.status(201).json(row);
  },
);

itemsRouter.patch(
  "/:id",
  requirePermission("items", "edit"),
  validateBody(itemSchema.partial().extend({ isActive: z.boolean().optional() })),
  async (req, res) => {
    const [row] = await db
      .update(items)
      .set({ ...req.body, updatedAt: new Date() })
      .where(eq(items.id, req.params.id!))
      .returning();
    if (!row) return res.status(404).json({ error: "Item not found" });
    res.json(row);
  },
);

itemsRouter.delete("/:id", requirePermission("items", "delete"), async (req, res) => {
  const [row] = await db
    .update(items)
    .set({ isActive: false, updatedAt: new Date() })
    .where(eq(items.id, req.params.id!))
    .returning({ id: items.id });
  if (!row) return res.status(404).json({ error: "Item not found" });
  res.json({ ok: true });
});

// ---------- Taxes ----------

export const taxesRouter = Router();

const taxSchema = z.object({
  name: z.string().min(1),
  rate: z.string().regex(/^\d+(\.\d{1,3})?$/),
  isGstGroup: z.boolean().optional(),
});

taxesRouter.get("/", requirePermission("items", "view"), async (_req, res) => {
  const rows = await db.select().from(taxes).orderBy(asc(taxes.rate));
  res.json(rows);
});

taxesRouter.post(
  "/",
  requirePermission("items", "create"),
  validateBody(taxSchema),
  async (req, res) => {
    const [row] = await db.insert(taxes).values(req.body).returning();
    res.status(201).json(row);
  },
);

taxesRouter.patch(
  "/:id",
  requirePermission("items", "edit"),
  validateBody(taxSchema.partial().extend({ isActive: z.boolean().optional() })),
  async (req, res) => {
    const [row] = await db
      .update(taxes)
      .set(req.body)
      .where(eq(taxes.id, req.params.id!))
      .returning();
    if (!row) return res.status(404).json({ error: "Tax not found" });
    res.json(row);
  },
);
