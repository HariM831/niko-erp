/**
 * Recost the mill's Mixiblend takes from 14 Oct 2026, and the feed they made.
 *
 *   npx tsx scripts/fix-mixiblend-recost.ts
 *   npx tsx scripts/fix-mixiblend-recost.ts --commit
 *
 * Mixiblend was counted in 4 kg packets, and BILL-002232 (keyed 14 Oct) put
 * its 1,250 packets in as 5,000. The average cost fell from ₹679 a packet to
 * about ₹171, and every batch milled after that took premix at a quarter of
 * its price. On 24 Oct the item's stock was restated in kg (×4, values kept),
 * so the rows now read 5,000 kg at ₹169.75 — right — while the takes still
 * carry the low values (₹42.75/kg, then ₹67.94/kg after GR-00074).
 *
 * The replay walks the rows in the order they were written, as the mill saw
 * them, and prices each later take at the running average the corrected rows
 * give:
 *
 *   premix    each take after BILL-002232 at that average; the batch's
 *             Mixiblend line, input value and cost per kg follow, and its
 *             feed comes into stock worth the difference more. Premix and
 *             feed share Feed Stock (1073), so the batch journals (overhead
 *             only) do not move.
 *   feed      each transfer of that feed sent after the first recosted batch
 *             is repriced at the feed's running average. Its journal (DR 5007
 *             Feed & Additives / CR 1073) is reversed and re-posted on the
 *             transfer date, the way an edited bill restates, so a later void
 *             still takes back exactly what the transfer says.
 *   houses    every house that took one is refreshed, so flock feed cost and
 *             the owner billing draft read the new values.
 *
 * Dry run by default: everything happens and is rolled back.
 */
import { and, eq, sql } from "drizzle-orm";
import { feedTransfers, inventoryTransactions, journalEntryLines, productionOrderLines, productionOrders, users } from "@shared/schema";
import { db, pool } from "../server/db";
import { postJournal, reverseJournal } from "../server/services/posting";
import { refreshHouse } from "../server/services/rollup";

const COMMIT = process.argv.includes("--commit");
const AS = process.argv.find((a) => a.startsWith("--as="))?.slice(5) ?? "admin";
const ITEM = "Mixiblend P Layer Premix (4Kg)";
const BILL = "BILL-002232";
const money = (p: number) => (p / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const paise = (n: number | string) => Math.round(Number(n) * 100);

class Rollback extends Error {}

type Row = { id: string; source_type: string; source_id: string | null; q: number; v: number };

async function rowsOf(tx: typeof db, itemId: string): Promise<Row[]> {
  return (
    await tx.execute(sql`
      SELECT id::text, source_type, source_id::text, quantity::float8 AS q, value::float8 AS v
        FROM inventory_transactions WHERE item_id = ${itemId}::uuid
       ORDER BY created_at, id`)
  ).rows as Row[];
}

async function main() {
  const [actor] = await db.select({ id: users.id }).from(users).where(eq(users.username, AS));
  if (!actor) throw new Error(`No user "${AS}"`);

  try {
    await db.transaction(async (tx) => {
      const [item] = (await tx.execute(sql`SELECT id::text, unit FROM items WHERE name = ${ITEM}`)).rows as Array<{ id: string; unit: string }>;
      if (!item || item.unit !== "kg") throw new Error(`${ITEM} is missing or not in kg — restate its stock first`);
      const [bill] = (await tx.execute(sql`SELECT id::text FROM bills WHERE number = ${BILL}`)).rows as Array<{ id: string }>;

      /* ── Premix ─────────────────────────────────────────────────────────── */
      const extra = new Map<string, number>(); // production order → paise more input
      let q = 0;
      let vP = 0;
      let after = false;
      for (const r of await rowsOf(tx as never, item.id)) {
        if (after && r.source_type === "feed_mill" && r.q < 0) {
          const rate = vP / 100 / q;
          const newP = Math.round(r.q * rate * 100);
          const d = newP - paise(r.v); // negative: more value out of premix
          if (d !== 0) {
            await tx.update(inventoryTransactions).set({ value: (newP / 100).toFixed(2) }).where(eq(inventoryTransactions.id, r.id));
            extra.set(r.source_id!, (extra.get(r.source_id!) ?? 0) - d);
          }
          q += r.q;
          vP += newP;
          continue;
        }
        if (r.source_type === "bill" && r.source_id === bill?.id) after = true;
        q += r.q;
        vP += paise(r.v);
      }

      console.log(`\nPREMIX — ${extra.size} batches recosted\n`);
      const firstFeedRow = new Map<string, string>(); // feed item → first recosted output row id
      let premixP = 0;
      for (const [orderId, addP] of extra) {
        const [o] = await tx.select().from(productionOrders).where(eq(productionOrders.id, orderId));
        const [line] = await tx
          .select()
          .from(productionOrderLines)
          .where(and(eq(productionOrderLines.orderId, orderId), eq(productionOrderLines.itemId, item.id)));
        const lineP = paise(line!.value!) + addP;
        await tx
          .update(productionOrderLines)
          .set({ value: (lineP / 100).toFixed(2), ratePerKg: (lineP / 100 / Number(line!.actualKg)).toFixed(6) })
          .where(eq(productionOrderLines.id, line!.id));
        const inputP = paise(o!.inputValue!) + addP;
        const totalP = inputP + paise(o!.overheadValue ?? 0);
        const oldCost = Number(o!.costPerKg);
        const newCost = totalP / 100 / Number(o!.actualOutputKg);
        await tx
          .update(productionOrders)
          .set({ inputValue: (inputP / 100).toFixed(2), costPerKg: newCost.toFixed(6) })
          .where(eq(productionOrders.id, orderId));
        const [out] = (await tx.execute(sql`
          SELECT it.id::text, it.item_id::text, it.value::float8 AS v FROM inventory_transactions it
           WHERE it.source_type = 'feed_mill' AND it.source_id = ${orderId}::uuid AND it.quantity > 0`)).rows as Array<{ id: string; item_id: string; v: number }>;
        await tx.update(inventoryTransactions).set({ value: ((paise(out!.v) + addP) / 100).toFixed(2) }).where(eq(inventoryTransactions.id, out!.id));
        if (!firstFeedRow.has(out!.item_id)) firstFeedRow.set(out!.item_id, out!.id);
        premixP += addP;
        console.log(
          `  ${o!.number}  ${o!.orderDate}  premix ₹${money(paise(line!.value!))} → ₹${money(lineP)}   ` +
            `feed ₹${oldCost.toFixed(4)} → ₹${newCost.toFixed(4)}/kg`,
        );
      }
      console.log(`  premix charged to feed: +₹${money(premixP)}`);

      /* ── Feed transfers ─────────────────────────────────────────────────── */
      const houses = new Set<string>();
      let feedP = 0;
      for (const [feedId, startId] of firstFeedRow) {
        const [{ name }] = (await tx.execute(sql`SELECT name FROM items WHERE id = ${feedId}::uuid`)).rows as Array<{ name: string }>;
        console.log(`\n${name.toUpperCase()}`);
        let fq = 0;
        let fvP = 0;
        let on = false;
        let itemP = 0;
        for (const r of await rowsOf(tx as never, feedId)) {
          if (r.id === startId) on = true;
          if (on && r.source_type === "feed_transfer") {
            const rate = fq > 0 ? fvP / 100 / fq : 0;
            const newP = Math.round(-r.q * rate * 100); // as the transfer prices it
            const oldP = -paise(r.v);
            if (newP !== oldP) {
              const [t] = await tx.select().from(feedTransfers).where(eq(feedTransfers.id, r.source_id!));
              await tx.update(inventoryTransactions).set({ value: (-newP / 100).toFixed(2) }).where(eq(inventoryTransactions.id, r.id));
              await tx
                .update(feedTransfers)
                .set({ ratePerKg: rate.toFixed(6), value: (newP / 100).toFixed(2) })
                .where(eq(feedTransfers.id, t!.id));
              if (t!.status !== "void" && t!.journalEntryId) {
                const old = await tx.select().from(journalEntryLines).where(eq(journalEntryLines.entryId, t!.journalEntryId));
                if (old.length !== 2) throw new Error(`${t!.number}'s journal has ${old.length} lines, expected 2`);
                await reverseJournal(tx, t!.journalEntryId, t!.transferDate, actor.id);
                const [je] = (await tx.execute(sql`SELECT narration FROM journal_entries WHERE id = ${t!.journalEntryId}::uuid`)).rows as Array<{ narration: string }>;
                const jeId = await postJournal(tx, {
                  entryDate: t!.transferDate,
                  narration: `${je!.narration} (recosted: Mixiblend premix)`,
                  sourceType: "feed_transfer",
                  sourceId: t!.id,
                  postedBy: actor.id,
                  lines: old.map((l) =>
                    Number(l.debit) > 0
                      ? { accountId: l.accountId, debit: (newP / 100).toFixed(2), description: l.description ?? undefined }
                      : { accountId: l.accountId, credit: (newP / 100).toFixed(2), description: l.description ?? undefined },
                  ),
                });
                await tx.update(feedTransfers).set({ journalEntryId: jeId }).where(eq(feedTransfers.id, t!.id));
              }
              if (t!.toHouseId) houses.add(t!.toHouseId);
              itemP += newP - oldP;
              console.log(
                `  ${t!.number}  ${t!.transferDate}  ${Number(t!.quantityKg).toLocaleString("en-IN")} kg  ` +
                  `₹${Number(t!.ratePerKg).toFixed(4)} → ₹${rate.toFixed(4)}/kg   ₹${money(oldP)} → ₹${money(newP)}`,
              );
            }
            fq += r.q;
            fvP -= newP;
            continue;
          }
          fq += r.q;
          fvP += paise(r.v);
        }
        feedP += itemP;
        console.log(`  more charged to the sheds: +₹${money(itemP)}`);
      }

      for (const h of houses) await refreshHouse(tx, h);
      console.log(`\nTOTAL  premix into feed +₹${money(premixP)}, feed sent to sheds +₹${money(feedP)}, still in feed stock +₹${money(premixP - feedP)}`);
      console.log(`${houses.size} houses refreshed`);

      if (!COMMIT) throw new Rollback();
    });
    console.log("\nCommitted.");
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
    console.log("\nDry run — rolled back. Pass --commit to apply.");
  }
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  await pool.end();
  process.exit(1);
});
