/**
 * Restart egg stock from a physical count (7 Oct 2026).
 *
 * From 28 Sep the trucks were not loaded in niko, so each evening count was
 * posted as an "Egg count" adjustment that carried the missing sales away as
 * losses — eight of them, −14,918 boxes, some out of date order. Counts no
 * longer post anything; this clears what they did and starts again:
 *
 *   1. delete every "Egg count …" adjustment and the stock it moved
 *      (quantity only, no journal — refused if one ever has a journal);
 *   2. post one adjustment bringing the ledger to the given day's count,
 *      "Egg stock opening from the <day> count";
 *   3. set stock_from to the day after, so the statement calculates from there
 *      and a backdated truck before it moves no stock.
 *
 * Dry run by default — everything runs and is printed, then rolled back.
 *
 * Run: npx tsx scripts/egg-stock-restart.ts --day 2026-10-06 [--apply]
 */
import { and, eq, inArray, like } from "drizzle-orm";
import {
  eggSalesPreferences,
  eggStockCount,
  inventoryAdjustmentLines,
  inventoryAdjustments,
  inventoryTransactions,
  users,
} from "@shared/schema";
import { EGG_SIZES, EGG_SIZE_LABEL } from "@shared/egg-sizes";
import { db } from "../server/db";
import { settleCountAgainstLedger, stockBySize } from "../server/services/egg-sales";

const arg = (k: string) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const day = arg("--day");
const apply = process.argv.includes("--apply");
if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
  console.error("Usage: npx tsx scripts/egg-stock-restart.ts --day YYYY-MM-DD [--apply]");
  process.exit(1);
}
const [y, m, d] = day.split("-").map(Number);
const next = new Date(Date.UTC(y!, m! - 1, d! + 1)).toISOString().slice(0, 10); // pure date arithmetic, UTC both ways

class DryRun extends Error {}

const line = (rec: Record<string, number>) =>
  EGG_SIZES.filter((s) => rec[s]).map((s) => `${EGG_SIZE_LABEL[s]} ${rec[s]}`).join(", ") || "nothing";

async function main() {
  const [admin] = await db.select({ id: users.id }).from(users).where(eq(users.username, "admin")).limit(1);
  const [anyUser] = admin ? [admin] : await db.select({ id: users.id }).from(users).limit(1);

  try {
    await db.transaction(async (tx) => {
      const [count] = await tx.select().from(eggStockCount).where(eq(eggStockCount.countedOn, day));
      if (!count) throw new Error(`No physical count saved for ${day}`);
      console.log(`Count on ${day}: ${line(count as unknown as Record<string, number>)}`);
      console.log(`Stock now:      ${line(await stockBySize(tx))}`);

      const adjs = await tx
        .select()
        .from(inventoryAdjustments)
        .where(like(inventoryAdjustments.reason, "Egg count %"))
        .orderBy(inventoryAdjustments.adjustmentDate);
      for (const a of adjs) {
        if (a.journalEntryId) throw new Error(`${a.number} has a journal entry — not touching it`);
        console.log(`  delete ${a.number} ${a.adjustmentDate}: ${a.description}`);
      }
      const ids = adjs.map((a) => a.id);
      if (ids.length) {
        const gone = await tx
          .delete(inventoryTransactions)
          .where(and(eq(inventoryTransactions.sourceType, "inventory_adjustment"), inArray(inventoryTransactions.sourceId, ids)))
          .returning({ id: inventoryTransactions.id });
        await tx.delete(inventoryAdjustmentLines).where(inArray(inventoryAdjustmentLines.adjustmentId, ids));
        await tx.delete(inventoryAdjustments).where(inArray(inventoryAdjustments.id, ids));
        console.log(`Deleted ${ids.length} adjustments and ${gone.length} stock movements.`);
      }
      console.log(`Stock without them: ${line(await stockBySize(tx))}`);

      const out = await settleCountAgainstLedger(tx, day, anyUser!.id, `Egg stock opening from the ${day} count`);
      console.log(`Opening adjustment ${out.adjustmentNumber ?? "(none needed)"}: ${line(out.variance)}`);

      await tx.update(eggSalesPreferences).set({ stockFrom: next });
      console.log(`stock_from set to ${next}`);
      console.log(`Stock after:    ${line(await stockBySize(tx))}`);

      if (!apply) throw new DryRun();
    });
    console.log("\nApplied.");
  } catch (err) {
    if (err instanceof DryRun) console.log("\nDry run — rolled back. Add --apply to keep it.");
    else throw err;
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
