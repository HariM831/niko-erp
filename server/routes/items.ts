import { Router } from "express";
import { and, asc, desc, eq, getTableColumns, ilike, or } from "drizzle-orm";
import { z } from "zod";
import {
  attachments,
  billLines,
  bills,
  contacts,
  invoiceLines,
  invoices,
  items,
  itemType,
  purchaseOrderLines,
  purchaseOrders,
  taxes,
} from "@shared/schema";
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
  preferredVendorId: z.string().uuid().optional(),
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
    .select({ ...getTableColumns(items), preferredVendorName: contacts.displayName })
    .from(items)
    .leftJoin(contacts, eq(contacts.id, items.preferredVendorId))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(asc(items.name))
    .limit(500);

  // Latest image attachment per item, used as the list thumbnail.
  const images = await db
    .select({ entityId: attachments.entityId, id: attachments.id })
    .from(attachments)
    .where(and(eq(attachments.entityType, "item"), ilike(attachments.mimeType, "image/%")))
    .orderBy(asc(attachments.createdAt));
  const imageByItem = new Map(images.map((a) => [a.entityId, a.id]));
  res.json(rows.map((r) => ({ ...r, imageId: imageByItem.get(r.id) ?? null })));
});

itemsRouter.get("/:id", requirePermission("items", "view"), async (req, res) => {
  const item = await db.query.items.findFirst({ where: eq(items.id, req.params.id!) });
  if (!item) return res.status(404).json({ error: "Item not found" });
  const vendor = item.preferredVendorId
    ? await db.query.contacts.findFirst({ where: eq(contacts.id, item.preferredVendorId) })
    : null;
  res.json({ ...item, preferredVendorName: vendor?.displayName ?? null });
});

/** Every transaction line referencing this item, newest first — the Transactions tab. */
itemsRouter.get("/:id/transactions", requirePermission("items", "view"), async (req, res) => {
  const id = req.params.id!;
  const [inv, billRows, po] = await Promise.all([
    db
      .select({
        id: invoices.id,
        number: invoices.number,
        date: invoices.invoiceDate,
        status: invoices.status,
        contactName: contacts.displayName,
        quantity: invoiceLines.quantity,
        amount: invoiceLines.amount,
      })
      .from(invoiceLines)
      .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
      .innerJoin(contacts, eq(contacts.id, invoices.customerId))
      .where(eq(invoiceLines.itemId, id))
      .orderBy(desc(invoices.invoiceDate)),
    db
      .select({
        id: bills.id,
        number: bills.number,
        date: bills.billDate,
        status: bills.status,
        contactName: contacts.displayName,
        quantity: billLines.quantity,
        amount: billLines.amount,
      })
      .from(billLines)
      .innerJoin(bills, eq(bills.id, billLines.billId))
      .innerJoin(contacts, eq(contacts.id, bills.vendorId))
      .where(eq(billLines.itemId, id))
      .orderBy(desc(bills.billDate)),
    db
      .select({
        id: purchaseOrders.id,
        number: purchaseOrders.number,
        date: purchaseOrders.orderDate,
        status: purchaseOrders.status,
        contactName: contacts.displayName,
        quantity: purchaseOrderLines.quantity,
        amount: purchaseOrderLines.amount,
      })
      .from(purchaseOrderLines)
      .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderLines.purchaseOrderId))
      .innerJoin(contacts, eq(contacts.id, purchaseOrders.vendorId))
      .where(eq(purchaseOrderLines.itemId, id))
      .orderBy(desc(purchaseOrders.orderDate)),
  ]);

  res.json({
    invoices: inv,
    bills: billRows,
    purchaseOrders: po,
  });
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
