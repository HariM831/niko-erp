/**
 * A layer house's week on one page.
 *
 * Seven days Monday to Sunday — eggs, egg %, mortality, feed per bird and per
 * egg — over the week before and the breed standard; the lay curve and feed
 * per egg since the flock came into lay; the feed it was given, judged against
 * its standard; and what Dr Niko last said about the house (the user, 13 Oct
 * 2026).
 *
 * Every figure is worked on ALL the birds in the house. A house can hold two
 * flocks while its eggs and feed are recorded on one of them, so a flock's own
 * hen-day reads high by the other's share of the cages; a house report divides
 * by the house (the user, 13 Oct 2026). That is the one place this report does
 * arithmetic over `flock_day` rather than reading its ratios.
 */
import PDFDocument from "pdfkit";
import { sql } from "drizzle-orm";
import { NUTRIENTS } from "@shared/feed";
import type { Db, Tx } from "../db";
import { addDays, istDate, weekdayOf } from "./day-resolution";
import { winAnsi } from "./owner-statement-pdf";

type Conn = Db | Tx;

export class HouseWeeklyError extends Error {}

export interface WeeklyDay {
  day: string;
  ageDays: number;
  birds: number;
  eggs: number | null;
  hdPct: number | null;
  mortality: number;
  feedKg: number | null;
  feedPerBirdG: number | null;
  feedPerEggG: number | null;
}

export interface WeeklyTotals {
  birds: number;
  eggs: number;
  hdPct: number | null;
  mortality: number;
  mortalityPct: number | null;
  feedKg: number;
  feedPerBirdG: number | null;
  feedPerEggG: number | null;
}

export interface WeeklyPoint {
  ageWeek: number;
  hdPct: number | null;
  feedPerEggG: number | null;
  stdLayPct: number | null;
  stdFeedPerEggG: number | null;
}

export interface WeeklyNutrient {
  label: string;
  unit: string;
  value: number;
  min: number | null;
  max: number | null;
}

export interface HouseWeeklySpec {
  orgName: string;
  house: string;
  from: string;
  to: string;
  flock: string;
  breed: string | null;
  ageDays: number;
  ageWeek: number;
  birds: number;
  days: WeeklyDay[];
  week: WeeklyTotals;
  previous: WeeklyTotals | null;
  standard: { layPct: number | null; feedPerBirdG: number | null; feedPerEggG: number | null };
  /** One point per week of age since the first egg; part-weeks left out. */
  trend: WeeklyPoint[];
  feed: {
    name: string;
    version: number;
    deliveredKg: number;
    costPerKg: number | null;
    standardName: string | null;
    nutrients: WeeklyNutrient[];
  } | null;
  observation: {
    observedOn: string;
    inWeek: boolean;
    category: string | null;
    note: string | null;
    remark: string;
    actions: string[];
  } | null;
  generated: string;
}

// ───────────────────────────── The figures ─────────────────────────────

/** The Monday-to-Sunday week holding `day`. */
export function weekOf(day: string): { from: string; to: string } {
  const from = addDays(day, -((weekdayOf(day) + 6) % 7));
  return { from, to: addDays(from, 6) };
}

/** The last week that has fully passed, in IST. */
export function lastFullWeek(today: string = istDate()): { from: string; to: string } {
  return weekOf(addDays(today, -7));
}

interface HouseDay {
  day: string;
  open: number;
  close: number;
  mortality: number;
  eggs: number | null;
  feedKg: number | null;
  ageDays: number;
  ageWeek: number;
  stdLay: number | null;
  stdFeed: number | null;
}

const ratio = (a: number, b: number, k = 1) => (b > 0 ? (a / b) * k : null);

function totals(days: HouseDay[]): WeeklyTotals | null {
  if (!days.length) return null;
  const avg = (d: HouseDay) => (d.open + d.close) / 2;
  const laid = days.filter((d) => d.eggs != null);
  const fed = days.filter((d) => d.feedKg != null);
  const both = fed.filter((d) => d.eggs != null);
  const eggs = laid.reduce((s, d) => s + d.eggs!, 0);
  const feedKg = fed.reduce((s, d) => s + d.feedKg!, 0);
  const mortality = days.reduce((s, d) => s + d.mortality, 0);
  return {
    birds: days[days.length - 1]!.close,
    eggs,
    hdPct: ratio(eggs, laid.reduce((s, d) => s + avg(d), 0), 100),
    mortality,
    mortalityPct: ratio(mortality, days[0]!.open, 100),
    feedKg,
    feedPerBirdG: ratio(feedKg, fed.reduce((s, d) => s + avg(d), 0), 1000),
    // Only over days that have both, so a day with eggs and no feed reading
    // cannot make the feed look lighter than it was.
    feedPerEggG: ratio(both.reduce((s, d) => s + d.feedKg!, 0), both.reduce((s, d) => s + d.eggs!, 0), 1000),
  };
}

/** Dr Niko answers in headed markdown; a remark that does not follow it prints whole. */
function parseRemark(remark: string) {
  const section = (name: string) => {
    const m = remark.match(new RegExp(`\\*\\*${name}:\\*\\*\\s*([\\s\\S]*?)(?=\\n\\s*\\*\\*|$)`));
    return m ? m[1]!.trim() : "";
  };
  const clinical = section("Clinical Remark");
  const actions = section("Action Plan")
    .split("\n")
    .map((l) => l.replace(/^\s*[-*]\s*/, "").trim())
    .filter(Boolean);
  const category = section("Category").replace(/_/g, " ").toLowerCase() || null;
  return clinical
    ? { category, remark: clinical, actions }
    : { category, remark: remark.replace(/\*\*/g, "").trim(), actions: [] };
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const shortDate = (ymd: string) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  return `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
};
const stampNow = () => {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date());
  const at = (t: string) => p.find((x) => x.type === t)!.value;
  return `${Number(at("day"))} ${MON[Number(at("month")) - 1]} ${at("year")}, ${at("hour")}:${at("minute")}`;
};

/** The nutrients the page has room for, in the order the formula screen lists them. */
const SHOWN = ["me", "cp", "cf", "fat", "ca", "avP", "digLys", "digMetCys", "digThr", "digTrp", "digArg", "digIle", "digVal"];

export async function houseWeeklySpec(conn: Conn, houseId: string, weekDay: string | null, orgName: string): Promise<HouseWeeklySpec> {
  const [house] = (
    await conn.execute(sql`SELECT id, code, name, purpose FROM houses WHERE id = ${houseId}::uuid`)
  ).rows as Array<{ id: string; code: string; name: string | null; purpose: string }>;
  if (!house) throw new HouseWeeklyError("House not found");
  if (house.purpose !== "layer") throw new HouseWeeklyError("The weekly report is for layer houses");

  const { from, to } = weekDay ? weekOf(weekDay) : lastFullWeek();

  // Lay-phase days only: the curves start at the first egg, and a rearing day
  // has no eggs to divide by.
  const rows = (
    await conn.execute(sql`
      SELECT fd.day::text AS day, fd.flock_id AS "flockId",
             fd.age_days AS "ageDays", fd.age_week AS "ageWeek",
             fd.opening_birds AS open, fd.closing_birds AS close, fd.mortality,
             fd.eggs, fd.feed_kg::float8 AS "feedKg",
             fd.std_lay_pct::float8 AS "stdLay", fd.std_feed_g_per_bird::float8 AS "stdFeed"
        FROM flock_day fd
       WHERE fd.house_id = ${houseId}::uuid AND fd.phase = 'lay' AND fd.day <= ${to}::date
       ORDER BY fd.day`)
  ).rows as Array<{
    day: string; flockId: string; ageDays: number; ageWeek: number; open: number; close: number;
    mortality: number; eggs: number | null; feedKg: number | null; stdLay: number | null; stdFeed: number | null;
  }>;

  // The house's day: every flock's birds, eggs and feed together. Age and the
  // standard are the biggest flock's — it is the one the house is run for.
  const byDay = new Map<string, HouseDay & { lead: number; leadFlock: string }>();
  for (const r of rows) {
    const d = byDay.get(r.day) ?? {
      day: r.day, open: 0, close: 0, mortality: 0, eggs: null, feedKg: null,
      ageDays: 0, ageWeek: 0, stdLay: null, stdFeed: null, lead: -1, leadFlock: "",
    };
    d.open += r.open;
    d.close += r.close;
    d.mortality += r.mortality;
    if (r.eggs != null) d.eggs = (d.eggs ?? 0) + r.eggs;
    if (r.feedKg != null) d.feedKg = (d.feedKg ?? 0) + r.feedKg;
    if (r.open > d.lead) {
      d.lead = r.open; d.leadFlock = r.flockId;
      d.ageDays = r.ageDays; d.ageWeek = r.ageWeek; d.stdLay = r.stdLay; d.stdFeed = r.stdFeed;
    }
    byDay.set(r.day, d);
  }
  const all = [...byDay.values()];
  const inWeek = all.filter((d) => d.day >= from && d.day <= to);
  const week = totals(inWeek);
  if (!week) throw new HouseWeeklyError(`${house.code} has no laying flock on record for ${shortDate(from)} to ${shortDate(to)}`);
  const prevFrom = addDays(from, -7);
  const last = inWeek[inWeek.length - 1]!;

  const byAgeWeek = new Map<number, HouseDay[]>();
  for (const d of all) byAgeWeek.set(d.ageWeek, [...(byAgeWeek.get(d.ageWeek) ?? []), d]);
  const trend: WeeklyPoint[] = [...byAgeWeek.entries()]
    .sort((a, b) => a[0] - b[0])
    // A week of age with only a day or two in it swings on those days alone.
    .filter(([, ds]) => ds.filter((d) => d.eggs != null).length >= 4)
    .map(([ageWeek, ds]) => {
      const t = totals(ds)!;
      const std = ds[ds.length - 1]!;
      return {
        ageWeek,
        hdPct: t.hdPct,
        feedPerEggG: t.feedPerEggG,
        stdLayPct: std.stdLay,
        stdFeedPerEggG: std.stdFeed != null && std.stdLay ? std.stdFeed / (std.stdLay / 100) : null,
      };
    });

  const [flock] = (
    await conn.execute(sql`
      SELECT f.code, b.name AS breed FROM flocks f LEFT JOIN breeds b ON b.id = f.breed_id
       WHERE f.id = ${last.leadFlock}::uuid`)
  ).rows as Array<{ code: string; breed: string | null }>;

  // The feed in use is what the mill last sent the house, in the week or before it.
  const [sent] = (
    await conn.execute(sql`
      SELECT item_id AS "itemId" FROM feed_transfers
       WHERE to_house_id = ${houseId}::uuid AND status = 'completed' AND transfer_date <= ${to}::date
       ORDER BY transfer_date DESC, created_at DESC LIMIT 1`)
  ).rows as Array<{ itemId: string }>;
  let feed: HouseWeeklySpec["feed"] = null;
  if (sent) {
    const [formula] = (
      await conn.execute(sql`
        SELECT id, name, version, stage::text AS stage FROM formulas
         WHERE output_item_id = ${sent.itemId}::uuid AND is_active LIMIT 1`)
    ).rows as Array<{ id: string; name: string; version: number; stage: string | null }>;
    if (formula) {
      const [given] = (
        await conn.execute(sql`
          SELECT coalesce(sum(quantity_kg), 0)::float8 AS kg, sum(value)::float8 AS value
            FROM feed_transfers
           WHERE to_house_id = ${houseId}::uuid AND status = 'completed' AND item_id = ${sent.itemId}::uuid
             AND transfer_date BETWEEN ${from}::date AND ${to}::date`)
      ).rows as Array<{ kg: number; value: number | null }>;
      // Over the whole batch, a material with no figure counting as none — the
      // same arithmetic as the formula screen, so the two cannot disagree.
      const mix = (
        await conn.execute(sql`
          SELECT n.nutrient, (sum(fl.quantity_kg * n.value) / t.kg)::float8 AS value
            FROM formula_lines fl
            JOIN item_nutrients n ON n.item_id = fl.item_id
           CROSS JOIN (SELECT sum(quantity_kg) AS kg FROM formula_lines WHERE formula_id = ${formula.id}::uuid) t
           WHERE fl.formula_id = ${formula.id}::uuid
           GROUP BY n.nutrient, t.kg`)
      ).rows as Array<{ nutrient: string; value: number }>;
      const has = new Map(mix.map((m) => [m.nutrient, Number(m.value)]));
      if (has.has("digMet") || has.has("digCyst")) has.set("digMetCys", (has.get("digMet") ?? 0) + (has.get("digCyst") ?? 0));

      const bounds = formula.stage
        ? ((
            await conn.execute(sql`
              SELECT p.nutrient, p.min_value::float8 AS min, p.max_value::float8 AS max
                FROM feed_standards s JOIN feed_standard_params p ON p.standard_id = s.id
               WHERE s.stage::text = ${formula.stage} AND s.is_active`)
          ).rows as Array<{ nutrient: string; min: number | null; max: number | null }>)
        : [];
      const want = new Map(bounds.map((b) => [b.nutrient, b]));
      const met = want.get("digMet"), cys = want.get("digCyst");
      if (met?.min != null && cys?.min != null) want.set("digMetCys", { nutrient: "digMetCys", min: met.min + cys.min, max: null });

      const def = new Map(NUTRIENTS.map((n) => [n.key, n]));
      feed = {
        name: formula.name,
        version: formula.version,
        deliveredKg: Number(given?.kg ?? 0),
        costPerKg: given?.value != null && Number(given.kg) > 0 ? Number(given.value) / Number(given.kg) : null,
        standardName: bounds.length ? formula.name : null,
        nutrients: SHOWN.filter((k) => has.has(k)).map((k) => ({
          label: k === "digMetCys" ? "Dig. Met + Cys" : def.get(k)!.label,
          unit: k === "digMetCys" ? "%" : def.get(k)!.unit,
          value: has.get(k)!,
          min: want.get(k)?.min ?? null,
          max: want.get(k)?.max ?? null,
        })),
      };
    }
  }

  // An observation filed in the week if there is one; otherwise the last on
  // file, said to be so — an old finding must not read as this week's.
  const [obs] = (
    await conn.execute(sql`
      SELECT observed_on::text AS "observedOn", note, ai_remark AS remark
        FROM ai_observations
       WHERE house_id = ${houseId}::uuid AND observed_on <= ${to}::date AND ai_remark IS NOT NULL
       ORDER BY observed_on DESC, created_at DESC LIMIT 1`)
  ).rows as Array<{ observedOn: string; note: string | null; remark: string }>;

  const day = (d: HouseDay): WeeklyDay => {
    const avg = (d.open + d.close) / 2;
    return {
      day: d.day, ageDays: d.ageDays, birds: d.open, eggs: d.eggs, mortality: d.mortality, feedKg: d.feedKg,
      hdPct: d.eggs != null ? ratio(d.eggs, avg, 100) : null,
      feedPerBirdG: d.feedKg != null ? ratio(d.feedKg, avg, 1000) : null,
      feedPerEggG: d.feedKg != null && d.eggs ? ratio(d.feedKg, d.eggs, 1000) : null,
    };
  };

  return {
    orgName,
    house: house.name || house.code,
    from, to,
    flock: flock?.code ?? "",
    breed: flock?.breed ?? null,
    ageDays: last.ageDays,
    ageWeek: last.ageWeek,
    birds: last.close,
    days: inWeek.map(day),
    week,
    previous: totals(all.filter((d) => d.day >= prevFrom && d.day < from)),
    standard: {
      layPct: last.stdLay,
      feedPerBirdG: last.stdFeed,
      feedPerEggG: last.stdFeed != null && last.stdLay ? last.stdFeed / (last.stdLay / 100) : null,
    },
    trend,
    feed,
    observation: obs ? { observedOn: obs.observedOn, inWeek: obs.observedOn >= from, note: obs.note?.trim() || null, ...parseRemark(obs.remark) } : null,
    generated: stampNow(),
  };
}

// ────────────────────────────── The page ──────────────────────────────

// niko's own colours: the sidebar's brown, the yolk accent, the table head.
const INK = "#111827";
const INK2 = "#4b5563";
const MUTED = "#6c718a";
const RULE = "#ece3d5";
const HEAD = "#f9f9fb";
const ACCENT = "#e06d05";
const MAST = "#2b2117";
const MAST_MUTED = "#d9c9b0";
const TINT = "#ffecd2";
const GOOD = "#0b8a60", GOOD_BG = "#e3f7ef";
const BAD = "#d03a4a", BAD_BG = "#fde8ea";
const WARN = "#b45309", WARN_BG = "#ffecd2";

const num = (v: number | null | undefined, dp = 0) =>
  v == null ? "-" : v.toLocaleString("en-IN", { minimumFractionDigits: dp, maximumFractionDigits: dp });
const age = (days: number) => `${Math.floor(days / 7)}w ${days % 7}d`;

export function houseWeeklyFilename(spec: HouseWeeklySpec): string {
  return `${spec.house.replace(/[^A-Za-z0-9]+/g, "-")}-weekly-${spec.from}.pdf`;
}

export function renderHouseWeekly(spec: HouseWeeklySpec): Promise<Buffer> {
  const title = `${spec.house} weekly report, ${shortDate(spec.from)} - ${shortDate(spec.to)}`;
  const doc = new PDFDocument({ size: "A4", margin: 36, info: { Title: winAnsi(title) } });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));

  const left = 36;
  const width = doc.page.width - 2 * left;
  // Everything is placed by hand on one page; a bottom margin would let pdfkit
  // start a second page under the footer.
  doc.page.margins.bottom = 0;
  /** One line, never wrapped: a width only says where right or centre is. */
  const text = (s: string, x: number, y: number, o: { width?: number; align?: "left" | "right" | "center"; characterSpacing?: number } = {}) => {
    const t = winAnsi(s);
    const slack = o.width != null && o.align && o.align !== "left" ? o.width - doc.widthOfString(t, { characterSpacing: o.characterSpacing }) : 0;
    doc.text(t, x + (o.align === "center" ? slack / 2 : slack), y, { lineBreak: false, characterSpacing: o.characterSpacing });
  };

  // Masthead
  doc.rect(0, 0, doc.page.width, 74).fill(MAST);
  doc.rect(0, 74, doc.page.width, 2.5).fill(ACCENT);
  doc.fillColor(MAST_MUTED).font("Helvetica-Bold").fontSize(7.5);
  text(`NIKO  |  ${spec.orgName.toUpperCase()}  |  WEEKLY HOUSE REPORT`, left, 16, { characterSpacing: 0.6 });
  doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(19);
  text(`Layer house ${spec.house}`, left, 29);
  const meta: Array<[string, string]> = [
    ["Week", `${shortDate(spec.from)} - ${shortDate(spec.to)} ${spec.to.slice(0, 4)}`],
    ["Flock", [spec.flock, spec.breed].filter(Boolean).join(", ")],
    ["Age", `${age(spec.ageDays)} (week ${spec.ageWeek})`],
    ["Birds", num(spec.birds)],
  ];
  let mx = left;
  for (const [k, v] of meta) {
    doc.font("Helvetica").fontSize(8.5).fillColor(MAST_MUTED);
    text(`${k} `, mx, 56);
    mx += doc.widthOfString(`${k} `);
    doc.font("Helvetica-Bold").fillColor("#ffffff");
    text(v, mx, 56);
    mx += doc.widthOfString(winAnsi(v)) + 16;
  }

  const heading = (label: string, note: string, x: number, y: number, w: number) => {
    doc.rect(x, y, 2.5, 12).fill(ACCENT);
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(10.5);
    text(label, x + 8, y + 1.5);
    if (note) {
      doc.fillColor(MUTED).font("Helvetica").fontSize(8);
      text(note, x, y + 3, { width: w, align: "right" });
    }
    return y + 18;
  };

  /** A header band and ruled rows; cells are [text, colour?, bold?]. */
  type Cell = string | { t: string; color?: string; bold?: boolean };
  const table = (x: number, y: number, cols: Array<{ label: string; w: number; left?: boolean }>, body: Array<{ cells: Cell[]; fill?: string; soft?: boolean }>, rowH: number) => {
    const w = cols.reduce((s, c) => s + c.w, 0);
    const draw = (cells: Cell[], yy: number, base: { color: string; bold: boolean; size: number }) => {
      let cx = x;
      cells.forEach((c, i) => {
        const col = cols[i]!;
        const cell = typeof c === "string" ? { t: c } : c;
        doc.font(cell.bold ?? base.bold ? "Helvetica-Bold" : "Helvetica").fontSize(base.size).fillColor(cell.color ?? base.color);
        text(cell.t, cx + 5, yy, { width: col.w - 10, align: col.left ? "left" : "right" });
        cx += col.w;
      });
    };
    doc.rect(x, y, w, rowH + 2).fill(HEAD);
    draw(cols.map((c) => c.label.toUpperCase()), y + (rowH + 2 - 7) / 2, { color: MUTED, bold: true, size: 7 });
    y += rowH + 2;
    for (const r of body) {
      if (r.fill) doc.rect(x, y, w, rowH).fill(r.fill);
      draw(r.cells, y + (rowH - 8.5) / 2 + 0.5, { color: r.soft ? INK2 : INK, bold: !!r.fill, size: 8.5 });
      y += rowH;
      doc.moveTo(x, y).lineTo(x + w, y).lineWidth(0.5).strokeColor(RULE).stroke();
    }
    return y;
  };

  // Production, day by day
  let y = heading("Production, day by day", "egg % is hen-day: eggs / birds in the house that day", left, 92, width);
  const b = (t: string): Cell => ({ t, bold: true });
  const cols = [
    { label: "Day", w: 70, left: true }, { label: "Age", w: 46 }, { label: "Birds", w: 58 }, { label: "Eggs", w: 60 },
    { label: "Egg %", w: 44 }, { label: "Mortality", w: 73 }, { label: "Feed kg", w: 52 }, { label: "Feed g/bird", w: 60 }, { label: "Feed g/egg", w: 60 },
  ];
  const sumRow = (label: string, t: WeeklyTotals): Cell[] => [
    label, "", num(t.birds), num(t.eggs), b(num(t.hdPct, 1)),
    `${num(t.mortality)} (${num(t.mortalityPct, 2)}%)`, num(t.feedKg), b(num(t.feedPerBirdG, 1)), b(num(t.feedPerEggG, 1)),
  ];
  const delta = (now: number | null, was: number | null, dp: number, upIsGood: boolean): Cell => {
    if (now == null || was == null) return "";
    const d = now - was;
    if (Math.abs(d) < 0.5 / 10 ** dp) return { t: num(0, dp), color: MUTED };
    return { t: `${d > 0 ? "+" : "-"}${num(Math.abs(d), dp)}`, color: d > 0 === upIsGood ? GOOD : BAD };
  };
  const p = spec.previous;
  y = table(left, y, cols, [
    ...spec.days.map((d) => ({
      cells: [shortDate(d.day), age(d.ageDays), num(d.birds), num(d.eggs), b(num(d.hdPct, 1)), num(d.mortality), num(d.feedKg), b(num(d.feedPerBirdG, 1)), b(num(d.feedPerEggG, 1))] as Cell[],
    })),
    { cells: sumRow("This week", spec.week), fill: TINT },
    ...(p ? [
      { cells: sumRow("Previous week", p), soft: true },
      { cells: ["Change on previous week", "", "", "", delta(spec.week.hdPct, p.hdPct, 1, true), delta(spec.week.mortality, p.mortality, 0, false), "", delta(spec.week.feedPerBirdG, p.feedPerBirdG, 1, false), delta(spec.week.feedPerEggG, p.feedPerEggG, 1, false)] as Cell[], soft: true },
    ] : []),
    { cells: [`${spec.breed ?? "Breed"} standard, week ${spec.ageWeek}`, "", "", "", num(spec.standard.layPct, 1), "", "", num(spec.standard.feedPerBirdG, 1), num(spec.standard.feedPerEggG, 1)], soft: true },
  ], 15);
  // The label cells above run past their own column on purpose; nothing sits beside them.

  // Since the first egg
  y += 16;
  const gap = 20;
  const half = (width - gap) / 2;
  const chart = (x: number, top: number, label: string, note: string, pts: Array<{ w: number; v: number | null; std: number | null }>, yMin: number, yMax: number, step: number, dp: number) => {
    let cy = heading(label, note, x, top, half);
    doc.moveTo(x, cy + 3).lineTo(x + 14, cy + 3).lineWidth(1.5).strokeColor(ACCENT).stroke();
    doc.fillColor(INK2).font("Helvetica").fontSize(7.5);
    text(spec.house, x + 18, cy);
    const sx = x + 18 + doc.widthOfString(spec.house) + 12;
    doc.moveTo(sx, cy + 3).lineTo(sx + 14, cy + 3).lineWidth(1).dash(3, { space: 2 }).strokeColor(MUTED).stroke().undash();
    text(`${spec.breed ?? "Breed"} standard`, sx + 18, cy);
    cy += 14;
    const L = x + 24, R = x + half - 30, T = cy, B = cy + 104;
    if (!pts.length) {
      doc.fillColor(MUTED).fontSize(8);
      text("Not enough weeks in lay to draw yet.", L, T + 40);
      return B + 16;
    }
    const w0 = pts[0]!.w, w1 = Math.max(pts[pts.length - 1]!.w, w0 + 1);
    const X = (w: number) => L + ((w - w0) / (w1 - w0)) * (R - L);
    const Y = (v: number) => T + ((yMax - Math.min(yMax, Math.max(yMin, v))) / (yMax - yMin)) * (B - T);
    doc.font("Helvetica").fontSize(7).fillColor(MUTED);
    for (let t = yMin; t <= yMax + 1e-9; t += step) {
      doc.moveTo(L, Y(t)).lineTo(R, Y(t)).lineWidth(0.5).strokeColor(RULE).stroke();
      text(num(t), x, Y(t) - 2.5, { width: 20, align: "right" });
    }
    for (let w = Math.ceil(w0 / 5) * 5; w <= w1; w += 5) text(String(w), X(w) - 10, B + 4, { width: 20, align: "center" });
    text("age, weeks", L, B + 13, { width: R - L, align: "center" });
    const line = (get: (q: (typeof pts)[number]) => number | null) => {
      let pen = false;
      for (const q of pts) {
        const v = get(q);
        if (v == null) { pen = false; continue; }
        if (pen) doc.lineTo(X(q.w), Y(v)); else doc.moveTo(X(q.w), Y(v));
        pen = true;
      }
    };
    line((q) => q.std);
    doc.lineWidth(1).dash(3, { space: 2 }).strokeColor(MUTED).stroke().undash();
    line((q) => q.v);
    doc.lineWidth(1.5).lineJoin("round").strokeColor(ACCENT).stroke();
    const end = [...pts].reverse().find((q) => q.v != null);
    if (end) {
      doc.circle(X(end.w), Y(end.v!), 2.5).fillAndStroke(ACCENT, "#ffffff");
      doc.fillColor(INK).font("Helvetica-Bold").fontSize(7.5);
      text(num(end.v, dp), X(end.w) + 5, Y(end.v!) - 3);
    }
    return B + 24;
  };
  const lay = spec.trend.map((t) => ({ w: t.ageWeek, v: t.hdPct, std: t.stdLayPct }));
  // Below three-quarters lay a handful of eggs carry the whole house's feed and
  // the figure runs into hundreds of grams, flattening everything after it.
  const fpe = spec.trend.filter((t) => (t.hdPct ?? 0) >= 75 && t.feedPerEggG != null)
    .map((t) => ({ w: t.ageWeek, v: t.feedPerEggG, std: t.stdFeedPerEggG }));
  const vals = fpe.flatMap((q) => [q.v, q.std]).filter((v): v is number => v != null);
  const lo = vals.length ? Math.floor(Math.min(...vals) / 10) * 10 : 80;
  const hi = vals.length ? Math.max(lo + 20, Math.ceil(Math.max(...vals) / 10) * 10) : 130;
  const peak = lay.filter((q) => q.v != null).sort((a, c) => c.v! - a.v!)[0];
  const afterCharts = Math.max(
    chart(left, y, "Egg production %", "weekly, since first egg", lay, 0, 100, 25, 1),
    chart(left + half + gap, y, "Feed per egg, g", "weekly, from 75% lay", fpe, lo, hi, hi - lo > 40 ? 20 : 10, 1),
  );
  if (peak) {
    doc.fillColor(MUTED).font("Helvetica").fontSize(7.5);
    text(`Peak ${num(peak.v, 1)}% at week ${peak.w}.`, left, afterCharts - 2);
  }
  y = afterCharts + 18;

  // Feed in use
  const feedW = 268;
  const f = spec.feed;
  let fy = heading(f ? `Feed in use: ${f.name}` : "Feed in use", f ? `version ${f.version}${f.costPerKg != null ? `, Rs ${num(f.costPerKg, 2)}/kg` : ""}` : "", left, y, feedW);
  if (!f) {
    doc.fillColor(MUTED).font("Helvetica").fontSize(8.5);
    doc.text("No feed transfer to this house matches a live formula, so there is no recipe to analyse.", left, fy, { width: feedW });
  } else {
    const pill = (n: WeeklyNutrient): Cell => {
      if (n.min == null && n.max == null) return { t: "no target", color: MUTED };
      const dp = n.unit === "%" ? 2 : 0;
      const r = (v: number) => Number(v.toFixed(dp));
      if (n.min != null && r(n.value) < r(n.min)) return { t: `${num((1 - n.value / n.min) * 100)}% short`, color: BAD, bold: true };
      if (n.max != null && r(n.value) > r(n.max)) return { t: "Over", color: WARN, bold: true };
      return { t: "Met", color: GOOD, bold: true };
    };
    const target = (n: WeeklyNutrient) => {
      const dp = n.unit === "%" ? 2 : 0;
      if (n.min != null && n.max != null) return `${num(n.min, dp)} - ${num(n.max, dp)}`;
      if (n.min != null) return `min ${num(n.min, dp)}`;
      if (n.max != null) return `max ${num(n.max, dp)}`;
      return "-";
    };
    const nCols = [{ label: "Nutrient", w: 104, left: true }, { label: "Formula", w: 48 }, { label: "Target", w: 64 }, { label: "Status", w: 52, left: true }];
    const startY = fy + 15;
    // Tint behind each verdict first, so the word sits on it.
    f.nutrients.forEach((n, i) => {
      const c = pill(n) as { t: string; color?: string };
      const bg = c.color === GOOD ? GOOD_BG : c.color === BAD ? BAD_BG : c.color === WARN ? WARN_BG : null;
      if (!bg) return;
      doc.font("Helvetica-Bold").fontSize(8.5);
      doc.roundedRect(left + 216 + 2, startY + i * 14 + 2, doc.widthOfString(c.t) + 6, 10, 5).fill(bg);
    });
    fy = table(left, fy, nCols, f.nutrients.map((n) => ({
      cells: [`${n.label}  ${n.unit}`, b(num(n.value, n.unit === "%" ? 2 : 0)), target(n), pill(n)] as Cell[],
    })), 14);
    doc.fillColor(MUTED).font("Helvetica").fontSize(7.5);
    doc.text(winAnsi(`${num(f.deliveredKg)} kg delivered in the week.${f.standardName ? ` Targets are the mill's ${f.standardName} standard.` : " No standard is set for this feed's stage."}`), left, fy + 5, { width: feedW });
  }

  // Dr Niko
  const ox = left + feedW + gap, ow = width - feedW - gap;
  const o = spec.observation;
  let oy = heading("Dr Niko", o ? `${o.inWeek ? "filed this week" : "latest on file"}, ${shortDate(o.observedOn)} ${o.observedOn.slice(0, 4)}` : "", ox, y, ow);
  const bottom = doc.page.height - 58;
  if (!o) {
    doc.fillColor(MUTED).font("Helvetica").fontSize(8.5);
    doc.text("No observation has been filed for this house.", ox, oy, { width: ow });
  } else {
    const tx = ox + 9, tw = ow - 9;
    const top = oy;
    const para = (s: string, font: string, color: string, size = 8.5) => {
      if (oy >= bottom - 10) return;
      doc.font(font).fontSize(size).fillColor(color);
      doc.text(winAnsi(s), tx, oy, { width: tw, height: bottom - oy, ellipsis: true, lineGap: 1 });
      oy = Math.min(doc.y, bottom) + 5;
    };
    if (o.category) para(o.category.toUpperCase(), "Helvetica-Bold", WARN, 7);
    if (o.note) para(`Reported: "${o.note}"`, "Helvetica-Oblique", INK2);
    para(o.remark, "Helvetica", INK);
    for (const a of o.actions) para(`-  ${a}`, "Helvetica", INK, 7.5);
    doc.rect(ox, top, 2, Math.max(oy - 5 - top, 10)).fill(RULE);
    if (!o.inWeek && oy < bottom) {
      doc.fillColor(MUTED).font("Helvetica").fontSize(7.5);
      doc.text("Nothing was filed in the report week, so the last observation on file is shown.", ox, oy + 2, { width: ow });
    }
  }

  // Footer
  const fyy = doc.page.height - 44;
  doc.moveTo(left, fyy).lineTo(left + width, fyy).lineWidth(0.5).strokeColor(RULE).stroke();
  doc.fillColor(MUTED).font("Helvetica").fontSize(7.5);
  text("niko  |  from house day records, feed mill formulas and Dr Niko", left, fyy + 6);
  text(`Generated ${spec.generated}`, left, fyy + 6, { width, align: "right" });

  doc.end();
  return done;
}
