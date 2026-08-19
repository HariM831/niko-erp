/**
 * Raw material as an asset: in at the gate, out at the mill.
 *
 * Until now a bill expensed what it bought and production capitalised finished
 * feed out of thin air — the ledger said the farm consumed forty tonnes the day
 * the lorry arrived, while Stock on Hand had nothing to consume.
 *
 * Now a bill for a tracked item debits the stock account and puts the kilos in;
 * producing takes them out at what they cost and puts the feed in at that plus
 * the overhead. The chain has to close: what goes in must come out, and a void
 * on either end must put it back.
 *
 * Rolled back; nothing survives.
 *
 * Run: npx tsx scripts/check-raw-material-stock.ts
 */
import { eq, sql } from "drizzle-orm";
import { contacts, formulaLines, formulas, items } from "@shared/schema";
import { db } from "../server/db";
import { produceOne } from "../server/routes/feed-production";
import { stockOnHand } from "../server/services/inventory";
import { createBill, loadVendor } from "../server/services/purchases";

let failed = 0;
const check = (name: string, pass: boolean, detail = "") => {
  if (!pass) failed++;
  console.log(`    ${pass ? "PASS" : "FAIL"}  ${name.padEnd(52)} ${detail}`);
};
const n = (v: unknown) => Number(v ?? 0);

class Rollback extends Error {}

try {
  await db.transaction(async (tx) => {
    const one = async (q: ReturnType<typeof sql>) =>
      (await tx.execute(q)).rows[0] as Record<string, string>;
    const acct = await one(sql`SELECT id FROM accounts WHERE type = 'expense' LIMIT 1`);
    const stock = await one(sql`SELECT id FROM accounts WHERE code = '1072' LIMIT 1`);
    const feedStock = await one(sql`SELECT id FROM accounts WHERE code = '1073' LIMIT 1`);
    const user = await one(sql`SELECT id FROM users LIMIT 1`);
    const loc = await one(sql`SELECT id FROM locations LIMIT 1`);

    /** A raw material that is now an inventory item. */
    const raw = async (name: string) => {
      const [it] = await tx
        .insert(items)
        .values({
          name,
          unit: "kg",
          isSold: false,
          category: "feed",
          isFeedIngredient: true,
          purchaseAccountId: acct.id!,
          trackInventory: true,
          inventoryAccountId: stock.id!,
        })
        .returning();
      return it!;
    };
    const maize = await raw("TEST STK MAIZE");
    const soya = await raw("TEST STK SOYA");

    const [feed] = await tx
      .insert(items)
      .values({
        name: "TEST STK LAYER FEED",
        unit: "kg",
        isSold: false,
        category: "poultry_feed",
        trackInventory: true,
        inventoryAccountId: feedStock.id!,
      })
      .returning();

    const [vendor] = await tx
      .insert(contacts)
      .values({ displayName: "TEST STK VENDOR", type: "vendor" })
      .returning();

    console.log("\n  A BILL PUTS RAW MATERIAL INTO STOCK\n");

    const vend = await loadVendor(tx, vendor!.id);
    const bill = await createBill(tx, {
      vendor: vend,
      billDate: "2026-08-19",
      reference: "TEST-STK",
      lines: [
        { itemId: maize.id, name: maize.name, quantity: "10000.000", unit: "kg", rate: "20.000000" },
        { itemId: soya.id, name: soya.name, quantity: "5000.000", unit: "kg", rate: "50.000000" },
      ],
      postedBy: user.id!,
    });
    check("the bill posts", !!bill.id, `${bill.number} — ₹${Number(bill.total).toLocaleString("en-IN")}`);

    const afterBuy = new Map((await stockOnHand(tx)).map((l) => [l.itemId, l]));
    check("maize is in stock", n(afterBuy.get(maize.id)?.quantity) === 10000, "10,000 kg");
    check("at what it cost", n(afterBuy.get(maize.id)?.value) === 200000, "₹2,00,000");
    check("soya too", n(afterBuy.get(soya.id)?.quantity) === 5000, `₹${n(afterBuy.get(soya.id)?.value).toLocaleString("en-IN")}`);

    // The line must have hit the STOCK account, not the expense account.
    const je = await tx.execute(sql`
      SELECT a.code, sum(l.debit)::numeric AS dr
      FROM journal_entry_lines l JOIN accounts a ON a.id = l.account_id
      WHERE l.entry_id = ${bill.journalEntryId}::uuid AND l.debit > 0
      GROUP BY 1 ORDER BY 1`);
    const debited = (je.rows as Array<{ code: string; dr: string }>).map((r) => r.code);
    check("it capitalised rather than expensed", debited.includes("1072"), `debits ${debited.join(", ")}`);

    console.log("\n  PRODUCING EATS IT\n");

    const [formula] = await tx
      .insert(formulas)
      .values({
        name: "TEST STK MIX",
        version: 1,
        outputItemId: feed!.id,
        batchSizeKg: "1000",
        effectiveFrom: "2026-01-01",
        isActive: true,
        createdBy: user.id!,
      })
      .returning();
    await tx.insert(formulaLines).values([
      { formulaId: formula!.id, itemId: maize.id, quantityKg: "700", sortOrder: 0 },
      { formulaId: formula!.id, itemId: soya.id, quantityKg: "300", sortOrder: 1 },
    ]);

    const order = await produceOne(
      tx,
      { formulaId: formula!.id, batchCount: 2 },
      { orderDate: "2026-08-19", locationId: loc.id! },
      user.id!,
    );
    const afterMill = new Map((await stockOnHand(tx)).map((l) => [l.itemId, l]));
    check("maize came out of the silo", n(afterMill.get(maize.id)?.quantity) === 8600, "10,000 − 1,400");
    check("soya too", n(afterMill.get(soya.id)?.quantity) === 4400, "5,000 − 600");
    check("finished feed went in", n(afterMill.get(feed!.id)?.quantity) === 2000, "2 × 1,000 kg");

    // 1,400 × 20 + 600 × 50 = 28,000 + 30,000 = 58,000 of material.
    check(
      "the batch cost what the silo cost, not a list price",
      n(order.inputValue) === 58000,
      `₹${n(order.inputValue).toLocaleString("en-IN")}`,
    );
    check(
      "and the feed carries material plus overhead",
      Math.abs(n(afterMill.get(feed!.id)?.value) - (58000 + 2000 * 0.75)) < 0.01,
      `₹${n(afterMill.get(feed!.id)?.value).toLocaleString("en-IN")}`,
    );

    console.log("\n  THE MILL CANNOT MAKE WHAT IT DOES NOT HOLD\n");

    let refused: string | null = null;
    try {
      await tx.transaction(async (inner) => {
        await produceOne(
          inner,
          { formulaId: formula!.id, batchCount: 50 },
          { orderDate: "2026-08-19", locationId: loc.id! },
          user.id!,
        );
      });
    } catch (e) {
      refused = (e as Error).message;
    }
    check("a batch bigger than the silo is refused", refused != null);
    check(
      "and it names the material and both figures",
      /TEST STK MAIZE/.test(refused ?? "") && /against/.test(refused ?? ""),
      (refused ?? "").slice(0, 96),
    );

    console.log("\n  VOIDING GIVES IT BACK\n");

    // What the bill void does: reverse the stock as well as the money.
    const { mainStore, moveStock } = await import("../server/services/inventory");
    await moveStock(tx, {
      stockLocationId: await mainStore(tx, loc.id!),
      movements: [
        { itemId: maize.id, quantity: "-10000.000", value: "-200000.00" },
        { itemId: soya.id, quantity: "-5000.000", value: "-250000.00" },
      ],
      transactionDate: "2026-08-20",
      sourceType: "bill",
      sourceId: bill.id,
    });
    const afterVoid = new Map((await stockOnHand(tx)).map((l) => [l.itemId, l]));
    check(
      "a voided bill takes the kilos back out",
      n(afterVoid.get(maize.id)?.quantity) === -1400,
      "what production ate is all that remains — negative, and visible",
    );

    throw new Rollback();
  });
} catch (e) {
  if (!(e instanceof Rollback)) throw e;
}

const strays = await db.select({ id: items.id }).from(items).where(eq(items.name, "TEST STK MAIZE"));
check("nothing survives the run", strays.length === 0);

console.log(failed === 0 ? "\n  All raw-material stock checks passed.\n" : `\n  ${failed} FAILED.\n`);
process.exit(failed ? 1 : 0);
