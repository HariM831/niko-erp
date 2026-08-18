/**
 * The item master's purchase rate, and the scoped call that broke every bill.
 *
 * syncPurchaseRates is called by createBill with the ids of the items just
 * billed. That scoped form was written as `ANY(${itemIds}::uuid[])` — but
 * drizzle flattens a JS array interpolated into a sql`` template into its
 * elements, so Postgres received a bare uuid, answered "malformed array
 * literal", and the rejection hung the request instead of failing it. Every
 * bill with an item on it was affected; a truck at settlement simply spun.
 *
 * So the case that matters here is the one with MORE THAN ONE id, which is
 * where a flattened array stops looking like a scalar and starts being wrong.
 *
 * Rolled back; nothing survives.
 *
 * Run: npx tsx scripts/check-purchase-rate-sync.ts
 */
import { eq, sql } from "drizzle-orm";
import { contacts, items } from "@shared/schema";
import { db } from "../server/db";
import { createBill, loadVendor, syncPurchaseRates } from "../server/services/purchases";

let failed = 0;
const check = (name: string, pass: boolean, detail = "") => {
  if (!pass) failed++;
  console.log(`    ${pass ? "PASS" : "FAIL"}  ${name.padEnd(54)} ${detail}`);
};

class Rollback extends Error {}

try {
  await db.transaction(async (tx) => {
    const [acct] = (
      await tx.execute(sql`SELECT id FROM accounts WHERE type = 'expense' LIMIT 1`)
    ).rows as Array<{ id: string }>;
    const [user] = (await tx.execute(sql`SELECT id FROM users LIMIT 1`)).rows as Array<{ id: string }>;

    const [vendor] = await tx
      .insert(contacts)
      .values({ displayName: "TEST RATE SYNC VENDOR", type: "vendor" })
      .returning();

    const made: string[] = [];
    for (const n of ["TEST RATE A", "TEST RATE B", "TEST RATE C"]) {
      const [it] = await tx
        .insert(items)
        .values({
          name: n,
          unit: "kg",
          isSold: false,
          purchaseAccountId: acct!.id,
          category: "feed",
          costPrice: "1.00",
        })
        .returning();
      made.push(it!.id);
    }

    console.log("\n  THE SCOPED CALL\n");

    // One id looks like a scalar and used to "work" by accident; three do not.
    const one = await syncPurchaseRates(tx, [made[0]!]);
    check("a single id does not throw", true, `${one} row(s) touched`);
    const many = await syncPurchaseRates(tx, made);
    check("several ids do not throw", true, `${many} row(s) touched`);
    check("an empty scope is the whole master, not an error", (await syncPurchaseRates(tx, [])) >= 0);

    console.log("\n  A BILL CARRYING ITEMS CAN BE RAISED\n");

    const vend = await loadVendor(tx, vendor!.id);
    const bill = await createBill(tx, {
      vendor: vend,
      billDate: "2026-08-18",
      reference: "TEST-RATE-SYNC",
      lines: made.map((id, i) => ({
        itemId: id,
        accountId: acct!.id,
        name: `TEST RATE ${"ABC"[i]}`,
        quantity: "100.000",
        unit: "kg",
        rate: (10 + i).toFixed(6),
      })),
      postedBy: user!.id,
    });
    check("a multi-item bill posts", !!bill.id, bill.number);

    const after = await tx.select({ id: items.id, cost: items.costPrice }).from(items);
    const costOf = (id: string) => after.find((r) => r.id === id)?.cost;
    check("each item took its own billed rate", costOf(made[0]!) === "10.00" && costOf(made[2]!) === "12.00",
      `${costOf(made[0]!)}, ${costOf(made[1]!)}, ${costOf(made[2]!)}`);

    console.log("\n  A DEDUCTION DOES NOT BECOME A PRICE\n");

    const bill2 = await createBill(tx, {
      vendor: vend,
      billDate: "2026-08-19",
      reference: "TEST-RATE-SYNC-2",
      lines: [
        { itemId: made[0]!, accountId: acct!.id, name: "TEST RATE A", quantity: "100.000", unit: "kg", rate: "20.000000" },
        // The settlement shape: a negative line against the same item.
        { itemId: made[0]!, accountId: acct!.id, name: "Damage", quantity: "1.000", rate: "-500.000000" },
      ],
      postedBy: user!.id,
    });
    check("a bill with a negative line posts", !!bill2.id, bill2.number);
    const after2 = await tx.select({ id: items.id, cost: items.costPrice }).from(items);
    check(
      "the rate followed the goods line, not the deduction",
      after2.find((r) => r.id === made[0])?.cost === "20.00",
      String(after2.find((r) => r.id === made[0])?.cost),
    );

    throw new Rollback();
  });
} catch (e) {
  if (!(e instanceof Rollback)) throw e;
}

const strays = await db.select({ id: items.id }).from(items).where(eq(items.name, "TEST RATE A"));
check("nothing survives the run", strays.length === 0);

console.log(failed === 0 ? "\n  All purchase-rate checks passed.\n" : `\n  ${failed} FAILED.\n`);
process.exit(failed ? 1 : 0);
