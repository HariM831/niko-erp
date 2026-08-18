/**
 * The over-delivery band at the gate.
 *
 * This setting decides whether a loaded truck comes in, so it is worth a test
 * that a person can read: an order is raised for a round tonnage before
 * anything is weighed, and the vendor loads what the vendor loads. The band
 * absorbs that; it must not absorb a real over-supply.
 *
 * Rolled back; nothing survives.
 *
 * Run: npx tsx scripts/check-po-tolerance.ts
 */
import { eq, sql } from "drizzle-orm";
import { contacts, items, preferences, purchaseOrderLines, purchaseOrders } from "@shared/schema";
import { db } from "../server/db";
import { matchPurchaseOrderLines } from "../server/services/po-match";

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
      .values({ displayName: "TEST TOLERANCE VENDOR", type: "vendor" })
      .returning();
    const [item] = await tx
      .insert(items)
      .values({
        name: "TEST TOLERANCE MATERIAL",
        unit: "kg",
        isSold: false,
        purchaseAccountId: acct!.id,
        category: "feed",
      })
      .returning();

    const [po] = await tx
      .insert(purchaseOrders)
      .values({
        number: "TEST-PO-TOL",
        vendorId: vendor!.id,
        orderDate: "2026-08-18",
        status: "issued",
        subTotal: "0",
        total: "0",
        createdBy: user!.id,
      })
      .returning();
    await tx.insert(purchaseOrderLines).values({
      purchaseOrderId: po!.id,
      itemId: item!.id,
      name: item!.name,
      quantity: "43300",
      rate: "50.30",
      amount: "2177990",
    });

    const setBand = async (pct: string) => {
      const [row] = await tx.select({ id: preferences.id }).from(preferences).limit(1);
      if (row) {
        await tx.update(preferences).set({ poOverDeliveryPct: pct }).where(eq(preferences.id, row.id));
      } else {
        await tx.insert(preferences).values({ id: "default", poOverDeliveryPct: pct });
      }
    };

    const match = async (qty: number) =>
      (
        await matchPurchaseOrderLines(tx, {
          vendorId: vendor!.id,
          billDate: "2026-08-18",
          lines: [{ itemId: item!.id, itemName: item!.name, quantityKg: qty, ratePerKg: 50.3 }],
        })
      )[0]!;

    console.log("\n  AT THE DEFAULT 1% BAND\n");
    await setBand("1.000");

    const exact = await match(43300);
    check("the exact ordered quantity matches", exact.method === "matched", exact.message);

    // The delivery that started all this: 30 kg over on 43 tonnes.
    const real = await match(43330);
    check("30 kg over on 43 tonnes comes in", real.method === "matched", real.chosen?.reasons.find((r) => r.factor === "quantity")?.detail ?? real.message);

    const under = await match(41000);
    check("a short delivery still matches", under.method === "matched", "the shortage is settled later, not at the gate");

    // 1% of 43,300 is 433 kg, so 43,733 is the last kilogram inside the band.
    const edge = await match(43733);
    check("the last kilogram inside the band matches", edge.method === "matched");

    const over = await match(43734);
    check("one kilogram past the band is refused", over.method === "unmatched", over.message);

    const way = await match(50000);
    check("a real over-supply is refused", way.method === "unmatched", "6.7 tonnes more than ordered");

    console.log("\n  THE BAND IS THE SETTING, NOT A CONSTANT\n");

    await setBand("0.000");
    const strict = await match(43330);
    check("at zero, the 30 kg truck is turned away", strict.method === "unmatched", strict.message);

    await setBand("5.000");
    const loose = await match(45000);
    check("at 5%, 1.7 tonnes over comes in", loose.method === "matched", "45,000 against 43,300");

    console.log("\n  THE OTHER CONDITIONS ARE STILL HARD\n");

    await setBand("1.000");
    const wrongRate = await match(43330);
    check("a matching truck still passes on rate", wrongRate.method === "matched");
    const priced = (
      await matchPurchaseOrderLines(tx, {
        vendorId: vendor!.id,
        billDate: "2026-08-18",
        lines: [{ itemId: item!.id, itemName: item!.name, quantityKg: 43330, ratePerKg: 52.815 }],
      })
    )[0]!;
    check(
      "a tolerated quantity does not excuse a wrong rate",
      priced.method === "unmatched",
      priced.message,
    );

    throw new Rollback();
  });
} catch (e) {
  if (!(e instanceof Rollback)) throw e;
}

const strays = await db.select({ id: items.id }).from(items).where(eq(items.name, "TEST TOLERANCE MATERIAL"));
check("nothing survives the run", strays.length === 0);

console.log(failed === 0 ? "\n  All over-delivery checks passed.\n" : `\n  ${failed} FAILED.\n`);
process.exit(failed ? 1 : 0);
