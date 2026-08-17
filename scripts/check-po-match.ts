/**
 * Raises a real purchase order for Shayan Enterprise and checks that bill 518
 * matches it — the decision that now controls whether the boom lifts.
 *
 * Also checks the refusals, because a matcher that says yes to everything is
 * worse than none: a wrong rate, an exhausted order and the wrong material must
 * each fail, and fail with a reason a guard can act on.
 *
 * The order is raised inside a transaction that is always rolled back. It used
 * to be committed so the gate screen could be driven by hand afterwards, but a
 * script that leaves an order behind poisons its own next run: two identical
 * open orders make the delivery ambiguous, and a hard match refuses to guess.
 *
 * Run: npx tsx scripts/check-po-match.ts
 */
import { and, eq, inArray, like } from "drizzle-orm";
import { contacts, items, purchaseOrderLines, purchaseOrders } from "@shared/schema";
import { db } from "../server/db";
import { nextDocumentNumber } from "../server/lib/numbering";
import { matchPurchaseOrderLines } from "../server/services/po-match";

class Rollback extends Error {}

let failed = 0;
const check = (name: string, pass: boolean, detail = "") => {
  if (!pass) failed++;
  console.log(`    ${pass ? "PASS" : "FAIL"}  ${name.padEnd(38)} ${detail}`);
};

async function main() {
  const [vendor] = await db
    .select({ id: contacts.id, name: contacts.displayName })
    .from(contacts)
    .where(and(like(contacts.displayName, "%hayan%"), inArray(contacts.type, ["vendor", "both"])))
    .limit(1);
  if (!vendor) throw new Error("No vendor matching 'Shayan' — create the contact first");

  const [maize] = await db.select({ id: items.id, name: items.name }).from(items).where(eq(items.name, "Maize")).limit(1);
  const [dorb] = await db.select({ id: items.id, name: items.name }).from(items).where(eq(items.name, "DORB")).limit(1);
  if (!maize || !dorb) throw new Error("Need both 'Maize' and 'DORB' in the item master");

  const [actor] = await db.select({ id: contacts.id }).from(contacts).limit(1);
  const userRow = await db.execute("select id from users limit 1");
  const userId = (userRow.rows[0] as { id: string }).id;

  console.log(`  Vendor: ${vendor.name}\n`);

  // 50 tonnes of maize on order at the rate bill 518 charges, due the day the
  // truck actually turned up.
  try {
  await db.transaction(async (tx) => {
    const number = await nextDocumentNumber(tx, "purchase_order");
    const [row] = await tx
      .insert(purchaseOrders)
      .values({
        number,
        vendorId: vendor.id,
        status: "issued",
        orderDate: "2026-08-10",
        expectedDeliveryDate: "2026-08-14",
        subTotal: "1155000.00",
        total: "1155000.00",
        createdBy: userId,
      })
      .returning();
    await tx.insert(purchaseOrderLines).values({
      purchaseOrderId: row!.id,
      itemId: maize.id,
      name: "Maize",
      quantity: "50000.000",
      rate: "23.100000",
      amount: "1155000.00",
      lineOrder: 0,
    });
    const po = row!;
    console.log(`  Raised ${po.number} — 50,000 kg Maize @ Rs 23.10, expected 14 Aug 2026\n`);

    // Against the transaction, so the matcher sees the order this run raised.
    const run = (lines: Parameters<typeof matchPurchaseOrderLines>[1]["lines"], billDate = "2026-08-13") =>
      matchPurchaseOrderLines(tx, { vendorId: vendor.id, billDate, lines });

    // The real thing: bill 518 exactly as the extractor reads it.
    const [m] = await run([{ itemId: maize.id, itemName: "Maize", quantityKg: 40790, ratePerKg: 23.1 }]);
    check("bill 518 matches", m!.method === "matched", m!.message);
    check("matched to the order we raised", m!.chosen?.poNumber === po.number, String(m!.chosen?.poNumber));
    check("every condition passed", m!.chosen?.reasons.every((r) => r.passed) === true, m!.chosen?.reasons.length + " conditions");
    m!.chosen?.reasons.forEach((r) => console.log(`          ${r.passed ? "·" : "!"} ${r.detail}`));

    console.log();
    // A rate the vendor changed without telling us must not slip through.
    const [wrongRate] = await run([{ itemId: maize.id, itemName: "Maize", quantityKg: 40790, ratePerKg: 26.5 }]);
    check("a wrong rate is refused", wrongRate!.method === "unmatched", wrongRate!.message);

    // More than the order has left.
    const [tooMuch] = await run([{ itemId: maize.id, itemName: "Maize", quantityKg: 90000, ratePerKg: 23.1 }]);
    check("over-delivery is refused", tooMuch!.method === "unmatched", tooMuch!.message);

    // Right vendor, right rate, wrong goods.
    const [wrongItem] = await run([{ itemId: dorb.id, itemName: "DORB", quantityKg: 6000, ratePerKg: 23.1 }]);
    check("a material not on order is refused", wrongItem!.method === "unmatched", wrongItem!.message);

    // Months late.
    const [stale] = await run([{ itemId: maize.id, itemName: "Maize", quantityKg: 40790, ratePerKg: 23.1 }], "2026-02-01");
    check("a delivery months late is refused", stale!.method === "unmatched", stale!.message);

    throw new Rollback();
  });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }

  console.log(
    failed === 0
      ? "\n  All checks passed. The order was rolled back — nothing is left on the books."
      : `\n  ${failed} check(s) FAILED.`,
  );
  process.exit(failed ? 1 : 0);
}

void main();
