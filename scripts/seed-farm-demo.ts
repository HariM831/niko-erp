/**
 * A demonstration farm — six houses, five batches, a month of daily records.
 *
 * Everything is written through the same services the screens use, so what
 * lands here is exactly what a person entering it would produce: the daily
 * figures go through `saveDay`, the batches through `createFlock`, and the
 * numbers are derived from the movement ledger rather than stuffed in.
 *
 * The shape is chosen to exercise the Houses screen rather than to look tidy:
 *  - four laying houses at different ages, so the standard comparison has
 *    something to disagree with;
 *  - one house deliberately left EMPTY, because a shed earning nothing is the
 *    thing the board exists to show;
 *  - two rearing houses, which have no egg column at all;
 *  - one house whose lay is running BELOW standard, so the red banding shows.
 *
 * Idempotent: it clears its own demo rows first, so running it twice leaves one
 * farm rather than two.
 *
 * Run:    npx tsx scripts/seed-farm-demo.ts
 * Clear:  npx tsx scripts/seed-farm-demo.ts --clear
 */
import { eq, inArray, sql } from "drizzle-orm";
import {
  birdWeighings,
  breeds,
  feedTransfers,
  flockHatches,
  flockMovements,
  flockPlacements,
  flocks,
  houses,
  items,
  locations,
  placementDays,
  standardPoints,
  standardSets,
  vaccinationEvents,
  vaccineStandards,
} from "@shared/schema";
import { db } from "../server/db";
import { createFlock } from "../server/services/flocks";
import { saveDay } from "../server/services/daily";

const CLEAR_ONLY = process.argv.includes("--clear");

/** The demo's own rows, so a re-run replaces rather than duplicates. */
const BREED_CODE = "LSL";
const CODES = ["AMN-2026-01", "AMN-2026-02", "AMN-2026-03", "AMN-2026-04", "AMN-2026-05"];

/** Deterministic jitter — the same farm every run, not a different one. */
function wobble(seed: number, spread: number) {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return (x - Math.floor(x) - 0.5) * 2 * spread;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: string, n: number) =>
  iso(new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000));

/**
 * A Lohmann-shaped layer curve: comes into lay around week 18, peaks near 95%
 * about week 27, then declines slowly. Body weight and intake grow with age;
 * mortality accumulates. Close enough that the "vs standard" chips mean
 * something on screen.
 */
function curve(week: number) {
  const lay =
    week < 17
      ? 0
      : week < 20
        ? (week - 16) * 22
        : week < 27
          ? 66 + (week - 20) * 4.2
          : Math.max(55, 95 - (week - 27) * 0.42);
  const bodyG =
    week < 18 ? 120 + week * 78 : Math.min(1980, 1530 + (week - 18) * 6.2);
  const feedG = week < 18 ? 22 + week * 3.9 : Math.min(118, 92 + (week - 18) * 0.55);
  const waterMl = feedG * 1.85;
  const cumMort = Math.min(9, week * 0.055 + (week > 20 ? (week - 20) * 0.03 : 0));
  return {
    ageWeek: week,
    layPct: lay > 0 ? lay.toFixed(2) : null,
    bodyWeightG: bodyG.toFixed(1),
    feedGPerBirdDay: feedG.toFixed(2),
    waterMlPerBirdDay: waterMl.toFixed(2),
    eggWeightG: week < 18 ? null : Math.min(64, 44 + (week - 18) * 0.34).toFixed(2),
    cumMortalityPct: cumMort.toFixed(2),
    uniformityCvPct: "8.50",
  };
}

/* ── Clear ────────────────────────────────────────────────────────────────── */

async function clear() {
  await db.transaction(async (tx) => {
    const mine = await tx.select().from(flocks).where(inArray(flocks.code, CODES));
    const ids = mine.map((f) => f.id);
    if (ids.length) {
      const ps = await tx
        .select({ id: flockPlacements.id })
        .from(flockPlacements)
        .where(inArray(flockPlacements.flockId, ids));
      const pids = ps.map((p) => p.id);
      if (pids.length) {
        await tx.delete(placementDays).where(inArray(placementDays.placementId, pids));
        await tx.delete(birdWeighings).where(inArray(birdWeighings.placementId, pids));
        await tx.delete(vaccinationEvents).where(inArray(vaccinationEvents.placementId, pids));
        await tx.delete(flockMovements).where(inArray(flockMovements.placementId, pids));
        await tx.delete(flockPlacements).where(inArray(flockPlacements.id, pids));
      }
      await tx.delete(flockHatches).where(inArray(flockHatches.flockId, ids));
      await tx.delete(flocks).where(inArray(flocks.id, ids));
    }
    await tx.delete(feedTransfers).where(sql`${feedTransfers.number} LIKE 'DEMO-%'`);
    console.log(`  cleared ${ids.length} demo batch(es)`);
  });
}

/* ── Seed ─────────────────────────────────────────────────────────────────── */

async function seed() {
  const today = iso(new Date());

  await db.transaction(async (tx) => {
    const userId = ((await tx.execute(sql`SELECT id FROM users LIMIT 1`)).rows[0] as { id: string })
      .id;

    // ── Breed and its curve ──
    let [breed] = await tx.select().from(breeds).where(eq(breeds.code, BREED_CODE));
    if (!breed) {
      [breed] = await tx
        .insert(breeds)
        .values({ code: BREED_CODE, name: "Lohmann LSL-Lite" })
        .returning();
    }
    let [set] = await tx.select().from(standardSets).where(eq(standardSets.breedId, breed!.id));
    if (!set) {
      [set] = await tx
        .insert(standardSets)
        .values({
          breedId: breed!.id,
          name: "Lohmann LSL-Lite 2023 guide",
          source: "breeder",
          isDefault: true,
        })
        .returning();
    }
    await tx.delete(standardPoints).where(eq(standardPoints.setId, set!.id));
    await tx
      .insert(standardPoints)
      .values(
        Array.from({ length: 90 }, (_, i) => ({ setId: set!.id, ...curve(i + 1) })),
      );
    console.log("  standard curve: 90 weeks");

    // ── The vaccination programme ──
    await tx.delete(vaccineStandards);
    await tx.insert(vaccineStandards).values([
      { age: "Day 1", vaccineName: "Marek's", sortOrder: 10 },
      { age: "Day 5", vaccineName: "IB (Ma5)", sortOrder: 20 },
      { age: "Day 10", vaccineName: "ND (Lasota)", sortOrder: 30 },
      { age: "Week 3", vaccineName: "IBD (Gumboro)", sortOrder: 40 },
      { age: "Week 6", vaccineName: "Fowl Pox", sortOrder: 50 },
      { age: "Week 10", vaccineName: "ND (killed)", sortOrder: 60 },
      { age: "Week 16", vaccineName: "ND + IB + EDS", sortOrder: 70 },
    ]);
    console.log("  vaccination programme: 7 items");

    // ── The houses, and what stands in them ──
    const sheds = await tx.select().from(houses).where(eq(houses.isActive, true));
    const of = (code: string) => sheds.find((h) => h.code === code)!;

    // L5 is left empty on purpose — an idle shed is what the board is for.
    const plan = [
      { code: CODES[0]!, house: "L2", ageWeeks: 32, birds: 12_000, offBy: 0 },
      { code: CODES[1]!, house: "L3", ageWeeks: 52, birds: 11_200, offBy: 0 },
      // Running below the guide, so the red banding has something to show.
      { code: CODES[2]!, house: "L4", ageWeeks: 41, birds: 12_600, offBy: -9 },
      { code: CODES[3]!, house: "P1", ageWeeks: 9, birds: 15_000, offBy: 0 },
      { code: CODES[4]!, house: "P2", ageWeeks: 3, birds: 16_400, offBy: 0 },
    ];

    const [feedItem] = await tx
      .select({ id: items.id })
      .from(items)
      .where(sql`${items.name} ILIKE '%layer%' OR ${items.name} ILIKE '%feed%'`)
      .limit(1);
    const [mill] = await tx.select().from(locations).where(eq(locations.type, "feed_mill"));

    let transferNo = 1;

    for (const p of plan) {
      const shed = of(p.house);
      const hatch = addDays(today, -p.ageWeeks * 7);
      // Two hatches a few days apart, because that is how a batch arrives.
      const first = Math.round(p.birds * 0.62);
      const { flock, placement } = await createFlock(tx, {
        code: p.code,
        locationId: shed.locationId,
        breedId: breed!.id,
        houseId: shed.id,
        hatches: [
          { hatchDate: hatch, qty: first },
          { hatchDate: addDays(hatch, 3), qty: p.birds - first },
        ],
        note: "Demonstration data",
        userId,
      });

      const laying = p.ageWeeks >= 18;
      if (laying) {
        await tx
          .update(flocks)
          .set({ status: "laying", layStartDate: addDays(hatch, 18 * 7) })
          .where(eq(flocks.id, flock.id));
      }

      // ── Feed delivered from the mill ──
      if (feedItem && mill) {
        for (let w = 0; w < 4; w++) {
          await tx.insert(feedTransfers).values({
            number: `DEMO-${String(transferNo++).padStart(4, "0")}`,
            transferDate: addDays(today, -21 + w * 7),
            itemId: feedItem.id,
            quantityKg: String(Math.round(p.birds * 0.115 * 7)),
            fromLocationId: mill.id,
            toLocationId: shed.locationId,
            toHouseId: shed.id,
          });
        }
      }

      // ── Thirty days of records, or the batch's whole life if shorter ──
      //
      // A three-week-old batch has no thirtieth day back, and saveDay rightly
      // refuses a day before the birds arrived — so the window is clamped
      // rather than the refusal worked around.
      let alive = p.birds;
      const firstDay = addDays(hatch, 3);
      for (let d = 29; d >= 0; d--) {
        const on = addDays(today, -d);
        if (on < firstDay) continue;
        const ageWeek = Math.floor(
          (Date.parse(`${on}T00:00:00Z`) - Date.parse(`${hatch}T00:00:00Z`)) / (7 * 86_400_000),
        );
        const std = curve(Math.max(1, ageWeek));

        const mortality = Math.max(0, Math.round(alive * 0.00018 + wobble(d + alive, 2.2)));
        const culls = d % 9 === 0 ? Math.max(0, Math.round(1 + wobble(d, 2))) : 0;
        alive -= mortality + culls;

        const feedPerBird = Number(std.feedGPerBirdDay) + wobble(d * 3, 3.5);
        const feedKg = (feedPerBird * alive) / 1000;
        const waterL = ((Number(std.waterMlPerBirdDay) + wobble(d * 5, 9)) * alive) / 1000;
        const eggs = laying
          ? Math.round(((Number(std.layPct ?? 0) + p.offBy + wobble(d * 7, 1.4)) / 100) * alive)
          : 0;

        await saveDay(
          tx,
          {
            placementId: placement.id,
            day: on,
            feedConsumedKg: feedKg.toFixed(2),
            feedClosingKg: (feedKg * 3.4).toFixed(2),
            // Two tanks, as the operator reads them.
            waterUpperKl: (waterL / 1000 / 2).toFixed(2),
            waterLowerKl: (waterL / 1000 / 2).toFixed(2),
            eggsTotal: eggs || null,
            eggsCracked: eggs ? Math.round(eggs * 0.004) : null,
            losses: [
              ...(mortality ? [{ kind: "mortality" as const, qty: mortality, causeCode: "unknown" }] : []),
              ...(culls ? [{ kind: "cull" as const, qty: culls, causeCode: "cull_weak" }] : []),
            ],
          },
          userId,
        );
      }

      // ── A few weighings, and the last vaccination given ──
      for (let k = 0; k < 4; k++) {
        const wk = p.ageWeeks - k * 4;
        if (wk < 1) continue;
        const s = curve(wk);
        await tx.insert(birdWeighings).values({
          placementId: placement.id,
          weekNumber: wk,
          weighedOn: addDays(today, -k * 28),
          avgWeightG: (Number(s.bodyWeightG) + wobble(wk, 45)).toFixed(1),
          eggWeightG: s.eggWeightG,
          sampleSize: 100,
        });
      }
      await tx.insert(vaccinationEvents).values({
        placementId: placement.id,
        eventDate: addDays(hatch, p.ageWeeks >= 16 ? 16 * 7 : 21),
        vaccineName: p.ageWeeks >= 16 ? "ND + IB + EDS" : "IBD (Gumboro)",
        make: "Ventri",
        birdsVaccinated: p.birds,
        vaccinatorCount: 2,
        laboursCount: 6,
      });

      console.log(
        `  ${p.code.padEnd(12)} ${p.house}  ${String(p.birds).padStart(6)} placed  ${String(alive).padStart(6)} now  ${p.ageWeeks}w${laying ? "  laying" : "  rearing"}`,
      );
    }
    console.log("  L5 left empty on purpose");
  });
}

await clear();
if (!CLEAR_ONLY) await seed();
console.log("");
process.exit(0);
