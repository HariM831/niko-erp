/**
 * A day's egg orders as a PDF, one row per customer and one column per grade.
 *
 * Amino's benchmark page printed the next day two ways, Orders and Sales, as
 * one row per customer per size. The farm's own sheet turns that round (29 Sep
 * 2026): a customer is one line, each grade a column, a total under each — the
 * loading bay reads across a name, the office reads down a grade. Landscape,
 * every grade the farm sells shown whether or not anyone takes it that day,
 * Jumbo last as on the sheet, and a dash where a customer takes none. Sales
 * adds each grade's box rate under its heading and the customer's amount at
 * the end of the row.
 */
import PDFDocument from "pdfkit";
import { inArray } from "drizzle-orm";
import { eggDispatches } from "@shared/schema";
import { DIRECT_RATE_SIZES, EGG_SIZE_LABEL, type EggSize } from "@shared/egg-sizes";
import type { Db, Tx } from "../db";
import { winAnsi } from "./owner-statement-pdf";
import { benchmarkOn, boxRateOn, dayOrders, eggPrefs, eggsInBox, sizeOffsetsOn } from "./egg-sales";

type Conn = Db | Tx;

/** Every grade the sheet carries, in its order: Jumbo last (29 Sep 2026). */
export const SHEET_SIZES: readonly EggSize[] = ["small", "medium", "large", "brown", "dirty", "jumbo"];

export interface EggDayRow {
  customer: string;
  boxes: Partial<Record<EggSize, number>>;
  /** Sales only: what the row comes to, in rupees. */
  amount?: number;
  /** Sales only: set when this customer's rates differ from the heading's (their own spread). */
  ownRates?: boolean;
}

export interface EggDaySpec {
  kind: "orders" | "sales";
  /** "Orders for Wed, 30 Sep 2026" */
  title: string;
  /** The line under the title: the farm, the benchmark, when it was printed. */
  subtitle: string;
  /** The grades that get a column, in the order they print. */
  sizes: EggSize[];
  rows: EggDayRow[];
  /** Sales only: rupees per box for each column, at the day's benchmark with the usual spread. */
  rates?: Partial<Record<EggSize, number>>;
}

const INK = "#111827";
const MUTED = "#6b7280";
const RULE = "#d1d5db";
const HEAD = "#f3f4f6";
const FOOT = "#e5e7eb";

const n = (v: number) => v.toLocaleString("en-IN");
const rs = (v: number) => Math.round(v).toLocaleString("en-IN");

export function renderEggDay(spec: EggDaySpec): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 36, info: { Title: winAnsi(spec.title) } });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));

  const sales = spec.kind === "sales";
  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;

  doc.fillColor(INK).font("Helvetica-Bold").fontSize(14).text(winAnsi(spec.title), left, 36);
  doc.fillColor(MUTED).font("Helvetica").fontSize(8.5).text(winAnsi(spec.subtitle), left, doc.y + 2);

  // The name takes what the numbers leave; the numbers share the rest evenly.
  const numCols = spec.sizes.length + (sales ? 1 : 0);
  const numW = Math.min(88, Math.floor((width * 0.66) / Math.max(numCols, 1)));
  const nameW = width - numW * numCols;
  const colX = (i: number) => left + nameW + i * numW;
  const rowH = 20;
  const pad = 6;

  let y = doc.y + 12;
  const pageBottom = doc.page.height - doc.page.margins.bottom;

  const cellBorder = (top: number, h: number) => {
    doc.lineWidth(0.5).strokeColor(RULE);
    doc.rect(left, top, width, h).stroke();
    doc.moveTo(left + nameW, top).lineTo(left + nameW, top + h).stroke();
    for (let i = 1; i < numCols; i++) doc.moveTo(colX(i), top).lineTo(colX(i), top + h).stroke();
  };

  const header = () => {
    const h = sales ? rowH + 12 : rowH;
    doc.rect(left, y, width, h).fill(HEAD);
    cellBorder(y, h);
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(9);
    doc.text("Customer", left + pad, y + 6, { width: nameW - 2 * pad });
    spec.sizes.forEach((s, i) => {
      doc.font("Helvetica-Bold").fontSize(9).fillColor(INK).text(EGG_SIZE_LABEL[s], colX(i), y + 6, { width: numW - pad, align: "right" });
      if (sales) {
        const r = spec.rates?.[s];
        doc.font("Helvetica").fontSize(7.5).fillColor(MUTED).text(r != null ? `@ ${rs(r)}/box` : "no rate", colX(i), y + 18, { width: numW - pad, align: "right" });
      }
    });
    if (sales) doc.font("Helvetica-Bold").fontSize(9).fillColor(INK).text("Amount", colX(spec.sizes.length), y + 6, { width: numW - pad, align: "right" });
    y += h;
  };

  const row = (cells: { name: string; boxes: Partial<Record<EggSize, number>>; amount?: number; mark?: boolean }, bold: boolean, fill?: string) => {
    if (y + rowH > pageBottom) {
      doc.addPage();
      y = doc.page.margins.top;
      header();
    }
    if (fill) doc.rect(left, y, width, rowH).fill(fill);
    cellBorder(y, rowH);
    doc.fillColor(INK).font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(9);
    doc.text(winAnsi(cells.name) + (cells.mark ? " *" : ""), left + pad, y + 6, { width: nameW - 2 * pad, lineBreak: false, ellipsis: true });
    spec.sizes.forEach((s, i) => {
      const v = cells.boxes[s] ?? 0;
      // A dash where there is nothing, so an empty cell is plainly none rather than forgotten.
      doc.fillColor(v ? INK : MUTED).text(v ? n(v) : "-", colX(i), y + 6, { width: numW - pad, align: "right" });
    });
    doc.fillColor(INK);
    if (sales && cells.amount != null) doc.text(rs(cells.amount), colX(spec.sizes.length), y + 6, { width: numW - pad, align: "right" });
    y += rowH;
  };

  header();
  for (const r of spec.rows) row({ name: r.customer, boxes: r.boxes, amount: r.amount, mark: r.ownRates }, false);

  const totals: Partial<Record<EggSize, number>> = {};
  for (const s of spec.sizes) totals[s] = spec.rows.reduce((a, r) => a + (r.boxes[s] ?? 0), 0);
  const totalAmount = sales ? spec.rows.reduce((a, r) => a + (r.amount ?? 0), 0) : undefined;
  row({ name: "Total", boxes: totals, amount: totalAmount }, true, FOOT);

  const allBoxes = Object.values(totals).reduce((a, v) => a + (v ?? 0), 0);
  const notes = [
    `${n(allBoxes)} boxes for ${spec.rows.length} customer${spec.rows.length === 1 ? "" : "s"}`,
    ...(sales && spec.rows.some((r) => r.ownRates) ? ["* priced at their own spread, not the heading's rate"] : []),
  ];
  doc.fillColor(MUTED).font("Helvetica").fontSize(8).text(winAnsi(notes.join("   ")), left, y + 6);

  doc.end();
  return done;
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** "Wed, 30 Sep 2026" — spelt out by hand: the locale tables write "Sept". */
const longDate = (ymd: string) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  return `${DOW[d.getUTCDay()]}, ${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};
/** Now, in IST: "29 Sep 2026, 16:29". */
const stampNow = () => {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date());
  const at = (t: string) => p.find((x) => x.type === t)!.value;
  return `${Number(at("day"))} ${MON[Number(at("month")) - 1]} ${at("year")}, ${at("hour")}:${at("minute")}`;
};

/**
 * One day's sheet, from the order book the calendar and the bay read.
 *
 * A loaded line shows what went on the truck, size by size. Before loading, a
 * spot order shows the sizes it was booked in, and a standing order — which is
 * a box count, its grades chosen at the bay — sits under Large, as Amino's
 * sheet did (the user, 29 Sep 2026). Priced by the invoice's own rule:
 * benchmark + the grade's differential + the customer's spread, times the eggs
 * in its box; Brown and Niko at their box rate.
 */
export async function eggDaySpec(conn: Conn, on: string, kind: "orders" | "sales", orgName: string): Promise<EggDaySpec> {
  const lines = (await dayOrders(conn, on)).filter((l) => !l.voided && l.boxes > 0);
  const dispatchIds = lines.map((l) => l.dispatch?.id).filter((v): v is string => !!v);
  const loaded = dispatchIds.length ? await conn.select().from(eggDispatches).where(inArray(eggDispatches.id, dispatchIds)) : [];
  const loadedOf = new Map(loaded.map((d) => [d.id, d]));

  const [bm, offsets, prefs] = await Promise.all([benchmarkOn(conn, on), sizeOffsetsOn(conn, on), eggPrefs(conn)]);
  const boxRate: Partial<Record<EggSize, number>> = {};
  for (const s of DIRECT_RATE_SIZES) {
    const r = await boxRateOn(conn, s, on);
    if (r) boxRate[s] = Number(r.ratePerBox);
  }
  const rateFor = (s: EggSize, spread: number): number | undefined => {
    if (boxRate[s] != null) return boxRate[s];
    if ((DIRECT_RATE_SIZES as readonly EggSize[]).includes(s)) return undefined;
    if (!bm) return undefined;
    return (Number(bm.ratePerEgg) + Number(offsets?.[s] ?? 0) + spread) * eggsInBox(s, prefs);
  };

  const byCustomer = new Map<string, { customer: string; boxes: Partial<Record<EggSize, number>>; amount: number; spreads: Set<number> }>();
  for (const l of lines) {
    const d = l.dispatch ? loadedOf.get(l.dispatch.id) : undefined;
    const boxes: Partial<Record<EggSize, number>> = d
      ? {
          small: d.loadedSmall, medium: d.loadedMedium, large: d.loadedLarge, xl: d.loadedXl,
          jumbo: d.loadedJumbo, brown: d.loadedBrown, niko: d.loadedNiko, dirty: d.loadedDirty,
        }
      : l.sizes ?? { large: l.boxes };
    const spread = Number(l.spreadPerEgg ?? 0);
    const c = byCustomer.get(l.customerId) ?? { customer: l.customerName, boxes: {}, amount: 0, spreads: new Set<number>() };
    for (const [s, v] of Object.entries(boxes) as [EggSize, number][]) {
      if (!v) continue;
      c.boxes[s] = (c.boxes[s] ?? 0) + v;
      c.amount += v * (rateFor(s, spread) ?? 0);
    }
    c.spreads.add(spread);
    byCustomer.set(l.customerId, c);
  }

  // The heading's rate is at the spread most customers have; anyone else is starred.
  const spreadCount = new Map<number, number>();
  for (const c of byCustomer.values()) for (const s of c.spreads) spreadCount.set(s, (spreadCount.get(s) ?? 0) + 1);
  const usual = [...spreadCount].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;

  // A grade off the sheet (Niko, XL) still prints when someone is taking it — never dropped silently.
  const extra = (["niko", "xl"] as EggSize[]).filter((s) => [...byCustomer.values()].some((c) => (c.boxes[s] ?? 0) > 0));
  const sizes = [...SHEET_SIZES.slice(0, -1), ...extra, SHEET_SIZES[SHEET_SIZES.length - 1]!];

  const rates: Partial<Record<EggSize, number>> = {};
  for (const s of sizes) {
    const r = rateFor(s, usual);
    if (r != null) rates[s] = r;
  }
  const stamp = stampNow();
  const bmText = bm ? `Benchmark ${Number(bm.ratePerEgg).toFixed(2)}/egg${bm.effectiveFrom !== on ? ` (set ${longDate(bm.effectiveFrom)})` : ""}${usual ? ` + ${usual.toFixed(2)} spread` : ""}` : "No benchmark set";

  return {
    kind,
    title: `${kind === "orders" ? "Orders" : "Sales"} for ${longDate(on)}`,
    subtitle: [orgName, ...(kind === "sales" ? [bmText] : []), `Generated ${stamp}`].join("  |  "),
    sizes,
    rows: [...byCustomer.values()].map((c) => ({
      customer: c.customer,
      boxes: c.boxes,
      ...(kind === "sales" ? { amount: c.amount, ownRates: [...c.spreads].some((s) => s !== usual) } : {}),
    })),
    ...(kind === "sales" ? { rates } : {}),
  };
}
