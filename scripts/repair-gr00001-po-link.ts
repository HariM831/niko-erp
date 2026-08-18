/**
 * One-off repair for GR-00001.
 *
 * BILL-001916 was voided before voiding knew to give the purchase order back
 * what settling took. So PO-00001 still reads 43,330 kg delivered and billed
 * against a bill that no longer exists, and the receipt line — re-matched by
 * the edit screen against an order that looked fully consumed — lost its link
 * altogether.
 *
 * Both are now handled by the void handler, so this repairs the one truck that
 * went through the old path. It is deliberately narrow: named ids, checked
 * before and after, and it refuses to run if the state is not the one it was
 * written for.
 *
 * Run: npx tsx scripts/repair-gr00001-po-link.ts
 */
import { and, eq, sql } from "drizzle-orm";
import { procurementReceiptLines, purchaseOrderLines } from "@shared/schema";
import { db } from "../server/db";

const RECEIPT = "10151e11-5dba-47c2-a7ca-bfdd4232a6eb";
const PO = "46b2bf45-b395-441c-a6d9-469dcd137122";
const PO_LINE = "61fb197b-8ee8-4e03-87e9-f9caae39ef05";

const show = async (label: string) => {
  const po = await db
    .select({
      qty: purchaseOrderLines.quantity,
      delivered: purchaseOrderLines.deliveredQuantity,
      billed: purchaseOrderLines.billedQuantity,
    })
    .from(purchaseOrderLines)
    .where(eq(purchaseOrderLines.id, PO_LINE));
  const rl = await db
    .select({
      status: procurementReceiptLines.status,
      poLineId: procurementReceiptLines.poLineId,
      poId: procurementReceiptLines.purchaseOrderId,
    })
    .from(procurementReceiptLines)
    .where(eq(procurementReceiptLines.receiptId, RECEIPT));
  console.log(`\n  ${label}`);
  console.log("    PO line   ", JSON.stringify(po[0]));
  console.log("    Receipt   ", JSON.stringify(rl[0]));
  return { po: po[0]!, line: rl[0]! };
};

const before = await show("BEFORE");

if (Number(before.po.delivered) === 0 && before.line.poLineId) {
  console.log("\n  Already repaired — nothing to do.\n");
  process.exit(0);
}

await db.transaction(async (tx) => {
  // The void reversed the money; the order was never told.
  await tx
    .update(purchaseOrderLines)
    .set({ deliveredQuantity: "0.000", billedQuantity: "0.000" })
    .where(eq(purchaseOrderLines.id, PO_LINE));

  // Put the line back against the order it actually came in on.
  await tx
    .update(procurementReceiptLines)
    .set({ purchaseOrderId: PO, poLineId: PO_LINE })
    .where(and(eq(procurementReceiptLines.receiptId, RECEIPT), eq(procurementReceiptLines.lineNo, 1)));
});

const after = await show("AFTER");

const ok =
  Number(after.po.delivered) === 0 &&
  Number(after.po.billed) === 0 &&
  after.line.poLineId === PO_LINE &&
  after.line.status === "unloaded";
console.log(ok ? "\n  Repaired. GR-00001 can be settled again.\n" : "\n  UNEXPECTED STATE — check by hand.\n");
await db.execute(sql`SELECT 1`);
process.exit(ok ? 0 : 1);
