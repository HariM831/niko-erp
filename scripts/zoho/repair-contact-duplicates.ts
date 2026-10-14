/**
 * Repairs the duplicate contacts the Zoho catch-up load created.
 *
 *   npx tsx scripts/zoho/repair-contact-duplicates.ts             # say what would happen
 *   npx tsx scripts/zoho/repair-contact-duplicates.ts --commit    # do it
 *
 * `load-contacts.ts` used to decide what to insert from `zoho_id_map` alone, so
 * a party that had reached niko by another route — the Amino import, or typed
 * in at the office — looked unimported and got a second copy. The 12 Oct 2026
 * catch-up on staging did that to seven of the twelve contacts it loaded:
 *
 *     ELITE WINDOWS                   same name
 *     LCGC BIOANALYTIC SOLUTIONS LLP  same name
 *     Rajendra Trading Company        same GSTIN 18AEAPB9602F1ZX
 *     VAISHNAVI DRUG CORPORATION      same GSTIN 10AOKPK4121L2Z7
 *     Goyal Proteins Limited          same GSTIN 08AABCG3707A1Z7
 *     M.B Suppliers (Mrinmoy Borah)   same name
 *     RK Phosphates Pvt Ltd           same name
 *
 * Only four of those turn up in a search for repeated display_names. Zoho
 * writes the others "GOYALPROTEINS LIMITED", "M.B SUPPLIERS(Mrinmoy Borah)"
 * and "R K Phosphates Pvt Ltd" — a space and some capitals away from the rows
 * the office had already typed in, and invisible to anything comparing names
 * as written.
 *
 * The loader no longer does this — see `contact-identity.ts`, which it and
 * `create-vendors.ts` both ask. This is for the rows already on file.
 *
 * What it does, per pair: carries any field the copy filled and the survivor
 * left blank, repoints `zoho_id_map.eggsy_id` at the survivor, and deletes the
 * copy. The copy's addresses go with it on the cascade, which is why it refuses
 * to delete one that anything else points at: nothing is moved here, so a copy
 * carrying a bill or a payment is a merge, not a repair, and needs a person.
 *
 * Pairs are found the same way the loader matches — shared GSTIN, or the same
 * name but for case, punctuation and spacing — so this and the loader cannot
 * disagree about what counts as the same party.
 *
 * Staging-only as of 14 Oct 2026: production has no duplicate contacts because
 * the catch-up was never applied there. It becomes necessary there the moment
 * that catch-up is replayed. Safe to re-run; with the duplicates gone it finds
 * nothing and writes nothing.
 */
import { and, eq, sql } from "drizzle-orm";
import { contacts, zohoIdMap } from "@shared/schema";
import { db, pool } from "../../server/db";
import { normGstin, squash } from "../contact-identity";

/** Carried from the copy onto the survivor, but only where it is blank. */
const FILLABLE = [
  "company_name", "email", "phone", "mobile", "website",
  "gstin", "pan", "place_of_supply_state", "notes",
] as const;

const UNREGISTERED = new Set(["consumer", "unregistered_business"]);
const registered = (t: string | null) => !!t && !UNREGISTERED.has(t);

/** The address and person tables hang off a contact and cascade with it. */
const CASCADES = new Set(["contact_addresses", "contact_persons"]);

interface Row {
  id: string;
  display_name: string;
  gstin: string | null;
  gst_treatment: string;
  type: string;
  created_at: string;
  mapped: number;
  [k: string]: unknown;
}

async function main() {
  const commit = process.argv.includes("--commit");

  const rows = (
    await db.execute(
      sql.raw(`
        SELECT c.id::text, c.display_name, c.gstin, c.gst_treatment, c.type,
               c.created_at::text,
               ${FILLABLE.map((f) => `c.${f}`).join(", ")},
               (SELECT count(*) FROM zoho_id_map m
                 WHERE m.entity = 'contact' AND m.eggsy_id = c.id)::int AS mapped
        FROM contacts c
        ORDER BY c.created_at
      `),
    )
  ).rows as unknown as Row[];

  // Every table that points at a contact, asked at runtime so a table added
  // later cannot quietly fall outside this check.
  const fks = (
    await db.execute(
      sql.raw(`
        SELECT tc.table_name, kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON kcu.constraint_name = tc.constraint_name
        JOIN information_schema.constraint_column_usage ccu
          ON ccu.constraint_name = tc.constraint_name
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND ccu.table_name = 'contacts' AND ccu.column_name = 'id'
        ORDER BY 1, 2
      `),
    )
  ).rows as unknown as Array<{ table_name: string; column_name: string }>;

  // Same party, by the loader's own rules.
  const buckets = new Map<string, Row[]>();
  for (const r of rows) {
    const g = normGstin(r.gstin);
    if (g) buckets.set(`gstin:${g}`, [...(buckets.get(`gstin:${g}`) ?? []), r]);
    const n = squash(r.display_name);
    if (n) buckets.set(`name:${n}`, [...(buckets.get(`name:${n}`) ?? []), r]);
  }

  // One contact can sit in both buckets; dedupe the pairs it makes.
  const pairs = new Map<string, { a: Row; b: Row; on: string }>();
  for (const [key, group] of buckets) {
    if (group.length < 2) continue;
    if (group.length > 2) {
      throw new Error(
        `${group.length} contacts share ${key} ` +
          `(${group.map((r) => `${r.display_name} [${r.id}]`).join(", ")}). ` +
          `This script repairs pairs; sort this one out by hand.`,
      );
    }
    const [a, b] = group as [Row, Row];
    pairs.set([a.id, b.id].sort().join("|"), { a, b, on: key.startsWith("gstin:") ? "GSTIN" : "name" });
  }

  console.log(`${rows.length} contacts on file, ${pairs.size} pair(s) that look like one party\n`);

  const plan: Array<{ keep: Row; drop: Row; on: string; patch: Record<string, string> }> = [];

  for (const { a, b, on } of pairs.values()) {
    const counts = new Map<string, number>();
    for (const r of [a, b]) {
      let hard = 0;
      for (const fk of fks) {
        if (CASCADES.has(fk.table_name)) continue;
        const n = (
          await db.execute(
            sql.raw(
              `SELECT count(*)::int AS n FROM ${fk.table_name} WHERE ${fk.column_name} = '${r.id}'`,
            ),
          )
        ).rows[0] as unknown as { n: number };
        hard += n.n;
      }
      counts.set(r.id, hard);
    }

    // The copy is the one nothing points at. The survivor keeps its name, its
    // documents and whatever the office has typed onto it since.
    const [drop, keep] =
      counts.get(a.id)! === 0 && counts.get(b.id)! > 0
        ? [a, b]
        : counts.get(b.id)! === 0 && counts.get(a.id)! > 0
          ? [b, a]
          : // Neither has documents: the copy is the newer row, and it must be
            // the one the load created.
            counts.get(a.id)! === 0 && counts.get(b.id)! === 0
            ? a.created_at > b.created_at
              ? [a, b]
              : [b, a]
            : [null, null];

    if (!drop || !keep) {
      console.log(
        `  SKIP  ${a.display_name} [${a.id}] and ${b.display_name} [${b.id}] (same ${on}):\n` +
          `          both carry documents (${counts.get(a.id)} and ${counts.get(b.id)} row(s)). ` +
          `Merging those is not a repair — leave it to a person.`,
      );
      continue;
    }

    if (drop.mapped === 0) {
      console.log(
        `  SKIP  ${drop.display_name} [${drop.id}] and ${keep.display_name} [${keep.id}] ` +
          `(same ${on}): neither copy came from the Zoho load, so this is not the ` +
          `duplicate this script is for.`,
      );
      continue;
    }

    const patch: Record<string, string> = {};
    for (const f of FILLABLE) {
      const theirs = drop[f] as string | null;
      const mine = keep[f] as string | null;
      if (theirs && String(theirs).trim() && !(mine && String(mine).trim())) {
        patch[f] = String(theirs).trim();
      }
    }
    // A GSTIN on a row still marked unregistered contradicts itself.
    if (patch.gstin && !registered(keep.gst_treatment) && registered(drop.gst_treatment)) {
      patch.gst_treatment = drop.gst_treatment;
    }
    // Widened, never narrowed: both halves trade with us.
    if (keep.type !== "both" && drop.type !== keep.type) patch.type = "both";

    plan.push({ keep, drop, on, patch });
  }

  if (!plan.length) {
    console.log("Nothing to repair.");
    await pool.end();
    return;
  }

  for (const { keep, drop, on, patch } of plan) {
    console.log(`  ${keep.display_name}  [${keep.id}]   — matched on ${on}`);
    console.log(`      drop  "${drop.display_name}" [${drop.id}], created ${drop.created_at.slice(0, 10)}`);
    console.log(`      ${drop.mapped} zoho_id_map row(s) repointed at the survivor`);
    for (const [k, v] of Object.entries(patch)) {
      console.log(`      ${k}: was blank, taking "${v}" from the copy`);
    }
    if (!Object.keys(patch).length) console.log(`      nothing to carry across`);
  }

  if (!commit) {
    console.log("\nDry run — nothing written. Re-run with --commit to apply.");
    await pool.end();
    return;
  }

  await db.transaction(async (tx) => {
    for (const { keep, drop, patch } of plan) {
      if (Object.keys(patch).length) {
        const sets = Object.entries(patch)
          .map(([k, v]) => `${k} = '${v.replace(/'/g, "''")}'`)
          .join(", ");
        await tx.execute(
          sql.raw(`UPDATE contacts SET ${sets}, updated_at = now() WHERE id = '${keep.id}'`),
        );
      }
      await tx
        .update(zohoIdMap)
        .set({ eggsyId: keep.id })
        .where(and(eq(zohoIdMap.entity, "contact"), eq(zohoIdMap.eggsyId, drop.id)));
      await tx.delete(contacts).where(eq(contacts.id, drop.id));
    }
  });

  console.log(`\nCommitted: ${plan.length} duplicate(s) removed, their Zoho ids repointed.`);
  await pool.end();
}

main().catch(async (err) => {
  console.error(`\n${err.message}`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
