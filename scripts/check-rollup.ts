/**
 * `flock_day`, exercised inside a rolled-back transaction.
 *
 * The thing worth testing is the one the old model got wrong: a batch reared in
 * P1 and then SPLIT across two layer houses. Lifetime mortality, cumulative
 * feed per bird and cumulative cost per egg have to run straight through the
 * move, because they belong to the birds and not to the shed. In the old app
 * every one of them restarted at zero on housing day — at exactly the moment
 * the figures start to matter.
 *
 * Run: npx tsx scripts/check-rollup.ts
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  breeds,
  feedTransfers,
  flockDay,
  flockPlacements,
  houses,
  items,
  locations,
  standardPoints,
  standardSets,
} from "@shared/schema";
import { db } from "../server/db";
import { createFlock, setFlockTransfers, startLay } from "../server/services/flocks";
import { saveDay } from "../server/services/daily";
import { refreshFlockDay, weeklySummary } from "../server/services/rollup";

let failures = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!cond) failures++;
};
const near = (a: number | null, b: number, tol = 0.005) =>
  a != null && Math.abs(a - b) <= tol;

const addDay = (iso: string, k: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + k * 86_400_000).toISOString().slice(0, 10);

class Rollback extends Error {}

try {
  await db.transaction(async (tx) => {
    const userId = ((await tx.execute(`SELECT id FROM users LIMIT 1`)).rows[0] as { id: string }).id;
    const [breed] = await tx.insert(breeds).values({ code: "ZZROL", name: "Rollup Check" }).returning();
    const [set] = await tx
      .insert(standardSets)
      .values({ breedId: breed!.id, name: "guide", isDefault: true })
      .returning();
    // A curve, so the pinned std_* columns have something to carry.
    await tx.insert(standardPoints).values(
      Array.from({ length: 60 }, (_, i) => ({
        setId: set!.id,
        ageWeek: i + 1,
        bodyWeightG: String(80 + i * 25),
        feedGPerBirdDay: String(Math.min(115, 12 + i * 2)),
        layPct: i + 1 < 19 ? null : String(Math.min(95, (i + 1 - 18) * 12)),
        cumMortalityPct: String((i + 1) * 0.05),
      })),
    );

    const pullet = (await tx.select().from(houses).where(eq(houses.purpose, "pullet")))[0]!;
    const layers = (await tx.select().from(houses).where(eq(houses.purpose, "layer"))).slice(0, 2);
    if (layers.length < 2) throw new Error("Need two layer houses to test the split");
    const [feedItem] = await tx.select().from(items).limit(1);

    const HATCH = "2026-01-05";
    const { flock, placement } = await createFlock(tx, {
      locationId: pullet.locationId,
      breedId: breed!.id,
      houseId: pullet.id,
      hatches: [{ hatchDate: HATCH, qty: 10_000 }],
      userId,
    });
    console.log(`\n  ${flock.code} — 10,000 into ${pullet.code}, split to ${layers[0]!.code} / ${layers[1]!.code}\n`);

    // ── Feed deliveries, one per house, at a known rate ──
    const deliver = async (houseId: string, day: string, kg: number, rate: number, n: string) => {
      const house = [pullet, ...layers].find((h) => h.id === houseId)!;
      await tx.insert(feedTransfers).values({
        number: n,
        transferDate: day,
        itemId: feedItem!.id,
        quantityKg: String(kg),
        fromLocationId: house.locationId,
        toLocationId: house.locationId,
        toHouseId: houseId,
        ratePerKg: rate.toFixed(6),
        value: (kg * rate).toFixed(2),
        status: "completed",
      });
    };
    // Generous enough that FIFO never runs dry — a dry pool is its own test below.
    await deliver(pullet.id, HATCH, 60_000, 30, "ZZ-T1");
    await deliver(layers[0]!.id, "2026-04-01", 400_000, 32, "ZZ-T2");
    await deliver(layers[1]!.id, "2026-04-01", 200_000, 32, "ZZ-T3");

    /* ── 120 days rearing ──────────────────────────────────────────────────── */
    let rearFeed = 0;
    let rearMort = 0;
    for (let i = 0; i < 120; i++) {
      const day = addDay(HATCH, i);
      const kg = 10 + i * 0.4; // grows with the birds
      rearFeed += kg;
      const dead = i % 10 === 0 ? 2 : 1;
      rearMort += dead;
      await saveDay(
        tx,
        {
          placementId: placement.id,
          day,
          feedConsumedKg: kg.toFixed(2),
          waterUpperKl: "1.5",
          waterLowerKl: "1.0",
          losses: [{ kind: "mortality", qty: dead, causeCode: "respiratory" }],
        },
        userId,
      );
    }

    const lastRear = addDay(HATCH, 119);
    const [rearRow] = await tx
      .select()
      .from(flockDay)
      .where(and(eq(flockDay.flockId, flock.id), eq(flockDay.day, lastRear)));
    ok("rearing rows exist", !!rearRow);
    ok(
      "closing birds match the ledger",
      rearRow!.closingBirds === 10_000 - rearMort,
      `${rearRow!.closingBirds}`,
    );
    ok("phase is rear", rearRow!.phase === "rear");
    ok("egg columns blank in rearing", rearRow!.eggs === null && rearRow!.hdPct === null);
    ok("cumulative feed carried", near(Number(rearRow!.cumFeedKg), rearFeed, 0.5), `${rearRow!.cumFeedKg} kg`);
    ok(
      "feed cost is the delivered rate",
      near(Number(rearRow!.feedCostPerKg), 30, 0.001),
      `₹${rearRow!.feedCostPerKg}/kg`,
    );
    ok("cost is complete", rearRow!.feedCostIncomplete === false);
    ok("standard pinned onto the day", rearRow!.stdBodyWeightG != null);

    const cumMortAtMove = rearRow!.cumMortality;
    const cumFeedAtMove = Number(rearRow!.cumFeedKg);
    const cumCostAtMove = Number(rearRow!.cumFeedCost);

    /* ── The split: 8,000 to L-a and the rest to L-b, over three days ──────── */
    const moveDay = addDay(HATCH, 120);
    const alive = 10_000 - rearMort;
    await setFlockTransfers(
      tx,
      flock.id,
      [
        { eventDate: moveDay, fromHouseId: pullet.id, toHouseId: layers[0]!.id, qty: 4_000 },
        { eventDate: addDay(moveDay, 1), fromHouseId: pullet.id, toHouseId: layers[0]!.id, qty: 4_000 },
        { eventDate: addDay(moveDay, 2), fromHouseId: pullet.id, toHouseId: layers[1]!.id, qty: alive - 8_000 },
      ],
      userId,
    );
    await startLay(tx, flock.id, addDay(HATCH, 126));

    const places = await tx
      .select()
      .from(flockPlacements)
      .where(eq(flockPlacements.flockId, flock.id))
      .orderBy(asc(flockPlacements.fromDate));
    ok("three placements after the split", places.length === 3, `${places.length}`);
    const pa = places.find((p) => p.houseId === layers[0]!.id)!;
    const pb = places.find((p) => p.houseId === layers[1]!.id)!;

    /* ── 200 days in lay, in both houses ───────────────────────────────────── */
    let layFeed = 0;
    let layMort = 0;
    let eggs = 0;
    // Birds alive in each house, walked down as they die — a fixed egg count
    // against a shrinking flock would drift the hen-day percentage upwards and
    // the test would be measuring its own arithmetic rather than the rollup's.
    const living = new Map([
      [pa.id, 8_000],
      [pb.id, alive - 8_000],
    ]);
    for (let i = 0; i < 200; i++) {
      const day = addDay(moveDay, 3 + i);
      for (const p of [pa, pb]) {
        const share = living.get(p.id)!;
        const kg = (share * 0.115).toFixed(2);
        layFeed += Number(kg);
        // 90% of the average of opening and closing, which is what hen-day is.
        const laid = i < 6 ? 0 : Math.round((share - 0.5) * 0.9);
        eggs += laid;
        layMort += 1;
        living.set(p.id, share - 1);
        await saveDay(
          tx,
          {
            placementId: p.id,
            day,
            feedConsumedKg: kg,
            waterUpperKl: "8",
            waterLowerKl: "6",
            eggsTotal: laid,
            losses: [{ kind: "mortality", qty: 1, causeCode: "respiratory" }],
          },
          userId,
        );
      }
    }

    const lastDay = addDay(moveDay, 202);
    const endRows = await tx
      .select()
      .from(flockDay)
      .where(and(eq(flockDay.flockId, flock.id), eq(flockDay.day, lastDay)));
    ok("both layer houses have the last day", endRows.length === 2, `${endRows.length}`);
    ok("phase flipped to lay", endRows.every((r) => r.phase === "lay"));

    /* ── The point of the whole exercise: continuity across the split ─────── */
    const maxCum = Math.max(...endRows.map((r) => r.cumMortality));
    ok(
      "cumulative mortality runs through the move",
      maxCum === rearMort + layMort,
      `${maxCum} = ${rearMort} rearing + ${layMort} laying`,
    );
    ok(
      "cumulative mortality did NOT restart at housing",
      maxCum > cumMortAtMove,
      `${cumMortAtMove} → ${maxCum}`,
    );
    const maxFeed = Math.max(...endRows.map((r) => Number(r.cumFeedKg)));
    ok(
      "cumulative feed runs through the move",
      near(maxFeed, cumFeedAtMove + layFeed, 1),
      `${maxFeed.toFixed(0)} kg`,
    );
    const maxCost = Math.max(...endRows.map((r) => Number(r.cumFeedCost)));
    ok(
      "cumulative feed cost includes the rearing feed",
      maxCost > cumCostAtMove && near(maxCost, cumCostAtMove + layFeed * 32, 200),
      `₹${maxCost.toFixed(0)}`,
    );
    const cumCfpe = Math.max(...endRows.map((r) => Number(r.cumCfpe)));
    ok(
      "cost per egg carries the pullet feed",
      near(cumCfpe, maxCost / eggs, 0.05),
      `₹${cumCfpe.toFixed(3)}/egg`,
    );
    ok(
      "cost per egg is above lay-only cost — rearing feed is in it",
      cumCfpe > (layFeed * 32) / eggs,
    );

    /* ── Recompute is idempotent ──────────────────────────────────────────── */
    const before = (
      await tx.execute(sql`SELECT count(*) c, sum(cum_feed_cost) s FROM flock_day WHERE flock_id = ${flock.id}`)
    ).rows[0] as { c: string; s: string };
    await refreshFlockDay(tx, flock.id);
    const after = (
      await tx.execute(sql`SELECT count(*) c, sum(cum_feed_cost) s FROM flock_day WHERE flock_id = ${flock.id}`)
    ).rows[0] as { c: string; s: string };
    ok("refresh is idempotent", before.c === after.c && before.s === after.s, `${after.c} rows`);

    /* ── Weekly summary ───────────────────────────────────────────────────── */
    const weeks = (await weeklySummary(tx, flock.id)) as Array<Record<string, unknown>>;
    ok("weeks start at 1", Number(weeks[0]!.week) === 1);
    ok("weeks are contiguous", weeks.every((w, i) => Number(w.week) === i + 1));
    const rearWeeks = weeks.filter((w) => w.phase === "rear");
    ok("rearing weeks are present", rearWeeks.length >= 17, `${rearWeeks.length}`);
    ok(
      "rearing weeks have blank egg columns",
      rearWeeks.every((w) => w.henDayPct == null || Number(w.henDayPct) === 0),
    );
    const layWeeks = weeks.filter((w) => w.phase === "lay" && Number(w.henDayPct) > 0);
    ok("laying weeks show hen-day", layWeeks.length > 20, `${layWeeks.length}`);
    ok(
      "hen-day is around 90%",
      near(Number(layWeeks[layWeeks.length - 1]!.henDayPct), 90, 2),
      `${layWeeks[layWeeks.length - 1]!.henDayPct}%`,
    );
    ok(
      "cumulative feed per bird only grows",
      weeks
        .filter((w) => w.cumFeedKgPerBird != null)
        .every((w, i, a) => i === 0 || Number(w.cumFeedKgPerBird) >= Number(a[i - 1]!.cumFeedKgPerBird) - 0.001),
    );
    ok("weekly cost per egg is reported", layWeeks.some((w) => w.cumCostPerEgg != null));

    /* ── A shed fed more than it was ever sent says so ─────────────────────── */
    const [dry] = await tx
      .insert(feedTransfers)
      .values({
        number: "ZZ-T4",
        transferDate: "2026-04-01",
        itemId: feedItem!.id,
        quantityKg: "10",
        fromLocationId: layers[1]!.locationId,
        toLocationId: layers[1]!.locationId,
        toHouseId: layers[1]!.id,
        ratePerKg: "31.000000",
        value: "310.00",
        status: "void",
      })
      .returning();
    await refreshFlockDay(tx, flock.id);
    const [voided] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(flockDay)
      .where(and(eq(flockDay.flockId, flock.id), eq(flockDay.feedCostIncomplete, true)));
    ok("a voided delivery never enters the pool", voided!.n === 0, `${voided!.n} incomplete days`);
    void dry;

    // Drain the layer pool and check the flag rather than a silent free lunch.
    await tx
      .update(feedTransfers)
      .set({ quantityKg: "100" })
      .where(inArray(feedTransfers.number, ["ZZ-T2"]));
    await refreshFlockDay(tx, flock.id);
    const [short] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(flockDay)
      .where(and(eq(flockDay.flockId, flock.id), eq(flockDay.feedCostIncomplete, true)));
    ok("eating more than was delivered is flagged", short!.n > 0, `${short!.n} days flagged`);

    throw new Rollback();
  });
} catch (e) {
  if (!(e instanceof Rollback)) {
    console.error(e);
    failures++;
  }
}

console.log(failures ? `\n  ${failures} failed\n` : "\n  all good\n");
process.exit(failures ? 1 : 0);
