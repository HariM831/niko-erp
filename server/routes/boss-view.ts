/**
 * The boss view — the whole operation on one screen, for a date range.
 *
 * Ported from Amino's executive report, section for section, but every
 * figure is computed from EGGSY's own tables: gate receipts for purchases,
 * production orders and feed transfers for the mill, flock_day for the farm,
 * invoices and the benchmark for sales, bills for payables. The group
 * companies are excluded wherever a customer or vendor is being counted —
 * they are the group, not the market. Amino's People section has no source
 * here yet (there is no attendance module), so it is honestly absent rather
 * than shown empty.
 */
import { Router } from "express";
import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import {
  bills,
  contacts,
  eggBenchmarkPrices,
  eggSizeItems,
  feedTransfers,
  flockDay,
  formulas,
  houses,
  invoiceLines,
  invoices,
  items,
  officeReceiptLines,
  officeReceipts,
  productionOrders,
  purchaseOrderLines,
  purchaseOrders,
} from "@shared/schema";
import { db } from "../db";
import { requirePermission } from "../lib/rbac";
import { eggPrefs } from "../services/egg-sales";

export const bossViewRouter = Router();

const n = (v: unknown) => Number(v ?? 0);
const notGroup = eq(contacts.isGroupCompany, false);

bossViewRouter.get("/", requirePermission("reports", "view"), async (req, res) => {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
  const from = (req.query.from as string) || today;
  const to = (req.query.to as string) || today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return res.status(400).json({ error: "from/to must be YYYY-MM-DD" });
  }

  /* ── Purchases: what came through the gate ─────────────────────────── */
  const arrived = sql`${officeReceipts.arrivalAt}::date BETWEEN ${from} AND ${to}`;
  const receivedLines = await db
    .select({
      itemName: sql<string>`coalesce(${items.name}, ${officeReceiptLines.itemName}, ${officeReceiptLines.billDescription}, '—')`,
      vendor: contacts.displayName,
      kg: officeReceiptLines.billQuantityKg,
      amount: officeReceiptLines.billAmount,
      date: sql<string>`${officeReceipts.arrivalAt}::date`,
      receiptId: officeReceipts.id,
    })
    .from(officeReceiptLines)
    .innerJoin(officeReceipts, eq(officeReceipts.id, officeReceiptLines.receiptId))
    .leftJoin(items, eq(items.id, officeReceiptLines.itemId))
    .leftJoin(contacts, eq(contacts.id, officeReceipts.vendorId))
    .where(
      and(
        arrived,
        sql`${officeReceipts.status} NOT IN ('turned_away', 'rejected')`,
        sql`${officeReceiptLines.status} <> 'qc_rejected'`,
      ),
    )
    .orderBy(desc(officeReceipts.arrivalAt));

  const byIngredient = new Map<string, { kg: number; value: number }>();
  for (const l of receivedLines) {
    const cur = byIngredient.get(l.itemName) ?? { kg: 0, value: 0 };
    cur.kg += n(l.kg);
    cur.value += n(l.amount);
    byIngredient.set(l.itemName, cur);
  }
  const pendingPOs = await db
    .select({
      vendor: contacts.displayName,
      item: purchaseOrderLines.name,
      pendingKg: sql<string>`${purchaseOrderLines.quantity} - ${purchaseOrderLines.deliveredQuantity}`,
      rate: purchaseOrderLines.rate,
      number: purchaseOrders.number,
    })
    .from(purchaseOrderLines)
    .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderLines.purchaseOrderId))
    .innerJoin(contacts, eq(contacts.id, purchaseOrders.vendorId))
    .where(
      and(
        sql`${purchaseOrders.status} NOT IN ('draft', 'cancelled', 'closed')`,
        sql`${purchaseOrderLines.quantity} > ${purchaseOrderLines.deliveredQuantity}`,
        notGroup,
      ),
    )
    .orderBy(asc(contacts.displayName));

  const purchases = {
    totalTonnageKg: receivedLines.reduce((a, l) => a + n(l.kg), 0),
    deliveryCount: new Set(receivedLines.map((l) => l.receiptId)).size,
    pendingTonnageKg: pendingPOs.reduce((a, p) => a + n(p.pendingKg), 0),
    tonnageByIngredient: [...byIngredient.entries()]
      .map(([name, v]) => ({ name, kg: v.kg, avgRate: v.kg ? v.value / v.kg : 0 }))
      .sort((a, b) => b.kg - a.kg),
    deliveries: receivedLines.map((l) => ({
      item: l.itemName,
      vendor: l.vendor ?? "—",
      kg: n(l.kg),
      rate: n(l.kg) ? n(l.amount) / n(l.kg) : 0,
      value: n(l.amount),
      date: l.date,
    })),
    pendingPOs: pendingPOs.map((p) => ({ vendor: p.vendor, item: p.item, pendingKg: n(p.pendingKg), rate: n(p.rate), number: p.number })),
  };

  /* ── Feed mill: made and sent ──────────────────────────────────────── */
  const produced = await db
    .select({
      formula: formulas.name,
      batches: sql<number>`count(*)::int`,
      kg: sql<string>`coalesce(sum(${productionOrders.actualOutputKg}), 0)`,
      value: sql<string>`coalesce(sum(coalesce(${productionOrders.inputValue}, 0) + coalesce(${productionOrders.overheadValue}, 0)), 0)`,
    })
    .from(productionOrders)
    .innerJoin(formulas, eq(formulas.id, productionOrders.formulaId))
    .where(
      and(
        eq(productionOrders.status, "completed"),
        gte(productionOrders.orderDate, from),
        lte(productionOrders.orderDate, to),
      ),
    )
    .groupBy(formulas.name)
    .orderBy(desc(sql`sum(${productionOrders.actualOutputKg})`));
  const transferred = await db
    .select({
      house: sql<string>`coalesce(${houses.code}, '—')`,
      item: items.name,
      kg: sql<string>`coalesce(sum(${feedTransfers.quantityKg}), 0)`,
      value: sql<string>`coalesce(sum(${feedTransfers.value}), 0)`,
    })
    .from(feedTransfers)
    .innerJoin(items, eq(items.id, feedTransfers.itemId))
    .leftJoin(houses, eq(houses.id, feedTransfers.toHouseId))
    .where(
      and(
        eq(feedTransfers.status, "completed"),
        gte(feedTransfers.transferDate, from),
        lte(feedTransfers.transferDate, to),
      ),
    )
    .groupBy(houses.code, items.name)
    .orderBy(asc(houses.code));
  const producedKg = produced.reduce((a, r) => a + n(r.kg), 0);
  const producedValue = produced.reduce((a, r) => a + n(r.value), 0);
  const feedMill = {
    totalProducedKg: producedKg,
    totalTransferredKg: transferred.reduce((a, r) => a + n(r.kg), 0),
    costPerKg: producedKg ? producedValue / producedKg : 0,
    produced: produced.map((r) => ({ formula: r.formula, batches: r.batches, kg: n(r.kg), costPerKg: n(r.kg) ? n(r.value) / n(r.kg) : 0 })),
    transferred: transferred.map((r) => ({ house: r.house, item: r.item, kg: n(r.kg), ratePerKg: n(r.kg) ? n(r.value) / n(r.kg) : 0 })),
  };

  /* ── Farm: from the rollup ─────────────────────────────────────────── */
  const farmRows = await db
    .select({
      house: houses.code,
      eggs: sql<string>`coalesce(sum(${flockDay.eggs}), 0)`,
      feedKg: sql<string>`coalesce(sum(${flockDay.feedKg}), 0)`,
      mortality: sql<string>`coalesce(sum(${flockDay.mortality}), 0)`,
      birdDays: sql<string>`coalesce(sum(${flockDay.closingBirds}), 0)`,
      days: sql<number>`count(*)::int`,
      openingBirds: sql<string>`coalesce((array_agg(${flockDay.openingBirds} ORDER BY ${flockDay.day}))[1], 0)`,
    })
    .from(flockDay)
    .innerJoin(houses, eq(houses.id, flockDay.houseId))
    .where(and(gte(flockDay.day, from), lte(flockDay.day, to), eq(flockDay.phase, "lay")))
    .groupBy(houses.code, houses.displayOrder)
    // A house that laid nothing in the range is not a laying house for it.
    .having(sql`coalesce(sum(${flockDay.eggs}), 0) > 0`)
    .orderBy(asc(houses.displayOrder));
  const farmEggs = farmRows.reduce((a, r) => a + n(r.eggs), 0);
  const farmBirdDays = farmRows.reduce((a, r) => a + n(r.birdDays), 0);
  const farmFeedKg = farmRows.reduce((a, r) => a + n(r.feedKg), 0);
  const farmMortality = farmRows.reduce((a, r) => a + n(r.mortality), 0);
  const farmOpening = farmRows.reduce((a, r) => a + n(r.openingBirds), 0);
  const farm = {
    totalEggs: farmEggs,
    layRatePct: farmBirdDays ? (farmEggs / farmBirdDays) * 100 : 0,
    mortalityPct: farmOpening ? (farmMortality / farmOpening) * 100 : 0,
    feedPerEggG: farmEggs ? (farmFeedKg * 1000) / farmEggs : 0,
    houses: farmRows.map((r) => ({
      house: r.house,
      eggs: n(r.eggs),
      feedKg: n(r.feedKg),
      mortality: n(r.mortality),
      days: r.days,
      layRatePct: n(r.birdDays) ? (n(r.eggs) / n(r.birdDays)) * 100 : 0,
      mortalityPct: n(r.openingBirds) ? (n(r.mortality) / n(r.openingBirds)) * 100 : 0,
      feedPerEggG: n(r.eggs) ? (n(r.feedKg) * 1000) / n(r.eggs) : 0,
    })),
  };

  /* ── Sales: the market, never the group ────────────────────────────── */
  const eggItemIds = (await db.select({ id: eggSizeItems.itemId }).from(eggSizeItems)).map((r) => r.id);
  const salesRows = await db
    .select({
      customer: contacts.displayName,
      value: sql<string>`coalesce(sum(${invoices.total}), 0)`,
      count: sql<number>`count(*)::int`,
    })
    .from(invoices)
    .innerJoin(contacts, eq(contacts.id, invoices.customerId))
    .where(
      and(
        sql`${invoices.status} NOT IN ('draft', 'void')`,
        gte(invoices.invoiceDate, from),
        lte(invoices.invoiceDate, to),
        notGroup,
      ),
    )
    .groupBy(contacts.displayName)
    .orderBy(desc(sql`sum(${invoices.total})`));
  const eggsSold = eggItemIds.length
    ? await db
        .select({
          customer: contacts.displayName,
          eggs: sql<string>`coalesce(sum(${invoiceLines.quantity}), 0)`, // boxes
        })
        .from(invoiceLines)
        .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
        .innerJoin(contacts, eq(contacts.id, invoices.customerId))
        .where(
          and(
            inArray(invoiceLines.itemId, eggItemIds),
            sql`${invoices.status} NOT IN ('draft', 'void')`,
            gte(invoices.invoiceDate, from),
            lte(invoices.invoiceDate, to),
            notGroup,
          ),
        )
        .groupBy(contacts.displayName)
    : [];
  // Egg lines are in boxes; the boss wants eggs.
  const { eggsPerBox } = await eggPrefs(db);
  const eggsByCustomer = new Map(eggsSold.map((r) => [r.customer, n(r.eggs) * eggsPerBox]));
  const benchmarks = await db
    .select({ on: eggBenchmarkPrices.effectiveFrom, rate: eggBenchmarkPrices.ratePerEgg })
    .from(eggBenchmarkPrices)
    .orderBy(asc(eggBenchmarkPrices.effectiveFrom));
  const inRange = benchmarks.filter((b) => b.on >= from && b.on <= to);
  const latestBefore = benchmarks.filter((b) => b.on <= to).slice(-1)[0];
  const avgBenchmark = inRange.length
    ? inRange.reduce((a, b) => a + n(b.rate), 0) / inRange.length
    : n(latestBefore?.rate);
  const sales = {
    totalSales: salesRows.reduce((a, r) => a + n(r.value), 0),
    totalEggs: [...eggsByCustomer.values()].reduce((a, v) => a + v, 0),
    invoiceCount: salesRows.reduce((a, r) => a + r.count, 0),
    avgBenchmarkRate: avgBenchmark,
    salesList: salesRows.map((r) => ({ customer: r.customer, value: n(r.value), invoices: r.count, eggs: eggsByCustomer.get(r.customer) ?? 0 })),
    priceHistory: benchmarks.slice(-30).map((b) => ({ date: b.on, price: n(b.rate) })),
  };

  /* ── Finance: what the market owes and is owed ─────────────────────── */
  const [ar] = await db
    .select({ v: sql<string>`coalesce(sum(${invoices.balanceDue}), 0)` })
    .from(invoices)
    .innerJoin(contacts, eq(contacts.id, invoices.customerId))
    .where(and(inArray(invoices.status, ["sent", "partially_paid"]), notGroup));
  const apDetails = await db
    .select({
      vendor: contacts.displayName,
      number: bills.number,
      total: bills.total,
      balanceDue: bills.balanceDue,
      dueDate: bills.dueDate,
      status: bills.status,
    })
    .from(bills)
    .innerJoin(contacts, eq(contacts.id, bills.vendorId))
    .where(and(inArray(bills.status, ["open", "partially_paid"]), notGroup))
    .orderBy(asc(bills.dueDate));
  const apTotal = apDetails.reduce((a, b) => a + n(b.balanceDue), 0);
  const finance = {
    totalRevenue: sales.totalSales,
    totalFeedCost: producedValue,
    receivables: n(ar?.v),
    payables: apTotal,
    grossMarginPct: sales.totalSales ? ((sales.totalSales - producedValue) / sales.totalSales) * 100 : 0,
    apDetails: apDetails.map((b) => ({ ...b, total: n(b.total), balanceDue: n(b.balanceDue) })),
  };

  res.json({ generatedAt: new Date().toISOString(), from, to, purchases, feedMill, farm, sales, finance });
});
