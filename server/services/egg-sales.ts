/**
 * Egg sales: the day's order book, derived; the loading, invoiced.
 *
 * The rule of the module: nothing is generated ahead of time. A day's orders
 * are computed from the agreements, the exceptions and the spot orders every
 * time they are asked for, so editing an agreement corrects every future day
 * instantly and there is no evening job to forget. The only rows written are
 * facts somebody stated — see shared/schema/egg-sales.ts.
 *
 * Pricing: (benchmark on the day + size differential + customer spread) per
 * egg. The benchmark is the same table owner billing reads. No benchmark for
 * the day means loading is refused, never silently priced off yesterday.
 */
import { and, asc, desc, eq, gte, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import {
  contacts,
  creditNotes,
  customerPayments,
  eggAgreementExceptions,
  eggAgreements,
  eggBenchmarkPrices,
  eggDispatches,
  eggGrading,
  eggSalesPreferences,
  eggSizeItems,
  eggSizeOffsets,
  eggSpotOrders,
  inventoryTransactions,
  invoiceLines,
  invoices,
  items,
  paymentApplications,
  placementDays,
  users,
} from "@shared/schema";
import type { db as Db } from "../db";
import { PostingError, postJournal } from "./posting";
import { applyDefaultSalesAccounts, computeDocumentTotals, fromPaise, toPaise, type DocLineInput } from "./documents";
import { nextDocumentNumber } from "../lib/numbering";
import { computeDueDate, loadCustomer, postInvoiceJournal } from "../routes/sales";
import { mainStore, moveStock } from "./inventory";

type Tx = Parameters<Parameters<typeof Db.transaction>[0]>[0];
type Conn = Tx | typeof Db;

export const EGG_SIZES = ["small", "medium", "large", "xl", "jumbo", "dirty"] as const;
export type EggSize = (typeof EGG_SIZES)[number];

const SIZE_LABEL: Record<EggSize, string> = {
  small: "Small",
  medium: "Medium",
  large: "Large",
  xl: "XL",
  jumbo: "Jumbo",
  dirty: "Dirty",
};

export async function eggPrefs(tx: Conn) {
  const [row] = await tx.select().from(eggSalesPreferences);
  if (!row) throw new PostingError("Egg sales preferences are missing — run migrations");
  return row;
}

/** The benchmark in force on a date, or null — null blocks invoicing. */
export async function benchmarkOn(tx: Conn, on: string) {
  const [row] = await tx
    .select()
    .from(eggBenchmarkPrices)
    .where(lte(eggBenchmarkPrices.effectiveFrom, on))
    .orderBy(desc(eggBenchmarkPrices.effectiveFrom))
    .limit(1);
  return row ?? null;
}

/** The size differentials in force on a date. */
export async function sizeOffsetsOn(tx: Conn, on: string) {
  const [row] = await tx
    .select()
    .from(eggSizeOffsets)
    .where(lte(eggSizeOffsets.effectiveFrom, on))
    .orderBy(desc(eggSizeOffsets.effectiveFrom))
    .limit(1);
  return row ?? null;
}

/** Does this agreement's schedule cover the date? */
function coversDay(a: { schedule: string; daysOfWeek: number[] | null }, on: string): boolean {
  if (a.schedule === "daily") return true;
  const weekday = new Date(`${on}T00:00:00`).getDay();
  return (a.daysOfWeek ?? []).includes(weekday);
}

export interface DayOrderLine {
  kind: "standing" | "spot";
  /** The agreement or spot order this line IS. */
  sourceId: string;
  customerId: string;
  customerName: string;
  /** Where they are, for the bay's eye — the default billing city. */
  city: string | null;
  boxes: number;
  /** Spot orders are booked per size; a standing order is a box count. */
  sizes: Partial<Record<EggSize, number>> | null;
  spreadPerEgg: string;
  notes: string | null;
  /** Set when the line was reduced or came from an exception. */
  exception: { kind: string; reason: string | null } | null;
  /** A voided spot order, still shown struck through. */
  voided: boolean;
  /** The dispatch that fulfilled it, when one has. */
  dispatch: {
    id: string;
    invoiceId: string;
    invoiceNumber: string;
    loadedBoxes: number;
    status: string;
  } | null;
}

/** The customer's default billing city, for the bay's eye. */
const cityOf = sql<string | null>`(
  SELECT a.city FROM contact_addresses a
  WHERE a.contact_id = ${contacts.id}
  ORDER BY (a.kind = 'billing') DESC, a.is_default DESC LIMIT 1
)`;

/**
 * The order book for one day — the derivation the whole module rests on.
 *
 * standing = active agreements alive on the day whose schedule covers it,
 *            minus that day's skip exceptions, quantities overridden where
 *            an override says so;
 * spot     = the day's spot orders, voided ones included but flagged;
 * status   = derived from whether a live dispatch answers the line.
 */
export async function dayOrders(tx: Conn, on: string): Promise<DayOrderLine[]> {
  const agreements = await tx
    .select({
      id: eggAgreements.id,
      customerId: eggAgreements.customerId,
      customerName: contacts.displayName,
      city: cityOf,
      schedule: eggAgreements.schedule,
      daysOfWeek: eggAgreements.daysOfWeek,
      boxes: eggAgreements.boxes,
      spreadPerEgg: eggAgreements.spreadPerEgg,
      notes: eggAgreements.notes,
    })
    .from(eggAgreements)
    .innerJoin(contacts, eq(contacts.id, eggAgreements.customerId))
    .where(
      and(
        eq(eggAgreements.status, "active"),
        lte(eggAgreements.startDate, on),
        or(isNull(eggAgreements.endDate), gte(eggAgreements.endDate, on)),
      ),
    )
    .orderBy(asc(contacts.displayName));

  const due = agreements.filter((a) => coversDay(a, on));
  const exceptions = due.length
    ? await tx
        .select()
        .from(eggAgreementExceptions)
        .where(
          and(
            eq(eggAgreementExceptions.onDate, on),
            inArray(
              eggAgreementExceptions.agreementId,
              due.map((a) => a.id),
            ),
          ),
        )
    : [];
  const exceptionOf = new Map(exceptions.map((e) => [e.agreementId, e]));

  const spots = await tx
    .select({
      id: eggSpotOrders.id,
      customerId: eggSpotOrders.customerId,
      customerName: contacts.displayName,
      city: cityOf,
      boxes: eggSpotOrders.boxes,
      small: eggSpotOrders.small,
      medium: eggSpotOrders.medium,
      large: eggSpotOrders.large,
      xl: eggSpotOrders.xl,
      jumbo: eggSpotOrders.jumbo,
      dirty: eggSpotOrders.dirty,
      spreadPerEgg: eggSpotOrders.spreadPerEgg,
      notes: eggSpotOrders.notes,
      status: eggSpotOrders.status,
    })
    .from(eggSpotOrders)
    .innerJoin(contacts, eq(contacts.id, eggSpotOrders.customerId))
    .where(eq(eggSpotOrders.orderDate, on))
    .orderBy(asc(eggSpotOrders.createdAt));

  const dispatches = await tx
    .select({
      id: eggDispatches.id,
      agreementId: eggDispatches.agreementId,
      spotOrderId: eggDispatches.spotOrderId,
      invoiceId: eggDispatches.invoiceId,
      invoiceNumber: invoices.number,
      status: eggDispatches.status,
      loadedBoxes: sql<number>`${eggDispatches.loadedSmall} + ${eggDispatches.loadedMedium} + ${eggDispatches.loadedLarge} + ${eggDispatches.loadedXl} + ${eggDispatches.loadedJumbo} + ${eggDispatches.loadedDirty}`,
    })
    .from(eggDispatches)
    .innerJoin(invoices, eq(invoices.id, eggDispatches.invoiceId))
    .where(eq(eggDispatches.dispatchDate, on));
  // A void dispatch no longer answers the order — the line derives back to due.
  const live = dispatches.filter((d) => d.status !== "void");
  const byAgreement = new Map(live.filter((d) => d.agreementId).map((d) => [d.agreementId!, d]));
  const bySpot = new Map(live.filter((d) => d.spotOrderId).map((d) => [d.spotOrderId!, d]));

  const lines: DayOrderLine[] = [];
  for (const a of due) {
    const ex = exceptionOf.get(a.id);
    if (ex?.kind === "skip") {
      // The count stays on the line so the record says what was skipped;
      // every consumer excludes skipped lines from the day's totals by the
      // exception, never by the number.
      lines.push({
        kind: "standing",
        sourceId: a.id,
        customerId: a.customerId,
        customerName: a.customerName,
        city: a.city,
        boxes: a.boxes,
        sizes: null,
        spreadPerEgg: a.spreadPerEgg,
        notes: a.notes,
        exception: { kind: "skip", reason: ex.reason },
        voided: false,
        dispatch: null,
      });
      continue;
    }
    const d = byAgreement.get(a.id);
    lines.push({
      kind: "standing",
      sourceId: a.id,
      customerId: a.customerId,
      customerName: a.customerName,
      city: a.city,
      boxes: ex?.kind === "qty_override" ? (ex.boxes ?? a.boxes) : a.boxes,
      sizes: null,
      spreadPerEgg: a.spreadPerEgg,
      notes: a.notes,
      exception: ex ? { kind: ex.kind, reason: ex.reason } : null,
      voided: false,
      dispatch: d
        ? {
            id: d.id,
            invoiceId: d.invoiceId,
            invoiceNumber: d.invoiceNumber,
            loadedBoxes: Number(d.loadedBoxes),
            status: d.status,
          }
        : null,
    });
  }
  for (const s of spots) {
    const d = bySpot.get(s.id);
    lines.push({
      kind: "spot",
      sourceId: s.id,
      customerId: s.customerId,
      customerName: s.customerName,
      city: s.city,
      boxes: s.boxes,
      sizes: Object.fromEntries(EGG_SIZES.filter((z) => s[z] > 0).map((z) => [z, s[z]])),
      spreadPerEgg: s.spreadPerEgg ?? "0",
      notes: s.notes,
      exception: null,
      voided: s.status === "voided",
      dispatch: d
        ? {
            id: d.id,
            invoiceId: d.invoiceId,
            invoiceNumber: d.invoiceNumber,
            loadedBoxes: Number(d.loadedBoxes),
            status: d.status,
          }
        : null,
    });
  }
  return lines;
}

/**
 * Expected production per day, in boxes.
 *
 * The average of the last seven RECORDED days across every laying house —
 * the day-end production records, as asked, rather than a hand-set plan that
 * goes stale. Days with no record at all are not averaged in as zeros; a day
 * nobody filled the sheet is missing, not eggless.
 */
export async function expectedBoxesPerDay(tx: Conn): Promise<number | null> {
  const prefs = await eggPrefs(tx);
  const rows = await tx
    .select({
      day: placementDays.day,
      eggs: sql<string>`sum(coalesce(${placementDays.eggsTotal}, 0))`,
    })
    .from(placementDays)
    .where(sql`${placementDays.eggsTotal} IS NOT NULL`)
    .groupBy(placementDays.day)
    .orderBy(desc(placementDays.day))
    .limit(7);
  if (!rows.length) return null;
  const avgEggs = rows.reduce((a, r) => a + Number(r.eggs), 0) / rows.length;
  return Math.round(avgEggs / prefs.eggsPerBox);
}

/** Actual production on a day, in boxes, from the day-end records. */
export async function actualBoxesOn(tx: Conn, from: string, to: string) {
  const prefs = await eggPrefs(tx);
  const rows = await tx
    .select({
      day: placementDays.day,
      eggs: sql<string>`sum(coalesce(${placementDays.eggsTotal}, 0))`,
    })
    .from(placementDays)
    .where(and(gte(placementDays.day, from), lte(placementDays.day, to)))
    .groupBy(placementDays.day);
  return new Map(rows.map((r) => [r.day, Math.round(Number(r.eggs) / prefs.eggsPerBox)]));
}

/* ── Supply: what can actually be sold on a day ────────────────────────────
 *
 * The shelf plus the lay, carried day to day:
 *   opening(d) = closing(d−1)
 *   supply(d)  = opening(d) + production(d)   graded sheet if in, else forecast
 *   closing(d) = supply(d) − committed(d)     assuming orders load
 * Past days rebuild their opening from the ledger (stock now − movements
 * since); today's is the same arithmetic; tomorrow's is projected.
 */
export interface SupplyDay {
  date: string;
  committed: number;
  standing: number;
  spot: number;
  skipped: number;
  dispatched: number;
  production: number | null;
  productionSource: "actual" | "forecast" | "none";
  opening: number | null;
  supply: number | null;
  closing: number | null;
}

export async function supplyCascade(tx: Conn, from: string, to: string): Promise<SupplyDay[]> {
  const today = new Date().toISOString().slice(0, 10);
  const graded = await gradedBoxesByDay(tx, from, to);
  const expected = await expectedGradedBoxesPerDay(tx);
  const held = await stockBySize(tx);
  const stockNow = EGG_SIZES.reduce((a, s) => a + held[s], 0);
  const moves = await netMovesByDay(tx, from);
  const openingFromLedger = (on: string) => {
    let since = 0;
    for (const [day, q] of moves) if (day >= on) since += q;
    return stockNow - since;
  };

  const out: SupplyDay[] = [];
  let carried: number | null = null;
  for (let d = new Date(`${from}T00:00:00Z`); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) {
    const on = d.toISOString().slice(0, 10);
    const lines = await dayOrders(tx, on);
    const standing = lines.filter((l) => l.kind === "standing" && !l.exception).reduce((a, l) => a + l.boxes, 0);
    const overridden = lines
      .filter((l) => l.kind === "standing" && l.exception?.kind === "qty_override")
      .reduce((a, l) => a + l.boxes, 0);
    const spot = lines.filter((l) => l.kind === "spot" && !l.voided).reduce((a, l) => a + l.boxes, 0);
    const dispatched = lines.reduce((a, l) => a + (l.dispatch?.loadedBoxes ?? 0), 0);
    const committed = standing + overridden + spot;

    const hasSheet = graded.has(on);
    const production = hasSheet ? graded.get(on)! : on >= today ? expected : null;
    const opening: number | null = on <= today ? openingFromLedger(on) : carried;
    const supply: number | null = opening != null && production != null ? opening + production : null;
    const closing: number | null = supply != null ? supply - committed : null;
    carried = closing;
    out.push({
      date: on,
      committed,
      standing: standing + overridden,
      spot,
      skipped: lines.filter((l) => l.exception?.kind === "skip").length,
      dispatched,
      production,
      productionSource: hasSheet ? "actual" : production != null ? "forecast" : "none",
      opening,
      supply,
      closing,
    });
  }
  return out;
}

/* ── Egg stock, by size ────────────────────────────────────────────────────
 *
 * ONE pool per size at the farm store. Production is recorded per shed
 * (the sheet says which shed laid what) but every box lands in the pool, and
 * a sale draws from the pool — the truck takes 1,434 Large from the pile, not
 * from L3. Stock by size = the item's opening balance + every movement, the
 * same rule as everything else; closing stock is never keyed.
 */

/** size → stock item, read once per call site. */
export async function sizeItems(tx: Conn): Promise<Map<EggSize, string>> {
  const rows = await tx.select().from(eggSizeItems);
  return new Map(rows.map((r) => [r.size as EggSize, r.itemId]));
}

/** Boxes on hand per size, right now. */
export async function stockBySize(tx: Conn): Promise<Record<EggSize, number>> {
  const map = await sizeItems(tx);
  const out = Object.fromEntries(EGG_SIZES.map((s) => [s, 0])) as Record<EggSize, number>;
  for (const [size, itemId] of map) {
    const [it] = await tx.select({ opening: items.openingStock }).from(items).where(eq(items.id, itemId));
    const [moved] = await tx
      .select({ q: sql<string>`coalesce(sum(${inventoryTransactions.quantity}), 0)` })
      .from(inventoryTransactions)
      .where(eq(inventoryTransactions.itemId, itemId));
    out[size] = Number(it?.opening ?? 0) + Number(moved?.q ?? 0);
  }
  return out;
}

export interface GradingInput {
  houseId: string;
  gradedOn: string;
  boxes: Partial<Record<EggSize, number>>;
}

/**
 * Save one shed-day of grading and re-state its stock movement.
 *
 * Delete-and-rewrite, because the sheet is corrected in place: 486 Large
 * amended to 468 must correct the movement, not add a second one. Stock moves
 * only from `stockFrom` — the same cutover rule as everywhere else.
 */
export async function saveGrading(tx: Tx, input: GradingInput, userId: string) {
  const prefs = await eggPrefs(tx);
  const qty = (s: EggSize) => Math.max(0, Math.trunc(input.boxes[s] ?? 0));

  const [row] = await tx
    .insert(eggGrading)
    .values({
      houseId: input.houseId,
      gradedOn: input.gradedOn,
      small: qty("small"),
      medium: qty("medium"),
      large: qty("large"),
      xl: qty("xl"),
      jumbo: qty("jumbo"),
      dirty: qty("dirty"),
      recordedBy: userId,
    })
    .onConflictDoUpdate({
      target: [eggGrading.houseId, eggGrading.gradedOn],
      set: {
        small: qty("small"),
        medium: qty("medium"),
        large: qty("large"),
        xl: qty("xl"),
        jumbo: qty("jumbo"),
        dirty: qty("dirty"),
        recordedBy: userId,
        updatedAt: new Date(),
      },
    })
    .returning();

  if (input.gradedOn < prefs.stockFrom) return row!;

  await tx.execute(sql`
    DELETE FROM inventory_transactions
    WHERE source_type = 'egg_grading'
      AND source_id = ${input.houseId}::uuid
      AND transaction_date = ${input.gradedOn}
  `);
  const map = await sizeItems(tx);
  const movements = EGG_SIZES.filter((s) => qty(s) > 0).map((s) => ({
    itemId: map.get(s)!,
    quantity: qty(s).toFixed(3),
  }));
  if (movements.length) {
    await moveStock(tx, {
      movements,
      transactionDate: input.gradedOn,
      sourceType: "egg_grading",
      sourceId: input.houseId,
      stockLocationId: await mainStore(tx, null),
    });
  }
  return row!;
}

/** Boxes graded per day, total across sheds, for the days that have a sheet. */
export async function gradedBoxesByDay(tx: Conn, from: string, to: string) {
  const rows = await tx
    .select({
      day: eggGrading.gradedOn,
      boxes: sql<string>`sum(${eggGrading.small} + ${eggGrading.medium} + ${eggGrading.large} + ${eggGrading.xl} + ${eggGrading.jumbo} + ${eggGrading.dirty})`,
    })
    .from(eggGrading)
    .where(and(gte(eggGrading.gradedOn, from), lte(eggGrading.gradedOn, to)))
    .groupBy(eggGrading.gradedOn);
  return new Map(rows.map((r) => [r.day, Number(r.boxes)]));
}

/**
 * Expected boxes per day: the average of the last seven graded days. Falls
 * back to the bird record's lay (÷ eggs per box) while no sheet exists yet,
 * so the calendar has a denominator from day one.
 */
export async function expectedGradedBoxesPerDay(tx: Conn): Promise<number | null> {
  const rows = await tx
    .select({
      day: eggGrading.gradedOn,
      boxes: sql<string>`sum(${eggGrading.small} + ${eggGrading.medium} + ${eggGrading.large} + ${eggGrading.xl} + ${eggGrading.jumbo} + ${eggGrading.dirty})`,
    })
    .from(eggGrading)
    .groupBy(eggGrading.gradedOn)
    .orderBy(desc(eggGrading.gradedOn))
    .limit(7);
  if (!rows.length) return expectedBoxesPerDay(tx);
  return Math.round(rows.reduce((a, r) => a + Number(r.boxes), 0) / rows.length);
}

/**
 * Net stock movement per day across all sizes, so a past day's opening can
 * be rebuilt from the ledger: opening(d) = stock now − Σ movements on/after d.
 */
export async function netMovesByDay(tx: Conn, from: string): Promise<Map<string, number>> {
  const map = await sizeItems(tx);
  const ids = [...map.values()];
  if (!ids.length) return new Map();
  const rows = await tx
    .select({
      day: inventoryTransactions.transactionDate,
      q: sql<string>`sum(${inventoryTransactions.quantity})`,
    })
    .from(inventoryTransactions)
    .where(and(inArray(inventoryTransactions.itemId, ids), gte(inventoryTransactions.transactionDate, from)))
    .groupBy(inventoryTransactions.transactionDate);
  return new Map(rows.map((r) => [r.day, Number(r.q)]));
}

/* ── The loading ─────────────────────────────────────────────────────────── */

export interface LoadInput {
  dispatchDate: string;
  customerId: string;
  /** One of these, or neither for a walk-in. */
  agreementId?: string;
  spotOrderId?: string;
  loaded: Partial<Record<EggSize, number>>;
  driverName: string;
  vehicleNumber: string;
  notes?: string;
}

/**
 * The bay's one action: record what left, raise the invoice, move the stock.
 *
 * Everything in one transaction. The invoice prices from the day's benchmark;
 * a day with no benchmark refuses to load rather than guessing.
 */
export async function loadAndInvoice(tx: Tx, input: LoadInput, userId: string) {
  const prefs = await eggPrefs(tx);
  const bm = await benchmarkOn(tx, input.dispatchDate);
  if (!bm) {
    throw new PostingError(
      `No benchmark rate is set for ${input.dispatchDate} — set it on the Benchmark page before loading`,
    );
  }
  if (bm.effectiveFrom !== input.dispatchDate) {
    // In force but stale — allowed, said out loud on the invoice note below.
  }
  const offsets = await sizeOffsetsOn(tx, input.dispatchDate);

  const qty = (s: EggSize) => Math.max(0, Math.trunc(input.loaded[s] ?? 0));
  const totalBoxes = EGG_SIZES.reduce((a, s) => a + qty(s), 0);
  if (totalBoxes <= 0) throw new PostingError("Nothing was loaded — at least one size must be above zero");
  if (!input.driverName.trim()) throw new PostingError("Who is driving?");
  if (!input.vehicleNumber.trim()) throw new PostingError("Which vehicle?");
  if (input.agreementId && input.spotOrderId) {
    throw new PostingError("A loading answers one order, not two");
  }

  /** The spread: the order's own, else the customer's standing one, else zero. */
  let spread = 0;
  let spotOrderId = input.spotOrderId ?? null;
  if (input.spotOrderId) {
    const [spot] = await tx.select().from(eggSpotOrders).where(eq(eggSpotOrders.id, input.spotOrderId));
    if (!spot) throw new PostingError("No such spot order");
    if (spot.status === "voided") throw new PostingError("That spot order was voided — book a fresh one");
    const already = await tx
      .select({ id: eggDispatches.id })
      .from(eggDispatches)
      .where(and(eq(eggDispatches.spotOrderId, spot.id), ne(eggDispatches.status, "void")));
    if (already.length) throw new PostingError("That spot order is already loaded and invoiced");
    spread = Number(spot.spreadPerEgg ?? (await standingSpread(tx, input.customerId, input.dispatchDate)) ?? 0);
  } else if (input.agreementId) {
    const [ag] = await tx.select().from(eggAgreements).where(eq(eggAgreements.id, input.agreementId));
    if (!ag) throw new PostingError("No such agreement");
    /**
     * A skipped day said "no delivery" — loading against the agreement anyway
     * would quietly un-say it. If the truck turned up regardless, that is a
     * walk-in, and booking it as one keeps the skip's story intact.
     */
    const [skipped] = await tx
      .select({ id: eggAgreementExceptions.id })
      .from(eggAgreementExceptions)
      .where(
        and(
          eq(eggAgreementExceptions.agreementId, ag.id),
          eq(eggAgreementExceptions.onDate, input.dispatchDate),
          eq(eggAgreementExceptions.kind, "skip"),
        ),
      );
    if (skipped) {
      throw new PostingError(
        "This day was skipped for the agreement — restore it on the calendar, or load as a walk-in",
      );
    }
    const already = await tx
      .select({ id: eggDispatches.id })
      .from(eggDispatches)
      .where(
        and(
          eq(eggDispatches.agreementId, ag.id),
          eq(eggDispatches.dispatchDate, input.dispatchDate),
          ne(eggDispatches.status, "void"),
        ),
      );
    if (already.length) {
      throw new PostingError("Today's delivery under this agreement is already loaded and invoiced");
    }
    spread = Number(ag.spreadPerEgg);
  } else {
    /**
     * A walk-in: the truck is at the gate with no booking. The spot order is
     * created here so the day's book still shows what happened as an order,
     * not as an invoice from nowhere.
     */
    const [spot] = await tx
      .insert(eggSpotOrders)
      .values({
        customerId: input.customerId,
        orderDate: input.dispatchDate,
        boxes: totalBoxes,
        small: qty("small"),
        medium: qty("medium"),
        large: qty("large"),
        xl: qty("xl"),
        jumbo: qty("jumbo"),
        dirty: qty("dirty"),
        notes: "Walk-in, booked at the bay",
        createdBy: userId,
      })
      .returning();
    spotOrderId = spot!.id;
    spread = Number((await standingSpread(tx, input.customerId, input.dispatchDate)) ?? 0);
  }

  /** Rupees per egg for a size — the whole pricing rule, in one line each. */
  const perEgg = (s: EggSize) => Number(bm.ratePerEgg) + Number(offsets?.[s] ?? 0) + spread;

  const customer = await loadCustomer(tx, input.customerId);
  const map = await sizeItems(tx);

  /**
   * A truck cannot take boxes that are not on the pile. Checked per size
   * against the pooled stock, before any paper is raised.
   */
  const held = await stockBySize(tx);
  for (const s of EGG_SIZES) {
    if (qty(s) > held[s]) {
      throw new PostingError(
        `Only ${held[s].toLocaleString("en-IN")} ${SIZE_LABEL[s]} box(es) in store — cannot load ${qty(s)}`,
      );
    }
  }

  const docLines: DocLineInput[] = EGG_SIZES.filter((s) => qty(s) > 0).map((s) => ({
    itemId: map.get(s),
    name: `Eggs — ${SIZE_LABEL[s]} (${qty(s)} box × ${prefs.eggsPerBox})`,
    quantity: String(qty(s) * prefs.eggsPerBox),
    unit: "eggs",
    rate: perEgg(s).toFixed(4),
  }));

  const totals = await computeDocumentTotals(tx, docLines, customer.placeOfSupplyState);

  /**
   * Payment first, truck second. The invoice is only raised against funds the
   * ledger actually holds — Amino's gate rule, enforced where the invoice is
   * born so no screen can slip past it.
   */
  const available = await ledgerAvailable(tx, input.customerId);
  if (Number(totals.total) > available + 0.005) {
    throw new PostingError(
      `${customer.displayName}'s ledger holds ₹${available.toLocaleString("en-IN", { maximumFractionDigits: 2 })} ` +
        `against a load of ₹${Number(totals.total).toLocaleString("en-IN", { maximumFractionDigits: 2 })} — ` +
        `record their payment first`,
    );
  }

  const number = await nextDocumentNumber(tx, "invoice");
  const benchNote =
    bm.effectiveFrom === input.dispatchDate
      ? `Benchmark ₹${Number(bm.ratePerEgg).toFixed(2)}/egg`
      : `Benchmark ₹${Number(bm.ratePerEgg).toFixed(2)}/egg (set ${bm.effectiveFrom} — no fresher rate)`;
  const [inv] = await tx
    .insert(invoices)
    .values({
      number,
      customerId: customer.id,
      status: "draft",
      invoiceDate: input.dispatchDate,
      dueDate: computeDueDate(input.dispatchDate, customer.paymentTermsDays),
      reference: `Egg dispatch ${input.dispatchDate}`,
      placeOfSupplyState: customer.placeOfSupplyState,
      subTotal: totals.subTotal,
      discountTotal: totals.discountTotal,
      cgst: totals.cgst,
      sgst: totals.sgst,
      igst: totals.igst,
      roundOff: totals.roundOff,
      total: totals.total,
      balanceDue: totals.total,
      customerNotes:
        `${benchNote}${spread ? `, spread ₹${spread.toFixed(2)}/egg` : ""}. ` +
        `Driver ${input.driverName.trim()}, vehicle ${input.vehicleNumber.trim()}.`,
      createdBy: userId,
    })
    .returning();
  const withAccounts = await applyDefaultSalesAccounts(tx, totals.lines);
  await tx.insert(invoiceLines).values(withAccounts.map((l) => ({ ...l, invoiceId: inv!.id })));
  const jeId = await postInvoiceJournal(tx, inv!, customer.displayName, userId);
  await tx.update(invoices).set({ status: "sent", journalEntryId: jeId }).where(eq(invoices.id, inv!.id));

  /**
   * The funds the gate just checked settle the invoice on the spot: the truck
   * leaves with a PAID invoice, not a due one the accountant must chase.
   */
  await applyAdvancesToInvoice(tx, inv!.id, userId);

  const [dispatch] = await tx
    .insert(eggDispatches)
    .values({
      dispatchDate: input.dispatchDate,
      customerId: input.customerId,
      agreementId: input.agreementId ?? null,
      spotOrderId,
      loadedSmall: qty("small"),
      loadedMedium: qty("medium"),
      loadedLarge: qty("large"),
      loadedXl: qty("xl"),
      loadedJumbo: qty("jumbo"),
      loadedDirty: qty("dirty"),
      driverName: input.driverName.trim(),
      vehicleNumber: input.vehicleNumber.trim(),
      notes: input.notes?.trim() || null,
      invoiceId: inv!.id,
      loadedBy: userId,
    })
    .returning();

  /**
   * Stock: the boxes leave the pool, size by size, tied to the invoice so the
   * void path can find and reverse them. Only once stock has begun counting —
   * a dispatch before stockFrom (backdated paperwork) moves no stock, same as
   * grading before it wrote none.
   */
  if (input.dispatchDate >= prefs.stockFrom) {
    await moveStock(tx, {
      movements: EGG_SIZES.filter((s) => qty(s) > 0).map((s) => ({
        itemId: map.get(s)!,
        quantity: `-${qty(s).toFixed(3)}`,
        value: `-${(qty(s) * prefs.eggsPerBox * perEgg(s)).toFixed(2)}`,
        notes: `Invoice ${number}`,
      })),
      transactionDate: input.dispatchDate,
      sourceType: "invoice",
      sourceId: inv!.id,
      stockLocationId: await mainStore(tx, null),
    });
  }

  return { dispatch: dispatch!, invoiceId: inv!.id, invoiceNumber: number };
}

/**
 * Settle a fresh invoice from the customer's advances, oldest money first.
 *
 * The bay runs payment-first, so by the time an invoice is born the funds are
 * sitting in `customer_advances`. Leaving them there would show the customer
 * owing an invoice they have already paid for; this moves the money the rest
 * of the way — application rows, the payments' unapplied balances, the
 * invoice's own balance, and one journal shifting the liability into the
 * receivable (DR advances / CR AR).
 *
 * Applies what advances can cover and leaves any remainder due — credit notes
 * count toward the loading gate but are not consumed here, so an invoice
 * riding on a credit note comes out partially paid rather than wrongly whole.
 */
export async function applyAdvancesToInvoice(tx: Tx, invoiceId: string, userId: string): Promise<string> {
  const [inv] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId));
  if (!inv || !["sent", "partially_paid"].includes(inv.status)) return "0.00";

  const open = await tx
    .select()
    .from(customerPayments)
    .where(
      and(
        eq(customerPayments.customerId, inv.customerId),
        sql`${customerPayments.unappliedAmount}::numeric > 0`,
      ),
    )
    .orderBy(asc(customerPayments.paymentDate), asc(customerPayments.createdAt));

  let remainingP = toPaise(inv.balanceDue);
  let appliedP = 0;
  for (const p of open) {
    if (remainingP <= 0) break;
    const takeP = Math.min(toPaise(p.unappliedAmount), remainingP);
    if (takeP <= 0) continue;
    await tx.insert(paymentApplications).values({
      paymentId: p.id,
      invoiceId: inv.id,
      amountApplied: fromPaise(takeP),
    });
    await tx
      .update(customerPayments)
      .set({ unappliedAmount: fromPaise(toPaise(p.unappliedAmount) - takeP) })
      .where(eq(customerPayments.id, p.id));
    remainingP -= takeP;
    appliedP += takeP;
  }
  if (appliedP > 0) {
    await tx
      .update(invoices)
      .set({
        balanceDue: fromPaise(remainingP),
        status: remainingP === 0 ? "paid" : "partially_paid",
        updatedAt: new Date(),
      })
      .where(eq(invoices.id, inv.id));
    await postJournal(tx, {
      entryDate: inv.invoiceDate,
      narration: `Advance applied to ${inv.number}`,
      sourceType: "advance_application",
      sourceId: inv.id,
      postedBy: userId,
      lines: [
        { systemKey: "customer_advances", debit: fromPaise(appliedP) },
        { systemKey: "ar", credit: fromPaise(appliedP) },
      ],
    });
  }
  return fromPaise(appliedP);
}

/**
 * The inverse, for the void path: hand every applied payment back to the
 * customer's advances so the invoice can be voided at full balance. The
 * reversing journal is dated to the void, not backdated to the application.
 */
export async function unapplyInvoicePayments(tx: Tx, invoiceId: string, on: string, userId: string): Promise<void> {
  const [inv] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId));
  if (!inv) return;
  const apps = await tx
    .select()
    .from(paymentApplications)
    .where(eq(paymentApplications.invoiceId, invoiceId));
  if (!apps.length) return;

  let returnedP = 0;
  for (const a of apps) {
    const [p] = await tx.select().from(customerPayments).where(eq(customerPayments.id, a.paymentId));
    if (!p) continue;
    await tx
      .update(customerPayments)
      .set({ unappliedAmount: fromPaise(toPaise(p.unappliedAmount) + toPaise(a.amountApplied)) })
      .where(eq(customerPayments.id, p.id));
    returnedP += toPaise(a.amountApplied);
  }
  await tx.delete(paymentApplications).where(eq(paymentApplications.invoiceId, invoiceId));
  await tx
    .update(invoices)
    .set({ balanceDue: inv.total, status: "sent", updatedAt: new Date() })
    .where(eq(invoices.id, invoiceId));
  if (returnedP > 0) {
    await postJournal(tx, {
      entryDate: on,
      narration: `Advance returned on void of ${inv.number}`,
      sourceType: "advance_application",
      sourceId: inv.id,
      postedBy: userId,
      lines: [
        { systemKey: "ar", debit: fromPaise(returnedP) },
        { systemKey: "customer_advances", credit: fromPaise(returnedP) },
      ],
    });
  }
}

/**
 * What the customer's ledger can pay for right now.
 *
 * Money in hand (unapplied payments, open credit notes) minus what they
 * already owe (unpaid invoice balances). The trade runs payment-first: the
 * customer transfers, then the truck loads — so an invoice may only be raised
 * against funds that are actually there.
 */
export async function ledgerAvailable(tx: Conn, customerId: string): Promise<number> {
  const [advances] = await tx
    .select({ v: sql<string>`coalesce(sum(${customerPayments.unappliedAmount}), 0)` })
    .from(customerPayments)
    .where(eq(customerPayments.customerId, customerId));
  const [credits] = await tx
    .select({ v: sql<string>`coalesce(sum(${creditNotes.balance}), 0)` })
    .from(creditNotes)
    .where(and(eq(creditNotes.customerId, customerId), sql`${creditNotes.status} NOT IN ('void', 'draft')`));
  const [dues] = await tx
    .select({ v: sql<string>`coalesce(sum(${invoices.balanceDue}), 0)` })
    .from(invoices)
    .where(and(eq(invoices.customerId, customerId), sql`${invoices.status} NOT IN ('void', 'draft')`));
  return Number(advances!.v) + Number(credits!.v) - Number(dues!.v);
}

/** The customer's standing spread, if they hold an agreement alive on the day. */
async function standingSpread(tx: Conn, customerId: string, on: string): Promise<string | null> {
  const [ag] = await tx
    .select({ spread: eggAgreements.spreadPerEgg })
    .from(eggAgreements)
    .where(
      and(
        eq(eggAgreements.customerId, customerId),
        eq(eggAgreements.status, "active"),
        lte(eggAgreements.startDate, on),
        or(isNull(eggAgreements.endDate), gte(eggAgreements.endDate, on)),
      ),
    )
    .orderBy(desc(eggAgreements.startDate))
    .limit(1);
  return ag?.spread ?? null;
}

/**
 * Called from the invoice void path: a voided egg invoice takes its dispatch
 * with it, and the day's order line derives back to "due". The stock reversal
 * is the void route's own job (it reverses by sourceType/sourceId), not this.
 */
export async function voidDispatchForInvoice(tx: Tx, invoiceId: string): Promise<void> {
  await tx
    .update(eggDispatches)
    .set({ status: "void" })
    .where(eq(eggDispatches.invoiceId, invoiceId));
}

/** For screens that show who set what. */
export async function benchmarkHistory(tx: Conn, limit = 60) {
  return tx
    .select({
      id: eggBenchmarkPrices.id,
      effectiveFrom: eggBenchmarkPrices.effectiveFrom,
      ratePerEgg: eggBenchmarkPrices.ratePerEgg,
      source: eggBenchmarkPrices.source,
      note: eggBenchmarkPrices.note,
      setBy: users.name,
      createdAt: eggBenchmarkPrices.createdAt,
    })
    .from(eggBenchmarkPrices)
    .leftJoin(users, eq(users.id, eggBenchmarkPrices.createdBy))
    .orderBy(desc(eggBenchmarkPrices.effectiveFrom))
    .limit(limit);
}
