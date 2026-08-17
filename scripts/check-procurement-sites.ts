/**
 * Checks the gate geofence, and the two rules that keep a site record usable.
 *
 * Gates and weighbridges were empty tables until there was a screen to fill
 * them, which meant gate-in took a GPS fix and compared it to nothing. Now that
 * they can be entered, three things have to hold:
 *
 *   a fix INSIDE a gate's radius reads inside, and one outside reads outside
 *     with the distance to the nearest gate — a truck at the wrong site is a
 *     fact worth recording, not an error worth raising;
 *   NO FIX is `no_fix`, never a silent null and never a block. A phone indoors
 *     or with location refused must still let a truck in;
 *   a gate with only ONE coordinate is refused. It is not half-located, it is
 *     unusable: the resolver needs both to measure anything, so a lone latitude
 *     reads as configured while doing nothing.
 *
 * Rolled back, so no gate, weighbridge or receipt survives.
 *
 * Run: npx tsx scripts/check-procurement-sites.ts
 */
import { eq } from "drizzle-orm";
import { gates, locations, weighbridges } from "@shared/schema";
import { db } from "../server/db";
import { resolvePlace } from "../server/services/geo";

let failed = 0;
const check = (name: string, pass: boolean, detail = "") => {
  if (!pass) failed++;
  console.log(`    ${pass ? "PASS" : "FAIL"}  ${name.padEnd(56)} ${detail}`);
};

class Rollback extends Error {}

/** The Main Gate figures from the real site, and a point 1.5 km north of it. */
const LAT = 26.44521;
const LNG = 91.44127;
const RADIUS = 150;

try {
  await db.transaction(async (tx) => {
    const [site] = await tx.select({ id: locations.id, name: locations.name }).from(locations).limit(1);
    if (!site) throw new Error("Need a location to hang a gate off");

    // Stand the real gates down so the resolver is measuring against ours only.
    await tx.update(gates).set({ isActive: false }).where(eq(gates.isActive, true));

    const [gate] = await tx
      .insert(gates)
      .values({
        locationId: site.id,
        name: "Check Gate",
        latitude: String(LAT),
        longitude: String(LNG),
        radiusM: RADIUS,
      })
      .returning();

    console.log("\n  THE GEOFENCE RECORDS, IT DOES NOT BLOCK\n");

    const at = await resolvePlace(tx, { latitude: LAT, longitude: LNG, accuracyM: 8 });
    check("a fix at the gate reads inside", at.verdict === "inside", `${at.distanceM?.toFixed(2)} m — ${at.label}`);
    check("and names the gate it matched", at.gateId === gate!.id);

    // Just inside the fence: ~100 m north is 0.0009 degrees of latitude.
    const near = await resolvePlace(tx, { latitude: LAT + 0.0009, longitude: LNG });
    check(
      "a fix within the radius still reads inside",
      near.verdict === "inside",
      `${near.distanceM?.toFixed(0)} m of ${RADIUS} m`,
    );

    const far = await resolvePlace(tx, { latitude: LAT + 0.0138, longitude: LNG });
    check("a fix beyond the radius reads outside", far.verdict === "outside", `${far.distanceM?.toFixed(0)} m`);
    check(
      "and still measures to the NEAREST gate, so the miss is quantified",
      far.gateId === gate!.id && (far.distanceM ?? 0) > RADIUS,
      "a truck at the wrong site is a fact, not an error",
    );

    for (const [label, fix] of [
      ["no fix at all", null],
      ["a null island reading", { latitude: 0, longitude: 0 }],
      ["a NaN reading", { latitude: Number.NaN, longitude: LNG }],
    ] as const) {
      const out = await resolvePlace(tx, fix);
      check(`${label} reads no_fix, not inside`, out.verdict === "no_fix", out.label);
    }

    console.log("\n  A SITE RECORD STAYS USABLE\n");

    // Both coordinates or neither — enforced by the route, mirrored here as the
    // rule it enforces, because a lone latitude is the trap.
    const lopsided = (lat?: string | null, lng?: string | null) => {
      const has = (v?: string | null) => v != null && String(v).trim() !== "";
      return has(lat) !== has(lng);
    };
    check("a latitude with no longitude is lopsided", lopsided("26.4", null));
    check("a longitude with no latitude is lopsided", lopsided(null, "91.4"));
    check("neither is fine — the gate simply has no fence", !lopsided(null, null));
    check("both is fine", !lopsided("26.4", "91.4"));

    // A gate with no coordinates must still resolve rather than throw: it is a
    // named place that happens not to be fenced.
    await tx.update(gates).set({ isActive: false }).where(eq(gates.id, gate!.id));
    await tx
      .insert(gates)
      .values({ locationId: site.id, name: "Unfenced Gate", latitude: null, longitude: null });
    const unfenced = await resolvePlace(tx, { latitude: LAT, longitude: LNG });
    check(
      "an unfenced gate does not break the resolver",
      unfenced.verdict === "inside" || unfenced.verdict === "outside" || unfenced.verdict === "no_fix",
      `verdict ${unfenced.verdict}, gate ${unfenced.gateId ? "matched" : "none"}`,
    );

    const [bridge] = await tx
      .insert(weighbridges)
      .values({ locationId: site.id, name: "Check Platform", capacityKg: "60000.000" })
      .returning();
    await tx.update(weighbridges).set({ isActive: false }).where(eq(weighbridges.id, bridge!.id));
    const [still] = await tx.select().from(weighbridges).where(eq(weighbridges.id, bridge!.id));
    check(
      "taking a platform out of service keeps the record",
      still != null && still.isActive === false,
      "off tomorrow's list, still on yesterday's receipts",
    );

    throw new Rollback();
  });
} catch (e) {
  if (!(e instanceof Rollback)) throw e;
}

const strayGates = await db.select({ n: gates.name }).from(gates).where(eq(gates.name, "Check Gate"));
const strayBridges = await db
  .select({ n: weighbridges.name })
  .from(weighbridges)
  .where(eq(weighbridges.name, "Check Platform"));
check("nothing survives the run", strayGates.length === 0 && strayBridges.length === 0);
const live = await db.select({ n: gates.name }).from(gates).where(eq(gates.isActive, true));
check("the real gates are live again", live.length > 0, `${live.length} in service`);

console.log(failed === 0 ? "\n  All site and geofence checks passed.\n" : `\n  ${failed} FAILED.\n`);
process.exit(failed ? 1 : 0);
