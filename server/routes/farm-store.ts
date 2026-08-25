/**
 * The farm store — goods held at a farm, seen and handled at farm level.
 *
 * NOT a second inventory. Stock on hand is the same `inventory_transactions`
 * ledger the whole system uses, summed at this farm's stock locations — so a
 * bill whose receiving site is this farm already shows up here without anyone
 * re-entering it. What this module adds is the two things that happen at the
 * farm gate and nowhere else:
 *
 *  - RECEIVE: goods arrive without a bill in hand — a vendor drops vaccines,
 *    a transfer lands from the mill. Records custody (+qty); the money side,
 *    when there is one, is the Purchases module's business, which is why a
 *    receipt here posts no journal. The note carries who brought it and
 *    against what paper, so the bill can be matched when it arrives.
 *
 *  - ISSUE: something is taken for use — vaccines to a shed, trays to the
 *    packing table. Records consumption (−qty), FEFO on lots when the item
 *    tracks batches, and refuses to drive this location's balance negative.
 */
import { Router } from "express";
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  houses,
  inventoryTransactions,
  itemLots,
  items,
  locations,
  stockLocations,
} from "@shared/schema";
import { db } from "../db";
import { requirePermission } from "../lib/rbac";
import { looseNumber, validateBody } from "../lib/validate";
import { mainStore, moveStock } from "../services/inventory";

export const farmStoreRouter = Router();

/**
 * The farm sites a store can belong to, for the picker.
 *
 * "Has houses" rather than "is typed farm": the legacy import left a location
 * row per shed and per owner, all typed farm, and a picker offering L2 as a
 * site invites stock into a place that is not a place. A farm, for the store's
 * purposes, is a site birds actually live at.
 */
farmStoreRouter.get("/locations", requirePermission("farms", "view"), async (_req, res) => {
  const rows = await db
    .selectDistinct({ id: locations.id, code: locations.code, name: locations.name, isPrimary: locations.isPrimary })
    .from(locations)
    .innerJoin(houses, eq(houses.locationId, locations.id))
    .orderBy(desc(locations.isPrimary), locations.name);
  res.json({ locations: rows });
});

/**
 * Stock on hand at one farm, per item per store.
 *
 * Summed from the ledger, never a stored balance — the same rule the GL
 * follows. Opening stock is deliberately excluded: it belongs to wherever the
 * opening count was taken (the primary site's books), and adding it to every
 * farm would conjure the same pallet into existence once per site.
 */
farmStoreRouter.get("/:locationId/stock", requirePermission("farms", "view"), async (req, res) => {
  const stores = await db
    .select({ id: stockLocations.id, code: stockLocations.code, name: stockLocations.name, kind: stockLocations.kind })
    .from(stockLocations)
    .where(and(eq(stockLocations.locationId, req.params.locationId!), eq(stockLocations.isActive, true)));
  const storeIds = stores.map((s) => s.id);
  if (!storeIds.length) return res.json({ stores: [], stock: [], catalogue: [] });

  const rows = await db
    .select({
      itemId: items.id,
      name: items.name,
      unit: items.unit,
      category: items.category,
      reorderLevel: items.reorderLevel,
      stockLocationId: inventoryTransactions.stockLocationId,
      qty: sql<string>`sum(${inventoryTransactions.quantity})`,
      value: sql<string>`sum(${inventoryTransactions.value})`,
      lastMoved: sql<string>`max(${inventoryTransactions.transactionDate})`,
    })
    .from(inventoryTransactions)
    .innerJoin(items, eq(items.id, inventoryTransactions.itemId))
    .where(inArray(inventoryTransactions.stockLocationId, storeIds))
    .groupBy(items.id, inventoryTransactions.stockLocationId)
    .orderBy(items.name);

  /**
   * The catalogue: everything receivable, whether it has moved here or not.
   * Feed ingredients and produce are excluded — the mill and the egg store
   * have their own screens, and offering maize here invites a receipt that
   * fights the mill's own ledger.
   */
  const catalogue = await db
    .select({ id: items.id, name: items.name, unit: items.unit, category: items.category, trackInventory: items.trackInventory })
    .from(items)
    .where(
      sql`${items.isActive} AND ${items.type} = 'goods'
          AND NOT ${items.isFeedIngredient}
          AND (${items.category} IS NULL OR ${items.category} NOT IN ('feed', 'poultry_feed', 'eggs', 'birds', 'manure'))`,
    )
    .orderBy(items.name);

  res.json({ stores, stock: rows, catalogue });
});

/** Recent movements at this farm's stores, the ledger the screen shows. */
farmStoreRouter.get("/:locationId/entries", requirePermission("farms", "view"), async (req, res) => {
  const stores = await db
    .select({ id: stockLocations.id })
    .from(stockLocations)
    .where(eq(stockLocations.locationId, req.params.locationId!));
  const ids = stores.map((s) => s.id);
  if (!ids.length) return res.json({ entries: [] });

  const rows = await db
    .select({
      id: inventoryTransactions.id,
      date: inventoryTransactions.transactionDate,
      itemName: items.name,
      unit: items.unit,
      quantity: inventoryTransactions.quantity,
      value: inventoryTransactions.value,
      sourceType: inventoryTransactions.sourceType,
      notes: inventoryTransactions.notes,
      storeName: stockLocations.name,
      createdAt: inventoryTransactions.createdAt,
    })
    .from(inventoryTransactions)
    .innerJoin(items, eq(items.id, inventoryTransactions.itemId))
    .innerJoin(stockLocations, eq(stockLocations.id, inventoryTransactions.stockLocationId))
    .where(inArray(inventoryTransactions.stockLocationId, ids))
    .orderBy(desc(inventoryTransactions.transactionDate), desc(inventoryTransactions.createdAt))
    .limit(100);
  res.json({ entries: rows });
});

const receiveSchema = z.object({
  locationId: z.string().uuid(),
  itemId: z.string().uuid(),
  quantity: looseNumber(z.number().positive()),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Optional: what one unit cost, if the paper says. Custody works without it. */
  ratePerUnit: looseNumber(z.number().nonnegative()).optional(),
  lotNo: z.string().max(60).optional(),
  expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  vendorName: z.string().max(120).optional(),
  reference: z.string().max(60).optional(),
  notes: z.string().max(500).optional(),
});

farmStoreRouter.post(
  "/receive",
  requirePermission("farms", "create"),
  validateBody(receiveSchema),
  async (req, res) => {
    const b = req.body as z.infer<typeof receiveSchema>;
    try {
      const out = await db.transaction(async (tx) => {
        const [item] = await tx.select().from(items).where(eq(items.id, b.itemId));
        if (!item) throw new Error("Unknown item");

        /**
         * Receiving at the farm is where this item's stock history begins, so
         * tracking is switched on here rather than refused. The import left
         * the store catalogue untracked because Amino had no history anyone
         * could vouch for; a receipt somebody just signed for is exactly the
         * vouched-for starting point that was missing.
         */
        if (!item.trackInventory) {
          await tx.update(items).set({ trackInventory: true }).where(eq(items.id, item.id));
        }

        let lotId: string | undefined;
        if (b.lotNo || b.expiryDate) {
          const [lot] = await tx
            .insert(itemLots)
            .values({
              itemId: b.itemId,
              lotNo: b.lotNo || null,
              expiryDate: b.expiryDate || null,
              receivedOn: b.date,
            })
            .onConflictDoNothing()
            .returning({ id: itemLots.id });
          lotId =
            lot?.id ??
            (b.lotNo
              ? (
                  await tx
                    .select({ id: itemLots.id })
                    .from(itemLots)
                    .where(and(eq(itemLots.itemId, b.itemId), eq(itemLots.lotNo, b.lotNo)))
                )[0]?.id
              : undefined);
        }

        const provenance = [
          b.vendorName && `from ${b.vendorName}`,
          b.reference && `ref ${b.reference}`,
          b.notes,
        ]
          .filter(Boolean)
          .join(" · ");

        await moveStock(tx, {
          movements: [
            {
              itemId: b.itemId,
              quantity: b.quantity.toFixed(3),
              value: b.ratePerUnit != null ? (b.quantity * b.ratePerUnit).toFixed(2) : "0",
              lotId,
              notes: provenance || undefined,
            },
          ],
          transactionDate: b.date,
          sourceType: "farm_store_receipt",
          stockLocationId: await mainStore(tx, b.locationId),
        });
        return { ok: true };
      });
      res.status(201).json(out);
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : "Receive failed" });
    }
  },
);

const issueSchema = z.object({
  locationId: z.string().uuid(),
  itemId: z.string().uuid(),
  quantity: looseNumber(z.number().positive()),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** The shed it went to, when it went to one. */
  houseId: z.string().uuid().optional(),
  notes: z.string().max(500).optional(),
});

farmStoreRouter.post(
  "/issue",
  requirePermission("farms", "create"),
  validateBody(issueSchema),
  async (req, res) => {
    const b = req.body as z.infer<typeof issueSchema>;
    try {
      const out = await db.transaction(async (tx) => {
        const storeId = await mainStore(tx, b.locationId);

        /**
         * Balance checked AT THIS STORE, not globally. The global guard would
         * happily let this farm issue stock that physically sits at the mill,
         * which is exactly the phantom the per-location ledger exists to stop.
         */
        const [bal] = await tx
          .select({ qty: sql<string>`coalesce(sum(${inventoryTransactions.quantity}), 0)` })
          .from(inventoryTransactions)
          .where(
            and(
              eq(inventoryTransactions.itemId, b.itemId),
              eq(inventoryTransactions.stockLocationId, storeId),
            ),
          );
        if (Number(bal!.qty) < b.quantity) {
          throw new Error(
            `Only ${Number(bal!.qty).toFixed(3)} on hand at this store — cannot issue ${b.quantity}`,
          );
        }

        /**
         * FEFO: the lot reaching expiry first goes out first. Judgement, not
         * schema — see stock-locations.ts. A lot with no expiry queues last.
         */
        const [lot] = await tx
          .select({
            id: itemLots.id,
            held: sql<string>`coalesce(sum(${inventoryTransactions.quantity}), 0)`,
          })
          .from(itemLots)
          .leftJoin(
            inventoryTransactions,
            and(
              eq(inventoryTransactions.lotId, itemLots.id),
              eq(inventoryTransactions.stockLocationId, storeId),
            ),
          )
          .where(eq(itemLots.itemId, b.itemId))
          .groupBy(itemLots.id, itemLots.expiryDate)
          .having(gt(sql`coalesce(sum(${inventoryTransactions.quantity}), 0)`, 0))
          .orderBy(sql`${itemLots.expiryDate} ASC NULLS LAST`)
          .limit(1);

        const house = b.houseId
          ? (await tx.select({ code: houses.code }).from(houses).where(eq(houses.id, b.houseId)))[0]
          : null;
        const note = [house && `to ${house.code}`, b.notes].filter(Boolean).join(" · ");

        await moveStock(tx, {
          movements: [
            {
              itemId: b.itemId,
              quantity: `-${b.quantity.toFixed(3)}`,
              lotId: lot?.id,
              notes: note || undefined,
            },
          ],
          transactionDate: b.date,
          sourceType: "farm_store_issue",
          sourceId: b.houseId,
          stockLocationId: storeId,
        });
        return { ok: true };
      });
      res.status(201).json(out);
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : "Issue failed" });
    }
  },
);
