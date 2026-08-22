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
import { houses, iotHistory, iotHouseDay, iotReadings } from "@shared/schema";
import { db } from "../server/db";
import { SINGLE_TAGS, tokenExpiry, type BhTagValue } from "../server/services/iot/bhfarm";
import { saveReadings, writeDay } from "../server/services/iot/store";

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

try {
  await db.transaction(async (tx) => {
    void tx;
    const [house] = await db.select().from(houses).limit(1);
    if (!house) throw new Error("no houses to test against");
    const DEV = "e2e-device";
    const DAY = "2026-05-11";

    // Clean slate for this house and day only.
    await db.delete(iotHouseDay).where(and(eq(iotHouseDay.houseId, house.id), eq(iotHouseDay.day, DAY)));
    await db.delete(iotHistory).where(eq(iotHistory.houseId, house.id));
    await db.delete(iotReadings).where(eq(iotReadings.houseId, house.id));

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

    /* ── History is written once ──────────────────────────────────────────── */
    const first = await saveReadings(house.id, polls.flat());
    const again = await saveReadings(house.id, polls.flat());
    const [count] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(iotHistory)
      .where(eq(iotHistory.houseId, house.id));
    ok("history is stored", first > 0, `${first} row(s)`);
    ok(
      "running the backfill twice adds nothing",
      again === 0 && count!.n === first,
      `${again} added on the second pass, ${count!.n} total`,
    );

    const latest = await db
      .select()
      .from(iotReadings)
      .where(and(eq(iotReadings.houseId, house.id), eq(iotReadings.tagId, `${DEV}.${SINGLE_TAGS.tempC}`)));
    ok(
      "the latest-value table holds the last reading",
      latest[0]?.value === "24",
      `${latest[0]?.value}°C`,
    );

    throw new Rollback();
  });
} catch (e) {
  if (!(e instanceof Rollback)) {
    console.error(e);
    failures++;
  }
}

// The transaction wrapper is for symmetry with the other checks; this one
// touches only its own house's IoT rows, so it tidies up after itself.
const [house] = await db.select().from(houses).limit(1);
if (house) {
  await db.delete(iotHouseDay).where(eq(iotHouseDay.houseId, house.id));
  await db.delete(iotHistory).where(eq(iotHistory.houseId, house.id));
  await db.delete(iotReadings).where(eq(iotReadings.houseId, house.id));
}

console.log(failures ? `\n  ${failures} failed\n` : "\n  all good\n");
process.exit(failures ? 1 : 0);
