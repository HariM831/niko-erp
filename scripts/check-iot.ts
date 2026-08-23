/**
 * The IoT store, exercised inside a rolled-back transaction.
 *
 * No network. Readings are handed in directly, so what is tested is what EGGSY
 * does with them rather than whether bhfarm answered — the vendor's own
 * behaviour is checked by pointing `probe-bhfarm.ts` at it.
 *
 * The thing worth pinning down is the day summary. It has two callers with
 * opposite shapes: a live poll hands over ONE sample, and a backfill hands over
 * a whole day at once. The obvious implementation is right for the first and
 * silently wrong for the second — it reports the day's last reading as its
 * average, which looks entirely plausible on a chart and is wrong every day.
 *
 * Run: npx tsx scripts/check-iot.ts
 */
import { and, eq, sql } from "drizzle-orm";
import {
  houses,
  iotHouseDay,
  iotHouseSample,
  iotReadings,
  locations,
  stockLocations,
} from "@shared/schema";
import { db } from "../server/db";
import { SINGLE_TAGS, tokenExpiry, type BhTagValue } from "../server/services/iot/bhfarm";
import { findSampleGaps, saveReadings, thinSamples, writeDay } from "../server/services/iot/store";

let failures = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!cond) failures++;
};
const near = (a: number | null, b: number, tol = 0.01) => a != null && Math.abs(a - b) <= tol;

class Rollback extends Error {}

/** One poll: the tags a controller reports, at one instant. */
const poll = (device: string, at: string, v: Partial<Record<keyof typeof SINGLE_TAGS, number>> & {
  siloLines?: number[];
  waterTotal?: number;
  feedTotal?: number;
}): BhTagValue[] => {
  const out: BhTagValue[] = [];
  const push = (leaf: string, value: number | null) =>
    out.push({ tagId: `${device}.${leaf}`, value: value == null ? null : String(value), quality: 0, unit: "", recordedAt: at });
  for (const [k, leaf] of Object.entries(SINGLE_TAGS)) {
    const val = v[k as keyof typeof SINGLE_TAGS];
    if (val != null) push(leaf, val);
  }
  for (const [i, kg] of (v.siloLines ?? []).entries()) {
    push(`基础数据.水料量.料塔实时重量${i + 1}`, kg);
  }
  if (v.waterTotal != null) push("基础数据.水料量.今日总用水量", v.waterTotal);
  if (v.feedTotal != null) push("基础数据.水料量.今日总用料量", v.feedTotal);
  return out;
};

/**
 * A shed that exists only for this run.
 *
 * Not one of the farm's own: the store's writes and its retention pass are not
 * transactional, so testing against a real house would apply retention to real
 * readings and then delete the rest on the way out. The house is removed at the
 * end and the IoT rows cascade with it.
 */
async function scratchHouse() {
  const [site] = await db.select().from(locations).limit(1);
  if (!site) throw new Error("no locations to hang a test house on");
  const [stock] = await db
    .insert(stockLocations)
    .values({ locationId: site.id, code: "ZZCHK", name: "check-iot scratch", kind: "house" })
    .returning();
  const [house] = await db
    .insert(houses)
    .values({
      locationId: site.id,
      stockLocationId: stock!.id,
      code: "ZZ-CHECK",
      purpose: "layer",
      isActive: false,
      displayOrder: 9999,
      // Named, because the gap finder only looks at houses with a controller —
      // without this every gap assertion below would pass by examining nothing.
      bhDeviceId: "zz-check-device",
    })
    .returning();
  return { house: house!, stockLocationId: stock!.id };
}

let scratch: { house: typeof houses.$inferSelect; stockLocationId: string } | null = null;

try {
  await db.transaction(async (tx) => {
    void tx;
    scratch = await scratchHouse();
    const house = scratch.house;
    const DEV = "e2e-device";
    const DAY = "2026-05-11";

    console.log(`\n  ${house.code}  ·  ${DAY}\n`);

    /* ── The token ────────────────────────────────────────────────────────── */
    const exp = tokenExpiry();
    ok(
      "the token expiry is readable, or the token is absent",
      exp !== null || !process.env.BH_TOKEN,
      exp ? `expires ${exp.toISOString().slice(0, 10)}` : "BH_TOKEN not set",
    );

    /* ── A day of polls ───────────────────────────────────────────────────── */
    //
    // Four instants. The temperature climbs, so the average is distinguishable
    // from the last reading — which is exactly the bug being guarded against.
    const polls = [
      poll(DEV, `${DAY} 06:00:00`, { tempC: 20, humidityPct: 60, co2Ppm: 900, waterTotal: 400, feedTotal: 300, siloLines: [1000, 1000], birdCount: 9000, birdAgeDays: 100 }),
      poll(DEV, `${DAY} 12:00:00`, { tempC: 26, humidityPct: 55, co2Ppm: 1500, waterTotal: 1200, feedTotal: 800, siloLines: [900, 950], birdCount: 8998 }),
      poll(DEV, `${DAY} 18:00:00`, { tempC: 30, humidityPct: 50, co2Ppm: 2100, waterTotal: 2000, feedTotal: 1400, siloLines: [850, 900], birdCount: 8998 }),
      poll(DEV, `${DAY} 23:00:00`, { tempC: 24, humidityPct: 58, co2Ppm: 1100, waterTotal: 2600, feedTotal: 1850, siloLines: [800, 880], birdCount: 8997 }),
    ];

    // ── Backfill shape: the whole day at once ──
    await writeDay(house.id, DAY, polls);
    const [day] = await db
      .select()
      .from(iotHouseDay)
      .where(and(eq(iotHouseDay.houseId, house.id), eq(iotHouseDay.day, DAY)));

    ok("a day row is written", !!day);
    ok("every instant counts as a sample", day?.samples === 4, `${day?.samples} sample(s)`);
    ok(
      "the average is the mean, NOT the last reading",
      near(Number(day?.tempAvg), 25, 0.01),
      `${day?.tempAvg}°C — last reading was 24, mean is 25`,
    );
    ok("the low is the day's low", near(Number(day?.tempMin), 20), `${day?.tempMin}°C`);
    ok("the high is the day's high", near(Number(day?.tempMax), 30), `${day?.tempMax}°C`);
    ok("CO2 peak is kept", near(Number(day?.co2Max), 2100), `${day?.co2Max} ppm`);
    ok(
      "the water total is the controller's own, not a sum of polls",
      near(Number(day?.waterL), 2600),
      `${day?.waterL} L — the sum of the four readings would be 6,200`,
    );
    ok("the feed total likewise", near(Number(day?.feedKg), 1850), `${day?.feedKg} kg`);
    ok(
      "the silo is the sum of its lines",
      near(Number(day?.siloKg), 1680),
      `${day?.siloKg} kg = 800 + 880`,
    );
    ok("the bird count is the latest", day?.birdCount === 8997, `${day?.birdCount}`);
    ok(
      "the age carries even though only the first poll reported it",
      day?.birdAgeDays === 100,
      `${day?.birdAgeDays} days`,
    );

    /* ── A live poll must not clobber the backfilled day ──────────────────── */
    await writeDay(house.id, DAY, [poll(DEV, `${DAY} 23:30:00`, { tempC: 24, waterTotal: 2700 })]);
    const [after] = await db
      .select()
      .from(iotHouseDay)
      .where(and(eq(iotHouseDay.houseId, house.id), eq(iotHouseDay.day, DAY)));
    ok(
      "a one-sample poll does not overwrite a fuller day",
      after?.samples === 4 && near(Number(after?.tempAvg), 25, 0.01),
      `${after?.samples} samples, avg ${after?.tempAvg}`,
    );
    ok(
      "but the running total still moves forward",
      near(Number(after?.waterL), 2700),
      `${after?.waterL} L`,
    );

    /* ── The frozen July tags must not be preferred ───────────────────────── */
    //
    // The pre-rename name still answers with the value it held on 2026-07-16.
    // Reading it would put 17,078 kg in a silo holding 10,788.
    const frozen: BhTagValue[] = [
      { tagId: `${DEV}.基础数据.水料量.料塔实时重量`, value: "17078", quality: 0, unit: "kg", recordedAt: `${DAY} 12:00:00` },
      { tagId: `${DEV}.基础数据.水料量.料塔实时重量1`, value: "5000", quality: 0, unit: "kg", recordedAt: `${DAY} 12:00:00` },
      { tagId: `${DEV}.基础数据.水料量.料塔实时重量2`, value: "5788", quality: 0, unit: "kg", recordedAt: `${DAY} 12:00:00` },
    ];
    const FROZEN_DAY = "2026-05-12";
    await writeDay(house.id, FROZEN_DAY, [frozen]);
    const [fz] = await db
      .select()
      .from(iotHouseDay)
      .where(and(eq(iotHouseDay.houseId, house.id), eq(iotHouseDay.day, FROZEN_DAY)));
    ok(
      "the silo reads the numbered lines, never the frozen name",
      near(Number(fz?.siloKg), 10788),
      `${fz?.siloKg} kg — the stale tag says 17,078`,
    );

    /* ── One wide row per instant, merged rather than replaced ────────────── */
    //
    // The storage optimisation: 27 charted tags are 27 COLUMNS of one row, not
    // 27 rows. What has to hold is that a second pass carrying fewer tags fills
    // gaps instead of blanking what the first pass knew.
    {
      await db.delete(iotHouseSample).where(eq(iotHouseSample.houseId, house.id));

      const first = await saveReadings(house.id, polls.flat());
      const [afterFirst] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(iotHouseSample)
        .where(eq(iotHouseSample.houseId, house.id));
      ok("four instants become four rows, not four hundred", afterFirst!.n === 4, `${afterFirst!.n} row(s) from ${polls.flat().length} readings`);
      ok("the write reports what it wrote", first === 4, `${first}`);

      await saveReadings(house.id, polls.flat());
      const [afterSecond] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(iotHouseSample)
        .where(eq(iotHouseSample.houseId, house.id));
      ok("running the backfill twice adds nothing", afterSecond!.n === 4, `${afterSecond!.n} row(s)`);

      // A later, thinner pass at an instant already recorded.
      await saveReadings(house.id, [
        { tagId: `${DEV}.${SINGLE_TAGS.co2Ppm}`, value: "1234", quality: 0, unit: "ppm", recordedAt: `${DAY} 06:00:00` },
      ]);
      const [merged] = await db
        .select()
        .from(iotHouseSample)
        .where(and(eq(iotHouseSample.houseId, house.id), sql`${iotHouseSample.at} = ${`${DAY} 06:00:00`}::timestamptz`));
      ok("a later partial pass updates the column it carries", merged?.co2Ppm === 1234, `CO2 ${merged?.co2Ppm}`);
      ok(
        "and does NOT blank the columns it is silent about",
        merged?.tempC === 20 && merged?.humidityPct === 60,
        `temp ${merged?.tempC}, humidity ${merged?.humidityPct} — both still from the first pass`,
      );
      ok("the aggregate columns carry too", merged?.waterL === 400, `${merged?.waterL} L`);
      ok("as do the per-line ones", merged?.siloKg1 === 1000 && merged?.siloKg2 === 1000, `${merged?.siloKg1} + ${merged?.siloKg2}`);
    }

    /* ── Detail thins with age; the day summary never does ────────────────── */
    //
    // Five-minute resolution for the week you are chasing a fault, a quarter of
    // an hour for the next two months, an hour for the rest of the year, and
    // nothing beyond it. What must NOT thin is `iot_house_day` — six rows a day
    // is the price of being able to answer for any day the farm has ever run.
    {
      await db.delete(iotHouseSample).where(eq(iotHouseSample.houseId, house.id));

      /** Three hours of five-minute samples, `daysAgo` old. */
      const spread = async (daysAgo: number) => {
        const base = Date.now() - daysAgo * 86_400_000;
        for (let i = 0; i < 36; i++) {
          const at = new Date(base + i * 300_000).toISOString();
          await saveReadings(house.id, [
            { tagId: `${DEV}.${SINGLE_TAGS.tempC}`, value: String(20 + i / 10), quality: 0, unit: "°C", recordedAt: at },
          ]);
        }
      };
      await spread(2); //  inside the fine window
      await spread(30); // the quarter-hour tier
      await spread(90); // the hourly tier

      const OLD = "2024-01-15";
      await saveReadings(house.id, [
        { tagId: `${DEV}.${SINGLE_TAGS.tempC}`, value: "19", quality: 0, unit: "°C", recordedAt: `${OLD} 09:00:00` },
      ]);
      await writeDay(house.id, OLD, [
        [{ tagId: `${DEV}.${SINGLE_TAGS.tempC}`, value: "19", quality: 0, unit: "°C", recordedAt: `${OLD} 09:00:00` }],
      ]);

      // Scoped to the scratch house: retention on the real farm is the
      // scheduler's business, not a check's.
      const thin = await thinSamples(365, { onlyHouseId: house.id });
      ok("samples past the retention window are dropped", thin.deleted >= 1, `${thin.deleted} dropped`);
      ok("aged samples are thinned", thin.thinned > 0, `${thin.thinned} thinned`);

      const kept = async (daysAgo: number) => {
        const from = new Date(Date.now() - daysAgo * 86_400_000 - 60_000).toISOString();
        const to = new Date(Date.now() - daysAgo * 86_400_000 + 4 * 3_600_000).toISOString();
        const [r] = await db
          .select({ n: sql<number>`count(*)::int` })
          .from(iotHouseSample)
          .where(
            and(
              eq(iotHouseSample.houseId, house.id),
              sql`${iotHouseSample.at} >= ${from}::timestamptz`,
              sql`${iotHouseSample.at} < ${to}::timestamptz`,
            ),
          );
        return r!.n;
      };

      ok("this week keeps every poll", (await kept(2)) === 36, `${await kept(2)} of 36`);
      // Three hours bucketed by a quarter of an hour is twelve buckets, by an
      // hour is three — give or take one, since the run does not start on a
      // bucket boundary.
      const mid = await kept(30);
      ok("last month keeps one per quarter-hour", mid >= 12 && mid <= 13, `${mid} of 36`);
      const old = await kept(90);
      ok("last quarter keeps one per hour", old >= 3 && old <= 4, `${old} of 36`);

      const [nothingLeft] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(iotHouseSample)
        .where(and(eq(iotHouseSample.houseId, house.id), sql`${iotHouseSample.at} < '2025-01-01'`));
      ok("no samples older than the window remain", nothingLeft!.n === 0);

      const [oldDay] = await db
        .select()
        .from(iotHouseDay)
        .where(and(eq(iotHouseDay.houseId, house.id), eq(iotHouseDay.day, OLD)));
      ok(
        "the day summary from before the window SURVIVES",
        !!oldDay && Number(oldDay.tempAvg) === 19,
        oldDay ? `${OLD} still answers: ${oldDay.tempAvg}°C` : "GONE — the archive tier was deleted",
      );

      /* ── Thinned history must not read as missing history ───────────────── */
      //
      // The trap this guards: the gap finder looks for stretches worth asking
      // the vendor about, and the thinning above deliberately spaces old
      // readings out. A finder that did not know the ladder would call every
      // thinned day a gap, refetch it at five minutes, and watch the next
      // thinning delete it again — for ever, every six hours, until the token
      // died. So a 15-minute stretch at 30 days old is CORRECT, not a hole.
      /**
       * Gaps strictly inside one stretch of readings.
       *
       * The three test islands sit weeks apart, and the empty weeks between
       * them are real gaps that the finder is right to report. What is under
       * test is what it says INSIDE a stretch that has readings, so the edges
       * are excluded rather than the assertion being loosened.
       */
      const inside = async (daysAgo: number) => {
        const lo = Date.now() - daysAgo * 86_400_000;
        const hi = lo + 36 * 300_000;
        return (await findSampleGaps(120)).filter(
          (g) => g.houseId === house.id && g.from.getTime() >= lo && g.to.getTime() <= hi,
        );
      };

      const thinned = await inside(30);
      ok(
        "thinned stretches are not mistaken for gaps",
        thinned.length === 0,
        thinned.length
          ? thinned.map((g) => `${g.minutes} min`).join(", ")
          : "a quarter-hour spacing at 30 days reads as intended, not as missing",
      );

      // A real hole, though, has to be found. Two hours removed from the middle
      // of the freshest stretch, which is still at five-minute spacing.
      const cutFrom = new Date(Date.now() - 2 * 86_400_000 + 3 * 300_000);
      const cutTo = new Date(cutFrom.getTime() + 2 * 3_600_000);
      await db
        .delete(iotHouseSample)
        .where(
          and(
            eq(iotHouseSample.houseId, house.id),
            sql`${iotHouseSample.at} >= ${cutFrom.toISOString()}::timestamptz`,
            sql`${iotHouseSample.at} < ${cutTo.toISOString()}::timestamptz`,
          ),
        );
      const hole = await inside(2);
      ok(
        "a real hole IS found",
        hole.length === 1 && hole[0]!.minutes >= 100,
        hole.length ? `${hole[0]!.minutes} min` : "not found — an outage would go unrepaired",
      );

      // The dial on the wall is the newest reading, whatever the thinning did
      // to the history behind it — the two tiers answer different questions.
      const latest = await db
        .select()
        .from(iotReadings)
        .where(and(eq(iotReadings.houseId, house.id), eq(iotReadings.tagId, `${DEV}.${SINGLE_TAGS.tempC}`)));
      ok(
        "the latest-value table still holds the newest reading",
        near(Number(latest[0]?.value), 23.5),
        `${latest[0]?.value}°C`,
      );
    }

    throw new Rollback();
  });
} catch (e) {
  if (!(e instanceof Rollback)) {
    console.error(e);
    failures++;
  }
}

// The transaction wrapper is for symmetry with the other checks; the store's
// writes do not join it, so the scratch house is what actually gets cleaned up.
// Its readings, samples and day rows go with it on the cascade.
if (scratch) {
  const { house, stockLocationId } = scratch as { house: { id: string }; stockLocationId: string };
  await db.delete(houses).where(eq(houses.id, house.id));
  await db.delete(stockLocations).where(eq(stockLocations.id, stockLocationId));
}

console.log(failures ? `\n  ${failures} failed\n` : "\n  all good\n");
process.exit(failures ? 1 : 0);
