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
import { contacts, formulaLines, formulas, items, productionOrders } from "@shared/schema";
import { db } from "../server/db";
import { produceOne } from "../server/routes/feed-production";
import { createBill, loadVendor } from "../server/services/purchases";
import { getPreferences } from "../server/services/preferences";

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
    // Milling loses moisture, so a batch yields the retained share of its input
    // (scripts/check-mill-yield.ts pins that down; here it only sets the target).
    const retention = Number((await getPreferences(tx)).millMoistureRetention);
    const yieldOf = (inputKg: number) => Math.round(inputKg * retention * 1000) / 1000;
    check(
      "chick made 2 × 1,000 kg, less moisture",
      Math.abs(Number(chickOrder.actualOutputKg) - yieldOf(2000)) < 0.0005,
      `${kg(Number(chickOrder.actualOutputKg))} of ${kg(yieldOf(2000))} at ${retention}`,
    );
    check(
      "layer made 3 × 1,000 kg, less moisture",
      Math.abs(Number(layerOrder.actualOutputKg) - yieldOf(3000)) < 0.0005,
      `${kg(Number(layerOrder.actualOutputKg))} of ${kg(yieldOf(3000))} at ${retention}`,
    );

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

    console.log("\n  AN EMPTY SILO PRICES AT THE LAST BILL\n");

    // Neither has a typed cost price or any stock, but both have been bought —
    // the formulator prices them from those bills, so the mill must too. The
    // premix is bought by the 4 kg pack: ₹679 a pack is ₹169.75 a kilo.
    const billed = await mk("TEST RUN BILLED", null);
    const [premix] = await tx
      .insert(items)
      .values({
        name: "TEST RUN PREMIX",
        unit: "pack",
        unitBagWeightKg: "4",
        isSold: false,
        purchaseAccountId: acct!.id,
        category: "feed",
        isFeedIngredient: true,
      })
      .returning();
    const [vendor] = await tx
      .insert(contacts)
      .values({ displayName: "TEST RUN VENDOR", type: "vendor" })
      .returning();
    await createBill(tx, {
      vendor: await loadVendor(tx, vendor!.id),
      billDate: "2026-08-19",
      reference: "TEST-RUN",
      lines: [
        { itemId: billed.id, name: billed.name, quantity: "1000.000", unit: "kg", rate: "30.000000" },
        { itemId: premix!.id, name: premix!.name, quantity: "10.000", unit: "pack", rate: "679.000000" },
      ],
      postedBy: user!.id,
    });
    const fromBills = await formula("TEST RUN FROM BILLS", (await output("TEST RUN FROM BILLS FEED")).id, [
      [maize.id, "900"],
      [billed.id, "94"],
      [premix!.id, "6"],
    ]);
    let billedOrder: Awaited<ReturnType<typeof produceOne>> | null = null;
    let billedErr = "";
    try {
      billedOrder = await produceOne(tx, { formulaId: fromBills.id, batchCount: 1 }, opts, user!.id);
    } catch (e) {
      billedErr = (e as Error).message;
    }
    check("a billed material with no cost price can be milled", !!billedOrder, billedErr);
    // 900×21.50 + 94×30 + 6×169.75 = 19,350 + 2,820 + 1,018.50 = 23,188.50
    check(
      "at its bill rate, a pack spread over its weight",
      Math.abs(Number(billedOrder?.inputValue ?? 0) - 23188.5) < 0.01,
      `₹${Number(billedOrder?.inputValue ?? 0).toLocaleString("en-IN")} of ₹23,188.50`,
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
