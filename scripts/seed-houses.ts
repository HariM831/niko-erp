/**
 * The six sheds, their site, and their feed stores.
 *
 * Nothing else in the farm module can be loaded until these exist:
 * `import-from-amino.ts` matches its export against houses that are already
 * here and refuses to invent them, and the IoT poller has nothing to poll until
 * a house names a controller. So this runs first, on an empty set of books.
 *
 * The controller ids are not guesses. Each one was read back from bhfarm.net —
 * `probe-bhfarm.ts` lists the enabled devices — and they are what ties a shed to
 * its temperatures and its silo. A wrong id here silently attaches one shed's
 * instruments to another's name, which is the kind of mistake that survives for
 * months because every number still looks plausible.
 *
 * OWNERS. `houses.owner_id` NULL means the shed is ours; a contact means it is
 * that company's and its birds get billed to them. The owning LLPs arrive with
 * the Zoho dump, so this script LINKS an owner when the contact already exists
 * and leaves it null when it does not — it never creates a contact. Inventing a
 * counterparty in a live ledger is not a thing an import should do quietly, and
 * a house can be pointed at its owner afterwards from Settings.
 *
 *   npx tsx scripts/seed-houses.ts            # report, writes nothing
 *   npx tsx scripts/seed-houses.ts --apply
 */
import { and, eq } from "drizzle-orm";
import { contacts, houses, locations, stockLocations } from "@shared/schema";
import { db, pool } from "../server/db";

const SITE = { code: "NALBARI", name: "Nalbari", type: "farm" } as const;

/**
 * Display order is the farm's own, not alphabetical: L3 first because it is the
 * one they walk to first. Carried across from the shed board they already read.
 */
const HOUSES = [
  { code: "L3", purpose: "layer", order: 0, device: "b5acf87ac916a026", owner: "Nandamuri Poultries LLP" },
  { code: "L4", purpose: "layer", order: 1, device: "904b9996922dff4f", owner: "Luit Valley Farms LLP" },
  { code: "L2", purpose: "layer", order: 2, device: "efdaeee6357c8a38", owner: "Nandamuri Poultries LLP" },
  { code: "L5", purpose: "layer", order: 3, device: "a34538861713fe4d", owner: "Luit Valley Farms LLP" },
  { code: "P1", purpose: "pullet", order: 4, device: "3b78dfdfa0086ffc", owner: null },
  { code: "P2", purpose: "pullet", order: 5, device: "67bce3e339dc7e5f", owner: null },
] as const;

async function main() {
  const apply = process.argv.includes("--apply");

  await db.transaction(async (tx) => {
    const plan: string[] = [];

    // Everything below WRITES, whether or not --apply was passed; a dry run is
    // the same transaction rolled back at the end. Guarding each insert instead
    // would make the report a description of what the script intends rather than
    // of what it does — on empty books the site would not exist yet, so nothing
    // downstream could be resolved and the plan would trail off into "after the
    // site". Rehearsing it for real also means a constraint that would fail on
    // apply fails here, where it costs nothing.

    // ── The site ──
    let [site] = await tx.select().from(locations).where(eq(locations.code, SITE.code));
    if (site) {
      plan.push(`site      ${SITE.code} exists`);
    } else {
      plan.push(`site      ${SITE.code} — ${SITE.name}   CREATE`);
      [site] = await tx
        .insert(locations)
        .values({ code: SITE.code, name: SITE.name, type: SITE.type, isActive: true })
        .returning();
    }

    // ── The site's main store ──
    //
    // Every location is expected to have one: it is where anything not yet in a
    // shed sits, and the Farm store screen opens on it.
    const mainName = `${SITE.name} — main store`;
    const [main] = await tx
      .select()
      .from(stockLocations)
      .where(and(eq(stockLocations.locationId, site!.id), eq(stockLocations.code, "MAIN")));
    if (main) {
      plan.push(`store     MAIN exists`);
    } else {
      plan.push(`store     MAIN — ${mainName}   CREATE`);
      await tx
        .insert(stockLocations)
        .values({ locationId: site!.id, code: "MAIN", name: mainName, kind: "main", isActive: true });
    }

    // ── A feed store and a house for each shed ──
    for (const h of HOUSES) {
      let [store] = await tx
        .select()
        .from(stockLocations)
        .where(and(eq(stockLocations.locationId, site!.id), eq(stockLocations.code, h.code)));
      if (!store) {
        plan.push(`store     ${h.code} — feed   CREATE`);
        [store] = await tx
          .insert(stockLocations)
          .values({
            locationId: site!.id,
            code: h.code,
            name: `${h.code} — feed`,
            kind: "house",
            isActive: true,
          })
          .returning();
      }

      // The owner is linked only if it is already on the books.
      let ownerId: string | null = null;
      let ownerNote = "";
      if (h.owner) {
        const [c] = await tx.select().from(contacts).where(eq(contacts.displayName, h.owner));
        if (c) {
          ownerId = c.id;
          ownerNote = `owner ${h.owner}`;
        } else {
          ownerNote = `owner ${h.owner} NOT ON THE BOOKS — left unowned, link it later`;
        }
      }

      const [existing] = await tx
        .select()
        .from(houses)
        .where(and(eq(houses.locationId, site!.id), eq(houses.code, h.code)));
      if (existing) {
        // The owning LLPs arrive with the Zoho dump, after the houses. Re-running
        // then is what links them: without this the script would report "exists"
        // and quietly leave every layer unowned forever, and the only way to
        // notice would be an owner-billing run that produced nothing.
        //
        // Only ever fills an EMPTY owner. Re-pointing a shed at a different
        // company is a decision about who gets billed, not a seed's business.
        if (!existing.ownerId && ownerId) {
          plan.push(`house     ${h.code} exists — LINK ${ownerNote}`);
          await tx.update(houses).set({ ownerId }).where(eq(houses.id, existing.id));
        } else {
          plan.push(`house     ${h.code} exists${ownerNote && !existing.ownerId ? `   ${ownerNote}` : ""}`);
        }
        continue;
      }

      plan.push(
        `house     ${h.code.padEnd(3)} ${h.purpose.padEnd(6)} order ${h.order}  ${h.device}  CREATE${ownerNote ? `   ${ownerNote}` : ""}`,
      );
      await tx.insert(houses).values({
        locationId: site!.id,
        stockLocationId: store!.id,
        ownerId,
        code: h.code,
        purpose: h.purpose,
        displayOrder: h.order,
        bhDeviceId: h.device,
        isActive: true,
      });
    }

    console.log(plan.map((p) => `  ${p}`).join("\n"));
    if (!apply) {
      console.log("\nReport only — nothing written. Re-run with --apply.");
      throw new ROLLBACK();
    }
    console.log(`\nWrote the site, its stores and ${HOUSES.length} houses.`);
  }).catch((e) => {
    if (!(e instanceof ROLLBACK)) throw e;
  });

  await pool.end();
}

/** Rolls the dry run back without reporting a failure. */
class ROLLBACK extends Error {}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.message : e);
  await pool.end();
  process.exit(1);
});
