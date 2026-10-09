/**
 * Put each house-day's water on the controller's whole day.
 *
 * The farm's register reads water off the controller at about 5pm, so most of
 * the days entered by hand hold midnight-to-5pm — 15–30% short, more in L4 and
 * L5, which drink late (found 9 Oct 2026: L5's register said 20.62 kL on 8 Oct,
 * the controller 20.70 at 5pm and 29.40 by midnight). Days entered from the
 * form's pre-fill hold whatever the controller had reached at entry, usually
 * about 7pm. Neither is a day.
 *
 * Decided with the farm: every day since 1 Sep 2026 that the controller
 * covered whole takes its midnight-to-midnight climb. Days it did not cover —
 * offline, or repeating one frozen reading — keep what is there and are
 * reported. The old figure is kept in the day's sources as `was`.
 *
 *   npx tsx scripts/rewrite-water-from-controller.ts           # report only
 *   npx tsx scripts/rewrite-water-from-controller.ts --apply   # and rewrite
 *   … --from 2026-09-01 --to 2026-10-08                        # the default range ends yesterday
 */
import { and, asc, eq, gte, lt, lte } from "drizzle-orm";
import { flockPlacements, houses, iotHouseSample, placementDays } from "@shared/schema";
import type { DaySources } from "@shared/schema";
import { db } from "../server/db";
import { addDays, istDate } from "../server/services/day-resolution";
import { countersOf } from "../server/services/iot/store";
import { dayCoverage } from "../server/services/iot/silo-events";
import { refreshFromPlacement } from "../server/services/rollup";

const APPLY = process.argv.includes("--apply");
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const FROM = arg("--from") ?? "2026-09-01";
const TO = arg("--to") ?? addDays(istDate(), -1);

const startOf = (day: string) => new Date(`${day}T00:00:00+05:30`);

async function main() {
  const rows = await db
    .select({
      placementId: placementDays.placementId,
      day: placementDays.day,
      waterKl: placementDays.waterKl,
      sources: placementDays.sources,
      houseId: houses.id,
      code: houses.code,
    })
    .from(placementDays)
    .innerJoin(flockPlacements, eq(flockPlacements.id, placementDays.placementId))
    .innerJoin(houses, eq(houses.id, flockPlacements.houseId))
    .where(and(gte(placementDays.day, FROM), lte(placementDays.day, TO)))
    .orderBy(asc(houses.code), asc(placementDays.day));

  const touched = new Set<string>();
  let changed = 0;
  let same = 0;
  const skipped: string[] = [];
  for (const r of rows) {
    const a = startOf(r.day);
    const b = startOf(addDays(r.day, 1));
    const samples = await db
      .select({ at: iotHouseSample.at, waterL: iotHouseSample.waterL })
      .from(iotHouseSample)
      .where(and(eq(iotHouseSample.houseId, r.houseId), gte(iotHouseSample.at, a), lt(iotHouseSample.at, b)))
      .orderBy(asc(iotHouseSample.at));
    if (!samples.length) continue; // a house with no controller
    const cov = dayCoverage(samples, a, b);
    if (!cov.complete) {
      skipped.push(`${r.code} ${r.day}: ${cov.reason}`);
      continue;
    }
    const c = await countersOf(r.houseId, r.day);
    if (c.waterL == null || c.waterL <= 0) {
      skipped.push(`${r.code} ${r.day}: the meter recorded nothing`);
      continue;
    }
    const kl = Math.round(c.waterL / 10) / 100;
    const old = r.waterKl == null ? null : Number(r.waterKl);
    if (old != null && Math.abs(old - kl) < 0.005) {
      same++;
      continue;
    }
    changed++;
    console.log(`${r.code} ${r.day}  ${old ?? "—"} → ${kl.toFixed(2)} kL`);
    if (APPLY) {
      const sources: DaySources = { ...(r.sources ?? {}), waterKl: { from: "controller", offered: kl, was: old } };
      await db
        .update(placementDays)
        .set({ waterKl: kl.toFixed(2), sources, updatedAt: new Date() })
        .where(and(eq(placementDays.placementId, r.placementId), eq(placementDays.day, r.day)));
      touched.add(r.placementId);
    }
  }
  // The flock's daily rollup carries water per bird; restate it.
  for (const id of touched) await db.transaction((tx) => refreshFromPlacement(tx, id));
  console.log(`\n${changed} day(s) ${APPLY ? "rewritten" : "to rewrite"}, ${same} already right, ${skipped.length} left as they were:`);
  for (const s of skipped) console.log(`  ${s}`);
  if (!APPLY && changed) console.log("\nReport only — run with --apply to rewrite.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
