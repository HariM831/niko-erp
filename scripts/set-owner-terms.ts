/**
 * Set the egg benchmark price and each owner's spread.
 *
 * Stands in for a settings screen that does not exist yet. These are real
 * commercial terms — the rate here decides what Amino pays for every egg — so
 * the numbers are passed in rather than assumed, and running it twice for the
 * same date corrects rather than duplicates.
 *
 *   npx tsx scripts/set-owner-terms.ts --benchmark 5.20 --spread 0.50
 *   npx tsx scripts/set-owner-terms.ts --benchmark 5.35 --from 2026-09-01
 */
import { and, eq } from "drizzle-orm";
import { eggBenchmarkPrices, ownerAgreements } from "@shared/schema";
import { db } from "../server/db";
import { owners } from "../server/services/owner-billing";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};

const benchmark = arg("benchmark");
const spread = arg("spread") ?? "0.50";
// Defaults to the first of this month, which is the period being billed.
const from = arg("from") ?? `${new Date().toISOString().slice(0, 7)}-01`;

if (!benchmark || Number.isNaN(Number(benchmark))) {
  console.log("\n  --benchmark is required, in rupees per EGG (e.g. --benchmark 5.20)\n");
  process.exit(1);
}

const userId = ((await db.execute(`SELECT id FROM users LIMIT 1`)).rows[0] as { id: string }).id;

await db
  .insert(eggBenchmarkPrices)
  .values({
    effectiveFrom: from,
    ratePerEgg: Number(benchmark).toFixed(4),
    source: "entered by hand",
    createdBy: userId,
  })
  .onConflictDoUpdate({
    target: eggBenchmarkPrices.effectiveFrom,
    set: { ratePerEgg: Number(benchmark).toFixed(4) },
  });
console.log(`\n  egg benchmark ₹${Number(benchmark).toFixed(4)}/egg from ${from}`);

for (const o of await owners(db)) {
  await db
    .insert(ownerAgreements)
    .values({
      contactId: o.id,
      effectiveFrom: from,
      eggSpreadPerEgg: Number(spread).toFixed(4),
      createdBy: userId,
    })
    .onConflictDoUpdate({
      target: [ownerAgreements.contactId, ownerAgreements.effectiveFrom],
      set: { eggSpreadPerEgg: Number(spread).toFixed(4) },
    });
  console.log(
    `  ${o.name.padEnd(28)} spread +₹${Number(spread).toFixed(2)}  ` +
      `→ ₹${(Number(benchmark) + Number(spread)).toFixed(2)}/egg`,
  );
}

// Amino buys their eggs, so an owner has to be a vendor as well as a customer.
for (const o of await owners(db)) {
  const [row] = await db.execute(
    `SELECT type FROM contacts WHERE id = '${o.id}'`,
  ).then((r) => r.rows as Array<{ type: string }>);
  if (row && row.type === "customer") {
    await db.execute(`UPDATE contacts SET type = 'both' WHERE id = '${o.id}'`);
    console.log(`  ${o.name} is now a vendor as well — Amino buys their eggs`);
  }
}

console.log("");
process.exit(0);
