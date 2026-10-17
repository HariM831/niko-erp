/**
 * Fold a duplicate contact back into the one niko already had.
 *
 *   npx tsx scripts/merge-duplicate-contacts.ts
 *   npx tsx scripts/merge-duplicate-contacts.ts --commit
 *   npx tsx scripts/merge-duplicate-contacts.ts --name "ELITE WINDOWS"
 *
 * scripts/zoho/load-contacts.ts decides what to insert from zoho_id_map alone,
 * so a party that reached niko by another route — the Amino import, hand entry —
 * has no mapping and gets a second row. On 16 October 2026 that happened to six
 * vendors in both books at once. Two of the duplicates carry the original's own
 * GST number, which is as sure as this gets.
 *
 * The oldest row stays, because it is the one the bills, payments and documents
 * are already against. Before anything is dropped, every foreign key pointing
 * at contacts is counted — read from the catalogue rather than a list typed
 * here, so a table added later cannot be forgotten — and a duplicate that any
 * document references is reported and left alone. Moving documents between
 * parties is a decision, not a tidy-up.
 *
 * Its addresses and contact persons are not documents — they belong to the
 * contact and cascade with it. Where the keeper has none, they move across;
 * where it has its own, the duplicate's go with the duplicate.
 *
 * Anything the duplicate knows and the keeper does not is carried across first:
 * the Zoho copy often has the GSTIN or the phone number that the hand-made row
 * never got. A field already filled on the keeper is never overwritten.
 */
import { and, eq, ne, sql } from "drizzle-orm";
import { contacts, zohoIdMap } from "@shared/schema";
import { db, pool } from "../server/db";

const COMMIT = process.argv.includes("--commit");
const only = process.argv.includes("--name")
  ? process.argv[process.argv.indexOf("--name") + 1]
  : undefined;

/**
 * Children of the contact rather than documents against it: they cascade on
 * delete, so they are never a reason to refuse a merge.
 */
const OWNED = [
  { tbl: "contact_addresses", col: "contact_id", one: "address", many: "addresses" },
  { tbl: "contact_persons", col: "contact_id", one: "contact person", many: "contact people" },
] as const;

/** Worth carrying from the duplicate when the keeper has nothing there. */
const CARRY = [
  "company_name", "email", "phone", "mobile", "website", "gstin", "pan",
  "place_of_supply_state", "bank_beneficiary_name", "bank_account_number",
  "bank_ifsc", "bank_name", "notes",
] as const;

async function main() {
  console.log(`\n  Duplicate contacts — ${COMMIT ? "MERGING" : "dry run"}\n`);

  // Every column in the database that points at a contact.
  const refs = (
    await db.execute(sql`
      SELECT c.conrelid::regclass::text AS tbl, a.attname::text AS col
      FROM pg_constraint c
      JOIN unnest(c.conkey) k ON TRUE
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k
      WHERE c.contype = 'f' AND c.confrelid = 'contacts'::regclass
      ORDER BY 1, 2`)
  ).rows as Array<{ tbl: string; col: string }>;
  console.log(`  ${refs.length} column(s) in the database point at a contact\n`);

  const groups = (
    await db.execute(sql`
      SELECT display_name, count(*)::int AS copies
      FROM contacts
      GROUP BY display_name HAVING count(*) > 1
      ORDER BY display_name`)
  ).rows as Array<{ display_name: string; copies: number }>;
  const todo = groups.filter((g) => !only || g.display_name === only);
  if (!todo.length) {
    console.log(only ? `  Nothing named "${only}" is duplicated.\n` : "  No duplicate names.\n");
    await pool.end();
    return;
  }

  let merged = 0, refused = 0;
  for (const g of todo) {
    const rows = await db
      .select({ id: contacts.id, made: contacts.createdAt })
      .from(contacts)
      .where(eq(contacts.displayName, g.display_name))
      .orderBy(contacts.createdAt);
    const keeper = rows[0]!;
    const dupes = rows.slice(1);
    console.log(`  ${g.display_name}  (${g.copies} copies)`);
    console.log(`    keep ${keeper.id}  made ${keeper.made.toISOString().slice(0, 10)}`);

    for (const d of dupes) {
      // Count the duplicate's references everywhere, in one go.
      const counted = (
        await db.execute(sql.join(
          documents.map((r) =>
            sql`SELECT ${`${r.tbl}.${r.col}`}::text AS ref, count(*)::int AS n FROM ${sql.identifier(r.tbl)} WHERE ${sql.identifier(r.col)} = ${d.id}`),
          sql` UNION ALL `,
        ))
      ).rows as Array<{ ref: string; n: number }>;
      const used = counted.filter((c) => c.n > 0);
      if (used.length) {
        console.log(`    REFUSED ${d.id}: ${used.map((u) => `${u.ref} x${u.n}`).join(", ")}`);
        refused++;
        continue;
      }

      // Addresses and people move only into a keeper that has none of its own.
      const moves: Array<{ tbl: string; col: string; one: string; many: string; n: number }> = [];
      for (const o of OWNED) {
        const [mineRow] = (
          await db.execute(sql`SELECT count(*)::int AS n FROM ${sql.identifier(o.tbl)} WHERE ${sql.identifier(o.col)} = ${d.id}`)
        ).rows as Array<{ n: number }>;
        const [keepRow] = (
          await db.execute(sql`SELECT count(*)::int AS n FROM ${sql.identifier(o.tbl)} WHERE ${sql.identifier(o.col)} = ${keeper.id}`)
        ).rows as Array<{ n: number }>;
        if ((mineRow?.n ?? 0) > 0 && (keepRow?.n ?? 0) === 0) {
          moves.push({ ...o, n: mineRow!.n });
        }
      }

      const [dup] = await db.select().from(contacts).where(eq(contacts.id, d.id));
      const [keep] = await db.select().from(contacts).where(eq(contacts.id, keeper.id));
      const carry: Record<string, string> = {};
      for (const col of CARRY) {
        const camel = col.replace(/_([a-z])/g, (_, c) => c.toUpperCase()) as keyof typeof dup;
        const from = String((dup as Record<string, unknown>)[camel] ?? "").trim();
        const have = String((keep as Record<string, unknown>)[camel] ?? "").trim();
        if (from && !have) carry[col] = from;
      }

      // A mapping the keeper already has, pointing somewhere else, is not ours to move.
      const mine = await db
        .select({ zohoId: zohoIdMap.zohoId })
        .from(zohoIdMap)
        .where(and(eq(zohoIdMap.entity, "contact"), eq(zohoIdMap.eggsyId, d.id)));
      const theirs = await db
        .select({ zohoId: zohoIdMap.zohoId })
        .from(zohoIdMap)
        .where(and(eq(zohoIdMap.entity, "contact"), eq(zohoIdMap.eggsyId, keeper.id)));
      const clash = theirs.filter((t) => !mine.some((m) => m.zohoId === t.zohoId));
      if (mine.length && clash.length) {
        console.log(`    REFUSED ${d.id}: the keeper is already Zoho ${clash.map((c) => c.zohoId).join(", ")}`);
        refused++;
        continue;
      }

      console.log(`    drop ${d.id}  made ${d.made.toISOString().slice(0, 10)}`
        + (mine.length ? `  moving Zoho ${mine.map((m) => m.zohoId).join(", ")}` : "  no Zoho mapping"));
      for (const [k, v] of Object.entries(carry)) console.log(`         carry ${k} = ${v}`);
      for (const m of moves) console.log(`         move ${m.n} ${m.n === 1 ? m.one : m.many}`);

      if (COMMIT) {
        await db.transaction(async (tx) => {
          if (Object.keys(carry).length) {
            await tx.execute(sql.join([
              sql`UPDATE contacts SET `,
              sql.join(Object.entries(carry).map(([k, v]) => sql`${sql.identifier(k)} = ${v}`), sql`, `),
              sql`, updated_at = now() WHERE id = ${keeper.id}`,
            ], sql``));
          }
          for (const m of moves) {
            await tx.execute(sql`UPDATE ${sql.identifier(m.tbl)} SET ${sql.identifier(m.col)} = ${keeper.id} WHERE ${sql.identifier(m.col)} = ${d.id}`);
          }
          await tx
            .update(zohoIdMap)
            .set({ eggsyId: keeper.id })
            .where(and(eq(zohoIdMap.eggsyId, d.id), ne(zohoIdMap.eggsyId, keeper.id)));
          await tx.delete(contacts).where(eq(contacts.id, d.id));
        });
      }
      merged++;
    }
  }

  console.log(`\n    duplicates ${COMMIT ? "merged" : "to merge"} ... ${merged}`);
  console.log(`    refused ................ ${refused}`);
  if (!COMMIT) console.log("\n  Dry run — nothing written. Re-run with --commit.\n");
  else console.log("");
  await pool.end();
}

main().catch(async (e) => {
  console.error(`\n  ${e.message}\n`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
