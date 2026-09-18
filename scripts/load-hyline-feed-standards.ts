/**
 * Load the breeder's own nutrient specification into feed_standards.
 *
 * A formula is a recipe; a standard is what the recipe has to achieve. niko has
 * carried the two tables since the feed mill went in and both were empty, so a
 * mix could be costed but never judged. The figures come from the Hy-Line W-80
 * India management guide (Srinivasa Hy-Line, May 2024) — the same guide the
 * climate and performance standards were read from — transcribed into
 * server/db/standards/hyline-w80-feed.json with the page they sit on.
 *
 * Two things about the transcription are worth knowing:
 *
 *   AMINO ACIDS ARE THE DIGESTIBLE COLUMN. The guide prints standardized ileal
 *   digestible beside total, and footnotes that total applies only to a corn and
 *   soyabean-meal diet — this mill also runs DORB, DOGN, DDGS and rice. niko's
 *   keys are digestible, so SID is what is held. Cystine is (Met+Cys) less Met,
 *   which is the definition of the sum, not an estimate.
 *
 *   LAYER CONCENTRATIONS DEPEND ON INTAKE. The production table is a grid of
 *   phase against grams eaten per bird per day; a bird eating 85 g needs a
 *   richer feed than one eating 105 g. The guide marks one intake per phase as
 *   typical (95, 100, 105 g) and those columns are the ones loaded. If the
 *   flock's real intake settles somewhere else, the standard should be reloaded
 *   off that column rather than left to drift.
 *
 * Every figure is a floor: the guide calls them recommended concentrations, so
 * they go in as minima. Energy in the laying phases is the exception — printed
 * as a range of kcal per bird per day, so it carries both bounds.
 *
 * Nothing is invented. A nutrient the guide does not specify gets no row, and
 * sodium, chloride, linoleic acid and choline are specified but have no nutrient
 * key in niko, so they are reported and left out rather than approximated.
 *
 *   npx tsx scripts/load-hyline-feed-standards.ts
 *   npx tsx scripts/load-hyline-feed-standards.ts --apply
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { feedStandardParams, feedStandards, lifeStage } from "@shared/schema";
import { NUTRIENT_KEYS, nutrientLabel } from "@shared/feed";
import { db, pool } from "../server/db";

const APPLY = process.argv.includes("--apply");
const FILE = join(import.meta.dirname, "../server/db/standards/hyline-w80-feed.json");

interface Diet {
  stage: string;
  diet: string;
  note: string;
  params: Record<string, { min?: number; max?: number }>;
}
interface File {
  breed: string;
  source: string;
  effectiveFrom: string;
  aminoAcidBasis: string;
  notLoaded: string[];
  diets: Diet[];
}

/**
 * What a figure could not possibly be. A decimal point in the wrong place is the
 * failure this guards — 4.32% calcium typed as 43.2 would still solve, produce a
 * mix no bird can eat, and say nothing about it.
 */
const SANE: Record<string, [number, number]> = {
  me: [2000, 3600],
  cp: [10, 30],
  ca: [0.3, 12],
  avP: [0.1, 1.5],
};
const AMINO: [number, number] = [0.05, 2.5];

function check(f: File) {
  const stages = new Set(lifeStage.enumValues as readonly string[]);
  const bad: string[] = [];
  const seen = new Set<string>();
  for (const d of f.diets) {
    if (!stages.has(d.stage)) bad.push(`${d.diet}: "${d.stage}" is not a life stage`);
    if (seen.has(d.stage)) bad.push(`${d.stage} appears twice — one live standard per stage`);
    seen.add(d.stage);
    if (!Object.keys(d.params).length) bad.push(`${d.diet}: no nutrients`);
    for (const [key, v] of Object.entries(d.params)) {
      if (!NUTRIENT_KEYS.includes(key)) {
        bad.push(`${d.diet}: "${key}" is not a nutrient niko knows`);
        continue;
      }
      const [lo, hi] = SANE[key] ?? AMINO;
      for (const [which, n] of [["min", v.min], ["max", v.max]] as const) {
        if (n == null) continue;
        if (!Number.isFinite(n)) { bad.push(`${d.diet} ${key} ${which}: not a number`); continue; }
        if (n < lo || n > hi) bad.push(`${d.diet} ${key} ${which} = ${n}, outside ${lo}-${hi}`);
      }
      if (v.min == null && v.max == null) bad.push(`${d.diet} ${key}: neither bound`);
      if (v.min != null && v.max != null && v.min > v.max) bad.push(`${d.diet} ${key}: min above max`);
    }
  }
  return bad;
}

/** How a mix actually analyses, and how much of its weight the analysis covers. */
async function measured(stage: string, key: string) {
  const r = await db.execute(sql`
    SELECT sum(fl.quantity_kg * n.value) / nullif(sum(fl.quantity_kg) FILTER (WHERE n.value IS NOT NULL), 0) AS value,
           sum(fl.quantity_kg) FILTER (WHERE n.value IS NOT NULL) / nullif(sum(fl.quantity_kg), 0) AS covered
      FROM formulas f
      JOIN formula_lines fl ON fl.formula_id = f.id
      LEFT JOIN item_nutrients n ON n.item_id = fl.item_id AND n.nutrient = ${key}
     WHERE f.is_active AND f.stage = ${stage}::life_stage
  `);
  const row = r.rows[0] as { value: string | null; covered: string | null } | undefined;
  if (!row?.value) return null;
  return { value: Number(row.value), covered: Number(row.covered) };
}

async function main() {
  const f = JSON.parse(readFileSync(FILE, "utf8")) as File;
  console.log(`\n  ${f.breed} feed standards — ${APPLY ? "WRITING" : "dry run"}`);
  console.log(`  ${f.source}\n`);

  const bad = check(f);
  if (bad.length) {
    for (const b of bad) console.log(`  x ${b}`);
    throw new Error("the transcription does not stand up — nothing written");
  }

  const order = (key: string) => NUTRIENT_KEYS.indexOf(key);
  for (const d of f.diets) {
    const keys = Object.keys(d.params).sort((a, b) => order(a) - order(b));
    console.log(`  ${d.stage.padEnd(14)} ${d.diet}`);
    for (const key of keys) {
      const v = d.params[key]!;
      const window = v.max != null ? `${v.min} - ${v.max}` : `min ${v.min}`;
      const m = await measured(d.stage, key);
      let against = "";
      if (m) {
        const short = v.min != null && m.value < v.min;
        const over = v.max != null && m.value > v.max;
        const mark = m.covered < 0.95 ? "~" : short ? "SHORT" : over ? "OVER" : "ok";
        against = `   mix ${m.value.toFixed(2)} (${(m.covered * 100).toFixed(0)}% of the weight analysed) ${mark}`;
      }
      console.log(`    ${nutrientLabel(key).padEnd(28)}${window.padStart(16)}${against}`);
    }
    console.log();
  }

  console.log("  specified by the guide and not held:");
  for (const n of f.notLoaded) console.log(`    - ${n}`);

  if (!APPLY) {
    console.log("\n  Dry run — nothing written. Re-run with --apply.\n");
    await pool.end();
    return;
  }

  await db.transaction(async (tx) => {
    for (const d of f.diets) {
      const stage = d.stage as (typeof lifeStage.enumValues)[number];
      const [latest] = await tx
        .select({ id: feedStandards.id, version: feedStandards.version, notes: feedStandards.notes })
        .from(feedStandards)
        .where(eq(feedStandards.stage, stage))
        .orderBy(sql`version DESC`)
        .limit(1);

      const notes = `${d.diet} — ${d.note}\n\n${f.source}\n\nAmino acids: ${f.aminoAcidBasis}`;
      let id: string;
      if (latest && latest.notes === notes) {
        // The same transcription re-run: correct its figures in place rather
        // than minting a version nobody changed anything in.
        id = latest.id;
        await tx
          .update(feedStandards)
          .set({ isActive: true, effectiveFrom: f.effectiveFrom })
          .where(eq(feedStandards.id, id));
        await tx.delete(feedStandardParams).where(eq(feedStandardParams.standardId, id));
      } else {
        // One live standard per stage is enforced by a partial unique index, so
        // the old one is stood down before the new one is written.
        await tx
          .update(feedStandards)
          .set({ isActive: false })
          .where(and(eq(feedStandards.stage, stage), eq(feedStandards.isActive, true)));
        const [ins] = await tx
          .insert(feedStandards)
          .values({
            stage,
            version: (latest?.version ?? 0) + 1,
            effectiveFrom: f.effectiveFrom,
            isActive: true,
            notes,
          })
          .returning({ id: feedStandards.id });
        id = ins!.id;
      }

      const keys = Object.keys(d.params).sort((a, b) => order(a) - order(b));
      await tx.insert(feedStandardParams).values(
        keys.map((key, i) => ({
          standardId: id,
          nutrient: key,
          minValue: d.params[key]!.min?.toString() ?? null,
          maxValue: d.params[key]!.max?.toString() ?? null,
          sortOrder: i,
        })),
      );
      console.log(`  ${d.stage.padEnd(14)} ${keys.length} nutrient(s)`);
    }
  });

  console.log(`\n  Written: ${f.diets.length} standards.\n`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(`\n  ${e.message}\n`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
