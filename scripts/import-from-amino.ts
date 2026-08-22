/**
 * Bring the farm's history across from Amino.
 *
 * Reads the file `scripts/export-farm-for-eggsy.ts` produces in the Amino repo
 * and writes it into EGGSY's shapes. Dry by default: it resolves every mapping,
 * prints what it would do, and refuses on anything ambiguous. `--apply` writes.
 *
 * The hard part is not the copying — it is that the two apps model a batch
 * differently. In Amino a batch belongs to a SHED: moving birds creates a
 * second bird_stock row in the destination with the same batch number, and the
 * two rows are related only by that string. In EGGSY a batch is a FLOCK that
 * owns its birds for life and is PLACED in a house at a time, which is the
 * whole reason its lifetime mortality and cost per egg survive the move.
 *
 * So bird_stock rows are grouped by batch number into one flock with several
 * placements. Get that wrong and every batch that has ever been housed shows
 * two half-lives instead of one whole one — the exact failure EGGSY exists to
 * fix, reintroduced by its own import.
 *
 * Idempotent: everything is keyed on Amino's identifiers, so a second run
 * corrects rather than duplicates.
 *
 *   npx tsx scripts/import-from-amino.ts --file farm-export/farm-export.json
 *   npx tsx scripts/import-from-amino.ts --file farm-export/farm-export.json --apply
 */
import { readFile } from "node:fs/promises";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  birdValuationRates,
  breeds,
  flockHatches,
  flockMovements,
  flockPlacements,
  flocks,
  houses,
  items,
  standardPoints,
  standardSets,
} from "@shared/schema";
import { db } from "../server/db";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const FILE = arg("file") ?? "farm-export/farm-export.json";
const APPLY = process.argv.includes("--apply");

/* ── The export's shapes, as Amino's tables actually are ───────────────────── */

interface AminoShed {
  id: string;
  name: string;
  type: string;
  farm_name: string | null;
  breed_id: string | null;
  display_order: number;
  bh_device_id: string | null;
}
interface AminoBreed {
  id: string;
  name: string;
  [k: string]: unknown;
}
interface AminoBreedStandard {
  breed_id: string;
  week_number: number;
  feed_grams_per_bird: number | null;
  water_ml_per_bird: number | null;
  egg_percentage: number | null;
  mortality_percent: number | null;
  body_weight_grams: number | null;
  bird_value: number | null;
  egg_weight_grams: number | null;
}
interface AminoBirdStock {
  id: string;
  shed_id: string;
  batch_number: string;
  date_in: string;
  opening_count: number;
  source_shed_id: string | null;
  batch_birth_date: string | null;
  breed_id: string | null;
  is_active: boolean;
  notes: string | null;
}
interface AminoTransfer {
  batch_number: string;
  from_shed_id: string;
  to_shed_id: string;
  transfer_date: string;
  bird_count: number;
  notes: string | null;
}

interface Export {
  exportedAt: string;
  manifest: Array<{ table: string; rows: number; from?: string | null; to?: string | null }>;
  data: Record<string, unknown[]>;
}

/* ── Reporting ────────────────────────────────────────────────────────────── */

let problems = 0;
const say = (s = "") => console.log(s);
const step = (s: string) => say(`\n  ${s}`);
const note = (s: string) => say(`     ${s}`);
const problem = (s: string) => {
  problems++;
  say(`   ! ${s}`);
};

/** Amino stores dates as timestamps; EGGSY's farm records are days. */
const day = (v: string | null | undefined): string | null =>
  v ? String(v).slice(0, 10) : null;

const raw = await readFile(FILE, "utf8");
const exp = JSON.parse(raw) as Export;

say(`\n  IMPORT FROM AMINO`);
say(`  exported ${exp.exportedAt.slice(0, 19).replace("T", " ")}`);
say(APPLY ? "  APPLYING — this writes" : "  dry run — nothing is written; add --apply when it reads right");

say("\n  what the file holds");
for (const m of exp.manifest) {
  const span = m.from ? `  ${String(m.from).slice(0, 10)} … ${String(m.to).slice(0, 10)}` : "";
  say(`     ${m.table.padEnd(22)} ${String(m.rows).padStart(6)}${span}`);
}

const table = <T>(name: string): T[] => (exp.data[name] ?? []) as T[];

/* ── 1. Sheds → houses ────────────────────────────────────────────────────── */
//
// Matched by name, never created. A house in EGGSY carries its site, its owner
// and its stock location — facts Amino never had — so inventing one from a
// shed name would produce a house belonging to nobody, standing nowhere.
step("1. Sheds → houses");
const aminoSheds = table<AminoShed>("sheds");
const eggsyHouses = await db.select().from(houses);
const houseByCode = new Map(eggsyHouses.map((h) => [h.code.toUpperCase().trim(), h]));

const shedToHouse = new Map<string, { id: string; code: string }>();
for (const s of aminoSheds) {
  const key = s.name.toUpperCase().trim();
  const match = houseByCode.get(key);
  if (!match) {
    problem(`shed "${s.name}" has no house in EGGSY — create it first, or rename to match`);
    continue;
  }
  shedToHouse.set(s.id, { id: match.id, code: match.code });
  const dev = s.bh_device_id ? `  controller ${s.bh_device_id}` : "  no controller";
  note(`${s.name.padEnd(6)} → ${match.code.padEnd(6)}${dev}`);
}
const unmatched = eggsyHouses.filter((h) => ![...shedToHouse.values()].some((v) => v.id === h.id));
for (const h of unmatched) note(`${"".padEnd(6)}   ${h.code} has no shed in the export — left alone`);

/* ── 2. Controllers ───────────────────────────────────────────────────────── */
//
// The device id rides along with the shed, so the IoT poller gets its mapping
// from the same import rather than from a list typed out by hand.
step("2. Controllers → houses.bh_device_id");
const deviceUpdates: Array<{ houseId: string; code: string; device: string }> = [];
for (const s of aminoSheds) {
  const h = shedToHouse.get(s.id);
  if (!h || !s.bh_device_id) continue;
  deviceUpdates.push({ houseId: h.id, code: h.code, device: s.bh_device_id });
}
note(`${deviceUpdates.length} house(s) name a controller`);
if (APPLY) {
  for (const u of deviceUpdates) {
    await db.update(houses).set({ bhDeviceId: u.device }).where(eq(houses.id, u.houseId));
  }
  note("written");
}

/* ── 3. Breeds ────────────────────────────────────────────────────────────── */
step("3. Breeds");
const aminoBreeds = table<AminoBreed>("breeds");
const eggsyBreeds = await db.select().from(breeds);
const breedByName = new Map(eggsyBreeds.map((b) => [b.name.toUpperCase().trim(), b]));
const breedMap = new Map<string, string>();

for (const b of aminoBreeds) {
  const key = String(b.name).toUpperCase().trim();
  const found = breedByName.get(key);
  if (found) {
    breedMap.set(b.id, found.id);
    note(`${b.name} → existing`);
    continue;
  }
  if (APPLY) {
    const code = String(b.name).slice(0, 10).toUpperCase().replace(/[^A-Z0-9]/g, "");
    const [made] = await db
      .insert(breeds)
      .values({ code: code || `B${breedMap.size + 1}`, name: String(b.name) })
      .returning();
    breedMap.set(b.id, made!.id);
    note(`${b.name} → created`);
  } else {
    note(`${b.name} → would be created`);
  }
}

/* ── 4. Breed standards → standard sets and points ────────────────────────── */
//
// Amino keeps one flat curve per breed. EGGSY versions them, so each breed's
// curve becomes one set named for where it came from — which is what makes it
// possible later to add a revised curve without restating the batches that
// were measured against this one.
step("4. Breed standards → curves");
const aminoStandards = table<AminoBreedStandard>("breed_standards");
const byBreed = new Map<string, AminoBreedStandard[]>();
for (const s of aminoStandards) {
  const list = byBreed.get(s.breed_id) ?? [];
  byBreed.set(s.breed_id, list);
  list.push(s);
}

const d2 = (v: number | null | undefined) => (v == null ? null : String(v));
let curvePoints = 0;
let valuationPoints = 0;

for (const [aminoBreedId, points] of byBreed) {
  const breedId = breedMap.get(aminoBreedId);
  const name = aminoBreeds.find((b) => b.id === aminoBreedId)?.name ?? aminoBreedId;
  if (!breedId) {
    if (!APPLY) {
      note(`${name}: ${points.length} week(s) — breed not mapped yet (would be, on --apply)`);
    } else {
      problem(`${name}: breed did not map, ${points.length} standard week(s) skipped`);
    }
    continue;
  }

  if (APPLY) {
    const [set] = await db
      .insert(standardSets)
      .values({
        breedId,
        name: "Amino import",
        source: "breeder",
        version: 1,
        isDefault: false,
        note: `Imported from Amino on ${new Date().toISOString().slice(0, 10)}`,
      })
      .onConflictDoNothing()
      .returning();

    const setId =
      set?.id ??
      (
        await db
          .select()
          .from(standardSets)
          .where(and(eq(standardSets.breedId, breedId), eq(standardSets.name, "Amino import")))
      )[0]?.id;
    if (!setId) {
      problem(`${name}: could not create a standard set`);
      continue;
    }

    for (const p of points) {
      await db
        .insert(standardPoints)
        .values({
          setId,
          ageWeek: p.week_number,
          bodyWeightG: d2(p.body_weight_grams),
          feedGPerBirdDay: d2(p.feed_grams_per_bird),
          waterMlPerBirdDay: d2(p.water_ml_per_bird),
          layPct: d2(p.egg_percentage),
          eggWeightG: d2(p.egg_weight_grams),
          cumMortalityPct: d2(p.mortality_percent),
        })
        .onConflictDoUpdate({
          target: [standardPoints.setId, standardPoints.ageWeek],
          set: {
            bodyWeightG: d2(p.body_weight_grams),
            feedGPerBirdDay: d2(p.feed_grams_per_bird),
            waterMlPerBirdDay: d2(p.water_ml_per_bird),
            layPct: d2(p.egg_percentage),
            eggWeightG: d2(p.egg_weight_grams),
            cumMortalityPct: d2(p.mortality_percent),
          },
        });
      curvePoints++;

      // Amino carried a bird value per week on the same row. That is a real
      // valuation curve, and better evidence than anything derived.
      if (p.bird_value != null && p.bird_value > 0) {
        await db
          .insert(birdValuationRates)
          .values({
            breedId,
            ageWeek: p.week_number,
            rate: p.bird_value.toFixed(2),
            effectiveFrom: "2025-04-01",
            note: "Imported from Amino breed standards",
          })
          .onConflictDoNothing();
        valuationPoints++;
      }
    }
  } else {
    curvePoints += points.length;
    valuationPoints += points.filter((p) => p.bird_value != null && p.bird_value > 0).length;
  }
  note(`${name}: ${points.length} week(s)`);
}
note(`${curvePoints} curve point(s), ${valuationPoints} bird valuation(s)`);

/* ── 5. Bird stock → flocks and placements ────────────────────────────────── */
//
// The heart of it. Rows sharing a batch number are ONE flock in EGGSY, however
// many sheds they are spread across.
step("5. Batches → flocks and placements");
const stock = table<AminoBirdStock>("bird_stock");
const byBatch = new Map<string, AminoBirdStock[]>();
for (const s of stock) {
  const list = byBatch.get(s.batch_number) ?? [];
  byBatch.set(s.batch_number, list);
  list.push(s);
}
note(`${stock.length} bird_stock row(s) → ${byBatch.size} flock(s)`);

const transfers = table<AminoTransfer>("batch_transfers");
const transfersByBatch = new Map<string, AminoTransfer[]>();
for (const t of transfers) {
  const list = transfersByBatch.get(t.batch_number) ?? [];
  transfersByBatch.set(t.batch_number, list);
  list.push(t);
}

for (const [batch, rows] of [...byBatch].sort()) {
  const sorted = [...rows].sort((a, b) => String(a.date_in).localeCompare(String(b.date_in)));
  const first = sorted[0]!;
  const placed = sorted.reduce((s, r) => s + r.opening_count, 0);
  const sheds = sorted.map((r) => shedToHouse.get(r.shed_id)?.code ?? "?").join(" → ");
  const hatch = day(first.batch_birth_date) ?? day(first.date_in)!;
  const moves = transfersByBatch.get(batch)?.length ?? 0;
  const unknown = sorted.filter((r) => !shedToHouse.has(r.shed_id));
  if (unknown.length) {
    problem(`batch ${batch} sits in a shed that did not map — skipped`);
    continue;
  }
  note(
    `${batch.padEnd(14)} ${String(placed).padStart(7)} placed  hatched ${hatch}  ` +
      `${sorted.length} placement(s): ${sheds}  ${moves} transfer(s)`,
  );
}

/* ── What is left ─────────────────────────────────────────────────────────── */
step("Still to write (this pass maps and reports only)");
for (const t of ["daily_bird_records", "weekly_bird_weights", "formula_transfers", "farm_items", "ai_observations"]) {
  const n = exp.manifest.find((m) => m.table === t)?.rows ?? 0;
  note(`${t.padEnd(22)} ${String(n).padStart(6)} row(s)`);
}

say(
  problems
    ? `\n  ${problems} thing(s) need sorting before this can be applied\n`
    : APPLY
      ? "\n  applied\n"
      : "\n  reads clean — run again with --apply\n",
);
void inArray;
void flocks;
void flockHatches;
void flockPlacements;
void flockMovements;
void items;
void sql;
process.exit(problems ? 1 : 0);
