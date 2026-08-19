/**
 * The Houses settings screen holds three things and only three: the farm, the
 * type, and the controller. This checks the database agrees — the CHECK is
 * tightened to two types, and nothing carries a third.
 *
 * Run: npx tsx scripts/check-house-settings.ts
 */
import { sql } from "drizzle-orm";
import { db } from "../server/db";

const [{ d } = { d: null }] = (
  await db.execute(
    sql`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'houses_purpose_check'`,
  )
).rows as Array<{ d: string | null }>;

console.log(`\n  purpose CHECK  ${d ?? "MISSING"}`);
if (!d?.includes("'rear'") || !d.includes("'lay'") || d.includes("'both'")) {
  console.log("  ✗ expected exactly rear and lay");
  process.exit(1);
}
console.log("  ✓ two types only");

const { rows } = await db.execute(sql`
  SELECT l.name AS farm, h.code, h.purpose, coalesce(h.bh_device_id, '—') AS device
  FROM houses h JOIN locations l ON l.id = h.location_id
  WHERE h.is_active
  ORDER BY l.name, h.display_order, h.code`);

console.log("\n  farm            house   type    controller");
for (const r of rows as Array<Record<string, string>>) {
  console.log(
    `  ${r.farm!.padEnd(15)} ${r.code!.padEnd(7)} ${r.purpose!.padEnd(7)} ${r.device}`,
  );
}
console.log(`\n  ${rows.length} house(s).\n`);
process.exit(0);
