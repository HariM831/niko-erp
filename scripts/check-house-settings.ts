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
if (!d?.includes("'layer'") || !d.includes("'pullet'") || d.includes("'both'")) {
  console.log("  ✗ expected exactly layer and pullet");
  process.exit(1);
}
console.log("  ✓ two types only");

const { rows } = await db.execute(sql`
  SELECT l.name AS site, h.code, h.purpose,
         coalesce(c.display_name, 'ours') AS owner,
         coalesce(c.type, 'both') AS owner_type,
         coalesce(h.bh_device_id, '—') AS device,
         l.is_active AS site_active
  FROM houses h
  JOIN locations l ON l.id = h.location_id
  LEFT JOIN contacts c ON c.id = h.owner_id
  WHERE h.is_active
  ORDER BY l.name, h.code`);

console.log("\n  site        house   type   owner                         controller");
let bad = 0;
for (const r of rows as Array<Record<string, string | boolean>>) {
  console.log(
    `  ${String(r.site).padEnd(11)} ${String(r.code).padEnd(7)} ${String(r.purpose).padEnd(6)} ${String(r.owner).padEnd(29)} ${r.device}`,
  );
  // A shed standing on a retired site, or owned by a contact that cannot be
  // both invoiced and billed, is master data that will fail at billing time.
  if (!r.site_active) {
    console.log(`      ✗ ${r.code} stands on a retired site`);
    bad++;
  }
  if (r.owner_type !== "both") {
    console.log(`      ✗ ${r.owner} is type ${r.owner_type}, not both`);
    bad++;
  }
}
console.log(`\n  ${rows.length} house(s), ${bad} problem(s).\n`);
process.exit(bad ? 1 : 0);
