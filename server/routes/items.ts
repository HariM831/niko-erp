import { Router } from "express";
import { and, asc, desc, eq, getTableColumns, ilike, isNull, or } from "drizzle-orm";
import { z } from "zod";
import {
  attachments,
  itemCategory,
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
import { contains } from "../services/document-search";
import { validateBody } from "../lib/validate";
import { getPreferences } from "../services/preferences";
import { findNameHolder, mergeItems } from "../services/item-names";
import { PostingError } from "../services/posting";

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
  isFeedIngredient: z.boolean().optional(),
  category: z.enum(itemCategory.enumValues).nullish(),
  /**
   * What this material is called elsewhere — on a vendor's bill, in the mill's
   * old system. Office's bill matching and the feed-mill import both
   * resolve names through these, so "GN De-Oiled-Cake 50%" on an invoice can
   * land on DOGN without a person retyping it.
   */
  aliases: z.array(z.string().min(1).max(80)).max(12).optional(),
  /** "Yes, this near-name is genuinely a different material." */
  confirmNotDuplicate: z.boolean().optional(),
  taxId: z.string().uuid().optional(),
  trackInventory: z.boolean().optional(),
  inventoryAccountId: z.string().uuid().optional(),
  openingStock: quantity.optional(),
  openingStockRate: money.optional(),
  reorderLevel: quantity.optional(),
});

itemsRouter.get("/", requirePermission("items", "view"), async (req, res) => {
  const { search, isActive, category } = req.query as Record<string, string | undefined>;
  const conditions = [];
  if (isActive !== undefined) conditions.push(eq(items.isActive, isActive === "true"));
  if (category === "none") conditions.push(isNull(items.category));
  else if (category && (itemCategory.enumValues as readonly string[]).includes(category)) {
    conditions.push(eq(items.category, category as (typeof itemCategory.enumValues)[number]));
  }
  if (search) {
    // Escaped, so "50%" searches for that text instead of matching everything.
    const term = contains(search);
    conditions.push(or(ilike(items.name, term), ilike(items.sku, term)));
  }
  const asked = Number((req.query as Record<string, string | undefined>).limit);
  const rows = await db
    .select({ ...getTableColumns(items), preferredVendorName: contacts.displayName })
    .from(items)
    .leftJoin(contacts, eq(contacts.id, items.preferredVendorId))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(asc(items.name))
    .limit(Number.isFinite(asked) && asked > 0 ? asked : 500);

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
    // Uniqueness is enforced here rather than by an index, because whether
    // duplicates are allowed is an org preference. The check reads names AND
    // aliases, normalised — "De-oiled rice bran" against an item whose alias
    // is "DORB" is how the master grew twins in the first place.
    const prefs = await getPreferences(db);
    if (!prefs.allowDuplicateItemNames) {
      const holder = await findNameHolder(db, req.body.name);
      if (holder && holder.match === "exact") {
        return res.status(422).json({
          error: holder.viaAlias
            ? `"${req.body.name}" is already an alias of "${holder.name}" — bill lines with this wording land there`
            : `An item named "${holder.name}" already exists`,
        });
      }
      // A near-name can be a twin or a genuinely different material — only a
      // person knows which, so the refusal is overridable with intent.
      if (holder && holder.match === "contains" && !req.body.confirmNotDuplicate) {
        return res.status(422).json({
          error: `"${req.body.name}" looks like "${holder.name}" — if it is the same material, use that item or add this wording as its alias. If it is genuinely different, confirm and create.`,
          similarTo: { id: holder.id, name: holder.name },
          requiresConfirmation: true,
        });
      }
    }
    const body = req.body as z.infer<typeof itemSchema>;
    // Not a column — consumed by the guard above, kept out of the insert.
    delete (body as Record<string, unknown>).confirmNotDuplicate;
    // Only Produce is sold — eggs, birds, manure. Everything else the org buys
    // to use, so a selling price on cement is a typo waiting to be invoiced.
    if (body.category !== "produce") {
      body.isSold = false;
      body.sellingPrice = undefined;
      body.salesAccountId = undefined;
      body.salesDescription = undefined;
    }
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
    const patch = { ...req.body } as Record<string, unknown>;
    // The clamp reads the category the item will END UP with, so recategorising
    // away from Produce strips its sale terms in the same edit.
    const current = await db.query.items.findFirst({ where: eq(items.id, req.params.id!) });
    if (!current) return res.status(404).json({ error: "Item not found" });
    const finalCategory = "category" in patch ? patch.category : current.category;
    if (finalCategory !== "produce") {
      patch.isSold = false;
      patch.sellingPrice = null;
      patch.salesAccountId = null;
      patch.salesDescription = null;
    }
    const [row] = await db
      .update(items)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(items.id, req.params.id!))
      .returning();
    if (!row) return res.status(404).json({ error: "Item not found" });
    res.json(row);
  },
);

/**
 * Fold a duplicate into its survivor: recipes repointed, missing analysis
 * copied, every name kept as an alias, the duplicate retired. Posted documents
 * stay where they were posted — only the future consolidates. Refusals (both
 * items in one formula, source is a formula's output, source still holds
 * stock) come back 422 with the reason.
 */
itemsRouter.post(
  "/:id/merge",
  requirePermission("items", "delete"),
  validateBody(z.object({ targetId: z.string().uuid() })),
  async (req, res) => {
    try {
      const summary = await db.transaction((tx) => mergeItems(tx, req.params.id!, req.body.targetId));
      res.json(summary);
    } catch (e) {
      if (e instanceof PostingError) return res.status(422).json({ error: e.message });
      throw e;
    }
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
