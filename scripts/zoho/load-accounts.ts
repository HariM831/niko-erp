/**
 * Phase 3, first step: create niko's chart of accounts from the reviewed map.
 *
 * The first thing in this migration that writes to the database, and everything
 * after it resolves against what this creates — so it runs dry by default and
 * only writes when told to.
 *
 *   npx tsx scripts/zoho/load-accounts.ts             # say what would happen
 *   npx tsx scripts/zoho/load-accounts.ts --commit    # do it
 *
 * Re-running is safe. Accounts are matched by the Zoho id recorded in
 * zoho_id_map, so a second run updates what it made before rather than
 * duplicating it, and a run interrupted halfway can simply be repeated.
 */
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { accounts, zohoIdMap } from "@shared/schema";
import { db, pool } from "../../server/db";

interface MappedAccount {
  zohoId: string;
  code: string;
  name: string;
  type: string;
  subtype: string;
  parentZohoId: string | null;
  depth: number;
  description: string;
  systemKey: string | null;
  balance: number;
}

async function main() {
  const commit = process.argv.includes("--commit");
  const map = JSON.parse(await readFile(".zoho-dump/account-map.json", "utf8")) as {
    accounts: MappedAccount[];
  };

  /*
   * Parents before children, worked out from the parent links themselves
   * rather than from the recorded depth.
   *
   * Sorting on `depth` looked equivalent and was not: the accounts added by
   * pull-missing-accounts.ts arrive with depth 0 and a parent several levels
   * down, so eight of them sorted ahead of parents that did not exist yet and
   * the load stopped on the first one. Depth is a number somebody else
   * computed; the parent link is the thing actually being relied on, so that
   * is what decides the order.
   *
   * A cycle would loop forever, so it is detected and named instead.
   */
  const byZohoId = new Map(map.accounts.map((a) => [String(a.zohoId), a]));
  const ordered: MappedAccount[] = [];
  const placed = new Set<string>();
  let remaining = [...map.accounts];
  while (remaining.length) {
    const ready = remaining.filter(
      (a) => !a.parentZohoId || !byZohoId.has(String(a.parentZohoId)) || placed.has(String(a.parentZohoId)),
    );
    if (!ready.length) {
      throw new Error(
        `Parent links form a cycle among: ${remaining.slice(0, 5).map((a) => `${a.code} ${a.name}`).join(", ")}`,
      );
    }
    for (const a of ready) {
      ordered.push(a);
      placed.add(String(a.zohoId));
    }
    const readySet = new Set(ready.map((a) => String(a.zohoId)));
    remaining = remaining.filter((a) => !readySet.has(String(a.zohoId)));
  }

  const existing = await db
    .select({ zohoId: zohoIdMap.zohoId, eggsyId: zohoIdMap.eggsyId })
    .from(zohoIdMap)
    .where(eq(zohoIdMap.entity, "account"));
  const idFor = new Map(existing.map((r) => [r.zohoId, r.eggsyId]));

  const toCreate = ordered.filter((a) => !idFor.has(a.zohoId));
  const toUpdate = ordered.filter((a) => idFor.has(a.zohoId));

  console.log(`${ordered.length} accounts in the map`);
  console.log(`  ${toCreate.length} to create, ${toUpdate.length} already imported`);
  console.log(`  ${ordered.filter((a) => a.systemKey).length} carry a system key`);
  console.log(`  ${ordered.filter((a) => a.parentZohoId).length} are nested under a parent`);
  console.log(`  deepest level: ${Math.max(...ordered.map((a) => a.depth))}`);

  const codes = new Set<string>();
  const clashes = ordered.filter((a) => !codes.add(a.code) || false);
  if (clashes.length) throw new Error(`Duplicate codes in the map: ${clashes.map((c) => c.code).join(", ")}`);

  if (!commit) {
    console.log("\nSample of what would be created:");
    for (const a of toCreate.slice(0, 8)) {
      console.log(
        `  ${a.code.padEnd(6)} ${a.name.slice(0, 44).padEnd(46)} ${a.type}/${a.subtype}` +
          `${a.systemKey ? `  [${a.systemKey}]` : ""}`,
      );
    }
    console.log(`\nDry run — nothing written. Re-run with --commit to apply.`);
    await pool.end();
    return;
  }

  await db.transaction(async (tx) => {
    for (const a of ordered) {
      const parentId = a.parentZohoId ? (idFor.get(a.parentZohoId) ?? null) : null;
      if (a.parentZohoId && !parentId) {
        throw new Error(
          `${a.code} ${a.name} names parent ${a.parentZohoId}, which has not been created. ` +
            `The depth ordering is wrong.`,
        );
      }

      const values = {
        code: a.code,
        name: a.name,
        type: a.type as typeof accounts.$inferInsert.type,
        subtype: a.subtype as typeof accounts.$inferInsert.subtype,
        parentId,
        systemKey: a.systemKey,
        description: a.description || null,
        // Every account comes across active. Zoho reported all 398 as active,
        // and an account carrying history must stay postable for the import.
        isActive: true,
        // Not marked as groups: Zoho posts to parent accounts as readily as to
        // leaves, so treating them as headers would reject postings this
        // migration has to make.
        isGroup: false,
      };

      const known = idFor.get(a.zohoId);
      if (known) {
        await tx.update(accounts).set(values).where(eq(accounts.id, known));
        continue;
      }

      const [created] = await tx.insert(accounts).values(values).returning({ id: accounts.id });
      idFor.set(a.zohoId, created!.id);
      await tx.insert(zohoIdMap).values({
        entity: "account",
        zohoId: a.zohoId,
        eggsyId: created!.id,
        label: `${a.code} ${a.name}`,
      });
    }
  });

  const [{ count }] = await db
    .select({ count: db.$count(accounts) })
    .from(accounts)
    .limit(1)
    .then((r) => (r.length ? r : [{ count: 0 }]));

  console.log(`\nCommitted. niko now has ${count} accounts.`);
  await pool.end();
}

main().catch(async (err) => {
  console.error(`\n${err.message}`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
