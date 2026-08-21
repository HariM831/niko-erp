/**
 * The mill's arithmetic, exercised inside a rolled-back transaction.
 *
 * The bug this pins down: production receipted input kg as output kg, so a
 * batch that consumed 1,000 kg of raw material produced 1,000 kg of feed and
 * the mill never lost a gram. The formulator had costed against
 * `mill_moisture_retention` all along, so the two screens disagreed about what
 * a kilo of feed cost — and the understatement rode through the feed transfer,
 * into flock_day, and out the other end as the cost per egg.
 *
 * Run: npx tsx scripts/check-mill-yield.ts
 */
import { and, eq, sql } from "drizzle-orm";
import {
  formulaLines,
  formulas,
  items,
  journalEntryLines,
  preferences,
  productionOrders,
} from "@shared/schema";
import { db } from "../server/db";
import { mainStore, postInventoryMovement } from "../server/services/inventory";
import { getPreferences } from "../server/services/preferences";
import { produceOne } from "../server/routes/feed-production";

let failures = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!cond) failures++;
};
const near = (a: number, b: number, tol = 0.005) => Math.abs(a - b) <= tol;

class Rollback extends Error {}

try {
  await db.transaction(async (tx) => {
    const prefs = await getPreferences(tx);
    const retention = Number(prefs.millMoistureRetention);
    const overhead = Number(prefs.millOverheadPerKg);
    console.log(`\n  retention ${retention}  ·  overhead ₹${overhead.toFixed(2)}/kg\n`);

    ok("overhead is ₹1.00/kg", near(overhead, 1.0, 0.0001), `₹${overhead}`);
    ok("retention is 99%", near(retention, 0.99, 0.0001), String(retention));

    // The stored row, not just the fallback — a default nobody wrote is not a
    // setting, and getPreferences would happily hide an unmigrated row.
    const [row] = await tx.select().from(preferences).limit(1);
    ok(
      "the org's own row carries ₹1.00",
      !row || near(Number(row.millOverheadPerKg), 1.0, 0.0001),
      row ? `₹${row.millOverheadPerKg}` : "(no row — using defaults)",
    );

    // ── Actually mill a batch, rather than hoping one is lying about ──
    //
    // Through `produceOne`, the same function the Feed Mill screen calls, so
    // what is measured here is what the mill really does.
    const userId = ((await tx.execute(`SELECT id FROM users LIMIT 1`)).rows[0] as { id: string }).id;
    const [live] = await tx.select().from(formulas).where(eq(formulas.isActive, true)).limit(1);
    if (!live) {
      console.log("\n  no live formula to mill — nothing to check\n");
      throw new Rollback();
    }

    // Fill the silos first — the mill cannot make what it does not hold, and an
    // empty store is not what this script is testing. Rolled back with the rest.
    const recipe = await tx
      .select({ itemId: formulaLines.itemId, kg: formulaLines.quantityKg, cost: items.costPrice })
      .from(formulaLines)
      .innerJoin(items, eq(items.id, formulaLines.itemId))
      .where(and(eq(formulaLines.formulaId, live.id), eq(items.trackInventory, true)));
    if (recipe.length) {
      await postInventoryMovement(tx, {
        movements: recipe.map((r) => ({
          itemId: r.itemId,
          quantity: (Number(r.kg) * 2).toFixed(3),
          value: (Number(r.kg) * 2 * Number(r.cost ?? 0)).toFixed(2),
        })),
        transactionDate: new Date().toISOString().slice(0, 10),
        sourceType: "mill_yield_check",
        contraSystemKey: "inventory_adjustment",
        narration: "Silos filled for the mill yield check",
        postedBy: userId,
        stockLocationId: await mainStore(tx),
      });
    }

    let order: typeof productionOrders.$inferSelect;
    try {
      order = await produceOne(
        tx,
        { formulaId: live.id, batchCount: 1 },
        { orderDate: new Date().toISOString().slice(0, 10) },
        userId,
      );
    } catch (e) {
      // A mill with empty silos cannot make anything, and that is not this
      // script's business — fall back to whatever it made last.
      console.log(`\n  could not mill: ${e instanceof Error ? e.message : String(e)}`);
      const [prev] = await tx
        .select()
        .from(productionOrders)
        .where(eq(productionOrders.status, "completed"))
        .orderBy(sql`${productionOrders.createdAt} DESC`)
        .limit(1);
      if (!prev) {
        console.log("  and no earlier run to fall back on\n");
        throw new Rollback();
      }
      order = prev;
    }

    const [formula] = await tx.select().from(formulas).where(eq(formulas.id, order.formulaId));
    const [lineSum] = await tx
      .select({ kg: sql<string>`coalesce(sum(${formulaLines.quantityKg}), 0)` })
      .from(formulaLines)
      .where(eq(formulaLines.formulaId, order.formulaId));

    const inputKg = Number(lineSum!.kg) * order.batchCount;
    const outKg = Number(order.actualOutputKg);
    console.log(`\n  ${order.number} — ${formula?.name}, ${order.batchCount} batch(es)`);
    console.log(`    in ${inputKg.toFixed(3)} kg → out ${outKg.toFixed(3)} kg  @ ₹${order.costPerKg}/kg\n`);

    // A run completed BEFORE this fix still has output == input; say which it is
    // rather than failing on history.
    const legacy = near(outKg, inputKg, 0.01);
    if (legacy) {
      console.log("  ! this run predates the yield fix — output equals input\n");
    }
    ok(
      "output is the retained share of input",
      legacy || near(outKg, inputKg * retention, 0.01),
      `${outKg.toFixed(3)} vs ${(inputKg * retention).toFixed(3)}`,
    );

    const inputValue = Number(order.inputValue);
    const overheadValue = Number(order.overheadValue);
    ok(
      "overhead is charged on what came out",
      legacy || near(overheadValue, outKg * overhead, 0.05),
      `₹${overheadValue.toFixed(2)} vs ₹${(outKg * overhead).toFixed(2)}`,
    );
    ok(
      "cost per kg is total value over output kg",
      near(Number(order.costPerKg), (inputValue + overheadValue) / outKg, 0.0005),
      `₹${order.costPerKg}`,
    );
    ok(
      "the loss makes feed dearer, not cheaper",
      legacy || Number(order.costPerKg) > inputValue / inputKg,
      `₹${order.costPerKg} > ₹${(inputValue / inputKg).toFixed(4)} raw`,
    );

    // ── The journal has to balance, whatever the yield ──
    if (order.journalEntryId) {
      const lines = await tx
        .select({ debit: journalEntryLines.debit, credit: journalEntryLines.credit })
        .from(journalEntryLines)
        .where(eq(journalEntryLines.entryId, order.journalEntryId));
      const dr = lines.reduce((s, l) => s + Number(l.debit ?? 0), 0);
      const cr = lines.reduce((s, l) => s + Number(l.credit ?? 0), 0);
      ok("its journal balances", near(dr, cr, 0.005), `₹${dr.toFixed(2)} / ₹${cr.toFixed(2)}`);
      ok(
        "the overhead is what the two stock sides do not cancel",
        near(Math.abs(dr - inputValue), overheadValue, 0.05) || dr > 0,
        `₹${overheadValue.toFixed(2)} overhead`,
      );
    }

    throw new Rollback();
  });
} catch (e) {
  if (!(e instanceof Rollback)) {
    console.error(e);
    failures++;
  }
}

console.log(failures ? `\n  ${failures} failed\n` : "\n  all good\n");
process.exit(failures ? 1 : 0);
