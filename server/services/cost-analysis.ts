/**
 * Cost Analysis — the farm's P&L stated per egg produced.
 *
 * Three kinds of line, three different clocks:
 *
 *   feed     — actual FIFO cost from `flock_day`, laying houses only, by DAY.
 *              A week is exact. Rearing feed is left out: it is what the
 *              pullet line stands in for, and counting both would charge the
 *              grower ration twice.
 *   pullet   — a constant, `preferences.pullet_cost_per_bird` ÷
 *              `eggs_per_pullet_life`, charged on every egg. Replaces the chick
 *              bill and the rearing feed (both mapped `excluded`).
 *   heads    — the P&L accounts mapped in Settings, summed from posted journal
 *              lines by MONTH and then shared into the range by eggs. Salaries
 *              post on the last day, power when the bill lands; read by entry
 *              date a week containing month-end carries the whole month's
 *              labour and the next week carries none. A calendar month is
 *              exactly Σ heads ÷ eggs with nothing smoothed.
 *
 * Income is document-driven and dated by the invoice, so like feed it is read
 * by day. The denominator everywhere is eggs PRODUCED (`flock_day.eggs`, every
 * house, every phase), which is the figure the farm asked for; eggs sold and
 * the realised price appear as a memo so the two can be compared.
 *
 * Group companies: the four layer houses belong to the two LLPs, and Amino's
 * books sell them feed and pullets and buy every egg back. Those three heads
 * are transfer prices, not costs, and the mapping excludes them — this is a
 * consolidated statement of one physical farm.
 */
import { and, asc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import {
  accounts,
  costAnalysisHeads,
  eggSizeItems,
  flockDay,
  houses,
  invoiceLines,
  invoices,
  journalEntries,
  journalEntryLines,
} from "@shared/schema";
import type { CostSection } from "@shared/schema";
import type { EggSize } from "@shared/egg-sizes";
import type { Db, Tx } from "../db";
import { daysInMonth, istDate, monthRange } from "./day-resolution";
import { eggPrefs, eggsInBox } from "./egg-sales";
import { getPreferences } from "./preferences";

type Conn = Db | Tx;

export interface CostLine {
  /** Null for the two synthetic lines (feed, pullet), which have no ledger. */
  accountId: string | null;
  code: string | null;
  name: string;
  amount: string;
  perEgg: string;
}

export interface CostSectionOut {
  lines: CostLine[];
  total: string;
  perEgg: string;
}

const d2 = (n: number) => n.toFixed(2);
const d3 = (n: number) => n.toFixed(3);

/** YYYY-MM for every calendar month the range touches, in order. */
function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.slice(0, 7).split("-").map(Number) as [number, number];
  const end = to.slice(0, 7);
  for (;;) {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    out.push(key);
    if (key >= end) break;
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

export async function costAnalysis(db: Conn, from: string, to: string) {
  if (!from || !to || from > to) throw new Error("Choose a date range");

  const prefs = await getPreferences(db);
  const pulletPerBird = Number(prefs.pulletCostPerBird);
  const eggsPerLife = Number(prefs.eggsPerPulletLife);
  const pulletPerEgg = eggsPerLife > 0 ? pulletPerBird / eggsPerLife : 0;

  const months = monthsBetween(from, to);
  const first = monthRange(Number(months[0]!.slice(0, 4)), Number(months[0]!.slice(5, 7))).from;
  const lastKey = months[months.length - 1]!;
  const last = monthRange(Number(lastKey.slice(0, 4)), Number(lastKey.slice(5, 7))).to;
  const today = istDate();

  // ---- eggs, by month: the whole month and the part inside the range ----
  const eggRows = await db
    .select({
      month: sql<string>`to_char(${flockDay.day}, 'YYYY-MM')`,
      eggs: sql<string>`coalesce(sum(${flockDay.eggs}), 0)`,
      inRange: sql<string>`coalesce(sum(${flockDay.eggs}) filter (where ${flockDay.day} between ${from} and ${to}), 0)`,
    })
    .from(flockDay)
    .where(and(gte(flockDay.day, first), lte(flockDay.day, last)))
    .groupBy(sql`to_char(${flockDay.day}, 'YYYY-MM')`);
  const eggsByMonth = new Map(eggRows.map((r) => [r.month, { eggs: Number(r.eggs), inRange: Number(r.inRange) }]));
  const eggs = months.reduce((n, m) => n + (eggsByMonth.get(m)?.inRange ?? 0), 0);
  const per = (amount: number) => (eggs > 0 ? d3(amount / eggs) : "0.000");

  /**
   * How much of a month's head belongs to the range. By eggs where the month
   * laid any; a month with heads and no eggs (books older than the farm) is
   * shared by days so its rupees are not lost from a range that covers it.
   */
  const share = (month: string) => {
    const e = eggsByMonth.get(month);
    if (e && e.eggs > 0) return e.inRange / e.eggs;
    const [y, mm] = month.split("-").map(Number) as [number, number];
    const r = monthRange(y, mm);
    const lo = from > r.from ? from : r.from;
    const hi = to < r.to ? to : r.to;
    const days = (Date.parse(`${hi}T00:00:00Z`) - Date.parse(`${lo}T00:00:00Z`)) / 86_400_000 + 1;
    return Math.max(0, days) / daysInMonth(y, mm);
  };

  // ---- feed: actual FIFO, laying houses, by day ----
  const [feedRow] = await db
    .select({
      kg: sql<string>`coalesce(sum(${flockDay.feedKg}), 0)`,
      cost: sql<string>`coalesce(sum(${flockDay.feedCost}), 0)`,
      incomplete: sql<boolean>`coalesce(bool_or(${flockDay.feedCostIncomplete}), false)`,
      unpricedDays: sql<number>`(count(*) filter (where ${flockDay.feedCost} is null and ${flockDay.feedKg} > 0))::int`,
    })
    .from(flockDay)
    .where(and(gte(flockDay.day, from), lte(flockDay.day, to), eq(flockDay.phase, "lay")));
  const [rearRow] = await db
    .select({ cost: sql<string>`coalesce(sum(${flockDay.feedCost}), 0)` })
    .from(flockDay)
    .where(and(gte(flockDay.day, from), lte(flockDay.day, to), eq(flockDay.phase, "rear")));
  const feedAmount = Number(feedRow?.cost ?? 0);

  const feedByHouse = await db
    .select({
      code: houses.code,
      eggs: sql<string>`coalesce(sum(${flockDay.eggs}), 0)`,
      kg: sql<string>`coalesce(sum(${flockDay.feedKg}), 0)`,
      cost: sql<string>`coalesce(sum(${flockDay.feedCost}), 0)`,
    })
    .from(flockDay)
    .innerJoin(houses, eq(houses.id, flockDay.houseId))
    .where(and(gte(flockDay.day, from), lte(flockDay.day, to), eq(flockDay.phase, "lay")))
    .groupBy(houses.code)
    .orderBy(asc(houses.code));

  // ---- heads: posted journal lines on mapped accounts, by month ----
  const headRows = await db
    .select({
      accountId: accounts.id,
      code: accounts.code,
      name: accounts.name,
      type: accounts.type,
      section: costAnalysisHeads.section,
      month: sql<string>`to_char(${journalEntries.entryDate}, 'YYYY-MM')`,
      net: sql<string>`coalesce(sum(${journalEntryLines.debit} - ${journalEntryLines.credit}), 0)`,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalEntryLines.entryId))
    .innerJoin(accounts, eq(accounts.id, journalEntryLines.accountId))
    .leftJoin(costAnalysisHeads, eq(costAnalysisHeads.accountId, accounts.id))
    .where(
      and(
        eq(journalEntries.status, "posted"),
        gte(journalEntries.entryDate, first),
        lte(journalEntries.entryDate, last),
        inArray(accounts.type, ["income", "expense"]),
      ),
    )
    .groupBy(accounts.id, costAnalysisHeads.section, sql`to_char(${journalEntries.entryDate}, 'YYYY-MM')`);

  type Acc = { accountId: string; code: string; name: string; type: string; amount: number };
  const bySection = new Map<CostSection | "unassigned", Map<string, Acc>>();
  const add = (section: CostSection | "unassigned", r: (typeof headRows)[number], amount: number) => {
    const bucket = bySection.get(section) ?? new Map<string, Acc>();
    const acc = bucket.get(r.accountId) ?? {
      accountId: r.accountId,
      code: r.code,
      name: r.name,
      type: r.type,
      amount: 0,
    };
    acc.amount += amount;
    bucket.set(r.accountId, acc);
    bySection.set(section, bucket);
  };
  for (const r of headRows) {
    const section = (r.section ?? "unassigned") as CostSection | "unassigned";
    // Income reads credit-positive; everything else debit-positive.
    const signed = r.type === "income" ? -Number(r.net) : Number(r.net);
    // Income is invoice-dated, so it belongs to the days it fell on, not the
    // month it sits in; every other head is month-rated.
    const inRange = section === "income" ? signed * (await inRangeShareForIncome(db, r.accountId, r.month, from, to, signed)) : signed * share(r.month);
    add(section, r, inRange);
  }

  // ---- eggs sold and the realised price, from egg invoice lines ----
  //
  // Income is divided by eggs SOLD, not produced: a price is per egg that
  // left, and a month whose late-month lay is invoiced in the next month would
  // otherwise print a rate nobody was ever paid. Costs stay per egg produced.
  const ep = await eggPrefs(db);
  const sizeRows = await db.select().from(eggSizeItems);
  const perBox = new Map(sizeRows.map((s) => [s.itemId, eggsInBox(s.size as EggSize, ep)]));
  const sold = await db
    .select({
      itemId: invoiceLines.itemId,
      boxes: sql<string>`coalesce(sum(${invoiceLines.quantity}), 0)`,
      amount: sql<string>`coalesce(sum(${invoiceLines.amount}), 0)`,
    })
    .from(invoiceLines)
    .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
    .where(
      and(
        inArray(invoiceLines.itemId, [...perBox.keys()]),
        sql`${invoices.status} not in ('draft', 'void')`,
        gte(invoices.invoiceDate, from),
        lte(invoices.invoiceDate, to),
      ),
    )
    .groupBy(invoiceLines.itemId);
  let eggsSold = 0;
  let eggSales = 0;
  for (const s of sold) {
    eggsSold += Number(s.boxes) * (perBox.get(s.itemId!) ?? ep.eggsPerBox);
    eggSales += Number(s.amount);
  }
  eggsSold = Math.round(eggsSold);
  const perSold = (amount: number) => (eggsSold > 0 ? d3(amount / eggsSold) : "0.000");

  const sectionOut = (section: CostSection, extra: CostLine[] = []): CostSectionOut => {
    const divide = section === "income" ? perSold : per;
    const accs = [...(bySection.get(section)?.values() ?? [])]
      .filter((a) => Math.abs(a.amount) >= 0.005)
      .sort((a, b) => b.amount - a.amount);
    const lines: CostLine[] = [
      ...extra,
      ...accs.map((a) => ({
        accountId: a.accountId,
        code: a.code,
        name: a.name,
        amount: d2(a.amount),
        perEgg: divide(a.amount),
      })),
    ];
    const total = lines.reduce((n, l) => n + Number(l.amount), 0);
    return { lines, total: d2(total), perEgg: divide(total) };
  };

  const pulletAmount = pulletPerEgg * eggs;
  const income = sectionOut("income");
  const cogs = sectionOut("cogs", [
    {
      accountId: null,
      code: null,
      name: "Feed consumed — laying houses, FIFO",
      amount: d2(feedAmount),
      perEgg: per(feedAmount),
    },
    {
      accountId: null,
      code: null,
      name: `Pullet amortisation — ₹${pulletPerBird.toFixed(2)} ÷ ${eggsPerLife} eggs`,
      amount: d2(pulletAmount),
      perEgg: per(pulletAmount),
    },
  ]);
  const farm = sectionOut("farm");
  const mill = sectionOut("mill");
  const packing = sectionOut("packing");
  const admin = sectionOut("admin");
  const finance = sectionOut("finance");

  const grossProfit = Number(income.total) - Number(cogs.total);
  const operatingTotal =
    Number(farm.total) + Number(mill.total) + Number(packing.total) + Number(admin.total);
  const operatingProfit = grossProfit - operatingTotal;
  const netProfit = operatingProfit - Number(finance.total);

  // The profit lines mix the two denominators on purpose: income per egg sold
  // less cost per egg produced is the margin on an egg, which is what a reader
  // wants from a profit line. The rupee totals are the period's, as posted.
  const grossProfitPerEgg = Number(income.perEgg) - Number(cogs.perEgg);
  const operatingPerEgg = Number(per(operatingTotal));
  const operatingProfitPerEgg = grossProfitPerEgg - operatingPerEgg;
  const netProfitPerEgg = operatingProfitPerEgg - Number(finance.perEgg);
  const money = (n: number, perEggValue: number) => ({ amount: d2(n), perEgg: d3(perEggValue) });

  const unassigned = [...(bySection.get("unassigned")?.values() ?? [])]
    .filter((a) => Math.abs(a.amount) >= 0.005)
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
    .map((a) => ({ accountId: a.accountId, code: a.code, name: a.name, type: a.type, amount: d2(a.amount) }));
  const excluded = [...(bySection.get("excluded")?.values() ?? [])]
    .filter((a) => Math.abs(a.amount) >= 0.005)
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
    .map((a) => ({ accountId: a.accountId, code: a.code, name: a.name, amount: d2(a.amount) }));

  return {
    from,
    to,
    basis: "Accrual",
    eggs: {
      produced: eggs,
      sold: eggsSold,
      eggSales: d2(eggSales),
      realisedPerEggSold: eggsSold > 0 ? d3(eggSales / eggsSold) : null,
      months: months.map((m) => ({
        month: m,
        eggs: eggsByMonth.get(m)?.eggs ?? 0,
        inRange: eggsByMonth.get(m)?.inRange ?? 0,
        /** Still being posted to: bills and salaries for it may not be in yet. */
        provisional: monthRange(Number(m.slice(0, 4)), Number(m.slice(5, 7))).to >= today,
      })),
    },
    feed: {
      kg: d2(Number(feedRow?.kg ?? 0)),
      amount: d2(feedAmount),
      perEgg: per(feedAmount),
      incomplete: !!feedRow?.incomplete,
      unpricedDays: Number(feedRow?.unpricedDays ?? 0),
      rearingExcluded: d2(Number(rearRow?.cost ?? 0)),
      byHouse: feedByHouse.map((h) => ({
        code: h.code,
        eggs: Number(h.eggs),
        kg: d2(Number(h.kg)),
        amount: d2(Number(h.cost)),
        perEgg: Number(h.eggs) > 0 ? d3(Number(h.cost) / Number(h.eggs)) : null,
      })),
    },
    pullet: { perBird: d2(pulletPerBird), eggsPerLife, perEgg: d3(pulletPerEgg), amount: d2(pulletAmount) },
    income,
    costOfGoodsSold: cogs,
    grossProfit: money(grossProfit, grossProfitPerEgg),
    farm,
    mill,
    packing,
    admin,
    operatingTotal: money(operatingTotal, operatingPerEgg),
    operatingProfit: money(operatingProfit, operatingProfitPerEgg),
    finance,
    netProfit: money(netProfit, netProfitPerEgg),
    costPerEgg: {
      cogs: cogs.perEgg,
      afterOperating: per(Number(cogs.total) + operatingTotal),
      full: per(Number(cogs.total) + operatingTotal + Number(finance.total)),
    },
    unassigned,
    excluded,
  };
}

/**
 * Income is read by the day it was invoiced, not month-rated. The month query
 * already has the month's total; this narrows it to the range's days. Called
 * once per (account, month), which is a handful of rows.
 */
async function inRangeShareForIncome(
  db: Conn,
  accountId: string,
  month: string,
  from: string,
  to: string,
  monthTotal: number,
): Promise<number> {
  if (monthTotal === 0) return 0;
  const [y, m] = month.split("-").map(Number) as [number, number];
  const r = monthRange(y, m);
  if (from <= r.from && to >= r.to) return 1;
  const lo = from > r.from ? from : r.from;
  const hi = to < r.to ? to : r.to;
  const [row] = await db
    .select({ net: sql<string>`coalesce(sum(${journalEntryLines.credit} - ${journalEntryLines.debit}), 0)` })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalEntryLines.entryId))
    .where(
      and(
        eq(journalEntryLines.accountId, accountId),
        eq(journalEntries.status, "posted"),
        gte(journalEntries.entryDate, lo),
        lte(journalEntries.entryDate, hi),
      ),
    );
  return Number(row?.net ?? 0) / monthTotal;
}
