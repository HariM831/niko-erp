/**
 * Bring the bills settled from gate receipts before 29 Sep 2026 onto the rule
 * settlement follows now: the bill keeps the vendor's date, the goods go into
 * stock on the day the lorry reached the gate, and payment falls due from
 * that day.
 *
 * Until then settlement dated all three on the vendor's date. Most loads are
 * billed the day before they arrive; two soybean-meal loads were billed on
 * 14 Sep and came in on the 21st, and a Cantaxanthin load was billed on 11 Sep
 * and came in on the 28th — so the ledger held stock the mill did not have,
 * and the mill import, starting on 12 Sep, counted the Cantaxanthin twice.
 *
 * For each settled receipt whose bill is live:
 *
 *   - the due date moves to the arrival day plus the vendor's terms, as
 *     settlement sets it (not the bill's own gap from its date, which a
 *     first run has already shifted);
 *   - its stock movements move to the arrival day, and the goods-in-transit
 *     pair is posted (services/purchases.ts postGoodsInTransit) so the stock
 *     account holds nothing before the goods do;
 *   - the bill date is left alone: it is the vendor's.
 *
 * A bill whose stock never moved (settled before settlement moved stock)
 * only has its due date moved; the mill import takes its stock in, on the
 * arrival day. Running it twice changes nothing the second time.
 *
 *   npx tsx scripts/redate-receipt-stock.ts
 *   npx tsx scripts/redate-receipt-stock.ts --apply
 */
import { and, asc, eq, ne, sql } from "drizzle-orm";
import { bills, contacts, inventoryTransactions, journalEntries, officeReceipts, roles, users } from "@shared/schema";
import { db } from "../server/db";
import { postGoodsInTransit } from "../server/services/purchases";

const APPLY = process.argv.includes("--apply");
class DryRun extends Error {}

const days = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
const plus = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

try {
  await db.transaction(async (tx) => {
    const [admin] = await tx.select({ id: users.id }).from(users).innerJoin(roles, eq(roles.id, users.roleId)).where(eq(roles.name, "Admin")).orderBy(asc(users.createdAt)).limit(1);
    if (!admin) throw new Error("No Admin user to post as");

    const rows = await tx
      .select({
        receipt: officeReceipts.number,
        billId: bills.id,
        bill: bills.number,
        billDate: bills.billDate,
        dueDate: bills.dueDate,
        terms: contacts.paymentTermsDays,
        arrived: sql<string>`to_char((${officeReceipts.arrivalAt} AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD')`,
      })
      .from(officeReceipts)
      .innerJoin(bills, eq(bills.id, officeReceipts.billId))
      .innerJoin(contacts, eq(contacts.id, bills.vendorId))
      .where(and(eq(officeReceipts.status, "settled"), ne(bills.status, "void")))
      .orderBy(asc(officeReceipts.number));

    const tally = { receipts: rows.length, dueMoved: 0, stockMoved: 0, transitPosted: 0 };
    console.log(`\n  receipt | bill | bill date | arrived | due: was → now | stock: was → now | transit`);
    for (const r of rows) {
      const due = plus(r.arrived, Number(r.terms ?? 0));
      if (due !== r.dueDate) {
        await tx.update(bills).set({ dueDate: due, updatedAt: new Date() }).where(eq(bills.id, r.billId));
        tally.dueMoved++;
      }

      const moves = await tx
        .select({ id: inventoryTransactions.id, itemId: inventoryTransactions.itemId, date: inventoryTransactions.transactionDate, value: inventoryTransactions.value })
        .from(inventoryTransactions)
        .where(and(eq(inventoryTransactions.sourceType, "bill"), eq(inventoryTransactions.sourceId, r.billId)));
      const wasOn = [...new Set(moves.map((m) => m.date))].join(",") || "—";
      const early = moves.filter((m) => m.date !== r.arrived);
      if (early.length) {
        await tx.update(inventoryTransactions).set({ transactionDate: r.arrived }).where(and(eq(inventoryTransactions.sourceType, "bill"), eq(inventoryTransactions.sourceId, r.billId)));
        tally.stockMoved++;
      }

      let transit = "—";
      if (moves.length && r.billDate !== r.arrived) {
        const [already] = await tx
          .select({ id: journalEntries.id })
          .from(journalEntries)
          .where(and(eq(journalEntries.sourceType, "bill"), eq(journalEntries.sourceId, r.billId), sql`${journalEntries.narration} LIKE ${`Bill ${r.bill} — goods in transit%`}`));
        if (already) transit = "already";
        else {
          await postGoodsInTransit(tx, {
            billId: r.billId,
            billNumber: r.bill,
            billDate: r.billDate,
            stockDate: r.arrived,
            movements: moves.map((m) => ({ itemId: m.itemId, value: String(m.value ?? 0) })),
            postedBy: admin.id,
          });
          tally.transitPosted++;
          transit = `${days(r.billDate, r.arrived)} day(s)`;
        }
      }
      console.log(`    ${r.receipt} | ${r.bill} | ${r.billDate} | ${r.arrived} | ${r.dueDate} → ${due} | ${wasOn} → ${moves.length ? r.arrived : "none yet (the mill import)"} | ${transit}`);
    }

    console.log(`\n  settled receipts       ${tally.receipts}`);
    console.log(`  due dates moved        ${tally.dueMoved}`);
    console.log(`  stock moved to arrival ${tally.stockMoved}`);
    console.log(`  transit pairs posted   ${tally.transitPosted}`);
    if (!APPLY) throw new DryRun();
  });
  console.log(`\n  Written.\n`);
} catch (e) {
  if (e instanceof DryRun) console.log(`\n  Dry run — nothing written. Re-run with --apply.\n`);
  else { console.error(e); process.exitCode = 1; }
}
process.exit(process.exitCode ?? 0);
