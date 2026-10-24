/**
 * Checks POs numbered by financial year (24 Oct 2026): the switch below renames
 * the POs already raised, and new ones carry on from the last, restart at 0001
 * each April, and follow the PO's date rather than the day it was keyed.
 *
 * The switch is not a migration — it is run on the database by hand, once.
 * It renames every PO-00014 to A-PO-27-0014 (year from the PO's date) and
 * points the "PO-" series at A-PO-{FY}-. Both go together: switched alone, the
 * first new PO would be A-PO-27-0001 and the old PO-00001 could never be
 * renamed. Lpad goes through int because it cuts a longer string: '00014'
 * would come out '0001'.
 *
 * Runs the switch and claims numbers inside a transaction that is always
 * rolled back, so it can be run before or after the switch.
 *
 * Run: npx tsx scripts/check-po-numbers.ts
 */
import { eq, sql } from "drizzle-orm";
import { contacts, purchaseOrders } from "@shared/schema";
import { db } from "../server/db";
import { fyTag, nextDocumentNumber } from "../server/lib/numbering";

class Rollback extends Error {}

let failed = 0;
const check = (name: string, pass: boolean, detail = "") => {
  if (!pass) failed++;
  console.log(`    ${pass ? "PASS" : "FAIL"}  ${name.padEnd(44)} ${detail}`);
};

check("3 Oct 2026 is FY 27", fyTag("2026-10-03") === "27");
check("31 Mar 2027 is still FY 27", fyTag("2027-03-31") === "27");
check("1 Apr 2027 is FY 28", fyTag("2027-04-01") === "28");
check("a calendar year reads as its own year", fyTag("2026-10-03", "01-01") === "26");

try {
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE purchase_orders
      SET number = 'A-PO-'
        || lpad(((extract(year FROM order_date)::int
            + CASE WHEN extract(month FROM order_date) >= 4 THEN 1 ELSE 0 END) % 100)::text, 2, '0')
        || '-'
        || lpad(substring(number FROM 4)::int::text, 4, '0')
      WHERE number ~ '^PO-[0-9]+$'
    `);
    await tx.execute(sql`
      UPDATE document_series SET prefix = 'A-PO-{FY}-', padding = 4
      WHERE entity = 'purchase_order' AND prefix = 'PO-'
    `);

    const left = await tx.execute(sql`SELECT count(*)::int AS n FROM purchase_orders WHERE number ~ '^PO-[0-9]+$'`);
    check("no PO keeps the old shape", (left.rows[0] as { n: number }).n === 0);
    const [last] = await tx
      .select({ number: purchaseOrders.number })
      .from(purchaseOrders)
      .orderBy(sql`${purchaseOrders.number} DESC`)
      .limit(1);
    console.log(`  Last PO after the rename: ${last?.number}\n`);

    const [vendor] = await tx.select({ id: contacts.id }).from(contacts).limit(1);
    const user = await tx.execute(sql`SELECT id FROM users LIMIT 1`);
    const createdBy = (user.rows[0] as { id: string }).id;
    const raise = async (orderDate: string) => {
      const number = await nextDocumentNumber(tx, "purchase_order", null, orderDate);
      await tx.insert(purchaseOrders).values({ number, vendorId: vendor!.id, status: "draft", orderDate, createdBy });
      return number;
    };

    const seq = Number(last!.number.slice(-4));
    const today = await raise("2026-10-24");
    check("a new PO follows on from the last", today === `A-PO-27-${String(seq + 1).padStart(4, "0")}`, today);
    const next = await raise("2026-10-25");
    check("and the next after it", next === `A-PO-27-${String(seq + 2).padStart(4, "0")}`, next);
    const april = await raise("2027-04-01");
    check("1 April starts again at 0001", april === "A-PO-28-0001", april);
    const march = await raise("2027-03-31");
    check("a March PO keyed in April stays in FY 27", march === `A-PO-27-${String(seq + 3).padStart(4, "0")}`, march);
    const april2 = await raise("2027-04-02");
    check("April carries on from its own count", april2 === "A-PO-28-0002", april2);

    const [po] = await tx.select().from(purchaseOrders).where(eq(purchaseOrders.number, today));
    check("the PO is stored under its new number", !!po);
    throw new Rollback();
  });
} catch (err) {
  if (!(err instanceof Rollback)) throw err;
}

console.log(failed ? `\n  ${failed} check(s) FAILED` : "\n  All checks passed.");
process.exit(failed ? 1 : 0);
