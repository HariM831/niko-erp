/**
 * The feed mill SCADA — batches as the mill weighed them.
 *
 * The SCADA PC runs Siemens WinCC; the integrator logs every batch to
 * `BATCH.dbo.HISTORY` on that PC's SQL Server: recipe, batch number, set and
 * actual kg for eight bins, and what each bin held. A helper on that PC
 * (scripts/scada/niko_scada_agent.py), paired as a `scada` device, copies the
 * rows here. It asks where to resume and sends what is newer; a row sent twice
 * is the same batch.
 *
 * Records only (the user, 6 Oct 2026): nothing here moves stock or posts.
 * Production orders stay what the books are built on, and these sit beside
 * them — ingredient usage set against actual, per day, per material.
 *
 * Two routers: the helper's, authenticated by its device token, and the
 * screens', by the session.
 */
import { Router } from "express";
import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { formulas, items, scadaBatches, scadaLive, scadaNames } from "@shared/schema";
import { LIVE_STALE_MS, LIVE_TAG_NAMES, LIVE_TAGS } from "@shared/scada-live";
import { db, type Tx } from "../db";
import { requirePermission } from "../lib/rbac";
import { validateBody } from "../lib/validate";
import { requireDeviceToken } from "./device";

export const scadaDeviceRouter = Router();
export const scadaRouter = Router();

/** HISTORY.dateandtime as the PC writes it: local wall clock, no zone. */
const localTime = z.string().regex(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,7})?$/);

const batchRow = z.object({
  time: localTime,
  recipe: z.string().max(80),
  qty: z.number().int().nullable(),
  set: z.array(z.number()).length(8),
  act: z.array(z.number()).length(8),
  names: z.array(z.string().max(80).nullable()).length(8),
});

/** The SCADA PC is in IST and writes its clock as it reads it. */
export function istInstant(local: string): Date {
  const [d, t] = local.replace("T", " ").split(" ");
  const ms = (t!.split(".")[1] ?? "0").padEnd(3, "0").slice(0, 3);
  return new Date(`${d}T${t!.split(".")[0]}.${ms}+05:30`);
}

export const fold = (s: string | null | undefined) => (s ?? "").trim().replace(/\s+/g, " ").toUpperCase();

export type ScadaRow = z.infer<typeof batchRow>;

/** Keep each row as a batch; one already held is left exactly as it was. */
export async function storeBatches(tx: Tx, rows: ScadaRow[], deviceId: string | null): Promise<number> {
  let stored = 0;
  for (const r of rows) {
    const bins = r.set.map((setKg, i) => ({
      bin: i + 1,
      name: r.names[i]?.trim() || null,
      setKg,
      actKg: r.act[i]!,
    }));
    const out = await tx
      .insert(scadaBatches)
      .values({
        sourceTime: r.time,
        batchedAt: istInstant(r.time),
        recipeName: r.recipe.trim(),
        batchSeq: r.qty,
        bins,
        setTotalKg: String(r.set.reduce((s, v) => s + v, 0)),
        actTotalKg: String(r.act.reduce((s, v) => s + v, 0)),
        deviceId,
      })
      .onConflictDoNothing()
      .returning({ id: scadaBatches.id });
    stored += out.length;
  }
  return stored;
}

// ─────────────────────────────── The helper ───────────────────────────────

/**
 * Where to resume: the newest batch niko holds, in the PC's own time text, so
 * the helper can ask its SQL Server for `dateandtime > ?` without any time
 * zone arithmetic. Null before the first batch — send everything.
 */
scadaDeviceRouter.get("/cursor", requireDeviceToken("scada"), async (_req, res) => {
  const [last] = await db
    .select({ sourceTime: scadaBatches.sourceTime })
    .from(scadaBatches)
    .orderBy(desc(scadaBatches.batchedAt))
    .limit(1);
  res.json({ after: last?.sourceTime ?? null });
});

scadaDeviceRouter.post(
  "/batches",
  requireDeviceToken("scada"),
  validateBody(z.object({ rows: z.array(batchRow).max(1000) })),
  async (req, res) => {
    const { rows } = req.body as { rows: ScadaRow[] };
    const device = (req as unknown as { device: { id: string } }).device;
    const stored = await db.transaction((tx) => storeBatches(tx, rows, device.id));
    res.json({ received: rows.length, stored });
  },
);

// ────────────────────────────── Live values ──────────────────────────────

/**
 * Which WinCC tags the helper should read for the Live Mill screen. Served
 * from niko so the list is kept in one place (shared/scada-live.ts): a tag
 * added there is read from the helper's next start, with no change on the PC.
 */
scadaDeviceRouter.get("/live-tags", requireDeviceToken("scada"), (_req, res) => {
  res.json({ tags: LIVE_TAG_NAMES, intervalMs: 2000 });
});

/** The latest reading. Only tags on the list are kept, so nothing else rides in. */
scadaDeviceRouter.post(
  "/live",
  requireDeviceToken("scada"),
  validateBody(
    z.object({
      at: z.string().datetime({ offset: true }),
      values: z.record(z.string(), z.union([z.number(), z.string().max(200), z.boolean(), z.null()])),
    }),
  ),
  async (req, res) => {
    const body = req.body as { at: string; values: Record<string, number | string | boolean | null> };
    const device = (req as unknown as { device: { id: string } }).device;
    const allowed = new Set(LIVE_TAG_NAMES);
    const values = Object.fromEntries(Object.entries(body.values).filter(([k]) => allowed.has(k)));
    const row = { id: 1, readAt: new Date(body.at), values, deviceId: device.id, receivedAt: new Date() };
    await db.insert(scadaLive).values(row).onConflictDoUpdate({ target: scadaLive.id, set: row });
    res.json({ kept: Object.keys(values).length });
  },
);

// ─────────────────────────────── The screens ──────────────────────────────

const view = requirePermission("feed_mill", "scada");
const dateParam = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** The window asked for, as IST days inclusive. */
function window(q: Record<string, unknown>) {
  const from = dateParam.safeParse(q.from).success ? (q.from as string) : null;
  const to = dateParam.safeParse(q.to).success ? (q.to as string) : null;
  return {
    from,
    to,
    where: and(
      from ? gte(scadaBatches.batchedAt, new Date(`${from}T00:00:00+05:30`)) : undefined,
      to ? lte(scadaBatches.batchedAt, new Date(`${to}T23:59:59.999+05:30`)) : undefined,
    ),
  };
}

async function nameMaps() {
  const rows = await db
    .select({
      kind: scadaNames.kind,
      name: scadaNames.name,
      itemId: scadaNames.itemId,
      itemName: items.name,
      formulaId: scadaNames.formulaId,
      formulaName: formulas.name,
    })
    .from(scadaNames)
    .leftJoin(items, eq(items.id, scadaNames.itemId))
    .leftJoin(formulas, eq(formulas.id, scadaNames.formulaId));
  const bins = new Map<string, { itemId: string; itemName: string }>();
  const recipes = new Map<string, { formulaId: string; formulaName: string }>();
  for (const r of rows) {
    if (r.kind === "bin" && r.itemId) bins.set(r.name, { itemId: r.itemId, itemName: r.itemName ?? "" });
    if (r.kind === "recipe" && r.formulaId) recipes.set(r.name, { formulaId: r.formulaId, formulaName: r.formulaName ?? "" });
  }
  return { bins, recipes };
}

type Bin = { bin: number; name: string | null; setKg: number; actKg: number };

/**
 * The Live Mill screen's data: the latest snapshot, read through the tag map,
 * and whether it is fresh. Stale means the helper, the OPC UA server or the
 * SCADA PC has stopped — the screen says so rather than showing old numbers
 * as though they were now.
 */
scadaRouter.get("/live", view, async (_req, res) => {
  const [row] = await db.select().from(scadaLive).limit(1);
  if (!row) return res.json({ readAt: null, receivedAt: null, stale: true, values: null, missing: [] });
  const raw = row.values as Record<string, unknown>;
  const values = Object.fromEntries(Object.entries(LIVE_TAGS).map(([key, tag]) => [key, raw[tag] ?? null]));
  res.json({
    readAt: row.readAt,
    receivedAt: row.receivedAt,
    stale: Date.now() - row.receivedAt.getTime() > LIVE_STALE_MS,
    values,
    /** Tags the helper could not read — usually a name the OPC UA server does not know. */
    missing: Object.entries(LIVE_TAGS).filter(([, tag]) => !(tag in raw)).map(([key]) => key),
  });
});

/** The batches in a window, newest first, each bin read by its own name. */
scadaRouter.get("/batches", view, async (req, res) => {
  const w = window(req.query);
  const limit = Math.min(Number(req.query.limit) || 500, 2000);
  const { bins: binMap, recipes } = await nameMaps();
  const rows = await db
    .select()
    .from(scadaBatches)
    .where(w.where)
    .orderBy(desc(scadaBatches.batchedAt))
    .limit(limit);
  res.json(
    rows.map((b) => ({
      id: b.id,
      batchedAt: b.batchedAt,
      recipeName: b.recipeName,
      formulaName: recipes.get(fold(b.recipeName))?.formulaName ?? null,
      batchSeq: b.batchSeq,
      setTotalKg: Number(b.setTotalKg),
      actTotalKg: Number(b.actTotalKg),
      bins: (b.bins as Bin[]).map((x) => ({ ...x, itemName: binMap.get(fold(x.name))?.itemName ?? null })),
    })),
  );
});

/**
 * Ingredient usage: set against actual, per material and per day, with the
 * bins that carry no weight left out. Two maize bins are one maize. A bin
 * name with no material yet is reported under its own name, so nothing
 * weighed is ever dropped from the total for want of a mapping.
 */
scadaRouter.get("/usage", view, async (req, res) => {
  const w = window(req.query);
  const { bins: binMap, recipes } = await nameMaps();
  const rows = await db
    .select({
      batchedAt: scadaBatches.batchedAt,
      recipeName: scadaBatches.recipeName,
      bins: scadaBatches.bins,
      setTotalKg: scadaBatches.setTotalKg,
      actTotalKg: scadaBatches.actTotalKg,
    })
    .from(scadaBatches)
    .where(w.where)
    .orderBy(asc(scadaBatches.batchedAt));

  res.json({ from: w.from, to: w.to, ...summarizeUsage(rows, binMap, recipes) });
});

type UsageRow = { batchedAt: Date; recipeName: string; bins: unknown; setTotalKg: string; actTotalKg: string };

/**
 * Usage per material, per day and per recipe. Pure, so the check can feed it
 * rows and maps of its own.
 */
export function summarizeUsage(
  rows: UsageRow[],
  binMap: Map<string, { itemId: string; itemName: string }>,
  recipes: Map<string, { formulaId: string; formulaName: string }>,
) {
  const istDay = (d: Date) => new Date(d.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);
  const materials = new Map<string, { key: string; name: string; mapped: boolean; setKg: number; actKg: number }>();
  const days = new Map<string, { day: string; batches: number; setKg: number; actKg: number; byMaterial: Record<string, { setKg: number; actKg: number }> }>();
  const byRecipe = new Map<string, { recipeName: string; formulaName: string | null; batches: number; setKg: number; actKg: number }>();
  const unmappedBins = new Set<string>();
  const unmappedRecipes = new Set<string>();

  for (const r of rows) {
    const day = istDay(r.batchedAt);
    const d = days.get(day) ?? { day, batches: 0, setKg: 0, actKg: 0, byMaterial: {} };
    d.batches += 1;
    d.setKg += Number(r.setTotalKg);
    d.actKg += Number(r.actTotalKg);
    for (const b of r.bins as Bin[]) {
      if (!b.setKg && !b.actKg) continue;
      const mapped = binMap.get(fold(b.name));
      if (!mapped && b.name) unmappedBins.add(fold(b.name));
      const key = mapped?.itemId ?? `name:${fold(b.name) || `BIN ${b.bin}`}`;
      const m = materials.get(key) ?? { key, name: mapped?.itemName ?? (b.name?.trim() || `Bin ${b.bin}`), mapped: !!mapped, setKg: 0, actKg: 0 };
      m.setKg += b.setKg;
      m.actKg += b.actKg;
      materials.set(key, m);
      const dm = d.byMaterial[key] ?? { setKg: 0, actKg: 0 };
      dm.setKg += b.setKg;
      dm.actKg += b.actKg;
      d.byMaterial[key] = dm;
    }
    days.set(day, d);
    const rk = fold(r.recipeName);
    const formula = recipes.get(rk);
    if (!formula) unmappedRecipes.add(rk);
    const rr = byRecipe.get(rk) ?? { recipeName: r.recipeName, formulaName: formula?.formulaName ?? null, batches: 0, setKg: 0, actKg: 0 };
    rr.batches += 1;
    rr.setKg += Number(r.setTotalKg);
    rr.actKg += Number(r.actTotalKg);
    byRecipe.set(rk, rr);
  }

  return {
    batches: rows.length,
    materials: [...materials.values()].sort((a, b) => b.actKg - a.actKg),
    days: [...days.values()].sort((a, b) => b.day.localeCompare(a.day)),
    recipes: [...byRecipe.values()].sort((a, b) => b.batches - a.batches),
    unmapped: { bins: [...unmappedBins].sort(), recipes: [...unmappedRecipes].sort() },
  };
}

/**
 * The names the SCADA uses and what each means in niko — every bin and recipe
 * name ever seen, mapped or not, with the choices to map them to.
 */
scadaRouter.get("/names", view, async (_req, res) => {
  const seenRecipes = await db.execute(sql`
    SELECT DISTINCT upper(regexp_replace(trim(recipe_name), '\s+', ' ', 'g')) AS name FROM scada_batches ORDER BY 1`);
  const seenBins = await db.execute(sql`
    SELECT DISTINCT upper(regexp_replace(trim(b->>'name'), '\s+', ' ', 'g')) AS name
      FROM scada_batches, jsonb_array_elements(bins) b
     WHERE coalesce(trim(b->>'name'), '') <> '' ORDER BY 1`);
  const { bins, recipes } = await nameMaps();
  const feedItems = await db
    .select({ id: items.id, name: items.name })
    .from(items)
    .where(and(eq(items.isActive, true), eq(items.isFeedIngredient, true)))
    .orderBy(items.name);
  const activeFormulas = await db
    .select({ id: formulas.id, name: formulas.name, version: formulas.version })
    .from(formulas)
    .where(eq(formulas.isActive, true))
    .orderBy(formulas.name);
  res.json({
    bins: (seenBins.rows as Array<{ name: string }>).map((r) => ({ name: r.name, ...(bins.get(r.name) ?? {}) })),
    recipes: (seenRecipes.rows as Array<{ name: string }>).map((r) => ({ name: r.name, ...(recipes.get(r.name) ?? {}) })),
    items: feedItems,
    formulas: activeFormulas,
  });
});

/**
 * Say what a SCADA name means. Writing a formula's meaning is the formula
 * author's authority; the same person maps a bin to a material.
 */
scadaRouter.put(
  "/names",
  requirePermission("feed_mill", "manage_formulas"),
  validateBody(
    z.object({
      kind: z.enum(["bin", "recipe"]),
      name: z.string().min(1).max(80),
      itemId: z.string().uuid().nullable().optional(),
      formulaId: z.string().uuid().nullable().optional(),
    }),
  ),
  async (req, res) => {
    const b = req.body as { kind: "bin" | "recipe"; name: string; itemId?: string | null; formulaId?: string | null };
    const name = fold(b.name);
    const target = b.kind === "bin" ? b.itemId ?? null : b.formulaId ?? null;
    await db.transaction(async (tx) => {
      await tx.delete(scadaNames).where(and(eq(scadaNames.kind, b.kind), eq(scadaNames.name, name)));
      if (target) {
        await tx.insert(scadaNames).values({
          kind: b.kind,
          name,
          itemId: b.kind === "bin" ? target : null,
          formulaId: b.kind === "recipe" ? target : null,
          createdBy: req.session.user!.id,
        });
      }
    });
    res.json({ ok: true });
  },
);
