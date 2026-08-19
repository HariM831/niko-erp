import { Router } from "express";
import { asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  accounts,
  inventoryAdjustmentLines,
  inventoryAdjustments,
  inventoryTransactions,
  items,
} from "@shared/schema";
import { db } from "../db";
import { getPreferences } from "../services/preferences";
import { requirePermission } from "../lib/rbac";
import { validateBody } from "../lib/validate";
import { nextDocumentNumber } from "../lib/numbering";
import { PostingError, reverseJournal } from "../services/posting";
import {
  postInventoryMovement,
  stockLedger,
  reverseStock,
  stockOnHand,
} from "../services/inventory";

export const inventoryRouter = Router();

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const signedMoney = z.string().regex(/^-?\d+(\.\d{1,2})?$/);
const signedQty = z.string().regex(/^-?\d+(\.\d{1,3})?$/);

const adjustmentSchema = z.object({
  seriesId: z.string().uuid().optional(),
  adjustmentDate: dateStr,
  mode: z.enum(["quantity", "value"]).default("quantity"),
  reason: z.string().min(1),
  description: z.string().optional(),
  adjustmentAccountId: z.string().uuid(),
  lines: z
    .array(
      z.object({
        itemId: z.string().uuid(),
        quantityChange: signedQty.optional(),
        valueChange: signedMoney.optional(),
        notes: z.string().optional(),
      }),
    )
    .min(1)
    .max(200),
});

function handlePostingError(err: unknown, res: Parameters<Parameters<Router["post"]>[1]>[1]) {
  if (err instanceof PostingError) {
    res.status(422).json({ error: err.message });
    return true;
  }
  return false;
}

inventoryRouter.get("/stock", requirePermission("items", "view"), async (_req, res) => {
  res.json(await stockOnHand(db));
});

/**
 * Stock for a window: what moved, and where it left us.
 *
 * Dates are required rather than defaulted here — a report that silently picks
 * its own period is one nobody can quote. The screen defaults to today and
 * says so.
 */
inventoryRouter.get("/stock/period", requirePermission("items", "view"), async (req, res) => {
  const q = req.query as Record<string, string | undefined>;
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  const to = q.to && iso.test(q.to) ? q.to : new Date().toISOString().slice(0, 10);
  const from = q.from && iso.test(q.from) ? q.from : to;
  if (from > to) return res.status(422).json({ error: "The period starts after it ends" });
  res.json(await stockLedger(db, { from, to, category: q.category || undefined }));
});

inventoryRouter.get(
  "/stock/:itemId",
  requirePermission("items", "view"),
  async (req, res) => {
    const [level] = await stockOnHand(db, req.params.itemId!);
    if (!level) {
      return res.status(404).json({ error: "Item not found or not inventory-tracked" });
    }
    const ledger = await db
      .select()
      .from(inventoryTransactions)
      .where(eq(inventoryTransactions.itemId, req.params.itemId!))
      .orderBy(desc(inventoryTransactions.transactionDate));
    res.json({ ...level, ledger });
  },
);

inventoryRouter.get("/adjustments", requirePermission("items", "view"), async (_req, res) => {
  const rows = await db
    .select({
      id: inventoryAdjustments.id,
      number: inventoryAdjustments.number,
      adjustmentDate: inventoryAdjustments.adjustmentDate,
      mode: inventoryAdjustments.mode,
      reason: inventoryAdjustments.reason,
      isVoid: inventoryAdjustments.isVoid,
      accountName: accounts.name,
    })
    .from(inventoryAdjustments)
    .leftJoin(accounts, eq(accounts.id, inventoryAdjustments.adjustmentAccountId))
    .orderBy(desc(inventoryAdjustments.adjustmentDate));
  res.json(rows.map((r) => ({ ...r, status: r.isVoid ? "void" : "adjusted" })));
});

inventoryRouter.get(
  "/adjustments/:id",
  requirePermission("items", "view"),
  async (req, res) => {
    const adj = await db.query.inventoryAdjustments.findFirst({
      where: eq(inventoryAdjustments.id, req.params.id!),
    });
    if (!adj) return res.status(404).json({ error: "Adjustment not found" });
    const lines = await db
      .select({
        id: inventoryAdjustmentLines.id,
        itemId: inventoryAdjustmentLines.itemId,
        itemName: items.name,
        unit: items.unit,
        quantityChange: inventoryAdjustmentLines.quantityChange,
        valueChange: inventoryAdjustmentLines.valueChange,
        notes: inventoryAdjustmentLines.notes,
      })
      .from(inventoryAdjustmentLines)
      .innerJoin(items, eq(items.id, inventoryAdjustmentLines.itemId))
      .where(eq(inventoryAdjustmentLines.adjustmentId, adj.id))
      .orderBy(asc(inventoryAdjustmentLines.lineOrder));
    const [account] = await db
      .select({ code: accounts.code, name: accounts.name })
      .from(accounts)
      .where(eq(accounts.id, adj.adjustmentAccountId));
    res.json({ ...adj, status: adj.isVoid ? "void" : "adjusted", account, lines });
  },
);

inventoryRouter.post(
  "/adjustments",
  requirePermission("items", "create"),
  validateBody(adjustmentSchema),
  async (req, res) => {
    const body = req.body as z.infer<typeof adjustmentSchema>;
    try {
      const result = await db.transaction(async (tx) => {
        const lines = body.lines.map((l, i) => ({
          itemId: l.itemId,
          quantityChange: body.mode === "value" ? "0" : (l.quantityChange ?? "0"),
          valueChange: l.valueChange ?? "0",
          notes: l.notes,
          lineOrder: i,
        }));

        if (lines.every((l) => Number(l.quantityChange) === 0 && Number(l.valueChange) === 0)) {
          throw new PostingError("Every line is zero — nothing to adjust");
        }

        const prefs = await getPreferences(tx);
        const movements = lines
          .filter((l) => Number(l.quantityChange) !== 0 || Number(l.valueChange) !== 0)
          .map((l) => ({
            itemId: l.itemId,
            quantity: l.quantityChange,
            value: l.valueChange,
            notes: l.notes,
          }));
        const number = await nextDocumentNumber(tx, "inventory_adjustment", body.seriesId);
        const [adj] = await tx
          .insert(inventoryAdjustments)
          .values({
            number,
            adjustmentDate: body.adjustmentDate,
            mode: body.mode,
            reason: body.reason,
            description: body.description,
            adjustmentAccountId: body.adjustmentAccountId,
            createdBy: req.session.user!.id,
          })
          .returning();

        await tx
          .insert(inventoryAdjustmentLines)
          .values(lines.map((l) => ({ ...l, adjustmentId: adj!.id })));

        const journalEntryId = await postInventoryMovement(tx, {
          movements,
          transactionDate: body.adjustmentDate,
          sourceType: "inventory_adjustment",
          sourceId: adj!.id,
          contraAccountId: body.adjustmentAccountId,
          narration: `Inventory adjustment ${number} — ${body.reason}`,
          postedBy: req.session.user!.id,
          preventNegative: prefs.preventNegativeStock,
        });
        if (journalEntryId) {
          await tx
            .update(inventoryAdjustments)
            .set({ journalEntryId })
            .where(eq(inventoryAdjustments.id, adj!.id));
        }

        return { ...adj!, journalEntryId };
      });
      res.status(201).json(result);
    } catch (err) {
      if (!handlePostingError(err, res)) throw err;
    }
  },
);

inventoryRouter.post(
  "/adjustments/:id/void",
  requirePermission("items", "delete"),
  validateBody(z.object({ voidDate: dateStr })),
  async (req, res) => {
    try {
      const result = await db.transaction(async (tx) => {
        const adj = await tx.query.inventoryAdjustments.findFirst({
          where: eq(inventoryAdjustments.id, req.params.id!),
        });
        if (!adj) throw new PostingError("Adjustment not found");
        if (adj.isVoid) throw new PostingError("Adjustment is already void");

        await reverseStock(tx, {
          sourceType: "inventory_adjustment",
          sourceId: adj.id,
          transactionDate: req.body.voidDate,
        });
        if (adj.journalEntryId) {
          await reverseJournal(tx, adj.journalEntryId, req.body.voidDate, req.session.user!.id);
        }
        const [updated] = await tx
          .update(inventoryAdjustments)
          .set({ isVoid: true })
          .where(eq(inventoryAdjustments.id, adj.id))
          .returning();
        return updated!;
      });
      res.json(result);
    } catch (err) {
      if (!handlePostingError(err, res)) throw err;
    }
  },
);
