/**
 * Phase 3: items, wired to the accounts already imported.
 *
 *   npx tsx scripts/zoho/load-items.ts             # say what would happen
 *   npx tsx scripts/zoho/load-items.ts --commit    # do it
 *
 * The accounts matter more than the item itself. Every invoice and bill line
 * resolves its posting account from the line's own override or, failing that,
 * the item's default — so an item whose sales or purchase account is wrong
 * quietly misposts every document that names it. Those defaults are resolved
 * here through zoho_id_map rather than by name.
 */
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { items, zohoIdMap } from "@shared/schema";
import { db, pool } from "../../server/db";

interface ZohoItem {
  item_id: string;
  name: string;
  description?: string;
  status: string;
  /** "sales", "purchases" or "inventory" — what the item is used for. */
  item_type?: string;
  /** "goods" or "service". */
  product_type?: string;
  unit?: string;
  hsn_or_sac?: string;
  sku?: string;
  rate?: number;
  purchase_rate?: number;
  account_id?: string;
  purchase_account_id?: string;
  inventory_account_id?: string;
  track_inventory?: boolean;
}

async function main() {
  const commit = process.argv.includes("--commit");
  const raw = await readFile(".zoho-dump/detail/items.jsonl", "utf8");
  const all: ZohoItem[] = raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

  const accountRows = await db
    .select({ zohoId: zohoIdMap.zohoId, eggsyId: zohoIdMap.eggsyId })
    .from(zohoIdMap)
    .where(eq(zohoIdMap.entity, "account"));
  const accountFor = new Map(accountRows.map((r) => [r.zohoId, r.eggsyId]));
  if (!accountFor.size) {
    throw new Error("No accounts imported yet — run load-accounts.ts --commit first.");
  }

  const done = await db
    .select({ zohoId: zohoIdMap.zohoId })
    .from(zohoIdMap)
    .where(eq(zohoIdMap.entity, "item"));
  const already = new Set(done.map((d) => d.zohoId));
  const todo = all.filter((i) => !already.has(i.item_id));

  // An account named on an item but missing from the map would silently become
  // null, leaving the item to fall back to the `sales` catch-all on every
  // document. Better to refuse than to mispost quietly.
  const dangling = all.flatMap((i) =>
    [i.account_id, i.purchase_account_id, i.inventory_account_id]
      .filter((id): id is string => !!id && !accountFor.has(id))
      .map((id) => `${i.name} -> ${id}`),
  );
  if (dangling.length) {
    throw new Error(`Items name accounts that were not imported:\n  ${dangling.join("\n  ")}`);
  }

  console.log(`${all.length} items — ${todo.length} to import, ${already.size} already done`);
  console.log(`  ${all.filter((i) => i.account_id).length} have a sales account`);
  console.log(`  ${all.filter((i) => i.purchase_account_id).length} have a purchase account`);
  console.log(`  ${all.filter((i) => i.track_inventory).length} track inventory`);
  console.log(`  ${all.filter((i) => !i.unit?.trim()).length} have no unit and will default to "pcs"`);

  if (!commit) {
    console.log("\nSample:");
    for (const i of todo.slice(0, 8)) {
      console.log(
        `  ${i.name.slice(0, 38).padEnd(40)} ${(i.item_type ?? "-").padEnd(10)} ` +
          `sell ${i.rate ?? 0}  cost ${i.purchase_rate ?? 0}`,
      );
    }
    console.log("\nDry run — nothing written. Re-run with --commit to apply.");
    await pool.end();
    return;
  }

  await db.transaction(async (tx) => {
    for (const i of todo) {
      // Zoho's item_type says what the item is for. An "inventory" item is both
      // bought and sold; the other two are one-way.
      const kind = i.item_type ?? "sales";
      const [row] = await tx
        .insert(items)
        .values({
          type: (i.product_type === "service" ? "service" : "goods") as typeof items.$inferInsert.type,
          name: i.name.trim(),
          sku: i.sku?.trim() || null,
          unit: i.unit?.trim().slice(0, 20) || "pcs",
          hsnOrSac: i.hsn_or_sac?.trim().slice(0, 10) || null,
          description: i.description?.trim() || null,
          isSold: kind === "sales" || kind === "inventory",
          sellingPrice: i.rate != null ? String(i.rate) : null,
          salesAccountId: i.account_id ? (accountFor.get(i.account_id) ?? null) : null,
          isPurchased: kind === "purchases" || kind === "inventory",
          costPrice: i.purchase_rate != null ? String(i.purchase_rate) : null,
          purchaseAccountId: i.purchase_account_id
            ? (accountFor.get(i.purchase_account_id) ?? null)
            : null,
          trackInventory: Boolean(i.track_inventory),
          inventoryAccountId: i.inventory_account_id
            ? (accountFor.get(i.inventory_account_id) ?? null)
            : null,
          // No tax: niko folds GST into the amount, so an item carries no rate.
          taxId: null,
          isActive: i.status === "active",
        })
        .returning({ id: items.id });

      await tx.insert(zohoIdMap).values({
        entity: "item",
        zohoId: i.item_id,
        eggsyId: row!.id,
        label: i.name,
      });
    }
  });

  console.log(`\nCommitted ${todo.length} items.`);
  await pool.end();
}

main().catch(async (err) => {
  console.error(`\n${err.message}`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
