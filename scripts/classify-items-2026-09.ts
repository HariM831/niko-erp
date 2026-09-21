/**
 * Give every item a category, fold the duplicates, retire the leftovers.
 *
 * The invoice form offers only what niko sells and the bill form only what it
 * buys (shared/item-categories: SALE_CATEGORIES, PURCHASE_CATEGORIES), which
 * works only if items say what they are. After the Zoho load 78 of 107 said
 * nothing, and the mill's own feeds were filed as raw material. The list below
 * was agreed with the user item by item on 21 Sep 2026.
 *
 * Merges: the Zoho egg sizes fold into niko's graded egg items, so a size's
 * sales read as one line across the Zoho years and niko; a keeper with no
 * sales or purchase account takes the duplicate's (niko's graded eggs had none
 * and would have posted to plain Sales instead of Eggs (Sales)). Selling prices
 * are NOT carried — eggs are priced from the daily benchmark, never a list.
 * Every reference moves: each foreign key onto items found in the catalogue at
 * run time, plus the links nothing enforces — the Zoho id map, attachments,
 * custom-field values and the flock day sheet. Each merge is one savepoint;
 * one that trips a uniqueness rule is rolled back, reported, and skipped.
 *
 * Idempotent: names already folded or already categorised are simply not found
 * or already right. Report only unless --apply.
 *
 *   npx tsx scripts/classify-items-2026-09.ts
 *   npx tsx scripts/classify-items-2026-09.ts --apply
 */
import { eq, inArray, sql } from "drizzle-orm";
import { accounts, items } from "@shared/schema";
import type { ItemCategory } from "@shared/item-categories";
import { db } from "../server/db";

const APPLY = process.argv.includes("--apply");

/** The duplicate → the item that stays. */
const MERGE: Record<string, string> = {
  "Egg's Large": "Eggs — Large",
  "Egg's Medium": "Eggs — Medium",
  "Egg's Small": "Eggs — Small",
  "Egg's Jumbo": "Eggs — Jumbo",
  "Eggs — Extra Large": "Eggs — XL",
  "Mixiblend Layer Premix (4Kg)": "Mixiblend P Layer Premix (4Kg)",
  "Egg Trays": "Egg Tray",
  "Poultry Manure": "Manure",
};

/** Early placeholders and generics, each shadowed by a real item. Kept, never offered. */
const DEACTIVATE = [
  "Marek's Disease Vaccine",
  "Newcastle Disease Vaccine",
  "Vitamin Supplement",
  "Disinfectant",
  "Bedding / Litter",
  "Vaccines",
  "Eggs (farm)",
];

const CATEGORY: Record<ItemCategory, string[]> = {
  eggs: ["Egg's (Purchases)"],
  poultry_feed: ["Poultry Feed", "Chick Feed", "Layer 1 Feed", "Layer 2 Feed", "Grower Feed", "Prelayer Feed"],
  birds: ["Layer Birds", "Layer Birds (Day Old Chicks)"],
  manure: ["Manure"],
  feed: [
    "Maize",
    "DDGS (Rice)",
    "Salt",
    "DL-Methionine",
    "L-Threonine",
    "Choline Chloride",
    "Monocalcium Phosphate",
    "Cantaxanthin",
    "Acidomix (20kg)",
    "Defusion Toxin Binder",
    "Layvit Classic Premix (5kg)",
    "Tracemin Classc CL (20kg)",
  ],
  vaccines: [
    "200ml - Diluent",
    "20ml - Diluent (Pigon)",
    "30ml - Diluent",
    "500ml - Diluent",
    "60ml - Diluent",
    "CA(L) 1000",
    "Coryza (K) 1000",
    "Fowl Pox 1000",
    "I.B. (BRO CLONE )1000",
    "IB-MA5 (1000 Doses Vaccine)",
    "IB-MA5 (5000 Doses Vaccine)",
    "IBD MB 1000 DS 20621889A",
    "Inactivated Pullet ND 2000 Does",
    "ND Bro Clone 1000",
    "ND+IB (K) 1000",
    "ND+IB (MN)",
    "NDCL 1000",
    "Nobilis IB+G+ND (500ml)",
    "R2B 100",
    "R2B 1000",
    "Triple (K) 1000",
    "VAC IB+G+ND Killed",
    "Vacc-Sure (20gm)",
  ],
  medicines: [
    "K-High (50 Grams)",
    "Pulmoxyl (500 Grams)",
    "Solucal 5ltr",
    "Solutyl - 100gms",
    "Stresvel",
    "Tiamulin 80%",
    "Vendox N - 250GM",
    "Venlyte",
    "Ventrimisole (500gms)",
  ],
  construction: [
    "Red Bricks",
    "Soling (Aggregate - Civil)",
    "TMT",
    "steel Column Boxes",
    "PVC NYLON PIPE",
    "TARPAULIN",
    "Submersible Boring and Motor",
    "Sludge Pump",
  ],
  packaging: ["Corrugated Boxes (210 Eggs)", "Corrugated Boxes (360 Eggs)", "Egg Tray", "BOPP Tape", "PP Strap", "Jute Rolls"],
  miscellaneous: ["Diesel (Fuel)", "DEF (Deisel Exhaust Fluid)", "Router"],
};

/**
 * Sales accounts for items that have none. The graded eggs niko added itself
 * came with no account, so their invoices would post to plain Sales; the
 * merged sizes take one from their Zoho twin, these two have no twin. Named
 * by the account's name, which the Zoho load brings; the code is not assumed.
 * Agreed with the user on 21 Sep 2026.
 */
const SALES_ACCOUNT: Record<string, string> = {
  "Eggs — Brown": "Eggs (Sales)",
  "Eggs — Niko": "Eggs (Sales)",
};

/** Links to an item that no foreign key enforces. */
const LOOSE: Array<{ table: string; column: string; where?: string }> = [
  { table: "flock_day", column: "item_id" },
  { table: "zoho_id_map", column: "eggsy_id", where: "entity = 'item'" },
  { table: "attachments", column: "entity_id", where: "entity_type = 'item'" },
  { table: "custom_field_values", column: "entity_id" },
  { table: "custom_field_values", column: "value_lookup_id" },
  { table: "custom_field_value_lookups", column: "lookup_id" },
];

const say = (m = "") => console.log(m);

async function main() {
  say(`\n  Classifying items — ${APPLY ? "APPLYING" : "report only"}\n`);
  const all = await db.select().from(items);
  const byName = new Map(all.map((i) => [i.name, i]));
  const missing: string[] = [];
  const find = (name: string) => {
    const it = byName.get(name);
    if (!it) missing.push(name);
    return it;
  };

  // Every foreign key onto items.id, read from the catalogue so a table added
  // later is not silently left pointing at a deleted item.
  const fks = (
    await db.execute<{ table_name: string; column_name: string }>(sql`
      SELECT DISTINCT tc.table_name, kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY' AND ccu.table_name = 'items' AND ccu.column_name = 'id'
      ORDER BY 1, 2`)
  ).rows.map((r) => ({ table: r.table_name, column: r.column_name }));
  const refs: Array<{ table: string; column: string; where?: string }> = [...fks, ...LOOSE];

  const count = async (t: { table: string; column: string; where?: string }, id: string) => {
    const r = await db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM ${sql.identifier(t.table)} WHERE ${sql.identifier(t.column)} = ${id}${
        t.where ? sql.raw(` AND ${t.where}`) : sql``
      }`,
    );
    return r.rows[0]?.n ?? 0;
  };

  // ── 1. Merges ──
  say("  1. Merge duplicates");
  const merges: Array<{ dupe: (typeof all)[number]; keep: (typeof all)[number]; moves: Array<{ t: (typeof refs)[number]; n: number }> }> = [];
  for (const [dupeName, keepName] of Object.entries(MERGE)) {
    const dupe = byName.get(dupeName);
    const keep = find(keepName);
    if (!dupe) {
      say(`     = ${dupeName}: already gone`);
      continue;
    }
    if (!keep) continue;
    const moves = [];
    for (const t of refs) {
      const n = await count(t, dupe.id);
      if (n) moves.push({ t, n });
    }
    merges.push({ dupe, keep, moves });
    const fill = [
      !keep.salesAccountId && dupe.salesAccountId ? "sales account" : null,
      !keep.purchaseAccountId && dupe.purchaseAccountId ? "purchase account" : null,
    ].filter(Boolean);
    say(
      `     ${dupeName} → ${keepName}: ${moves.map((m) => `${m.t.table}.${m.t.column} ${m.n}`).join(", ") || "nothing refers to it"}${
        fill.length ? `; keeper takes its ${fill.join(" and ")}` : ""
      }`,
    );
  }

  // ── 2. Categories ──
  say("\n  2. Categories");
  const recat: Array<{ id: string; name: string; from: string | null; to: ItemCategory }> = [];
  for (const [category, names] of Object.entries(CATEGORY) as Array<[ItemCategory, string[]]>) {
    for (const name of names) {
      const it = find(name);
      if (it && it.category !== category) recat.push({ id: it.id, name, from: it.category, to: category });
    }
  }
  const byTo = new Map<string, string[]>();
  for (const r of recat) byTo.set(r.to, [...(byTo.get(r.to) ?? []), r.from ? `${r.name} (was ${r.from})` : r.name]);
  for (const [to, names] of byTo) say(`     ${to} ← ${names.length}: ${names.join(", ")}`);
  if (!recat.length) say("     nothing to change");

  // ── 2b. Sales accounts ──
  say("\n  2b. Sales accounts");
  const accts = await db.select({ id: accounts.id, name: accounts.name, code: accounts.code }).from(accounts);
  const setSales: Array<{ id: string; name: string; accountId: string }> = [];
  for (const [itemName, acctName] of Object.entries(SALES_ACCOUNT)) {
    const it = find(itemName);
    const acct = accts.filter((a) => a.name === acctName);
    if (!it) continue;
    if (acct.length !== 1) {
      say(`     ! ${itemName}: ${acct.length ? "several accounts" : "no account"} named "${acctName}" — skipped`);
      continue;
    }
    if (it.salesAccountId) continue;
    setSales.push({ id: it.id, name: itemName, accountId: acct[0]!.id });
    say(`     ${itemName} → ${acct[0]!.code} ${acctName}`);
  }
  if (!setSales.length) say("     nothing to change");

  // ── 3. Deactivate ──
  say("\n  3. Deactivate");
  const retire = DEACTIVATE.map((n) => byName.get(n)).filter((i): i is (typeof all)[number] => !!i && i.isActive);
  say(`     ${retire.map((i) => i.name).join(", ") || "nothing — already inactive or gone"}`);

  // What is left without a category once all of the above is done.
  const merging = new Set(merges.map((m) => m.dupe.id));
  const gettingOne = new Set(recat.map((r) => r.id));
  const left = all.filter((i) => !i.category && !merging.has(i.id) && !gettingOne.has(i.id));
  say(`\n  Still uncategorised after this: ${left.length}${left.length ? ` — ${left.map((i) => i.name).join(", ")}` : ""}`);
  if (missing.length) say(`\n  ! Not found by name (skipped): ${missing.join(", ")}`);

  if (!APPLY) {
    say("\n  Report only. Run with --apply to write.\n");
    return;
  }

  let merged = 0;
  const failed: string[] = [];
  await db.transaction(async (tx) => {
    for (const m of merges) {
      try {
        await tx.transaction(async (sp) => {
          for (const { t } of m.moves) {
            await sp.execute(
              sql`UPDATE ${sql.identifier(t.table)} SET ${sql.identifier(t.column)} = ${m.keep.id}
                  WHERE ${sql.identifier(t.column)} = ${m.dupe.id}${t.where ? sql.raw(` AND ${t.where}`) : sql``}`,
            );
          }
          const patch: Partial<typeof items.$inferInsert> = {};
          if (!m.keep.salesAccountId && m.dupe.salesAccountId) patch.salesAccountId = m.dupe.salesAccountId;
          if (!m.keep.purchaseAccountId && m.dupe.purchaseAccountId) patch.purchaseAccountId = m.dupe.purchaseAccountId;
          if (Object.keys(patch).length) await sp.update(items).set(patch).where(eq(items.id, m.keep.id));
          await sp.delete(items).where(eq(items.id, m.dupe.id));
        });
        merged++;
      } catch (e) {
        failed.push(`${m.dupe.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    for (const r of recat) await tx.update(items).set({ category: r.to }).where(eq(items.id, r.id));
    for (const s of setSales) await tx.update(items).set({ salesAccountId: s.accountId }).where(eq(items.id, s.id));
    if (retire.length) await tx.update(items).set({ isActive: false }).where(inArray(items.id, retire.map((i) => i.id)));
  });
  say(`\n  Merged ${merged}, recategorised ${recat.length}, sales accounts set ${setSales.length}, deactivated ${retire.length}.`);
  for (const f of failed) say(`  ! merge skipped — ${f}`);
  say();
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
