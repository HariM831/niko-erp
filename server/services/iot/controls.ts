/**
 * The shed controllers' settings: what they can be told, what they are set to,
 * and what changed.
 *
 * Three things live here, all read-only in stage 1.
 *
 *   · The CATALOGUE. The vendor's remote-control screen is a tree of pages,
 *     each either a Form (label / value / unit rows) or a Table (a grid where
 *     every cell is a register). One model, one catalogue: all six houses are
 *     9200s. Fetched from the vendor's own page definitions, normalised, and
 *     kept in `controller_catalog`, so the page in niko renders from data and
 *     validation later comes from the vendor's ranges rather than from us.
 *
 *   · SNAPSHOTS. Every register of a house read from the controller and kept
 *     whole, nightly and on demand. About 1,900 values a house.
 *
 *   · CHANGES. Two snapshots differ, therefore somebody changed something on
 *     the panel or on the vendor's site. Until niko writes (stage 2), every
 *     change is from outside, and the house page says so.
 *
 * Register names are kept WITHOUT the house code prefix the vendor puts on
 * them (`efdaeee6357c8a38.基础控制.通风级别.级别01风机01`), because the same
 * register means the same thing in every house and the catalogue is shared.
 */
import { readFileSync } from "node:fs";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { controllerCatalog, controllerChanges, controllerSnapshots, houses, iotHouseSample } from "@shared/schema";
import { db } from "../../db";
import {
  fetchControlMenu,
  fetchControlPage,
  fetchDeviceStatus,
  readRegisters,
  type BhControlMenu,
} from "./bhfarm";

export const CONTROLLER_MODEL = "9200";

/* ── The catalogue ──────────────────────────────────────────────────────── */

export interface CatalogOption {
  value: string;
  label: string;
  labelEn: string;
}
export interface CatalogField {
  label: string;
  labelEn: string;
  register: string;
  range: string;
  unit: string;
  kind: string;
  options: CatalogOption[];
  readOnly: boolean;
  group: string;
}
export interface CatalogColumn {
  key: string;
  labelEn: string;
  range: string;
  unit: string;
  kind: string;
  options: CatalogOption[];
}
export interface CatalogRow {
  id: number;
  /** What the vendor prints in the first column: a level, a row number, an inlet name. */
  label: string;
  /** Column key → register. */
  cells: Record<string, string>;
}
export interface CatalogPage {
  code: string;
  type: "Form" | "Table";
  position: string;
  path: string[];
  pathEn: string[];
  fields?: CatalogField[];
  columns?: CatalogColumn[];
  rows?: CatalogRow[];
  /** Registers the vendor repeats in every row of a table but that belong to the page — the fan cycle time, the tunnel entry step. */
  shared?: CatalogField[];
  /** Every register on the page, in order. */
  registers: string[];
  /** Registers the vendor marks read-only (status figures on a settings page). */
  readOnlyRegisters: string[];
}
export interface Catalog {
  model: string;
  fetchedAt: Date;
  sourceHouseCode: string | null;
  menu: BhControlMenu[];
  pages: CatalogPage[];
}

interface LabelMap {
  pages: Record<string, string>;
  labels: Record<string, string>;
}
let labelMap: LabelMap | null = null;
/**
 * English for the vendor's Chinese labels, lifted from the vendor's own locale
 * file so a support call has a shared vocabulary. niko's own words for pages
 * live in the client; these are the fallback and the hover.
 */
function labels(): LabelMap {
  if (!labelMap) {
    labelMap = JSON.parse(readFileSync(new URL("./control-labels.json", import.meta.url), "utf-8")) as LabelMap;
  }
  return labelMap;
}
const en = (cn: string) => labels().labels[cn] ?? labels().labels[cn.replace(/\d+/g, "")] ?? cn;
const enPage = (cn: string) => labels().pages[cn] ?? cn;

/** The register without the house prefix. */
const strip = (fullName: string, houseCode: string) =>
  fullName.startsWith(`${houseCode}.`) ? fullName.slice(houseCode.length + 1) : fullName;

const opts = (raw: unknown): CatalogOption[] =>
  Array.isArray(raw)
    ? raw.map((o: { value?: unknown; label?: unknown }) => ({
        value: String(o.value ?? ""),
        label: String(o.label ?? ""),
        labelEn: en(String(o.label ?? "")),
      }))
    : [];

function normaliseForm(raw: unknown[], houseCode: string): Pick<CatalogPage, "fields" | "registers" | "readOnlyRegisters"> {
  const fields: CatalogField[] = [];
  for (const r of raw as Array<Record<string, unknown>>) {
    const full = r.labelFullName;
    if (typeof full !== "string" || !full) continue;
    fields.push({
      label: String(r.label ?? ""),
      labelEn: en(String(r.label ?? "")),
      register: strip(full, houseCode),
      range: String(r.range ?? ""),
      unit: String(r.unit ?? ""),
      kind: String(r.type || "number"),
      options: opts(r.options),
      readOnly: r.readOnly === true,
      group: String(r.group ?? ""),
    });
  }
  return {
    fields,
    registers: fields.map((f) => f.register),
    readOnlyRegisters: fields.filter((f) => f.readOnly).map((f) => f.register),
  };
}

/**
 * A Table page comes as one object per row, with `<column>FullName`,
 * `<column>`, `<column>Range`, `<column>Unit`, `<column>Options`/`Type`
 * for each settable cell, and fan cells as `f1`..`f26` with shared
 * `fjOptions`/`fjType`/`fjRange`. Columns are discovered from the keys.
 */
function normaliseTable(raw: unknown[], houseCode: string): Pick<CatalogPage, "columns" | "rows" | "shared" | "registers" | "readOnlyRegisters"> {
  const columns = new Map<string, CatalogColumn>();
  const rows: CatalogRow[] = [];
  const registers: string[] = [];
  for (const r of raw as Array<Record<string, unknown>>) {
    const cells: Record<string, string> = {};
    for (const [k, v] of Object.entries(r)) {
      if (typeof v !== "string" || !v.startsWith(`${houseCode}.`)) continue;
      let key: string;
      if (k.endsWith("FullName")) key = k.slice(0, -8);
      else if (/^f\d+$/.test(k)) key = k;
      else continue;
      const register = strip(v, houseCode);
      cells[key] = register;
      registers.push(register);
      if (!columns.has(key)) {
        const fan = /^f\d+$/.test(key);
        const leaf = register.split(".").pop() ?? register;
        columns.set(key, {
          key,
          labelEn: fan ? `Fan ${key.slice(1)}` : en(leaf.replace(/\d+/g, "")),
          range: String((fan ? r.fjRange : r[`${key}Range`]) ?? ""),
          unit: String((fan ? "" : r[`${key}Unit`]) ?? ""),
          kind: String((fan ? r.fjType : r[`${key}Type`]) || "number"),
          options: opts(fan ? r.fjOptions : r[`${key}Options`]),
        });
      }
    }
    if (!Object.keys(cells).length) continue;
    rows.push({
      id: Number(r.id ?? rows.length + 1),
      label: String(r.level ?? r.name ?? r.id ?? rows.length + 1),
      cells,
    });
  }
  /*
   * A column whose register is the same in every row is not a column: the
   * vendor repeats the page's own settings (fan cycle time, tunnel entry step)
   * on each row for its grid's convenience. Lifted out, so the grid holds only
   * what varies by row and the page shows the rest once.
   */
  const shared: CatalogField[] = [];
  if (rows.length > 1) {
    for (const col of [...columns.values()]) {
      const regs = new Set(rows.map((r) => r.cells[col.key]).filter(Boolean));
      if (regs.size !== 1 || rows.some((r) => !r.cells[col.key])) continue;
      const register = [...regs][0]!;
      shared.push({
        label: register.split(".").pop() ?? register,
        labelEn: col.labelEn,
        register,
        range: col.range,
        unit: col.unit,
        kind: col.kind,
        options: col.options,
        readOnly: false,
        group: "",
      });
      columns.delete(col.key);
      for (const r of rows) delete r.cells[col.key];
    }
  }
  return { columns: [...columns.values()], rows, shared, registers: [...new Set(registers)], readOnlyRegisters: [] };
}

/** Walk the vendor's tree into a flat list of (path, layout) pairs. */
function leaves(menu: BhControlMenu[], path: string[] = []): Array<{ path: string[]; position: string; type: string; code: string }> {
  const out: Array<{ path: string[]; position: string; type: string; code: string }> = [];
  for (const n of menu) {
    const p = [...path, n.Name];
    if (Array.isArray(n.Children) && n.Children.length) out.push(...leaves(n.Children, p));
    if (Array.isArray(n.Layout)) {
      for (const l of n.Layout) out.push({ path: p, position: l.Name, type: l.Type, code: l.Data });
    }
  }
  return out;
}

/**
 * Fetch the model's catalogue from the vendor, through one house that has it,
 * and keep it. Re-run when the vendor changes the tree; the page codes and
 * registers are stable otherwise.
 */
export async function refreshCatalog(houseCode: string, model = CONTROLLER_MODEL): Promise<Catalog> {
  const menu = await fetchControlMenu(houseCode);
  const pages: CatalogPage[] = [];
  for (const leaf of leaves(menu)) {
    const raw = await fetchControlPage(leaf.code, houseCode, leaf.type, leaf.position, model);
    const base = { code: leaf.code, position: leaf.position, path: leaf.path, pathEn: leaf.path.map(enPage) };
    if (leaf.type === "Form") pages.push({ ...base, type: "Form", ...normaliseForm(raw, houseCode) });
    else pages.push({ ...base, type: "Table", ...normaliseTable(raw, houseCode) });
  }
  const fetchedAt = new Date();
  await db
    .insert(controllerCatalog)
    .values({ model, fetchedAt, sourceHouseCode: houseCode, menu, pages })
    .onConflictDoUpdate({
      target: controllerCatalog.model,
      set: { fetchedAt, sourceHouseCode: houseCode, menu, pages },
    });
  catalogCache = { model, fetchedAt, sourceHouseCode: houseCode, menu, pages };
  return catalogCache;
}

let catalogCache: Catalog | null = null;

/** The kept catalogue, or null until the first refresh. */
export async function getCatalog(model = CONTROLLER_MODEL): Promise<Catalog | null> {
  if (catalogCache?.model === model) return catalogCache;
  const [row] = await db.select().from(controllerCatalog).where(eq(controllerCatalog.model, model));
  if (!row) return null;
  catalogCache = {
    model: row.model,
    fetchedAt: row.fetchedAt,
    sourceHouseCode: row.sourceHouseCode,
    menu: row.menu as BhControlMenu[],
    pages: row.pages as CatalogPage[],
  };
  return catalogCache;
}

/** Every register in the catalogue, once, with the page it is on. */
export function catalogRegisters(cat: Catalog): Map<string, { pageCode: string; readOnly: boolean }> {
  const m = new Map<string, { pageCode: string; readOnly: boolean }>();
  for (const p of cat.pages) {
    const ro = new Set(p.readOnlyRegisters);
    for (const r of p.registers) if (!m.has(r)) m.set(r, { pageCode: p.code, readOnly: ro.has(r) });
  }
  return m;
}

/* ── Live values and snapshots ──────────────────────────────────────────── */

async function houseDevice(houseId: string): Promise<{ id: string; code: string; houseCode: string }> {
  const [h] = await db
    .select({ id: houses.id, code: houses.code, device: houses.bhDeviceId })
    .from(houses)
    .where(eq(houses.id, houseId));
  if (!h) throw new Error(`no house ${houseId}`);
  if (!h.device) throw new Error(`${h.code} names no controller`);
  return { id: h.id, code: h.code, houseCode: h.device };
}

/** Current values from the controller for a list of registers, keyed without the house prefix. */
export async function liveValues(houseCode: string, registers: string[]): Promise<Map<string, string>> {
  const rows = await readRegisters(registers.map((r) => `${houseCode}.${r}`));
  return new Map(rows.map((r) => [strip(r.fullName, houseCode), r.value]));
}

/** One page of the catalogue with the controller's current values for it. */
export async function pageWithLive(houseId: string, code: string) {
  const cat = await getCatalog();
  const page = cat?.pages.find((p) => p.code === code);
  if (!page) throw new Error(`no page ${code} in the catalogue`);
  const h = await houseDevice(houseId);
  const status = await fetchDeviceStatus(h.houseCode);
  const values = status.isLiving ? await liveValues(h.houseCode, page.registers) : new Map<string, string>();
  return { page, live: status.isLiving, values: Object.fromEntries(values), at: new Date() };
}

export interface SnapshotResult {
  houseId: string;
  code: string;
  takenAt: Date;
  registers: number;
  changes: number;
  skipped?: string;
}

/**
 * Read every register of one house and keep it; then compare with the last
 * snapshot and record what moved. Status figures the vendor marks read-only
 * (current level, current age, pad duty) change on their own and are not
 * changes anyone made, so they are kept in the snapshot but never diffed.
 */
export async function snapshotHouse(houseId: string, source: "outside" | "niko" = "outside"): Promise<SnapshotResult> {
  const cat = await getCatalog();
  if (!cat) throw new Error("no catalogue yet — refresh it first");
  const h = await houseDevice(houseId);
  const status = await fetchDeviceStatus(h.houseCode);
  if (!status.isLiving) {
    return { houseId, code: h.code, takenAt: new Date(), registers: 0, changes: 0, skipped: "controller not reachable" };
  }
  const regs = catalogRegisters(cat);
  const names = [...regs.keys()];
  const values = await liveValues(h.houseCode, names);
  const takenAt = new Date();

  const [previous] = await db
    .select()
    .from(controllerSnapshots)
    .where(eq(controllerSnapshots.houseId, houseId))
    .orderBy(desc(controllerSnapshots.takenAt))
    .limit(1);

  const obj = Object.fromEntries(values);
  await db.insert(controllerSnapshots).values({ houseId, takenAt, registers: values.size, values: obj });

  let changes = 0;
  if (previous) {
    const before = previous.values as Record<string, string>;
    const rows: Array<typeof controllerChanges.$inferInsert> = [];
    for (const [register, after] of values) {
      const meta = regs.get(register);
      if (!meta || meta.readOnly) continue;
      const b = before[register];
      if (b === undefined || Number(b) === Number(after) || b === after) continue;
      rows.push({ houseId, register, pageCode: meta.pageCode, before: b, after, seenAt: takenAt, source });
    }
    if (rows.length) await db.insert(controllerChanges).values(rows);
    changes = rows.length;
  }
  return { houseId, code: h.code, takenAt, registers: values.size, changes };
}

/** Every house that names a controller. */
export async function snapshotAll(): Promise<SnapshotResult[]> {
  const rows = await db
    .select({ id: houses.id })
    .from(houses)
    .where(and(sql`${houses.bhDeviceId} IS NOT NULL`, eq(houses.isActive, true)));
  const out: SnapshotResult[] = [];
  for (const r of rows) {
    try {
      out.push(await snapshotHouse(r.id));
    } catch (e) {
      out.push({ houseId: r.id, code: "?", takenAt: new Date(), registers: 0, changes: 0, skipped: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

export async function latestSnapshot(houseId: string) {
  const [row] = await db
    .select()
    .from(controllerSnapshots)
    .where(eq(controllerSnapshots.houseId, houseId))
    .orderBy(desc(controllerSnapshots.takenAt))
    .limit(1);
  return row ?? null;
}

export async function recentChanges(houseId: string, days = 30) {
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await db
    .select()
    .from(controllerChanges)
    .where(and(eq(controllerChanges.houseId, houseId), gte(controllerChanges.seenAt, since)))
    .orderBy(desc(controllerChanges.seenAt))
    .limit(500);
  const cat = await getCatalog();
  const pageOf = new Map(cat?.pages.map((p) => [p.code, p]) ?? []);
  return rows.map((r) => {
    const page = r.pageCode ? pageOf.get(r.pageCode) : undefined;
    const leaf = r.register.split(".").pop() ?? r.register;
    const field = page?.fields?.find((f) => f.register === r.register);
    return {
      ...r,
      labelEn: field?.labelEn ?? en(leaf),
      pageEn: page ? page.pathEn.join(" › ") : null,
      unit: field?.unit ?? "",
    };
  });
}

/* ── Power and comfort, from what is already recorded ───────────────────── */

/** From the equipment quotation: 50-inch direct-drive cone fans, 1.5 kW each. */
export const FAN_KW = 1.5;
/**
 * The controller switches fans in groups; the quotation does not say how many
 * fans a group holds. Two is the working assumption until the fan cabinet's
 * wiring is read, and every figure derived from it is marked estimated.
 */
export const FANS_PER_GROUP = 2;

/**
 * Kilowatts at each ventilation step, from the house's ladder as last
 * snapshotted: a fan group set to continuous counts fully, one set to cycle or
 * alternate counts half. Index 1..36; null when there is no snapshot yet.
 */
export async function ladderPower(houseId: string): Promise<number[] | null> {
  const [cat, snap] = await Promise.all([getCatalog(), latestSnapshot(houseId)]);
  const page = cat?.pages.find((p) => p.code === "TFJB_TFJB_S");
  if (!page?.rows || !snap) return null;
  const values = snap.values as Record<string, string>;
  const kw: number[] = [0];
  for (const row of page.rows) {
    let fans = 0;
    for (const [key, register] of Object.entries(row.cells)) {
      if (!/^f\d+$/.test(key)) continue;
      const mode = Number(values[register] ?? 0);
      if (mode === 2) fans += 1;
      else if (mode === 1 || mode === 3) fans += 0.5;
    }
    kw[row.id] = fans * FANS_PER_GROUP * FAN_KW;
  }
  return kw;
}

/**
 * Fan energy since IST midnight, from the ventilation level the poller has
 * sampled every five minutes and the ladder's kilowatts per step. An estimate
 * until a meter says otherwise.
 */
export async function fanEnergyToday(houseId: string, kw: number[]): Promise<{ kwh: number; kwNow: number | null } | null> {
  const nowIst = new Date(Date.now() + 5.5 * 3_600_000);
  const midnight = new Date(Date.UTC(nowIst.getUTCFullYear(), nowIst.getUTCMonth(), nowIst.getUTCDate()) - 5.5 * 3_600_000);
  const rows = await db
    .select({ at: iotHouseSample.at, level: iotHouseSample.ventLevel })
    .from(iotHouseSample)
    .where(and(eq(iotHouseSample.houseId, houseId), gte(iotHouseSample.at, midnight), lte(iotHouseSample.at, new Date())))
    .orderBy(iotHouseSample.at);
  if (!rows.length) return null;
  let kwh = 0;
  for (let i = 0; i < rows.length; i++) {
    const level = rows[i]!.level;
    if (level == null) continue;
    const next = rows[i + 1]?.at ?? new Date();
    const hours = Math.min((next.getTime() - rows[i]!.at.getTime()) / 3_600_000, 0.25);
    kwh += (kw[Math.round(level)] ?? 0) * hours;
  }
  const last = rows[rows.length - 1]!.level;
  return { kwh: Math.round(kwh), kwNow: last == null ? null : (kw[Math.round(last)] ?? null) };
}

/**
 * Temperature-humidity index, the number the birds feel.
 *
 *   THI = 0.8·T + (RH/100)·(T − 14.4) + 46.4
 *
 * The livestock form (Thom, in the NRC's Celsius fit) that layer guidance uses.
 * The bands are the working ones for laying hens and are a setting for the vet,
 * not a law: under 70 comfortable, 70–75 mild, 76–81 moderate, over 81 severe.
 */
export function heatIndex(tempC: number | null, humidityPct: number | null): { thi: number; band: "comfortable" | "mild" | "moderate" | "severe" } | null {
  if (tempC == null || humidityPct == null) return null;
  const thi = 0.8 * tempC + (humidityPct / 100) * (tempC - 14.4) + 46.4;
  const band = thi < 70 ? "comfortable" : thi < 76 ? "mild" : thi < 82 ? "moderate" : "severe";
  return { thi: Math.round(thi * 10) / 10, band };
}
