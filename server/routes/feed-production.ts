/**
 * Production and feed transfers — one step each, the way the mill actually runs.
 *
 * PRODUCE: a formula and a batch count. The tonnage — batches × the formula's
 * batch size — is in stock the moment the button is hit, costed at material
 * prices plus the per-kg overhead. There is no slip and no pending state; the
 * slip was Amino's system and it is retired. A mistake is handled by VOIDING
 * the production, which reverses the journal and withdraws the stock — a
 * correction on the record, not a draft stage in front of every real run.
 *
 * TRANSFER: a formula's feed, a house, x tons. Consumption, not relocation —
 * the house holds no stock, so the kilos leave inventory and the cost lands on
 * feed expense the moment they arrive.
 *
 * The books, all periodic, all pivoting on the account the bills landed in
 * (5007 Feed & Additives):
 *
 *   purchases    Dr 5007                       (procurement settlement)
 *   produce      Dr 1073 Feed Stock, Cr 5007   (batch cost capitalised)
 *   transfer     Dr 5007, Cr 1073              (consumed at the house)
 *
 * Net: 5007 carries the cost of feed actually fed, Feed Stock the unfed
 * remainder, and raw materials stay periodic — procurement moves no stock.
 */
import { Router } from "express";
import { asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  accounts,
  feedTransfers,
  formulaLines,
  formulas,
  items,
  locations,
  productionOrderLines,
  productionOrders,
} from "@shared/schema";
import { db, type Tx } from "../db";
import { requirePermission } from "../lib/rbac";
import { validateBody } from "../lib/validate";
import { nextDocumentNumber } from "../lib/numbering";
import { PostingError, assertPeriodOpen, reverseJournal } from "../services/posting";
import { moveStock, postInventoryMovement, stockOnHand } from "../services/inventory";
import { getPreferences } from "../services/preferences";

export const feedProductionRouter = Router();

const qtyStr = z.string().regex(/^\d+(\.\d{1,3})?$/, "Enter a quantity");
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * The expense account the whole cycle pivots on. Resolved by code because the
 * chart came from Zoho with no system keys; if 5007 is ever renumbered this is
 * the one place that knows.
 */
async function feedExpenseAccount(tx: Tx) {
  const [row] = await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.code, "5007"));
  if (!row) throw new PostingError("Account 5007 (Feed & Additives) is missing from the chart");
  return row.id;
}

/** The mill. One-location org today, so it resolves silently. */
async function millLocation(tx: Tx): Promise<string> {
  const primary = await tx.query.locations.findFirst({ where: eq(locations.isPrimary, true) });
  const any = primary ?? (await tx.query.locations.findFirst());
  if (!any) throw new PostingError("No location exists to produce at");
  return any.id;
}

function fail(err: unknown, res: { status: (n: number) => { json: (b: unknown) => unknown } }) {
  if (err instanceof PostingError) {
    res.status(422).json({ error: err.message });
    return true;
  }
  return false;
}

// ───────────────────────────── Production ─────────────────────────────

feedProductionRouter.get("/orders", requirePermission("feed_mill", "view"), async (_req, res) => {
  const orders = await db
    .select({
      id: productionOrders.id,
      number: productionOrders.number,
      status: productionOrders.status,
      orderDate: productionOrders.orderDate,
      batchCount: productionOrders.batchCount,
      outputKg: productionOrders.actualOutputKg,
      inputValue: productionOrders.inputValue,
      overheadValue: productionOrders.overheadValue,
      costPerKg: productionOrders.costPerKg,
      voidReason: productionOrders.voidReason,
      formulaName: formulas.name,
      formulaVersion: formulas.version,
      locationName: locations.name,
    })
    .from(productionOrders)
    .innerJoin(formulas, eq(formulas.id, productionOrders.formulaId))
    .leftJoin(locations, eq(locations.id, productionOrders.locationId))
    .orderBy(desc(productionOrders.orderDate), desc(productionOrders.createdAt))
    .limit(100);
  res.json(orders);
});

feedProductionRouter.get("/orders/:id", requirePermission("feed_mill", "view"), async (req, res) => {
  const order = await db.query.productionOrders.findFirst({
    where: eq(productionOrders.id, req.params.id!),
  });
  if (!order) return res.status(404).json({ error: "Production not found" });
  const lines = await db
    .select({
      itemName: items.name,
      quantityKg: productionOrderLines.actualKg,
      ratePerKg: productionOrderLines.ratePerKg,
      value: productionOrderLines.value,
    })
    .from(productionOrderLines)
    .innerJoin(items, eq(items.id, productionOrderLines.itemId))
    .where(eq(productionOrderLines.orderId, order.id))
    .orderBy(asc(productionOrderLines.sortOrder));
  res.json({ ...order, lines });
});

/**
 * Produce. One call: the formula scaled by batches goes into the record, the
 * finished feed goes into stock, the journal posts, done.
 *
 * Every ingredient needs a price — the batch cost is real money the moment it
 * capitalises, and a zero-priced line would silently make feed cheaper than it
 * is. Refused by name, before anything moves.
 */
feedProductionRouter.post(
  "/produce",
  requirePermission("feed_mill", "produce"),
  validateBody(
    z.object({
      formulaId: z.string().uuid(),
      batchCount: z.number().int().min(1).max(100),
      orderDate: dateStr,
      locationId: z.string().uuid().optional(),
      notes: z.string().max(2000).nullish(),
    }),
  ),
  async (req, res) => {
    const body = req.body as {
      formulaId: string;
      batchCount: number;
      orderDate: string;
      locationId?: string;
      notes?: string | null;
    };
    try {
      const out = await db.transaction(async (tx) => {
        await assertPeriodOpen(tx, body.orderDate, "inventory_adjustment");
        const formula = await tx.query.formulas.findFirst({ where: eq(formulas.id, body.formulaId) });
        if (!formula) throw new PostingError("Formula not found");
        if (!formula.isActive) {
          throw new PostingError(`${formula.name} v${formula.version} is retired — produce the live version`);
        }
        const recipe = await tx
          .select({ line: formulaLines, itemName: items.name, costPrice: items.costPrice })
          .from(formulaLines)
          .innerJoin(items, eq(items.id, formulaLines.itemId))
          .where(eq(formulaLines.formulaId, formula.id))
          .orderBy(asc(formulaLines.sortOrder));
        if (!recipe.length) throw new PostingError("The formula has no ingredient lines");

        const unpriced = recipe.filter((r) => !(Number(r.costPrice ?? 0) > 0));
        if (unpriced.length) {
          throw new PostingError(
            `${unpriced.map((u) => u.itemName).join(", ")} ${unpriced.length === 1 ? "has" : "have"} no cost price — a batch cannot be costed without one`,
          );
        }

        const locationId = body.locationId ?? (await millLocation(tx));
        const outputKg = Number(formula.batchSizeKg) * body.batchCount;
        let inputValueP = 0;
        const lineValues = recipe.map((r) => {
          const kgTotal = Number(r.line.quantityKg) * body.batchCount;
          const rate = Number(r.costPrice);
          const valueP = Math.round(kgTotal * rate * 100);
          inputValueP += valueP;
          return { r, kgTotal, rate, valueP };
        });
        const prefs = await getPreferences(tx);
        const overheadP = Math.round(outputKg * Number(prefs.millOverheadPerKg) * 100);
        const totalP = inputValueP + overheadP;
        const costPerKg = totalP / 100 / outputKg;

        const number = await nextDocumentNumber(tx, "production_order");
        const [order] = await tx
          .insert(productionOrders)
          .values({
            number,
            formulaId: formula.id,
            locationId,
            orderDate: body.orderDate,
            batchCount: body.batchCount,
            plannedOutputKg: outputKg.toFixed(3),
            actualOutputKg: outputKg.toFixed(3),
            status: "completed",
            inputValue: (inputValueP / 100).toFixed(2),
            overheadValue: (overheadP / 100).toFixed(2),
            costPerKg: costPerKg.toFixed(6),
            notes: body.notes ?? null,
            completedAt: new Date(),
            completedBy: req.session.user!.id,
            createdBy: req.session.user!.id,
          })
          .returning();
        await tx.insert(productionOrderLines).values(
          lineValues.map(({ r, kgTotal, rate, valueP }, i) => ({
            orderId: order!.id,
            itemId: r.line.itemId,
            plannedKg: kgTotal.toFixed(3),
            actualKg: kgTotal.toFixed(3),
            ratePerKg: rate.toFixed(6),
            value: (valueP / 100).toFixed(2),
            sortOrder: i,
          })),
        );

        const journalEntryId = await postInventoryMovement(tx, {
          movements: [
            { itemId: formula.outputItemId, quantity: outputKg.toFixed(3), value: (totalP / 100).toFixed(2) },
          ],
          transactionDate: body.orderDate,
          sourceType: "feed_mill",
          sourceId: order!.id,
          contraAccountId: await feedExpenseAccount(tx),
          narration:
            `Production ${number} — ${formula.name} v${formula.version}, ${body.batchCount} batch(es), ` +
            `${outputKg.toLocaleString("en-IN")} kg at ₹${costPerKg.toFixed(2)}/kg`,
          postedBy: req.session.user!.id,
        });
        const [updated] = await tx
          .update(productionOrders)
          .set({ journalEntryId })
          .where(eq(productionOrders.id, order!.id))
          .returning();
        return updated!;
      });
      res.status(201).json(out);
    } catch (err) {
      if (!fail(err, res)) throw err;
    }
  },
);

/**
 * Void a production: reverse the journal, withdraw the feed. Refused once
 * transfers have eaten further into the batch than the remaining stock can
 * give back — those must be voided first, so the story stays in order.
 */
feedProductionRouter.post(
  "/orders/:id/void",
  requirePermission("feed_mill", "produce"),
  validateBody(z.object({ reason: z.string().min(3) })),
  async (req, res) => {
    try {
      const out = await db.transaction(async (tx) => {
        const order = await tx.query.productionOrders.findFirst({
          where: eq(productionOrders.id, req.params.id!),
        });
        if (!order) throw new PostingError("Production not found");
        if (order.status === "void") throw new PostingError("Already void");
        const formula = await tx.query.formulas.findFirst({ where: eq(formulas.id, order.formulaId) });

        const [level] = await stockOnHand(tx, formula!.outputItemId);
        const qty = Number(order.actualOutputKg ?? 0);
        if (Number(level?.quantity ?? 0) < qty) {
          throw new PostingError(
            `Only ${Number(level?.quantity ?? 0).toLocaleString("en-IN")} kg remain of the ` +
              `${qty.toLocaleString("en-IN")} kg this production made — some has been transferred. ` +
              `Void the transfers first, or adjust stock instead.`,
          );
        }

        if (order.journalEntryId) {
          await reverseJournal(
            tx,
            order.journalEntryId,
            new Date().toISOString().slice(0, 10),
            req.session.user!.id,
          );
        }
        await moveStock(tx, {
          movements: [
            {
              itemId: formula!.outputItemId,
              quantity: `-${order.actualOutputKg}`,
              value: `-${(Number(order.inputValue ?? 0) + Number(order.overheadValue ?? 0)).toFixed(2)}`,
              notes: `Void ${order.number}: ${req.body.reason}`,
            },
          ],
          transactionDate: new Date().toISOString().slice(0, 10),
          sourceType: "feed_mill_void",
          sourceId: order.id,
        });
        const [updated] = await tx
          .update(productionOrders)
          .set({ status: "void", voidReason: req.body.reason, updatedAt: new Date() })
          .where(eq(productionOrders.id, order.id))
          .returning();
        return updated!;
      });
      res.json(out);
    } catch (err) {
      if (!fail(err, res)) throw err;
    }
  },
);

// ─────────────────────────── Feed transfers ───────────────────────────

feedProductionRouter.get("/transfers", requirePermission("feed_mill", "view"), async (_req, res) => {
  const rows = await db
    .select({
      id: feedTransfers.id,
      number: feedTransfers.number,
      transferDate: feedTransfers.transferDate,
      itemId: feedTransfers.itemId,
      itemName: items.name,
      quantityKg: feedTransfers.quantityKg,
      ratePerKg: feedTransfers.ratePerKg,
      value: feedTransfers.value,
      status: feedTransfers.status,
      toLocationId: feedTransfers.toLocationId,
    })
    .from(feedTransfers)
    .innerJoin(items, eq(items.id, feedTransfers.itemId))
    .orderBy(desc(feedTransfers.transferDate))
    .limit(100);
  const locs = await db.select({ id: locations.id, name: locations.name }).from(locations);
  const byId = new Map(locs.map((l) => [l.id, l.name]));
  res.json(rows.map((r) => ({ ...r, toLocationName: byId.get(r.toLocationId) ?? "—" })));
});

/** What a transfer picks from: each formula's feed with the stock behind it. */
feedProductionRouter.get(
  "/transfers/context",
  requirePermission("feed_mill", "view"),
  async (_req, res) => {
    const [levels, formulaRows, locs] = await Promise.all([
      stockOnHand(db),
      db
        .select({ name: formulas.name, outputItemId: formulas.outputItemId })
        .from(formulas)
        .where(eq(formulas.isActive, true)),
      db
        .select({ id: locations.id, name: locations.name, type: locations.type, isPrimary: locations.isPrimary })
        .from(locations)
        // Deactivated places stay on old documents but out of new dropdowns.
        .where(eq(locations.isActive, true))
        .orderBy(asc(locations.name)),
    ]);
    const byItem = new Map(levels.map((l) => [l.itemId, l]));
    res.json({
      feeds: formulaRows.map((f) => {
        const held = byItem.get(f.outputItemId);
        return {
          formulaName: f.name,
          itemId: f.outputItemId,
          itemName: held?.name ?? f.name,
          quantity: Number(held?.quantity ?? 0),
          value: Number(held?.value ?? 0),
        };
      }),
      locations: locs,
    });
  },
);

/**
 * Send x tons of a formula's feed to a house. Costed at the ledger's weighted
 * average the moment it leaves; refused when it would overdraw the stock.
 */
feedProductionRouter.post(
  "/transfers",
  requirePermission("feed_mill", "transfer"),
  validateBody(
    z.object({
      itemId: z.string().uuid(),
      quantityKg: qtyStr,
      toLocationId: z.string().uuid(),
      fromLocationId: z.string().uuid().optional(),
      transferDate: dateStr,
      notes: z.string().max(2000).nullish(),
    }),
  ),
  async (req, res) => {
    const body = req.body as {
      itemId: string;
      quantityKg: string;
      toLocationId: string;
      fromLocationId?: string;
      transferDate: string;
      notes?: string | null;
    };
    try {
      const out = await db.transaction(async (tx) => {
        await assertPeriodOpen(tx, body.transferDate, "inventory_adjustment");

        const fromLocationId = body.fromLocationId ?? (await millLocation(tx));
        if (fromLocationId === body.toLocationId) {
          throw new PostingError("A transfer needs two different places");
        }

        const [level] = await stockOnHand(tx, body.itemId);
        if (!level) throw new PostingError("That feed does not track inventory");
        const qty = Number(body.quantityKg);
        const held = Number(level.quantity);
        if (qty > held) {
          throw new PostingError(
            `Only ${held.toLocaleString("en-IN")} kg of ${level.name} in stock — cannot send ${qty.toLocaleString("en-IN")} kg`,
          );
        }
        const rate = held > 0 ? Number(level.value) / held : 0;
        const valueP = Math.round(qty * rate * 100);

        const number = await nextDocumentNumber(tx, "feed_transfer");
        const [transfer] = await tx
          .insert(feedTransfers)
          .values({
            number,
            transferDate: body.transferDate,
            itemId: body.itemId,
            quantityKg: body.quantityKg,
            fromLocationId,
            toLocationId: body.toLocationId,
            ratePerKg: rate.toFixed(6),
            value: (valueP / 100).toFixed(2),
            notes: body.notes ?? null,
            createdBy: req.session.user!.id,
          })
          .returning();

        const toName = (await tx.query.locations.findFirst({ where: eq(locations.id, body.toLocationId) }))!
          .name;
        const journalEntryId = await postInventoryMovement(tx, {
          movements: [
            { itemId: body.itemId, quantity: `-${body.quantityKg}`, value: `-${(valueP / 100).toFixed(2)}` },
          ],
          transactionDate: body.transferDate,
          sourceType: "feed_transfer",
          sourceId: transfer!.id,
          contraAccountId: await feedExpenseAccount(tx),
          narration: `Feed transfer ${number} — ${level.name} ${qty.toLocaleString("en-IN")} kg to ${toName}`,
          postedBy: req.session.user!.id,
          preventNegative: true,
        });
        const [updated] = await tx
          .update(feedTransfers)
          .set({ journalEntryId })
          .where(eq(feedTransfers.id, transfer!.id))
          .returning();
        return updated!;
      });
      res.status(201).json(out);
    } catch (err) {
      if (!fail(err, res)) throw err;
    }
  },
);

/** Void a transfer: reverse its journal, put the feed back. */
feedProductionRouter.post(
  "/transfers/:id/void",
  requirePermission("feed_mill", "transfer"),
  validateBody(z.object({ reason: z.string().min(3) })),
  async (req, res) => {
    try {
      const out = await db.transaction(async (tx) => {
        const transfer = await tx.query.feedTransfers.findFirst({
          where: eq(feedTransfers.id, req.params.id!),
        });
        if (!transfer) throw new PostingError("Transfer not found");
        if (transfer.status === "void") throw new PostingError("Already void");

        if (transfer.journalEntryId) {
          await reverseJournal(
            tx,
            transfer.journalEntryId,
            new Date().toISOString().slice(0, 10),
            req.session.user!.id,
          );
        }
        await moveStock(tx, {
          movements: [
            {
              itemId: transfer.itemId,
              quantity: transfer.quantityKg,
              value: transfer.value ?? "0",
              notes: `Void ${transfer.number}: ${req.body.reason}`,
            },
          ],
          transactionDate: new Date().toISOString().slice(0, 10),
          sourceType: "feed_transfer_void",
          sourceId: transfer.id,
        });
        const [updated] = await tx
          .update(feedTransfers)
          .set({ status: "void", voidReason: req.body.reason })
          .where(eq(feedTransfers.id, transfer.id))
          .returning();
        return updated!;
      });
      res.json(out);
    } catch (err) {
      if (!fail(err, res)) throw err;
    }
  },
);
