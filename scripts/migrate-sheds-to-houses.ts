/**
 * Move the sheds out of `locations` and into `houses`.
 *
 * The feed mill import created one location per Amino shed because there was
 * nowhere else to put them, and threw away the farm each belonged to. So L2 and
 * Nalbari Feed Mill ended up in the same list, and Feed Transfer offered the
 * mill as a destination house.
 *
 * The farm names are recovered from the export the import read, not guessed:
 *
 *     L2, L3  → Nandamuri      (layer)
 *     L4, L5  → Luit Valley    (layer)
 *     P1, P2  → Amino          (pullet)
 *
 * A shed's location row is RETIRED rather than deleted. GR-00001 was gated in
 * at L2, and a posted receipt that points at a row we removed is worse than one
 * pointing at a row marked closed. Its location is repointed to the farm the
 * shed sits on, which is the truthful answer to "where did the truck arrive".
 *
 * Idempotent: run it twice and the second run reports no work.
 *
 * Run: npx tsx scripts/migrate-sheds-to-houses.ts
 */
import { readFileSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import { houses, locations, officeReceipts, stockLocations } from "@shared/schema";
import { db } from "../server/db";

interface Shed {
  name: string;
  type: string | null;
  farmName: string | null;
}

const EXPORT = "feed-mill-export.json";
let sheds: Shed[] = [];
try {
  sheds = (JSON.parse(readFileSync(EXPORT, "utf8")) as { sheds?: Shed[] }).sheds ?? [];
} catch {
  console.log(`\n  ${EXPORT} not found — cannot recover which farm each shed belongs to.\n`);
  process.exit(1);
}
if (!sheds.length) {
  console.log("\n  The export lists no sheds.\n");
  process.exit(1);
}

/**
 * layer → lays, pullet → rears. There is no third answer to fall back on, so a
 * shed the export does not classify stops the run rather than being guessed at:
 * every shed in the real export carried one of the two.
 */
const purposeOf = (name: string, t: string | null) => {
  if (t === "layer") return "layer";
  if (t === "pullet") return "pullet";
  throw new Error(`Shed ${name} has type ${t ?? "(none)"} — set it to layer or pullet first.`);
};

const norm = (s: string) => s.trim().toLowerCase();

await db.transaction(async (tx) => {
  const allLocations = await tx.select().from(locations);
  const byName = new Map(allLocations.map((l) => [norm(l.name), l]));

  // ── The farms the sheds actually belong to ──
  const farmNames = [...new Set(sheds.map((s) => s.farmName).filter((v): v is string => !!v))];
  const farmIdOf = new Map<string, string>();
  for (const name of farmNames) {
    const existing = byName.get(norm(name));
    if (existing) {
      farmIdOf.set(name, existing.id);
      console.log(`  farm     ${name.padEnd(14)} already a location`);
      continue;
    }
    const code = name.replace(/[^A-Za-z0-9]/g, "").slice(0, 12).toUpperCase();
    const [made] = await tx
      .insert(locations)
      .values({ code, name, type: "farm" })
      .returning();
    // Every location gets its main store — farm-level stock lives there.
    await tx.insert(stockLocations).values({
      locationId: made!.id,
      code: "MAIN",
      name: `${name} — main store`,
      kind: "main",
    });
    farmIdOf.set(name, made!.id);
    console.log(`  farm     ${name.padEnd(14)} created`);
  }

  // ── Each shed becomes a house on its farm ──
  let made = 0;
  let skipped = 0;
  for (const [i, shed] of sheds.entries()) {
    const farmId = shed.farmName ? farmIdOf.get(shed.farmName) : undefined;
    if (!farmId) {
      console.log(`  house    ${shed.name.padEnd(14)} SKIPPED — no farm named on the export`);
      skipped++;
      continue;
    }
    const already = await tx
      .select({ id: houses.id })
      .from(houses)
      .where(and(eq(houses.locationId, farmId), eq(houses.code, shed.name)));
    if (already.length) {
      console.log(`  house    ${shed.name.padEnd(14)} already migrated`);
      skipped++;
      continue;
    }

    const [store] = await tx
      .insert(stockLocations)
      .values({
        locationId: farmId,
        code: shed.name.toUpperCase().slice(0, 20),
        name: `${shed.name} — feed`,
        kind: "house",
      })
      .returning();
    await tx.insert(houses).values({
      locationId: farmId,
      stockLocationId: store!.id,
      code: shed.name,
      purpose: purposeOf(shed.name, shed.type),
      displayOrder: i,
    });
    made++;
    console.log(
      `  house    ${shed.name.padEnd(14)} → ${shed.farmName} (${purposeOf(shed.name, shed.type)})`,
    );

    // The shed's own location row: hand its references to the farm, then retire.
    const old = byName.get(norm(shed.name));
    if (!old) continue;
    const moved = await tx
      .update(officeReceipts)
      .set({ locationId: farmId })
      .where(eq(officeReceipts.locationId, old.id))
      .returning({ number: officeReceipts.number });
    if (moved.length) {
      console.log(
        `           ${moved.map((m) => m.number).join(", ")} repointed to ${shed.farmName}`,
      );
    }
    // Its main store may hold movements; leave them, but close the row so it
    // stops appearing in a site picker.
    await tx.update(locations).set({ isActive: false }).where(eq(locations.id, old.id));
    console.log(`           location ${shed.name} retired`);
  }

  console.log(`\n  ${made} house(s) created, ${skipped} skipped.`);

  const orphans = await tx.execute(sql`
    SELECT l.code, l.name FROM locations l
    WHERE l.type = 'farm' AND l.is_active
      AND NOT EXISTS (SELECT 1 FROM houses h WHERE h.location_id = l.id)
      AND NOT EXISTS (SELECT 1 FROM office_receipts o WHERE o.location_id = l.id)`);
  if (orphans.rows.length) {
    console.log("\n  Farms with no houses and no receipts — check these by hand:");
    for (const o of orphans.rows as Array<{ code: string; name: string }>) {
      console.log(`    ${o.code} ${o.name}`);
    }
  }
});

console.log("");
process.exit(0);
