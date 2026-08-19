/**
 * Split a house's SITE from its OWNER.
 *
 * `migrate-sheds-to-houses.ts` read "farmName" out of the feed mill export and
 * created a location per value: Nandamuri, Luit Valley, Amino. Those are not
 * places. They are the three companies that own the sheds — all six of which
 * stand at one site, Nalbari.
 *
 * Getting this wrong is not cosmetic. Owner decides who gets billed: feed
 * delivered to L4 is a sale to Luit Valley, and the eggs L4 lays are a purchase
 * from them. Site decides where the truck goes.
 *
 *     L2, L3  → Nalbari, owned by Nandamuri Poultries LLP
 *     L4, L5  → Nalbari, owned by Luit Valley
 *     P1, P2  → Nalbari, ours
 *
 * L1 is still being built and L6–L10 will stand at Panbari; neither exists yet,
 * so neither is invented here.
 *
 * A company location is RETIRED, never deleted, and only once nothing points at
 * it — GR-00001 is a posted receipt, and moving it to Nalbari is the truthful
 * answer to "where did the truck arrive", not a rewrite.
 *
 * Idempotent: run it twice and the second run reports no work.
 *
 * Run: npx tsx scripts/migrate-houses-to-sites.ts
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { contacts, houses, locations, officeReceipts, stockLocations } from "@shared/schema";
import { db } from "../server/db";

/** The site every existing shed stands on. */
const SITE = { code: "NALBARI", name: "Nalbari" };

/** Company names as they appear in `locations` — the rows to be retired. */
const COMPANY_LOCATIONS = ["Nandamuri", "Luit Valley", "Amino"];

/**
 * Shed → owning company, by contact display name. `null` means ours: Amino
 * keeps these books, so it is the org rather than a contact.
 */
const OWNER_OF: Record<string, string | null> = {
  L2: "Nandamuri Poultries LLP",
  L3: "Nandamuri Poultries LLP",
  L4: "Luit Valley Farms LLP",
  L5: "Luit Valley Farms LLP",
  P1: null,
  P2: null,
};

await db.transaction(async (tx) => {
  // ── The site ──────────────────────────────────────────────────────────────
  const [existing] = await tx.select().from(locations).where(eq(locations.code, SITE.code));
  let siteId = existing?.id;
  if (existing) {
    console.log(`  site     ${SITE.name.padEnd(16)} already a location`);
  } else {
    const [made] = await tx
      .insert(locations)
      .values({ code: SITE.code, name: SITE.name, type: "farm" })
      .returning();
    siteId = made!.id;
    await tx.insert(stockLocations).values({
      locationId: siteId,
      code: "MAIN",
      name: `${SITE.name} — main store`,
      kind: "main",
    });
    console.log(`  site     ${SITE.name.padEnd(16)} created`);
  }

  // ── Owners ────────────────────────────────────────────────────────────────
  // A shed's owner is billed for feed AND bought from for eggs, so the contact
  // has to be usable in both directions. Anything narrower is a Zoho split.
  const wanted = [...new Set(Object.values(OWNER_OF).filter((v): v is string => !!v))];
  const found = await tx
    .select({ id: contacts.id, name: contacts.displayName, type: contacts.type })
    .from(contacts)
    .where(inArray(contacts.displayName, wanted));
  const ownerIdOf = new Map(found.map((c) => [c.name, c.id]));
  for (const name of wanted) {
    if (!ownerIdOf.has(name)) throw new Error(`No contact named "${name}" — create it first.`);
  }
  for (const c of found) {
    if (c.type === "both") continue;
    await tx.update(contacts).set({ type: "both" }).where(eq(contacts.id, c.id));
    console.log(`  owner    ${c.name.padEnd(28)} type ${c.type} → both`);
  }

  // ── Each house moves to the site and gains its owner ───────────────────────
  const all = await tx.select().from(houses);
  let moved = 0;
  for (const h of all) {
    const ownerName = OWNER_OF[h.code];
    if (ownerName === undefined) {
      console.log(`  house    ${h.code.padEnd(16)} SKIPPED — not in the owner map`);
      continue;
    }
    const ownerId = ownerName ? ownerIdOf.get(ownerName)! : null;
    if (h.locationId === siteId && h.ownerId === ownerId) {
      console.log(`  house    ${h.code.padEnd(16)} already correct`);
      continue;
    }
    await tx.update(houses).set({ locationId: siteId!, ownerId }).where(eq(houses.id, h.id));
    // Its feed store was created under the company location; it stands at the
    // site too, and a store whose location disagrees with its house is how
    // stock reports start naming places that do not exist.
    await tx
      .update(stockLocations)
      .set({ locationId: siteId! })
      .where(eq(stockLocations.id, h.stockLocationId));
    moved++;
    console.log(`  house    ${h.code.padEnd(16)} → ${SITE.name}, ${ownerName ?? "ours"}`);
  }

  // ── The company locations, and anything still pointing at them ─────────────
  const companies = await tx
    .select()
    .from(locations)
    .where(and(inArray(locations.name, COMPANY_LOCATIONS), eq(locations.type, "farm")));
  for (const c of companies) {
    const receipts = await tx
      .update(officeReceipts)
      .set({ locationId: siteId! })
      .where(eq(officeReceipts.locationId, c.id))
      .returning({ number: officeReceipts.number });
    if (receipts.length) {
      console.log(
        `  receipt  ${receipts.map((r) => r.number).join(", ")} → ${SITE.name} (was ${c.name})`,
      );
    }
    if (c.isActive) {
      await tx.update(locations).set({ isActive: false }).where(eq(locations.id, c.id));
      console.log(`  location ${c.name.padEnd(16)} retired — a company is not a place`);
    }
  }

  // ── Undo a promotion this script made on an earlier, wrong guess ──────────
  // "Luit Valley" is two contacts — a customer we invoiced feed to and a vendor
  // we bought eggs from. An earlier run picked the customer as the shed owner
  // and promoted it to "both". The LLP is the owner, so put the other one back
  // where it was, but only if nothing has since been billed against it.
  const promoted = await tx
    .select({ id: contacts.id, name: contacts.displayName, type: contacts.type })
    .from(contacts)
    .where(eq(contacts.displayName, "Luit Valley Farm Pvt ltd"));
  for (const c of promoted) {
    if (c.type !== "both" || ownerIdOf.get(c.name)) continue;
    const [{ n } = { n: 0 }] = (
      await tx.execute(sql`SELECT count(*)::int AS n FROM bills WHERE vendor_id = ${c.id}`)
    ).rows as Array<{ n: number }>;
    if (n > 0) {
      console.log(`  owner    ${c.name.padEnd(28)} left as both — it has ${n} bill(s)`);
      continue;
    }
    await tx.update(contacts).set({ type: "customer" }).where(eq(contacts.id, c.id));
    console.log(`  owner    ${c.name.padEnd(28)} both → customer (not a shed owner)`);
  }

  console.log(`\n  ${moved} house(s) moved.`);

  // ── What is left pointing at a retired location ───────────────────────────
  const stranded = await tx.execute(sql`
    SELECT s.code, s.name, l.name AS loc,
           (SELECT count(*)::int FROM inventory_transactions t
             WHERE t.stock_location_id = s.id) AS movements
    FROM stock_locations s
    JOIN locations l ON l.id = s.location_id
    WHERE NOT l.is_active`);
  const rows = stranded.rows as Array<{ code: string; name: string; loc: string; movements: number }>;
  if (rows.length) {
    console.log("\n  Stores still under a retired location:");
    for (const r of rows) {
      console.log(`    ${r.code.padEnd(10)} ${r.name.padEnd(28)} ${r.loc}  movements=${r.movements}`);
    }
  }
});

console.log("");
process.exit(0);
