/**
 * What the IoT tables cost, and what a year of them will.
 *
 * Kept because the answer changed by a factor of forty once and will change
 * again the next time a tag is added to `SAMPLE_COLUMNS`.
 *
 * Run: npx tsx scripts/_iot-size.ts
 */
import { db } from "../server/db";
import { sql } from "drizzle-orm";

const q = async (s: string) => (await db.execute(sql.raw(s))).rows;

async function main() {
  console.log("\n--- table + index bytes ---");
  console.table(await q(`
    select relname,
           pg_size_pretty(pg_relation_size(c.oid)) heap,
           pg_size_pretty(pg_indexes_size(c.oid)) idx,
           pg_size_pretty(pg_total_relation_size(c.oid)) total
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and relname like 'iot%' and relkind='r'
    order by pg_total_relation_size(c.oid) desc`));

  console.log("--- iot_house_sample shape ---");
  console.table(await q(`
    select count(*)::int rows,
           min(at)::date since, max(at)::date until,
           count(distinct house_id)::int houses,
           round(pg_relation_size('iot_house_sample')::numeric / nullif(count(*),0),1) heap_per_row,
           round(pg_indexes_size('iot_house_sample')::numeric / nullif(count(*),0),1) idx_per_row,
           round(pg_total_relation_size('iot_house_sample')::numeric / nullif(count(*),0),1) bytes_per_row
    from iot_house_sample`));

  console.log("--- rows per day, and what a year of that costs ---");
  console.table(await q(`
    select at::date d, count(*)::int rows,
           pg_size_pretty((count(*) * 365 *
             (pg_total_relation_size('iot_house_sample')::numeric /
              nullif((select count(*) from iot_house_sample),0)))::bigint) as year_at_this_rate
    from iot_house_sample group by 1 order by 1 desc limit 6`));

  console.log("--- how much of a row is actually filled ---");
  console.table(await q(`
    select count(*)::int rows,
           count(temp_c)::int temp, count(co2_ppm)::int co2,
           count(silo_kg)::int silo, count(water_l)::int water,
           count(bird_count)::int birds
    from iot_house_sample`));

  console.log("--- iot_house_day, the tier that is never thinned ---");
  console.table(await q(`select count(*)::int rows, min(day) since, max(day) until,
    pg_size_pretty(pg_total_relation_size('iot_house_day')) size from iot_house_day`));

  console.log("--- whole database ---");
  console.table(await q(`
    select pg_size_pretty(pg_database_size(current_database())) db,
           pg_size_pretty(sum(pg_total_relation_size(c.oid))::bigint) iot,
           round(100.0 * sum(pg_total_relation_size(c.oid)) /
                 pg_database_size(current_database()), 1) iot_pct
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and relname like 'iot%' and relkind='r'`));
  process.exit(0);
}
main();
