/**
 * A purchase order a truck has been matched to can still be edited.
 *
 * Editing used to delete every line and write them again. Once a lorry had
 * been matched to a line — even one turned back at QC — the database refused
 * the save ("Refers to something that doesn't exist"), because the goods
 * receipt would have pointed at nothing; and on any order it did save, the
 * delivered and billed counts on each line were thrown away.
 *
 * Now a line that comes back with its id is updated where it stands, a new
 * line is added, and a line a goods receipt names cannot be removed — refused
 * in words that name the truck.
 *
 * Runs against a real unbilled order that a goods receipt is matched to.
 * Rolled back; nothing survives.
 *
 * Run: npx tsx scripts/check-po-edit.ts
 */
import { eq, sql } from "drizzle-orm";
import { purchaseOrderLines, purchaseOrders } from "@shared/schema";
import { db, pool } from "../server/db";
import { editPurchaseOrder } from "../server/routes/purchases";

let failed = 0;
const check = (name: string, pass: boolean, detail = "") => {
  if (!pass) failed++;
  console.log(`    ${pass ? "PASS" : "FAIL"}  ${name.padEnd(58)} ${detail}`);
};
class Rollback extends Error {}

try {
  await db.transaction(async (tx) => {
    const [row] = (
      await tx.execute(sql`
        SELECT po.id, po.number, l.po_line_id AS "lineId", r.number AS receipt
          FROM office_receipt_lines l
          JOIN office_receipts r ON r.id = l.receipt_id
          JOIN purchase_order_lines pl ON pl.id = l.po_line_id
          JOIN purchase_orders po ON po.id = pl.purchase_order_id
         WHERE po.status NOT IN ('billed', 'partially_billed', 'cancelled')
         ORDER BY r.arrival_at DESC LIMIT 1`)
    ).rows as Array<{ id: string; number: string; lineId: string; receipt: string }>;
    if (!row) throw new Error("No unbilled order with a matched goods receipt on this database");
    console.log(`\n  ${row.number}, matched by ${row.receipt}\n`);

    const lines = await tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, row.id));
    const asSent = (l: (typeof lines)[number], patch: Partial<{ quantity: string; rate: string }> = {}) => ({
      id: l.id,
      itemId: l.itemId ?? undefined,
      accountId: l.accountId ?? undefined,
      name: l.name,
      quantity: patch.quantity ?? Number(l.quantity).toString(),
      rate: patch.rate ?? Number(l.rate).toString(),
      discountPercent: Number(l.discountPercent ?? 0).toString(),
      taxId: l.taxId ?? undefined,
    });
    const matched = lines.find((l) => l.id === row.lineId)!;
    const deliveredBefore = Number(matched.deliveredQuantity);

    // 1. Change the matched line's quantity — the edit that used to fail.
    const newQty = (Number(matched.quantity) + 1).toString();
    let err = "";
    try {
      await editPurchaseOrder(tx, row.id, {
        reference: "check-po-edit",
        lines: lines.map((l) => asSent(l, l.id === matched.id ? { quantity: newQty } : {})),
      });
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
    check("an order a truck is matched to saves", !err, err);
    const [after] = await tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.id, matched.id));
    check("the matched line keeps its identity", !!after, matched.id.slice(0, 8));
    check("and takes the new quantity", Number(after?.quantity) === Number(newQty), `${Number(after?.quantity)}`);
    check("and keeps what was delivered on it", Number(after?.deliveredQuantity) === deliveredBefore, `${deliveredBefore}`);
    const [po] = await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, row.id));
    check("the header saved too", po?.reference === "check-po-edit");

    // 2. A new line alongside.
    const now = await tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, row.id));
    await editPurchaseOrder(tx, row.id, {
      lines: [...now.map((l) => asSent(l)), { ...asSent(matched), id: undefined, name: "check-po-edit extra", quantity: "1" }],
    });
    const withNew = await tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, row.id));
    check("a new line is added", withNew.length === now.length + 1, `${now.length} → ${withNew.length}`);

    // 3. Removing the matched line is refused, by name.
    let refusal = "";
    try {
      await tx.execute(sql`SAVEPOINT drop_matched`);
      await editPurchaseOrder(tx, row.id, { lines: withNew.filter((l) => l.id !== matched.id).map((l) => asSent(l)) });
    } catch (e) {
      refusal = e instanceof Error ? e.message : String(e);
      await tx.execute(sql`ROLLBACK TO SAVEPOINT drop_matched`);
    }
    check("removing the matched line is refused", refusal.includes(row.receipt), refusal);

    // 4. Removing the extra line, which nothing names, is allowed.
    const extra = withNew.find((l) => l.name === "check-po-edit extra")!;
    await editPurchaseOrder(tx, row.id, { lines: withNew.filter((l) => l.id !== extra.id).map((l) => asSent(l)) });
    const final = await tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, row.id));
    check("a line nothing names can be removed", final.length === now.length && final.some((l) => l.id === matched.id));

    throw new Rollback();
  });
} catch (e) {
  if (!(e instanceof Rollback)) {
    console.error(`\n  ${e instanceof Error ? e.message : e}\n`);
    failed++;
  }
} finally {
  await pool.end().catch(() => {});
}
console.log(failed === 0 ? "\n  All purchase-order edit checks passed.\n" : `\n  ${failed} FAILED.\n`);
process.exitCode = failed ? 1 : 0;
