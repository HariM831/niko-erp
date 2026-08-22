import { db } from "../server/db";
import { sql } from "drizzle-orm";

const q = async (s: string) => (await db.execute(sql.raw(s))).rows;

async function main() {
  console.log("--- table + index bytes ---");
  console.table(await q(`
    select relname,
           pg_size_pretty(pg_relation_size(c.oid)) heap,
           pg_size_pretty(pg_indexes_size(c.oid)) idx,
           pg_size_pretty(pg_total_relation_size(c.oid)) total
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and relname like 'iot%' and relkind='r'
    order by pg_total_relation_size(c.oid) desc`));

  console.log("--- iot_history shape ---");
  console.table(await q(`
    select count(*)::int rows,
           min(recorded_at)::date since, max(recorded_at)::date until,
           count(distinct tag_id)::int tags,
           count(distinct house_id)::int houses,
           round(avg(length(tag_id)),1) avg_tag_len,
           round(avg(length(value)),1) avg_val_len,
           round(pg_relation_size('iot_history')::numeric / nullif(count(*),0),1) heap_per_row,
           round(pg_indexes_size('iot_history')::numeric / nullif(count(*),0),1) idx_per_row
    from iot_history`));

  console.log("--- index detail ---");
  console.table(await q(`
    select indexrelname, idx_scan, pg_size_pretty(pg_relation_size(indexrelid)) size
    from pg_stat_user_indexes where relname='iot_history' order by pg_relation_size(indexrelid) desc`));

  console.log("--- rows / distinct instants per day ---");
  console.table(await q(`
    select recorded_at::date d, count(distinct recorded_at)::int instants, count(*)::int rows
    from iot_history group by 1 order by 1 desc limit 6`));

  console.log("--- do values actually move? (last full day) ---");
  console.table(await q(`
    select tag_id, count(*)::int samples, count(distinct value)::int distinct_vals
    from iot_history
    where recorded_at::date = (select max(recorded_at)::date - 1 from iot_history)
    group by 1 order by 2 desc limit 10`));

  console.log("--- iot_house_day ---");
  console.table(await q(`select count(*)::int rows, min(day) since, max(day) until,
    pg_size_pretty(pg_total_relation_size('iot_house_day')) size from iot_house_day`));
  process.exit(0);
}
main();
