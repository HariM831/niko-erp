import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { inventoryTransactions, items, locations, stockLocations } from "@shared/schema";
import type { Db, Tx } from "../db";
import { PostingError, postJournal } from "./posting";

/** Reads work against a plain connection or a transaction; writes need a Tx. */
type Reader = Db | Tx;

const toPaise = (s: string | number | null | undefined): number =>
  Math.round(Number(s ?? 0) * 100);
const fromPaise = (p: number): string => (p / 100).toFixed(2);

export interface StockMovement {
  itemId: string;
  /**
   * Which store this happened in.
   *
   * Optional on the movement and defaulted per call, because almost every
   * caller moves stock in ONE place — the mill makes feed at the mill. Only a
   * transfer needs two, and it says so by setting it per movement.
   */
  stockLocationId?: string;
  /** The batch, where the item tracks them. FEFO is the caller's decision. */
  lotId?: string;
  /** Signed: positive receives stock, negative issues it. */
  quantity: string;
  /** Signed value of the movement, matching the sign of quantity. */
  value?: string;
  notes?: string;
}

/**
 * Record stock movements against the item ledger.
 *
 * This is the single entry point for changing stock — the inventory adjustment
 * document calls it, and the Feed Mill module will call it directly for
 * production and consumption. It deliberately does NOT post to the GL: the
 * caller owns the accounting, because only the caller knows which accounts the
 * movement belongs against. Quantity on hand is always derived from these rows.
 */
/**
 * The main store of a location, or of the primary location when none is given.
 *
 * Every location gets one when it is created, so this is a lookup rather than a
 * find-or-create. Callers that genuinely know where they are — the mill, a
 * house — pass their own; the rest land in the main store of the site the
 * business runs from, which is where stock with no better answer belongs.
 */
export async function mainStore(tx: Tx | Db, locationId?: string | null): Promise<string> {
  const [row] = await tx
    .select({ id: stockLocations.id })
    .from(stockLocations)
    .innerJoin(locations, eq(locations.id, stockLocations.locationId))
    .where(
      locationId
        ? and(eq(stockLocations.locationId, locationId), eq(stockLocations.kind, "main"))
        : eq(stockLocations.kind, "main"),
    )
    .orderBy(desc(locations.isPrimary), asc(locations.createdAt))
    .limit(1);
  if (!row) {
    throw new PostingError("No stock location exists — every location needs a main store");
  }
  return row.id;
}

export async function moveStock(
  tx: Tx,
  args: {
    movements: StockMovement[];
    transactionDate: string;
    sourceType: string;
    sourceId?: string;
    /** The store these movements happened in, unless a movement names its own. */
    stockLocationId?: string;
  },
): Promise<void> {
  if (!args.movements.length) return;

  const itemIds = [...new Set(args.movements.map((m) => m.itemId))];
  const rows = await tx
    .select({ id: items.id, name: items.name, tracked: items.trackInventory })
    .from(items)
    .where(inArray(items.id, itemIds));
  const byId = new Map(rows.map((r) => [r.id, r]));

  for (const id of itemIds) {
    const item = byId.get(id);
    if (!item) throw new PostingError(`Unknown item: ${id}`);
    if (!item.tracked) {
      throw new PostingError(
        `"${item.name}" does not track inventory — enable tracking on the item first`,
      );
    }
  }

  // Every row must land somewhere. A movement with no store, in a call with no
  // default, is a row nobody can ask "where" of — refused rather than parked in
  // whichever store happened to be first.
  const txnRows = args.movements.map((m) => {
    const stockLocationId = m.stockLocationId ?? args.stockLocationId;
    if (!stockLocationId) {
      throw new PostingError(
        "A stock movement needs a store — pass stockLocationId on the call or on the movement",
      );
    }
    return {
      itemId: m.itemId,
      stockLocationId,
      lotId: m.lotId,
      transactionDate: args.transactionDate,
      quantity: m.quantity,
      value: m.value ?? "0",
      sourceType: args.sourceType,
      sourceId: args.sourceId,
      notes: m.notes,
    };
  });
  await tx.insert(inventoryTransactions).values(txnRows);
}

/**
 * Move stock AND post the matching journal entry in one call.
 *
 * This is the seam operational modules use — the feed mill says what moved and
 * which account the other side belongs to, and all the accounting happens here.
 * Stock going up debits each item's inventory account and credits the contra;
 * stock going down does the reverse. Inventory accounts are grouped so a
 * movement spanning several item categories still posts one balanced entry.
 *
 * Returns the journal entry id, or null when every line is zero-valued (a pure
 * quantity correction with no financial effect posts nothing).
 */
export async function postInventoryMovement(
  tx: Tx,
  args: {
    movements: StockMovement[];
    transactionDate: string;
    sourceType: string;
    sourceId?: string;
    /** The other side of the entry: an account id, or a systemKey to resolve. */
    contraAccountId?: string;
    contraSystemKey?: string;
    narration: string;
    postedBy: string;
    /** Refuse movements that would take stock below zero. */
    preventNegative?: boolean;
    /** The store these movements happened in, unless a movement names its own. */
    stockLocationId?: string;
  },
): Promise<string | null> {
  if (!args.contraAccountId && !args.contraSystemKey) {
    throw new PostingError("An inventory movement needs a contra account");
  }
  if (args.preventNegative) await assertStockNotNegative(tx, args.movements);

  await moveStock(tx, {
    movements: args.movements,
    transactionDate: args.transactionDate,
    sourceType: args.sourceType,
    sourceId: args.sourceId,
    stockLocationId: args.stockLocationId,
  });

  const itemIds = [...new Set(args.movements.map((m) => m.itemId))];
  const rows = await tx
    .select({ id: items.id, name: items.name, account: items.inventoryAccountId })
    .from(items)
    .where(inArray(items.id, itemIds));
  const byId = new Map(rows.map((r) => [r.id, r]));

  const byAccount = new Map<string, number>();
  let netP = 0;
  for (const m of args.movements) {
    const p = toPaise(m.value);
    if (p === 0) continue;
    const item = byId.get(m.itemId)!;
    if (!item.account) throw new PostingError(`"${item.name}" has no inventory account set`);
    byAccount.set(item.account, (byAccount.get(item.account) ?? 0) + p);
    netP += p;
  }
  if (netP === 0 && byAccount.size === 0) return null;

  const lines: Parameters<typeof postJournal>[1]["lines"] = [];
  for (const [accountId, p] of byAccount) {
    if (p === 0) continue;
    lines.push(p > 0 ? { accountId, debit: fromPaise(p) } : { accountId, credit: fromPaise(-p) });
  }
  const contra = args.contraAccountId
    ? { accountId: args.contraAccountId }
    : { systemKey: args.contraSystemKey! };
  if (netP > 0) {
    lines.push({ ...contra, credit: fromPaise(netP) });
  } else if (netP < 0) {
    lines.push({ ...contra, debit: fromPaise(-netP) });
  }
  if (lines.length < 2) return null;

  return postJournal(tx, {
    entryDate: args.transactionDate,
    narration: args.narration,
    sourceType: "inventory_adjustment",
    sourceId: args.sourceId,
    postedBy: args.postedBy,
    lines,
  });
}

/** Reverse every movement a source produced, for voiding it. */
export async function reverseStock(
  tx: Tx,
  args: { sourceType: string; sourceId: string; transactionDate: string },
): Promise<void> {
  const existing = await tx
    .select()
    .from(inventoryTransactions)
    .where(
      sql`${inventoryTransactions.sourceType} = ${args.sourceType}
          and ${inventoryTransactions.sourceId} = ${args.sourceId}`,
    );
  if (!existing.length) return;

  await tx.insert(inventoryTransactions).values(
    existing.map((e) => ({
      itemId: e.itemId,
      // A reversal undoes a movement where it happened. Sending it back to a
      // different store would leave both stores wrong.
      stockLocationId: e.stockLocationId,
      lotId: e.lotId,
      transactionDate: args.transactionDate,
      quantity: (-Number(e.quantity)).toFixed(3),
      value: (-Number(e.value)).toFixed(2),
      sourceType: `${args.sourceType}_reversal`,
      sourceId: args.sourceId,
      notes: `Reversal of ${e.sourceType}`,
    })),
  );
}

export interface StockLevel {
  itemId: string;
  name: string;
  unit: string;
  openingStock: string;
  movements: string;
  quantity: string;
  value: string;
  reorderLevel: string | null;
  belowReorder: boolean;
}

/**
 * Stock on hand for every tracked item: opening stock plus the sum of all
 * ledger movements. Never a stored column, for the same reason account
 * balances aren't — a cached number can drift from the rows behind it.
 */
export interface StockPeriodRow {
  itemId: string;
  name: string;
  unit: string;
  category: string | null;
  /** On hand the moment the period opened. */
  opening: string;
  /** Received during the period. */
  inQty: string;
  /** Issued during the period, as a positive number. */
  outQty: string;
  /** On hand at the close of the end date. */
  closing: string;
  /** What that closing stock is worth, at weighted average. */
  value: string;
  reorderLevel: string | null;
  belowReorder: boolean;
}

/**
 * Stock for a period: what moved, and where it left us.
 *
 * Opening is everything before the window — the item's opening balance plus
 * every movement up to it — so the three columns tell one story that adds up:
 * opening + in − out = closing. A report where the balance is computed from a
 * different set of rows than the movements is a report nobody can reconcile.
 *
 * Value is at the CLOSING date rather than for the period, because a value for
 * a window is not a thing anybody can use: stock is worth what it is worth on
 * the day you ask.
 */
export async function stockLedger(
  tx: Reader,
  opts: { from: string; to: string; category?: string },
): Promise<StockPeriodRow[]> {
  const rows = await tx
    .select({
      itemId: items.id,
      name: items.name,
      unit: items.unit,
      category: items.category,
      openingStock: items.openingStock,
      openingRate: items.openingStockRate,
      reorderLevel: items.reorderLevel,
      before: sql<string>`coalesce(sum(${inventoryTransactions.quantity}) FILTER (
        WHERE ${inventoryTransactions.transactionDate} < ${opts.from}), 0)`,
      inQty: sql<string>`coalesce(sum(${inventoryTransactions.quantity}) FILTER (
        WHERE ${inventoryTransactions.transactionDate} BETWEEN ${opts.from} AND ${opts.to}
          AND ${inventoryTransactions.quantity} > 0), 0)`,
      outQty: sql<string>`coalesce(-sum(${inventoryTransactions.quantity}) FILTER (
        WHERE ${inventoryTransactions.transactionDate} BETWEEN ${opts.from} AND ${opts.to}
          AND ${inventoryTransactions.quantity} < 0), 0)`,
      // Everything up to and including the end date, for the closing figures.
      toDateQty: sql<string>`coalesce(sum(${inventoryTransactions.quantity}) FILTER (
        WHERE ${inventoryTransactions.transactionDate} <= ${opts.to}), 0)`,
      toDateValue: sql<string>`coalesce(sum(${inventoryTransactions.value}) FILTER (
        WHERE ${inventoryTransactions.transactionDate} <= ${opts.to}), 0)`,
    })
    .from(items)
    .leftJoin(inventoryTransactions, eq(inventoryTransactions.itemId, items.id))
    .where(
      opts.category
        ? and(eq(items.trackInventory, true), eq(items.isActive, true), sql`${items.category}::text = ${opts.category}`)
        : and(eq(items.trackInventory, true), eq(items.isActive, true)),
    )
    .groupBy(items.id)
    .orderBy(items.name);

  return rows.map((r) => {
    const opening = Number(r.openingStock) + Number(r.before);
    const closing = Number(r.openingStock) + Number(r.toDateQty);
    const openingValueP = Math.round(Number(r.openingStock) * toPaise(r.openingRate));
    const valueP = openingValueP + toPaise(r.toDateValue);
    return {
      itemId: r.itemId,
      name: r.name,
      unit: r.unit,
      category: r.category,
      opening: opening.toFixed(3),
      inQty: Number(r.inQty).toFixed(3),
      outQty: Number(r.outQty).toFixed(3),
      closing: closing.toFixed(3),
      value: (valueP / 100).toFixed(2),
      reorderLevel: r.reorderLevel,
      belowReorder: r.reorderLevel !== null && closing < Number(r.reorderLevel),
    };
  });
}

export async function stockOnHand(tx: Reader, itemId?: string): Promise<StockLevel[]> {
  // A join rather than a correlated subquery: drizzle renders bare column names
  // inside sql`` subqueries, so `where item_id = id` would silently bind `id` to
  // the subquery's own table and every sum would come back zero.
  const rows = await tx
    .select({
      itemId: items.id,
      name: items.name,
      unit: items.unit,
      openingStock: items.openingStock,
      openingRate: items.openingStockRate,
      reorderLevel: items.reorderLevel,
      moved: sql<string>`coalesce(sum(${inventoryTransactions.quantity}), 0)`,
      movedValue: sql<string>`coalesce(sum(${inventoryTransactions.value}), 0)`,
    })
    .from(items)
    .leftJoin(inventoryTransactions, eq(inventoryTransactions.itemId, items.id))
    .where(
      itemId
        ? and(eq(items.id, itemId), eq(items.trackInventory, true))
        : eq(items.trackInventory, true),
    )
    .groupBy(items.id)
    .orderBy(items.name);

  return rows.map((r) => {
    const quantity = Number(r.openingStock) + Number(r.moved);
    const openingValueP = Math.round(Number(r.openingStock) * toPaise(r.openingRate));
    const valueP = openingValueP + toPaise(r.movedValue);
    return {
      itemId: r.itemId,
      name: r.name,
      unit: r.unit,
      openingStock: Number(r.openingStock).toFixed(3),
      movements: Number(r.moved).toFixed(3),
      quantity: quantity.toFixed(3),
      value: (valueP / 100).toFixed(2),
      reorderLevel: r.reorderLevel,
      belowReorder: r.reorderLevel !== null && quantity < Number(r.reorderLevel),
    };
  });
}

/**
 * Refuse movements that would drive an item's stock negative. Zoho's
 * "prevent stock from going below zero" — checked against the resulting
 * balance, not the individual movement, so a receipt and an issue in the same
 * document net out correctly.
 */
export async function assertStockNotNegative(
  tx: Reader,
  movements: StockMovement[],
): Promise<void> {
  const net = new Map<string, number>();
  for (const m of movements) {
    net.set(m.itemId, (net.get(m.itemId) ?? 0) + Number(m.quantity));
  }
  for (const [itemId, delta] of net) {
    if (delta >= 0) continue;
    const [level] = await stockOnHand(tx, itemId);
    if (!level) continue;
    if (Number(level.quantity) + delta < 0) {
      throw new PostingError(
        `${level.name}: only ${level.quantity} ${level.unit} on hand, cannot reduce by ${Math.abs(delta)}`,
      );
    }
  }
}
