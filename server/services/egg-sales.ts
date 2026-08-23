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
  eggAgreementExceptions,
  eggAgreements,
  eggBenchmarkPrices,
  eggDispatches,
  eggSalesPreferences,
  eggSizeOffsets,
  eggSpotOrders,
  invoiceLines,
  invoices,
  placementDays,
  users,
} from "@shared/schema";
import type { db as Db } from "../db";
import { PostingError } from "./posting";
import { applyDefaultSalesAccounts, computeDocumentTotals, type DocLineInput } from "./documents";
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
  boxes: number;
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
      boxes: eggSpotOrders.boxes,
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
      lines.push({
        kind: "standing",
        sourceId: a.id,
        customerId: a.customerId,
        customerName: a.customerName,
        boxes: 0,
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
      boxes: ex?.kind === "qty_override" ? (ex.boxes ?? a.boxes) : a.boxes,
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
      boxes: s.boxes,
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

/* ── Egg stock ─────────────────────────────────────────────────────────────
 *
 * The store's egg count follows the same ledger as everything else:
 * +eggs when the day-end production record is saved, −eggs when a dispatch is
 * invoiced. Production before prefs.stockFrom writes nothing — that history
 * has no matching sales and would pile up a phantom mountain.
 */

/**
 * Re-state one house-day's production in the stock ledger.
 *
 * Delete-and-rewrite rather than insert, because the day's record is itself
 * saved that way: correcting eggs from 4,100 to 4,010 must correct the stock
 * movement, not add a second one.
 */
export async function syncEggProduction(
  tx: Tx,
  placementId: string,
  day: string,
  eggsTotal: number | null,
): Promise<void> {
  const prefs = await eggPrefs(tx);
  if (day < prefs.stockFrom || !prefs.eggItemId) return;

  await tx.execute(sql`
    DELETE FROM inventory_transactions
    WHERE source_type = 'egg_production'
      AND source_id = ${placementId}::uuid
      AND transaction_date = ${day}
  `);
  if (!eggsTotal || eggsTotal <= 0) return;

  await moveStock(tx, {
    movements: [{ itemId: prefs.eggItemId, quantity: eggsTotal.toFixed(3) }],
    transactionDate: day,
    sourceType: "egg_production",
    sourceId: placementId,
    stockLocationId: await mainStore(tx, null),
  });
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
  const docLines: DocLineInput[] = EGG_SIZES.filter((s) => qty(s) > 0).map((s) => ({
    itemId: prefs.eggItemId ?? undefined,
    name: `Eggs — ${SIZE_LABEL[s]} (${qty(s)} box × ${prefs.eggsPerBox})`,
    quantity: String(qty(s) * prefs.eggsPerBox),
    unit: "eggs",
    rate: perEgg(s).toFixed(4),
  }));

  const totals = await computeDocumentTotals(tx, docLines, customer.placeOfSupplyState);
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
   * Stock: the eggs leave the farm store, tied to the invoice so the invoice
   * void path can find and reverse them. Only once stock has begun counting —
   * a dispatch before stockFrom (backdated paperwork) moves no stock, same as
   * production before it wrote none.
   */
  if (prefs.eggItemId && input.dispatchDate >= prefs.stockFrom) {
    const totalEggs = totalBoxes * prefs.eggsPerBox;
    await moveStock(tx, {
      movements: [
        {
          itemId: prefs.eggItemId,
          quantity: `-${totalEggs.toFixed(3)}`,
          value: `-${totals.subTotal}`,
          notes: `Invoice ${number}`,
        },
      ],
      transactionDate: input.dispatchDate,
      sourceType: "invoice",
      sourceId: inv!.id,
      stockLocationId: await mainStore(tx, null),
    });
  }

  return { dispatch: dispatch!, invoiceId: inv!.id, invoiceNumber: number };
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
