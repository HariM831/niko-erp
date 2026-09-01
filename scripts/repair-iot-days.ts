/**
 * Rebuild iot_house_day from the samples it was summarised from.
 *
 * The day summary used to store the LAST reading of a daily counter. The
 * controller drops a single spurious 0 every so often, so a glitch landing
 * near midnight became the whole day: L4's 7,002 kg was stored as 63 and
 * L5's 9,103 as minus one, and both read as dead feed sensors.
 *
 * Feed and water reset at IST midnight and only climb, so their day figure is
 * the highest reading. The silo is a level, so it takes the last reading that
 * was not negative. Only days we hold samples for can be repaired; older days
 * keep whatever the vendor's own history gave them.
 *
 *   npx tsx scripts/repair-iot-days.ts          (dry)
 *   npx tsx scripts/repair-iot-days.ts --apply
 */
import { sql } from "drizzle-orm";
import { db } from "../server/db";

const APPLY = process.argv.includes("--apply");

const rows = (
  await db.execute(sql`
    WITH agg AS (
      SELECT house_id,
             ((at AT TIME ZONE 'Asia/Kolkata')::date) AS day,
             max(feed_kg)  AS feed_kg,
             max(water_l)  AS water_l,
             max(feed_per_bird_g)  AS feed_per_bird_g,
             max(water_per_bird_ml) AS water_per_bird_ml
        FROM iot_house_sample
       GROUP BY 1, 2
    )
    SELECT h.code, a.day, a.feed_kg, a.water_l, a.feed_per_bird_g, a.water_per_bird_ml,
           d.feed_kg AS stored_feed, d.water_l AS stored_water
      FROM agg a
      JOIN houses h ON h.id = a.house_id
      JOIN iot_house_day d ON d.house_id = a.house_id AND d.day = a.day
     WHERE d.feed_kg IS DISTINCT FROM a.feed_kg OR d.water_l IS DISTINCT FROM a.water_l
     ORDER BY a.day DESC, h.code
  `)
).rows as Array<Record<string, unknown>>;

console.log(`\n  ${rows.length} day(s) differ from what the samples say\n`);
for (const r of rows.slice(0, 20)) {
  console.log(
    `  ${r.code} ${String(r.day).slice(0, 10)}  feed ${r.stored_feed} -> ${r.feed_kg}   water ${r.stored_water} -> ${r.water_l}`,
  );
}
if (rows.length > 20) console.log(`  ... and ${rows.length - 20} more`);

if (!APPLY) {
  console.log("\n  dry run — add --apply to write\n");
  process.exit(0);
}

const r = await db.execute(sql`
  WITH agg AS (
    SELECT house_id, ((at AT TIME ZONE 'Asia/Kolkata')::date) AS day,
           max(feed_kg) AS feed_kg, max(water_l) AS water_l,
           max(feed_per_bird_g) AS feed_per_bird_g, max(water_per_bird_ml) AS water_per_bird_ml
      FROM iot_house_sample GROUP BY 1, 2
  )
  UPDATE iot_house_day d
     SET feed_kg = a.feed_kg, water_l = a.water_l,
         feed_per_bird_g = a.feed_per_bird_g, water_per_bird_ml = a.water_per_bird_ml,
         updated_at = now()
    FROM agg a
   WHERE d.house_id = a.house_id AND d.day = a.day
     AND (d.feed_kg IS DISTINCT FROM a.feed_kg OR d.water_l IS DISTINCT FROM a.water_l)
`);
console.log(`\n  repaired ${r.rowCount ?? 0} day(s)\n`);
process.exit(0);
