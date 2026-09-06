/**
 * Load the breeders' own standards and the bird value schedule into niko.
 *
 * The files live in server/db/standards/. A breed file carries the breeder's
 * weekly points — body weight, feed, water, lay, egg weight, mortality — as
 * printed in the management guide; the bird value file carries what a layer is
 * worth at each age week, from the consultant's letter. Nobody types body
 * weights into niko: the flock's hatch date and its breed decide every
 * age-based figure from here.
 *
 * Breeds are matched by code, then by the aliases in each file, so a breed the
 * farm already named ("Hy-Line W-80", "Bovans") is reused rather than
 * duplicated. A breeder set is written once per (breed, name, version) and its
 * points replaced in full; it becomes the breed's default only when the breed
 * has none. Bird values are dated by the letter, and re-running for the same
 * date corrects rather than duplicates.
 *
 *   npx tsx scripts/seed-breed-standards.ts            (dry)
 *   npx tsx scripts/seed-breed-standards.ts --apply
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { birdValuationRates, breeds, standardPoints, standardSets } from "@shared/schema";
import { db } from "../server/db";

const APPLY = process.argv.includes("--apply");
const DIR = join(import.meta.dirname, "../server/db/standards");

interface Point {
  ageWeek: number;
  bodyWeightG: number | null;
  feedGPerBirdDay: number | null;
  waterMlPerBirdDay: number | null;
  layPct: number | null;
  eggWeightG: number | null;
  cumMortalityPct: number | null;
}
interface BreedFile {
  breed: { code: string; name: string; aliases?: string[] };
  set: { name: string; source: "breeder" | "in-house" | "blend"; version: number; note?: string };
  points: Point[];
}
interface ValuesFile {
  source: string;
  effectiveFrom: string;
  valuesByWeek: Record<string, number>;
}

const files = readdirSync(DIR).filter((f) => f.endsWith(".json"));
const breedFiles: BreedFile[] = [];
let values: ValuesFile | null = null;
for (const f of files) {
  const j = JSON.parse(readFileSync(join(DIR, f), "utf-8"));
  if (j.valuesByWeek) values = j;
  else if (j.breed && j.points) breedFiles.push(j);
}
console.log(`\n  ${breedFiles.length} breed file(s), ${values ? "one" : "no"} bird value schedule\n`);

const d = (v: number | null | undefined) => (v == null ? null : String(v));

async function findBreed(b: BreedFile["breed"]) {
  const [byCode] = await db.select().from(breeds).where(eq(breeds.code, b.code));
  if (byCode) return byCode;
  const needles = [b.name, ...(b.aliases ?? [])].map((s) => s.toLowerCase());
  const all = await db.select().from(breeds);
  return all.find((r) => needles.some((n) => r.name.toLowerCase().includes(n) || n.includes(r.name.toLowerCase()))) ?? null;
}

const touched: Array<{ id: string; name: string }> = [];

for (const bf of breedFiles) {
  let breed = await findBreed(bf.breed);
  console.log(`  ${bf.breed.name}: ${breed ? `matches breed "${breed.name}" (${breed.code})` : "new breed"}; set "${bf.set.name}" v${bf.set.version}, ${bf.points.length} weekly points`);
  if (!APPLY) continue;
  await db.transaction(async (tx) => {
    if (!breed) {
      [breed] = await tx.insert(breeds).values({ code: bf.breed.code, name: bf.breed.name }).returning();
    }
    let [set] = await tx
      .select()
      .from(standardSets)
      .where(and(eq(standardSets.breedId, breed!.id), eq(standardSets.name, bf.set.name), eq(standardSets.version, bf.set.version)));
    if (!set) {
      const [hasDefault] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(standardSets)
        .where(and(eq(standardSets.breedId, breed!.id), eq(standardSets.isDefault, true)));
      [set] = await tx
        .insert(standardSets)
        .values({
          breedId: breed!.id,
          name: bf.set.name,
          source: bf.set.source,
          version: bf.set.version,
          note: bf.set.note ?? null,
          isDefault: (hasDefault?.n ?? 0) === 0,
        })
        .returning();
    }
    await tx.delete(standardPoints).where(eq(standardPoints.setId, set!.id));
    await tx.insert(standardPoints).values(
      bf.points.map((p) => ({
        setId: set!.id,
        ageWeek: p.ageWeek,
        bodyWeightG: d(p.bodyWeightG),
        feedGPerBirdDay: d(p.feedGPerBirdDay),
        waterMlPerBirdDay: d(p.waterMlPerBirdDay),
        layPct: d(p.layPct),
        eggWeightG: d(p.eggWeightG),
        cumMortalityPct: d(p.cumMortalityPct),
      })),
    );
  });
  touched.push({ id: breed!.id, name: breed!.name });
}

if (values) {
  const weeks = Object.entries(values.valuesByWeek).map(([w, v]) => ({ week: Number(w), value: v }));
  const targets = APPLY ? touched : breedFiles.map((b) => ({ id: "?", name: b.breed.name }));
  console.log(`\n  bird values effective ${values.effectiveFrom}: ${weeks.length} weeks (${weeks[0]!.value} → ${weeks.at(-1)!.value}) for ${targets.map((t) => t.name).join(", ")}`);
  if (APPLY) {
    for (const t of touched) {
      for (const w of weeks) {
        await db
          .insert(birdValuationRates)
          .values({
            breedId: t.id,
            ageWeek: w.week,
            rate: w.value.toFixed(2),
            effectiveFrom: values.effectiveFrom,
            note: values.source,
          })
          .onConflictDoUpdate({
            target: [birdValuationRates.breedId, birdValuationRates.ageWeek, birdValuationRates.effectiveFrom],
            set: { rate: w.value.toFixed(2), note: values.source },
          });
      }
    }
  }
}

console.log(APPLY ? "\n  done\n" : "\n  dry run — add --apply to write\n");
process.exit(0);
