/**
 * Bring the farm's history across from Amino.
 *
 * Dry by default: it resolves everything, says what it would write, and stops.
 * `--apply` writes, in ONE transaction, so a failure half-way leaves nothing
 * behind rather than a farm that is half here.
 *
 * Run `check-amino-export.ts` first. It explains the two things about the
 * source that this file depends on: a batch's later hatches arrive as daily
 * "transferred in" rows rather than as bird_stock, and the batch_number on the
 * daily sheet is backfilled and wrong often enough to be useless. Arrivals are
 * therefore resolved by SHED AND DATE throughout.
 *
 * Everything goes through the same services the screens use — createFlock,
 * setFlockTransfers, saveDay — rather than straight into tables. They refuse
 * impossible movements, which is the point: an import that writes what the
 * screens would reject is an import that has quietly invented history.
 *
 *   npx tsx scripts/import-from-amino.ts --file farm-export/farm-export.json
 *   npx tsx scripts/import-from-amino.ts --file farm-export/farm-export.json --apply
 *   npx tsx scripts/import-from-amino.ts --file ... --apply --reset   (re-import)
 */
import { readFile } from "node:fs/promises";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  birdValuationRates,
  birdWeighings,
  breeds,
  feedTransfers,
  flockDay,
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
} from "@shared/schema";
import { db } from "../server/db";
import { createFlock, setFlockTransfers, startLay } from "../server/services/flocks";
import { saveDay } from "../server/services/daily";
import { refreshFlockDay } from "../server/services/rollup";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const FILE = arg("file") ?? "farm-export/farm-export.json";
const APPLY = process.argv.includes("--apply");
const RESET = process.argv.includes("--reset");

type Row = Record<string, unknown>;
const exp = JSON.parse(await readFile(FILE, "utf8")) as {
  exportedAt: string;
  data: Record<string, Row[]>;
};
const t = (name: string) => exp.data[name] ?? [];

const n = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0) || 0);
const s = (v: unknown) => (v == null ? "" : String(v));
const day = (v: unknown) => s(v).slice(0, 10);
const num = (v: number) => v.toLocaleString("en-IN");
const d2 = (v: unknown) => (v == null ? null : String(n(v)));

/** Thrown to roll a dry run back. Not an error anybody needs to see. */
class DryRun extends Error {}

let problems = 0;
const say = (m = "") => console.log(m);
const step = (m: string) => say(`\n  ${m}`);
const note = (m: string) => say(`     ${m}`);
const problem = (m: string) => {
  problems++;
  say(`   ! ${m}`);
};

say("\n  IMPORT FROM AMINO");
say(`  exported ${exp.exportedAt.slice(0, 19).replace("T", " ")}`);
say(APPLY ? (RESET ? "  APPLY + RESET — imported flocks are removed first" : "  APPLY — writing") : "  dry run");

const shedRows = t("sheds");
const stock = t("bird_stock");
const daily = t("daily_bird_records");
const weights = t("weekly_bird_weights");
const feed = t("formula_transfers");
const aminoBreeds = t("breeds");
const aminoStd = t("breed_standards");
const aminoItems = t("farm_items");

/* ── The stay timeline: which batch stood in which shed, when ─────────────── */
const stays = stock.map((r) => ({
  batch: s(r.batch_number),
  shed: s(r.shed_id),
  from: day(r.date_in),
}));
const byShed = new Map<string, typeof stays>();
for (const st of stays) {
  const list = byShed.get(st.shed) ?? [];
  byShed.set(st.shed, list);
  list.push(st);
}
for (const list of byShed.values()) list.sort((a, b) => a.from.localeCompare(b.from));

/**
 * Which batch a house's day belongs to: the one with the most birds standing
 * there.
 *
 * Not "the batch that arrived most recently", which is the obvious rule and is
 * wrong in both directions on this farm. L3 holds 124,384 birds of one batch
 * and a stray 1,835 of another that arrived later — charging L3's eggs to the
 * newcomer gives a hen-day of 13,000%. P1 holds the tail of a batch that has
 * nearly all left alongside a new one that has just arrived — and there the
 * newcomer IS the answer.
 *
 * Presence is computed from bird_stock alone: birds that arrived into this
 * house, less those that have since arrived somewhere else FROM this house.
 * Mortality is not subtracted — it is small against these numbers and knowing
 * it would require the very records this is resolving.
 */
function presentIn(shedId: string, batch: string, on: string): number {
  const arrived = stock
    .filter((r) => s(r.batch_number) === batch && s(r.shed_id) === shedId && day(r.date_in) <= on)
    .reduce((sum, r) => sum + n(r.opening_count), 0);
  const left = stock
    .filter(
      (r) =>
        s(r.batch_number) === batch && s(r.source_shed_id) === shedId && day(r.date_in) <= on,
    )
    .reduce((sum, r) => sum + n(r.opening_count), 0);
  return arrived - left;
}

/** Every batch that has ever stood in a house. */
const batchesInShed = new Map<string, string[]>();
for (const st of stays) {
  const list = batchesInShed.get(st.shed) ?? [];
  batchesInShed.set(st.shed, list);
  if (!list.includes(st.batch)) list.push(st.batch);
}

/** Days where two batches were BOTH materially present — reported, not hidden. */
const ambiguous: string[] = [];

function batchOn(shedId: string, on: string): string | null {
  const candidates = (batchesInShed.get(shedId) ?? [])
    .map((batch) => ({ batch, birds: presentIn(shedId, batch, on) }))
    .filter((c) => c.birds > 0)
    .sort((a, b) => b.birds - a.birds);
  if (!candidates.length) return null;
  const [top, second] = candidates;
  // A house whose second batch is more than a tenth of it cannot honestly have
  // its shed-level day given to one of them; Amino never recorded which was
  // which. Said out loud rather than quietly rounded away.
  if (second && second.birds > top!.birds * 0.1) {
    ambiguous.push(`${shedId}|${on}|${top!.batch} ${top!.birds} vs ${second.batch} ${second.birds}`);
  }
  return top!.batch;
}

try {
  await db.transaction(async (tx) => {
    const userId = ((await tx.execute(sql`SELECT id FROM users LIMIT 1`)).rows[0] as { id: string }).id;

    /* ── 1. Sheds → houses ──────────────────────────────────────────────── */
    step("1. Sheds → houses");
    const eggsyHouses = await tx.select().from(houses);
    const byCode = new Map(eggsyHouses.map((h) => [h.code.toUpperCase().trim(), h]));
    const houseOf = new Map<string, (typeof eggsyHouses)[number]>();
    for (const sh of shedRows) {
      const match = byCode.get(s(sh.name).toUpperCase().trim());
      if (!match) {
        problem(`shed "${s(sh.name)}" has no house in niko`);
        continue;
      }
      houseOf.set(s(sh.id), match);
      note(`${s(sh.name).padEnd(4)} → ${match.code.padEnd(4)}  ${s(sh.bh_device_id) || "no controller"}`);
      if (APPLY && sh.bh_device_id) {
        await tx.update(houses).set({ bhDeviceId: s(sh.bh_device_id) }).where(eq(houses.id, match.id));
      }
    }
    if (problems) throw new Error("houses must match before anything else can be read");

    /* ── 2. Breeds ──────────────────────────────────────────────────────── */
    step("2. Breeds");
    const existingBreeds = await tx.select().from(breeds);
    const breedByName = new Map(existingBreeds.map((b) => [b.name.toUpperCase().trim(), b]));
    const breedOf = new Map<string, string>();
    for (const b of aminoBreeds) {
      const key = s(b.name).toUpperCase().trim();
      const found = breedByName.get(key);
      if (found) {
        breedOf.set(s(b.id), found.id);
        note(`${s(b.name)} → existing`);
      } else if (APPLY) {
        const code = s(b.name).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10) || `B${breedOf.size}`;
        const [made] = await tx.insert(breeds).values({ code, name: s(b.name) }).returning();
        breedOf.set(s(b.id), made!.id);
        breedByName.set(key, made!);
        note(`${s(b.name)} → created`);
      } else {
        // Mapped to a placeholder so the dry run can report everything that
        // hangs off this breed instead of claiming it does not exist.
        breedOf.set(s(b.id), `would-create:${s(b.id)}`);
        note(`${s(b.name)} → would be created`);
      }
    }

    /* ── 3. Standards, and the valuation curve that rode with them ──────── */
    step("3. Breed standards → curves");
    const stdByBreed = new Map<string, Row[]>();
    for (const p of aminoStd) {
      const list = stdByBreed.get(s(p.breed_id)) ?? [];
      stdByBreed.set(s(p.breed_id), list);
      list.push(p);
    }
    let points = 0;
    let valuations = 0;
    for (const [aminoBreed, rows] of stdByBreed) {
      const breedId = breedOf.get(aminoBreed);
      const name = s(aminoBreeds.find((b) => s(b.id) === aminoBreed)?.name) || aminoBreed;
      if (!breedId) {
        // Standards for a breed that is not in the breeds table at all. Real
        // orphans in the source, worth naming rather than dropping silently.
        note(`${name}: ${rows.length} week(s) — orphaned, no such breed; skipped`);
        continue;
      }
      if (breedId.startsWith("would-create:")) {
        points += rows.length;
        valuations += rows.filter((p) => n(p.bird_value) > 0).length;
        note(`${name}: ${rows.length} week(s)`);
        continue;
      }
      if (APPLY) {
        const [set] = await tx
          .insert(standardSets)
          .values({
            breedId,
            name: "Amino import",
            source: "breeder",
            version: 1,
            // Made the default only when the breed has none, so an import never
            // silently repoints a flock that is already measured against a curve.
            isDefault: !(
              await tx
                .select()
                .from(standardSets)
                .where(and(eq(standardSets.breedId, breedId), eq(standardSets.isDefault, true)))
            ).length,
            note: `Imported from Amino ${exp.exportedAt.slice(0, 10)}`,
          })
          .onConflictDoNothing()
          .returning();
        const setId =
          set?.id ??
          (
            await tx
              .select()
              .from(standardSets)
              .where(and(eq(standardSets.breedId, breedId), eq(standardSets.name, "Amino import")))
          )[0]!.id;

        for (const p of rows) {
          const week = n(p.week_number);
          await tx
            .insert(standardPoints)
            .values({
              setId,
              ageWeek: week,
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
          points++;

          // Amino carried a bird value per week on the same row. Real evidence,
          // and better than anything derived from a cost model.
          if (n(p.bird_value) > 0) {
            await tx
              .insert(birdValuationRates)
              .values({
                breedId,
                ageWeek: week,
                rate: n(p.bird_value).toFixed(2),
                effectiveFrom: "2025-04-01",
                note: "From Amino breed standards",
              })
              .onConflictDoNothing();
            valuations++;
          }
        }
      } else {
        points += rows.length;
        valuations += rows.filter((p) => n(p.bird_value) > 0).length;
      }
      note(`${name}: ${rows.length} week(s)`);
    }
    note(`${points} curve point(s), ${valuations} valuation(s)`);

    /* ── 4. Batches → flocks, hatches, placements, transfers ────────────── */
    step("4. Batches → flocks");

    const origins = stock
      .filter((r) => !r.source_shed_id)
      .sort((a, b) => day(a.date_in).localeCompare(day(b.date_in)));

    if (RESET && APPLY) {
      const codes = origins.map((o) => s(o.batch_number));
      const doomed = await tx.select({ id: flocks.id }).from(flocks).where(inArray(flocks.code, codes));
      if (doomed.length) {
        const ids = doomed.map((f) => f.id);
        const places = await tx
          .select({ id: flockPlacements.id })
          .from(flockPlacements)
          .where(inArray(flockPlacements.flockId, ids));
        const pids = places.map((p) => p.id);
        if (pids.length) {
          await tx.delete(flockDay).where(inArray(flockDay.placementId, pids));
          await tx.delete(placementDays).where(inArray(placementDays.placementId, pids));
          await tx.delete(birdWeighings).where(inArray(birdWeighings.placementId, pids));
          await tx.delete(flockMovements).where(inArray(flockMovements.placementId, pids));
          await tx.delete(flockPlacements).where(inArray(flockPlacements.id, pids));
        }
        await tx.delete(flockHatches).where(inArray(flockHatches.flockId, ids));
        await tx.delete(flocks).where(inArray(flocks.id, ids));
        note(`reset: removed ${doomed.length} previously imported flock(s)`);
      }
    }

    const flockIdOf = new Map<string, string>();

    for (const o of origins) {
      const batch = s(o.batch_number);
      const shed = s(o.shed_id);
      const house = houseOf.get(shed)!;
      const start = day(o.date_in);

      // Later hatches arrive on the daily sheet, in the origin house, while this
      // batch stood there.
      const later = daily
        .filter((r) => s(r.shed_id) === shed && n(r.birds_transferred_in) > 0)
        .filter((r) => day(r.date) >= start && batchOn(shed, day(r.date)) === batch)
        .sort((a, b) => day(a.date).localeCompare(day(b.date)));

      const hatches = [
        { hatchDate: day(o.batch_birth_date) || start, qty: n(o.opening_count) },
        ...later.map((r) => ({ hatchDate: day(r.date), qty: n(r.birds_transferred_in) })),
      ];
      // A batch whose first hatch shares a date with a later one is one hatch.
      const merged = new Map<string, number>();
      for (const h of hatches) merged.set(h.hatchDate, (merged.get(h.hatchDate) ?? 0) + h.qty);
      const hatchLines = [...merged].map(([hatchDate, qty]) => ({ hatchDate, qty }));
      const placed = hatchLines.reduce((sum, h) => sum + h.qty, 0);

      const breedId =
        breedOf.get(s(o.breed_id)) ??
        breedOf.get(s(shedRows.find((x) => s(x.id) === shed)?.breed_id)) ??
        [...breedOf.values()][0];

      // Arrivals elsewhere are this batch being housed.
      const arrivals = stock
        .filter((r) => s(r.batch_number) === batch && r.source_shed_id)
        .sort((a, b) => day(a.date_in).localeCompare(day(b.date_in)));
      const moves = arrivals.map((r) => ({
        eventDate: day(r.date_in),
        fromHouseId: houseOf.get(s(r.source_shed_id))!.id,
        toHouseId: houseOf.get(s(r.shed_id))!.id,
        qty: n(r.opening_count),
      }));

      note(
        `${batch}  ${hatchLines.length} hatch(es) ${num(placed).padStart(9)} into ${house.code}` +
          `  → ${moves.length} move(s) ${num(moves.reduce((s2, m) => s2 + m.qty, 0))}`,
      );

      if (!APPLY) continue;
      if (!breedId) {
        problem(`${batch}: no breed could be resolved`);
        continue;
      }

      const existing = await tx.select().from(flocks).where(eq(flocks.code, batch));
      if (existing.length) {
        note(`   already imported — skipped (use --reset to redo)`);
        flockIdOf.set(batch, existing[0]!.id);
        continue;
      }

      const { flock } = await createFlock(tx, {
        code: batch,
        locationId: house.locationId,
        breedId,
        houseId: house.id,
        hatches: hatchLines,
        note: `Imported from Amino ${exp.exportedAt.slice(0, 10)}`,
        userId,
      });
      flockIdOf.set(batch, flock.id);

      if (moves.length) await setFlockTransfers(tx, flock.id, moves, userId);
    }

    /* ── 5. The daily sheet ─────────────────────────────────────────────── */
    //
    // Resolved by house and date, never by the daily sheet's own batch column.
    // Transfers are NOT replayed here: they were written as movements above, and
    // applying them twice would double every housing.
    step("5. Daily records");
    const placements = APPLY
      ? await tx
          .select({
            id: flockPlacements.id,
            flockId: flockPlacements.flockId,
            houseId: flockPlacements.houseId,
            from: flockPlacements.fromDate,
            to: flockPlacements.toDate,
          })
          .from(flockPlacements)
          .where(inArray(flockPlacements.flockId, [...flockIdOf.values()]))
      : [];

    /**
     * Which placement a shed's day belongs to.
     *
     * A house can hold two flocks at once and regularly does: B240925 still had
     * 7,656 birds in P1 when B160226 was placed there, because the last of a
     * batch trickles out over weeks. Matching on house and date alone picks
     * whichever placement the database happened to return first, which is how
     * a day of B160226's mortality ends up charged to a flock that had already
     * left.
     *
     * So the BATCH is resolved first, from the same shed-and-date timeline the
     * hatches use, and the placement is then that flock's stay in that house.
     */
    const placementOn = (shedId: string, houseId: string, on: string) => {
      const batch = batchOn(shedId, on);
      const flockId = batch ? flockIdOf.get(batch) : undefined;
      if (!flockId) return undefined;
      return placements.find(
        (p) =>
          p.flockId === flockId &&
          p.houseId === houseId &&
          p.from <= on &&
          (!p.to || on <= p.to),
      );
    };

    let written = 0;
    let skipped = 0;
    const refused: string[] = [];
    const sortedDaily = [...daily].sort((a, b) => day(a.date).localeCompare(day(b.date)));

    for (const r of sortedDaily) {
      const house = houseOf.get(s(r.shed_id));
      if (!house) continue;
      const on = day(r.date);
      if (!APPLY) {
        written++;
        continue;
      }
      const placement = placementOn(s(r.shed_id), house.id, on);
      if (!placement) {
        skipped++;
        continue;
      }

      const losses: Array<{ kind: "mortality" | "cull" | "male_removal"; qty: number; causeCode?: string }> = [];
      if (n(r.mortality) > 0) losses.push({ kind: "mortality", qty: n(r.mortality), causeCode: "unknown" });
      if (n(r.birds_culled) > 0) losses.push({ kind: "cull", qty: n(r.birds_culled), causeCode: "cull_weak" });
      if (n(r.male_birds) > 0) losses.push({ kind: "male_removal", qty: n(r.male_birds) });

      try {
        await saveDay(
          tx,
          {
            placementId: placement.id,
            day: on,
            feedConsumedKg: r.feed_intake_kg == null ? null : n(r.feed_intake_kg).toFixed(2),
            feedClosingKg: r.feed_stock_kg == null ? null : n(r.feed_stock_kg).toFixed(2),
            waterUpperKl: r.water_upper_kl == null ? null : n(r.water_upper_kl).toFixed(2),
            waterLowerKl: r.water_lower_kl == null ? null : n(r.water_lower_kl).toFixed(2),
            eggsTotal: n(r.eggs_produced) || null,
            losses,
          },
          userId,
        );
        written++;
      } catch (e) {
        refused.push(`${house.code} ${on}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    note(`${written} written, ${skipped} outside any placement, ${refused.length} refused`);
    if (ambiguous.length) {
      const days = new Set(ambiguous.map((a) => a.split("|")[1]));
      note(
        `${days.size} day(s) where a house held two batches at once — the day went to ` +
          `whichever had more birds, because Amino recorded per shed, not per batch`,
      );
    }
    for (const r of refused.slice(0, 8)) note(`   ! ${r}`);
    if (refused.length > 8) note(`   … and ${refused.length - 8} more`);

    /* ── 5b. When each flock came into lay ──────────────────────────────── */
    //
    // Amino never recorded a lay date; it is simply the first day the batch
    // produced an egg. Without it every row of flock_day reads "rear", the
    // weekly report shows blank egg columns for a year, and eggs per hen housed
    // has no denominator — a flock laying 120,000 a day described as rearing.
    step("5b. First lay");
    if (APPLY) {
      for (const [batch, flockId] of flockIdOf) {
        const [first] = await tx
          .select({ day: flockDay.day })
          .from(flockDay)
          .where(and(eq(flockDay.flockId, flockId), sql`${flockDay.eggs} > 0`))
          .orderBy(flockDay.day)
          .limit(1);
        if (!first) {
          note(`${batch}  still rearing — no eggs recorded`);
          continue;
        }
        await startLay(tx, flockId, first.day);
        note(`${batch}  in lay from ${first.day}`);
      }
    } else {
      note("(runs on --apply)");
    }

    /* ── 6. Weighings ───────────────────────────────────────────────────── */
    step("6. Weighings");
    let weighed = 0;
    for (const w of weights) {
      const house = houseOf.get(s(w.shed_id));
      if (!house) continue;
      if (!APPLY) {
        weighed++;
        continue;
      }
      const placement = placementOn(s(w.shed_id), house.id, day(w.date));
      if (!placement) continue;
      await tx
        .insert(birdWeighings)
        .values({
          placementId: placement.id,
          weekNumber: n(w.week_number),
          weighedOn: day(w.date),
          avgWeightG: d2(w.average_weight),
          eggWeightG: d2(w.egg_weight),
        })
        .onConflictDoUpdate({
          target: [birdWeighings.placementId, birdWeighings.weekNumber],
          set: { weighedOn: day(w.date), avgWeightG: d2(w.average_weight), eggWeightG: d2(w.egg_weight) },
        });
      weighed++;
    }
    note(`${weighed} weighing(s)`);

    /* ── 7. Feed transfers ──────────────────────────────────────────────── */
    //
    // Amino recorded a cost per kg with each. That is the one feed cost, and it
    // is what the owner invoices and the cost per egg are both built from — so it
    // comes across as the transfer's rate rather than being recomputed.
    step("7. Feed sent to the sheds");
    const [mill] = await tx.select().from(locations).limit(1);
    const feedItems = await tx.select().from(items).where(eq(items.category, "poultry_feed"));
    const anyItem = feedItems[0] ?? (await tx.select().from(items).limit(1))[0];
    let sent = 0;
    for (const [i, f] of feed.entries()) {
      const house = houseOf.get(s(f.shed_id));
      if (!house || !anyItem || !mill) continue;
      if (!APPLY) {
        sent++;
        continue;
      }
      const kg = n(f.quantity_kg);
      const rate = n(f.cost_per_kg);
      const byName = feedItems.find(
        (it) => it.name.toUpperCase().includes(s(f.formula_name).toUpperCase()),
      );
      await tx
        .insert(feedTransfers)
        .values({
          number: `AMN-FT-${String(i + 1).padStart(5, "0")}`,
          transferDate: day(f.date),
          itemId: (byName ?? anyItem).id,
          quantityKg: kg.toFixed(3),
          fromLocationId: mill.id,
          toLocationId: house.locationId,
          toHouseId: house.id,
          ratePerKg: rate ? rate.toFixed(6) : null,
          value: rate ? (kg * rate).toFixed(2) : null,
          status: "completed",
          notes: `Amino ${s(f.formula_name)}`,
        })
        .onConflictDoNothing();
      sent++;
    }
    note(`${sent} transfer(s)`);

    /* ── 8. The farm store catalogue ────────────────────────────────────── */
    step("8. Farm store → items");
    const CATEGORY: Record<string, "vaccines" | "medicines" | "feed" | "birds" | "miscellaneous"> = {
      vaccine: "vaccines",
      medicine: "medicines",
      feed: "feed",
      doc: "birds",
      consumable: "miscellaneous",
    };
    let made = 0;
    for (const it of aminoItems) {
      if (!APPLY) {
        made++;
        continue;
      }
      const existing = await tx.select().from(items).where(eq(items.name, s(it.name)));
      if (existing.length) continue;
      await tx.insert(items).values({
        type: "goods",
        name: s(it.name),
        unit: s(it.unit).slice(0, 20) || "pcs",
        category: CATEGORY[s(it.category)] ?? "miscellaneous",
        description: s(it.description) || null,
        // Nothing was ever issued in Amino, so there is no stock history to carry
        // and tracking would start from a balance nobody can vouch for.
        trackInventory: false,
        isActive: it.is_active !== false,
      });
      made++;
    }
    note(`${made} item(s)`);

    /* ── 9. Rebuild the rollup over everything ──────────────────────────── */
    step("9. Rebuilding flock_day");
    if (APPLY) {
      let rows = 0;
      for (const [batch, id] of flockIdOf) {
        const written2 = await refreshFlockDay(tx, id);
        rows += written2;
        note(`${batch}  ${num(written2)} day(s)`);
      }
      note(`${num(rows)} row(s) total`);
    } else {
      note("(runs on --apply)");
    }

    if (!APPLY) {
      // Rolled back rather than simply not written: a dry run must leave
      // nothing behind, and undoing the transaction is the only way to be sure.
      say("\n  dry run — nothing written. Add --apply.\n");
      throw new DryRun();
    }
  });
} catch (e) {
  if (!(e instanceof DryRun)) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
  process.exit(0);
}

say(problems ? `\n  ${problems} problem(s)\n` : "\n  imported\n");
process.exit(problems ? 1 : 0);
