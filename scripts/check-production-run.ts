/**
 * A production run carrying several formulas.
 *
 * A morning at the mill is one act — one operator, one shift, one decision —
 * but it is several recipes. The screen submits them together and they post as
 * one ORDER EACH, because a formula has its own output item, its own
 * ingredients and its own cost per kilo; merging them would make the cost of
 * layer mash depend on how much chick mash was made beside it.
 *
 * The thing worth testing is the atomicity. If any formula in a run cannot be
 * produced, none of them may be — a half-posted run puts feed into stock that
 * the ledger does not know it paid for.
 *
 * Rolled back; nothing survives.
 *
 * Run: npx tsx scripts/check-production-run.ts
 */
import { eq, sql } from "drizzle-orm";
import { formulaLines, formulas, items, productionOrders } from "@shared/schema";
import { db } from "../server/db";
import { produceOne } from "../server/routes/feed-production";

let failed = 0;
const check = (name: string, pass: boolean, detail = "") => {
  if (!pass) failed++;
  console.log(`    ${pass ? "PASS" : "FAIL"}  ${name.padEnd(54)} ${detail}`);
};

class Rollback extends Error {}

const kg = (v: number) => `${v.toLocaleString("en-IN")} kg`;

try {
  await db.transaction(async (tx) => {
    const [acct] = (
      await tx.execute(sql`SELECT id FROM accounts WHERE type = 'expense' LIMIT 1`)
    ).rows as Array<{ id: string }>;
    const [user] = (await tx.execute(sql`SELECT id FROM users LIMIT 1`)).rows as Array<{ id: string }>;
    const [loc] = (await tx.execute(sql`SELECT id FROM locations LIMIT 1`)).rows as Array<{ id: string }>;

    /** A priced material, and one deliberately left unpriced. */
    const mk = async (name: string, cost: string | null) => {
      const [it] = await tx
        .insert(items)
        .values({
          name,
          unit: "kg",
          isSold: false,
          purchaseAccountId: acct!.id,
          category: "feed",
          isFeedIngredient: true,
          costPrice: cost,
        })
        .returning();
      return it!;
    };
    const maize = await mk("TEST RUN MAIZE", "21.50");
    const soya = await mk("TEST RUN SOYA", "54.00");
    const mystery = await mk("TEST RUN UNPRICED", null);

    const [stockAcct] = (
      await tx.execute(sql`SELECT id FROM accounts WHERE code = '1073' LIMIT 1`)
    ).rows as Array<{ id: string }>;
    const output = async (name: string) => {
      const [it] = await tx
        .insert(items)
        .values({
          name,
          unit: "kg",
          isSold: false,
          trackInventory: true,
          category: "feed",
          // Finished feed capitalises into Feed Stock, same as the real outputs.
          inventoryAccountId: stockAcct!.id,
        })
        .returning();
      return it!;
    };

    const formula = async (name: string, outId: string, lines: Array<[string, string]>) => {
      const [f] = await tx
        .insert(formulas)
        .values({
          name,
          version: 1,
          outputItemId: outId,
          batchSizeKg: "1000",
          effectiveFrom: "2026-01-01",
          isActive: true,
          createdBy: user!.id,
        })
        .returning();
      await tx.insert(formulaLines).values(
        lines.map(([itemId, qty], i) => ({ formulaId: f!.id, itemId, quantityKg: qty, sortOrder: i })),
      );
      return f!;
    };

    const chick = await formula("TEST RUN CHICK", (await output("TEST RUN CHICK FEED")).id, [
      [maize.id, "700"],
      [soya.id, "300"],
    ]);
    const layer = await formula("TEST RUN LAYER", (await output("TEST RUN LAYER FEED")).id, [
      [maize.id, "850"],
      [soya.id, "150"],
    ]);
    const broken = await formula("TEST RUN BROKEN", (await output("TEST RUN BROKEN FEED")).id, [
      [maize.id, "900"],
      [mystery.id, "100"],
    ]);

    console.log("\n  ONE RUN, TWO FORMULAS\n");

    const before = (
      await tx.execute(sql`SELECT count(*)::int AS n FROM production_orders`)
    ).rows[0] as { n: number };

    // Exactly what the endpoint does: each run through produceOne, all inside
    // one transaction.
    const opts = { orderDate: "2026-08-19", locationId: loc!.id };
    const made = [
      await produceOne(tx, { formulaId: chick.id, batchCount: 2 }, opts, user!.id),
      await produceOne(tx, { formulaId: layer.id, batchCount: 3 }, opts, user!.id),
    ];

    check("both formulas produced", made.length === 2, made.map((m) => m.number).join(", "));
    check(
      "each is its own order, not one merged record",
      new Set(made.map((m) => m.id)).size === 2,
    );
    const chickOrder = made.find((m) => m.formulaId === chick.id)!;
    const layerOrder = made.find((m) => m.formulaId === layer.id)!;
    check("chick made 2 × 1,000 kg", Number(chickOrder.actualOutputKg) === 2000, kg(2000));
    check("layer made 3 × 1,000 kg", Number(layerOrder.actualOutputKg) === 3000, kg(3000));

    // 700×21.50 + 300×54 = 15,050 + 16,200 = 31,250 per batch; ×2 = 62,500
    check(
      "chick costs its own materials, not the run's",
      Math.abs(Number(chickOrder.inputValue) - 62500) < 0.01,
      `₹${Number(chickOrder.inputValue).toLocaleString("en-IN")}`,
    );
    // 850×21.50 + 150×54 = 18,275 + 8,100 = 26,375 per batch; ×3 = 79,125
    check(
      "layer costs its own materials",
      Math.abs(Number(layerOrder.inputValue) - 79125) < 0.01,
      `₹${Number(layerOrder.inputValue).toLocaleString("en-IN")}`,
    );
    check(
      "and they land on different costs per kg",
      Number(chickOrder.costPerKg) !== Number(layerOrder.costPerKg),
      `₹${Number(chickOrder.costPerKg).toFixed(4)} vs ₹${Number(layerOrder.costPerKg).toFixed(4)}`,
    );
    check("each posted its own journal", !!chickOrder.journalEntryId && !!layerOrder.journalEntryId);

    const after = (
      await tx.execute(sql`SELECT count(*)::int AS n FROM production_orders`)
    ).rows[0] as { n: number };
    check("two records were written", after.n - before.n === 2, `${before.n} → ${after.n}`);

    console.log("\n  A RUN IS ALL OR NOTHING\n");

    const countNow = (
      await tx.execute(sql`SELECT count(*)::int AS n FROM production_orders`)
    ).rows[0] as { n: number };

    let refused: string | null = null;
    try {
      await tx.transaction(async (inner) => {
        await produceOne(inner, { formulaId: layer.id, batchCount: 1 }, opts, user!.id);
        await produceOne(inner, { formulaId: broken.id, batchCount: 1 }, opts, user!.id);
      });
    } catch (e) {
      refused = (e as Error).message;
    }
    check("a run with an unpriceable formula is refused", refused != null, refused ?? "");
    check(
      "and it names the material rather than the formula",
      /TEST RUN UNPRICED/.test(refused ?? ""),
      refused ?? "",
    );
    const countAfter = (
      await tx.execute(sql`SELECT count(*)::int AS n FROM production_orders`)
    ).rows[0] as { n: number };
    check(
      "the good formula in that run did NOT post",
      countAfter.n === countNow.n,
      `${countNow.n} → ${countAfter.n} — nothing half-made`,
    );
    throw new Rollback();
  });
} catch (e) {
  if (!(e instanceof Rollback)) throw e;
}

const strays = await db
  .select({ id: productionOrders.id })
  .from(productionOrders)
  .where(eq(productionOrders.number, "TEST-RUN"));
check("nothing survives the run", strays.length === 0);

console.log(failed === 0 ? "\n  All production-run checks passed.\n" : `\n  ${failed} FAILED.\n`);
process.exit(failed ? 1 : 0);
