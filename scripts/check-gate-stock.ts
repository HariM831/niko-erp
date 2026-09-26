/**
 * A settled gate receipt takes what came off the lorry into stock.
 *
 * The user's call on 26 Sep 2026: every gate in causes a stock uptake, after
 * settlement. Four things have to hold for that to be worth anything:
 *
 *   - the kilos are the WEIGHED net per material, not the vendor's billed
 *     figure — a lorry billed at 20,000 kg that weighs 19,800 kg puts 19,800
 *     into the silo, and a pack item goes in by its bag weight;
 *   - the value is what the load finally cost — goods, its share of their tax
 *     and rounding, less the deductions — and matches, to the paisa, what the
 *     bill puts on the stock account;
 *   - a tracked material's bill charges the stock account, never the purchase
 *     expense, so production can take it back out without Feed Stock going
 *     negative;
 *   - voiding the bill takes exactly that back out, and reopens the truck.
 *
 * Runs against a real gated-out truck on this database, with its materials
 * switched to tracking for the test. Rolled back; nothing survives, and the
 * photo copies settlement makes are removed afterwards.
 *
 * Run: npx tsx scripts/check-gate-stock.ts
 */
import { unlink } from "node:fs/promises";
import path from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  accounts,
  attachments,
  inventoryTransactions,
  items,
  journalEntryLines,
  officeReceiptLines,
  officeReceipts,
} from "@shared/schema";
import { db, pool } from "../server/db";
import { settleReceipt } from "../server/routes/office";
import { voidBill } from "../server/routes/purchases";
import { stockUnitsPerKg } from "../server/services/inventory";
import { istDate } from "../server/services/day-resolution";

let failed = 0;
const check = (name: string, pass: boolean, detail = "") => {
  if (!pass) failed++;
  console.log(`    ${pass ? "PASS" : "FAIL"}  ${name.padEnd(58)} ${detail}`);
};
const near = (a: number, b: number, tol = 0.011) => Math.abs(a - b) <= tol;

class Rollback extends Error {}
const copies: string[] = [];

try {
  await db.transaction(async (tx) => {
    const [feedStock] = await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.code, "1073"));
    if (!feedStock) throw new Error("No account 1073 Feed Stock");
    const [user] = (await tx.execute(sql`SELECT id FROM users ORDER BY created_at LIMIT 1`)).rows as Array<{ id: string }>;

    // A gated-out truck whose unloaded lines all name a material and an order.
    const candidates = (
      await tx.execute(sql`
        SELECT r.id FROM office_receipts r
         WHERE r.status = 'gate_out' AND r.vendor_id IS NOT NULL
           AND EXISTS (SELECT 1 FROM office_receipt_lines l WHERE l.receipt_id = r.id AND l.status = 'unloaded')
           AND NOT EXISTS (SELECT 1 FROM office_receipt_lines l
                            WHERE l.receipt_id = r.id AND l.status = 'unloaded'
                              AND (l.item_id IS NULL OR l.po_line_id IS NULL))
         ORDER BY r.arrival_at DESC LIMIT 1`)
    ).rows as Array<{ id: string }>;
    if (!candidates.length) throw new Error("No gated-out truck to settle on this database");
    const receiptId = candidates[0]!.id;
    const [receipt] = await tx.select().from(officeReceipts).where(eq(officeReceipts.id, receiptId));
    const lines = await tx
      .select({ line: officeReceiptLines, unit: items.unit, unitBagWeightKg: items.unitBagWeightKg, name: items.name })
      .from(officeReceiptLines)
      .innerJoin(items, eq(items.id, officeReceiptLines.itemId))
      .where(and(eq(officeReceiptLines.receiptId, receiptId), eq(officeReceiptLines.status, "unloaded")));
    const itemIds = [...new Set(lines.map((l) => l.line.itemId!))];
    console.log(`\n  ${receipt!.number} · ${receipt!.vehicleNumber} · ${lines.map((l) => l.name).join(", ")}\n`);

    // As scripts/track-raw-materials.ts leaves them.
    await tx
      .update(items)
      .set({ trackInventory: true, inventoryAccountId: feedStock.id })
      .where(inArray(items.id, itemIds));

    const heldOf = async () =>
      new Map(
        (
          await tx
            .select({ itemId: inventoryTransactions.itemId, q: sql<string>`sum(${inventoryTransactions.quantity})` })
            .from(inventoryTransactions)
            .where(inArray(inventoryTransactions.itemId, itemIds))
            .groupBy(inventoryTransactions.itemId)
        ).map((r) => [r.itemId, Number(r.q)]),
      );
    const before = await heldOf();

    const out = await settleReceipt(tx, receiptId, {}, user!.id);
    const bill = out.bill;
    for (const a of await tx
      .select({ storedName: attachments.storedName })
      .from(attachments)
      .where(and(eq(attachments.entityType, "bill"), eq(attachments.entityId, bill.id)))) {
      copies.push(a.storedName);
    }

    const moves = await tx
      .select()
      .from(inventoryTransactions)
      .where(and(eq(inventoryTransactions.sourceType, "bill"), eq(inventoryTransactions.sourceId, bill.id)));

    for (const l of lines) {
      const perKg = stockUnitsPerKg(l)!;
      const want = Number(l.line.allocatedNetKg ?? l.line.billQuantityKg) * perKg;
      const got = moves.filter((m) => m.itemId === l.line.itemId).reduce((s, m) => s + Number(m.quantity), 0);
      check(
        `${l.name}: weighed net into stock`,
        near(got, want, 0.001),
        `${got.toFixed(3)} ${l.unit} (billed ${Number(l.line.billQuantityKg).toFixed(0)} kg, weighed ${Number(l.line.allocatedNetKg ?? 0).toFixed(0)} kg)`,
      );
    }
    const after = await heldOf();
    const rose = itemIds.every((id) => (after.get(id) ?? 0) > (before.get(id) ?? 0));
    check("stock on hand rose for every material", rose);

    // The bill's own journal against the stock account.
    const je = (
      await tx
        .select({ accountId: journalEntryLines.accountId, dr: sql<string>`sum(${journalEntryLines.debit})`, cr: sql<string>`sum(${journalEntryLines.credit})` })
        .from(journalEntryLines)
        .where(eq(journalEntryLines.entryId, bill.journalEntryId!))
        .groupBy(journalEntryLines.accountId)
    ).map((r) => ({ accountId: r.accountId, net: Number(r.dr) - Number(r.cr) }));
    const onStock = je.find((j) => j.accountId === feedStock.id)?.net ?? 0;
    const moveValue = moves.reduce((s, m) => s + Number(m.value ?? 0), 0);
    check("stock value matches the bill's debit to Feed Stock", near(onStock, moveValue, 0.05), `₹${onStock.toFixed(2)} vs ₹${moveValue.toFixed(2)}`);
    const expensed = (
      await tx.execute(sql`
        SELECT coalesce(sum(jl.debit - jl.credit), 0) AS net FROM journal_entry_lines jl
          JOIN accounts a ON a.id = jl.account_id
         WHERE jl.entry_id = ${bill.journalEntryId} AND a.type = 'expense'`)
    ).rows[0] as { net: string };
    check("nothing on the bill is expensed", near(Number(expensed.net), 0), `₹${Number(expensed.net).toFixed(2)}`);

    await voidBill(tx, bill.id, istDate(), user!.id);
    const net = moves.length
      ? (
          await tx
            .select({ q: sql<string>`coalesce(sum(${inventoryTransactions.quantity}), 0)`, v: sql<string>`coalesce(sum(${inventoryTransactions.value}), 0)` })
            .from(inventoryTransactions)
            .where(and(eq(inventoryTransactions.sourceType, "bill"), eq(inventoryTransactions.sourceId, bill.id)))
        )[0]!
      : { q: "0", v: "0" };
    check("voiding the bill takes the stock back out", near(Number(net.q), 0, 0.0005) && near(Number(net.v), 0), `net ${Number(net.q).toFixed(3)} / ₹${Number(net.v).toFixed(2)}`);
    const back = await heldOf();
    check("stock on hand is where it started", itemIds.every((id) => near(back.get(id) ?? 0, before.get(id) ?? 0, 0.0005)));
    const [reopened] = await tx.select({ status: officeReceipts.status }).from(officeReceipts).where(eq(officeReceipts.id, receiptId));
    check("the truck is back at gated out", reopened!.status === "gate_out", reopened!.status);

    throw new Rollback();
  });
} catch (e) {
  if (!(e instanceof Rollback)) {
    console.error(`\n  ${e instanceof Error ? e.message : e}\n`);
    failed++;
  }
} finally {
  const dir = path.resolve(process.cwd(), "uploads");
  for (const c of copies) await unlink(path.join(dir, c)).catch(() => {});
  await pool.end().catch(() => {});
}

console.log(failed === 0 ? "\n  All gate-stock checks passed.\n" : `\n  ${failed} FAILED.\n`);
process.exitCode = failed ? 1 : 0;
