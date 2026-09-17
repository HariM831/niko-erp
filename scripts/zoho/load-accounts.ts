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
 *
 * The database it loads into is not empty. A fresh niko install seeds its own
 * chart — 149 accounts, built from these same books' statement headings — so
 * most of Zoho's accounts already exist under the same name with a different
 * code. Those are adopted rather than duplicated: the seeded row takes Zoho's
 * code, type and parent, and keeps any system key Zoho's map has no opinion on,
 * which is how payroll keeps finding `pf_payable`. A seeded account Zoho has
 * never heard of is deleted if nothing depends on it, and kept if it carries a
 * system key the engine needs. Anything posted to or referenced stops the load
 * on its foreign key rather than being removed.
 */
import { readFile } from "node:fs/promises";
import { eq, inArray, sql } from "drizzle-orm";
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

  // Whatever is in the chart and did not come from Zoho: the seed.
  const norm = (s: string) => s.toLowerCase().split(/\s+/).filter(Boolean).join(" ");
  const imported = new Set(existing.map((r) => r.eggsyId));
  const seeded = (
    await db
      .select({ id: accounts.id, code: accounts.code, name: accounts.name, systemKey: accounts.systemKey })
      .from(accounts)
  ).filter((a) => !imported.has(a.id));

  // Adopted on an unambiguous name only. Two Zoho accounts sharing a name, or
  // two seeded ones, is a pairing this script has no business guessing at.
  const count = (names: string[]) => {
    const n = new Map<string, number>();
    for (const x of names) n.set(x, (n.get(x) ?? 0) + 1);
    return n;
  };
  const inMap = count(ordered.filter((a) => !idFor.has(a.zohoId)).map((a) => norm(a.name)));
  const inSeed = count(seeded.map((a) => norm(a.name)));
  const seedByName = new Map(seeded.map((a) => [norm(a.name), a]));
  const adopt = new Map<string, (typeof seeded)[number]>();
  for (const a of ordered) {
    if (idFor.has(a.zohoId)) continue;
    const n = norm(a.name);
    const s = seedByName.get(n);
    if (s && inMap.get(n) === 1 && inSeed.get(n) === 1) adopt.set(a.zohoId, s);
  }

  const mapKeys = new Set(ordered.map((a) => a.systemKey).filter((k): k is string => !!k));
  const adoptedIds = new Set([...adopt.values()].map((s) => s.id));
  const leftover = seeded.filter((s) => !adoptedIds.has(s.id));
  // A key the map assigns elsewhere moves there; one it does not mention stays.
  const kept = leftover.filter((s) => s.systemKey && !mapKeys.has(s.systemKey));
  const dropped = leftover.filter((s) => !kept.includes(s));

  for (const [zohoId, s] of adopt) {
    const a = byZohoId.get(zohoId)!;
    if (a.systemKey && s.systemKey && !mapKeys.has(s.systemKey) && s.systemKey !== a.systemKey) {
      throw new Error(
        `${a.name}: the map keys it ${a.systemKey} but the seeded account holds ${s.systemKey}, ` +
          `which would be lost. Decide which it is.`,
      );
    }
  }

  const toCreate = ordered.filter((a) => !idFor.has(a.zohoId) && !adopt.has(a.zohoId));
  const toUpdate = ordered.filter((a) => idFor.has(a.zohoId));

  console.log(`${ordered.length} accounts in the map`);
  console.log(`  ${toCreate.length} to create, ${toUpdate.length} already imported`);
  if (seeded.length) {
    console.log(`${seeded.length} accounts already in niko that did not come from Zoho`);
    console.log(`  ${adopt.size} adopted by name`);
    console.log(`  ${dropped.length} deleted — no Zoho counterpart, no key the engine needs`);
    console.log(`  ${kept.length} kept for their system key:`);
    for (const s of kept) console.log(`      ${s.systemKey!.padEnd(24)} ${s.name}`);
    const carried = [...adopt.entries()].filter(
      ([z, s]) => s.systemKey && !mapKeys.has(s.systemKey) && !byZohoId.get(z)!.systemKey,
    );
    console.log(`  ${carried.length} system keys carried onto the Zoho account of the same name:`);
    for (const [, s] of carried) console.log(`      ${s.systemKey!.padEnd(24)} ${s.name}`);
  }
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
    // Seeded rows step off their codes, and off any key the map hands to
    // another account, before anything lands: both columns are unique, and a
    // Zoho code is as likely as not to be one the seed is sitting on.
    if (seeded.length) {
      const ids = seeded.map((s) => s.id);
      await tx
        .update(accounts)
        .set({ code: sql`'~' || substr(replace(${accounts.id}::text, '-', ''), 1, 11)` })
        .where(inArray(accounts.id, ids));
      if (mapKeys.size) {
        await tx
          .update(accounts)
          .set({ systemKey: null })
          .where(sql`${inArray(accounts.id, ids)} AND ${inArray(accounts.systemKey, [...mapKeys])}`);
      }
    }

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

      const seed = adopt.get(a.zohoId);
      if (seed) {
        const carriedKey = seed.systemKey && !mapKeys.has(seed.systemKey) ? seed.systemKey : null;
        await tx
          .update(accounts)
          .set({ ...values, systemKey: a.systemKey ?? carriedKey })
          .where(eq(accounts.id, seed.id));
        idFor.set(a.zohoId, seed.id);
        await tx.insert(zohoIdMap).values({
          entity: "account",
          zohoId: a.zohoId,
          eggsyId: seed.id,
          label: `${a.code} ${a.name}`,
        });
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

    // One statement, so a seeded header and its seeded children go together.
    // Anything a posting or a setting still points at fails here, loudly, and
    // takes the whole load back with it.
    if (dropped.length) {
      await tx.delete(accounts).where(inArray(accounts.id, dropped.map((s) => s.id)));
    }
    // The survivors get their own code back where Zoho has not taken it, and
    // stand at the top level: the header they sat under has just gone.
    const taken = new Set(ordered.map((a) => a.code));
    for (const s of kept) {
      await tx
        .update(accounts)
        .set({ parentId: null, ...(taken.has(s.code) ? {} : { code: s.code }) })
        .where(eq(accounts.id, s.id));
    }
  });

  const [{ count: total }] = await db
    .select({ count: db.$count(accounts) })
    .from(accounts)
    .limit(1)
    .then((r) => (r.length ? r : [{ count: 0 }]));

  console.log(`\nCommitted. niko now has ${total} accounts.`);
  await pool.end();
}

main().catch(async (err) => {
  console.error(`\n${err.message}`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
