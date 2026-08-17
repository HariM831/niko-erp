/**
 * Checks that a deduction can live on the bill instead of on a vendor credit.
 *
 * Settlement now raises ONE document: the goods at the vendor's own figure, then
 * a negative line per deduction. The vendor never countersigned a credit note,
 * so the second document bought nothing a line on the first does not — and this
 * way the goods line still ties to their invoice figure for figure, with the
 * difference explained one row below it.
 *
 * Three things have to hold, and two of them are easy to get wrong:
 *
 *   the bill TOTAL is the net, so a payment goes against one number;
 *   the JOURNAL still balances, and posts no negative amount — a deduction on
 *     the same account as its goods nets into one debit rather than a pair that
 *     cancel, and where it outweighs the goods the account is CREDITED instead;
 *   the goods line keeps the vendor's own figure, untouched.
 *
 * Rolled back, so no bill, journal or payable survives.
 *
 * Run: npx tsx scripts/check-bill-deductions.ts
 */
import { eq, sql } from "drizzle-orm";
import { accounts, billLines, bills, contacts, journalEntryLines, users } from "@shared/schema";
import { db } from "../server/db";
import { createBill, loadVendor } from "../server/services/purchases";

let failed = 0;
const check = (name: string, pass: boolean, detail = "") => {
  if (!pass) failed++;
  console.log(`    ${pass ? "PASS" : "FAIL"}  ${name.padEnd(56)} ${detail}`);
};

class Rollback extends Error {}

const inr = (v: string | number) =>
  `₹${Number(v).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;

try {
  await db.transaction(async (tx) => {
    const [vendorRow] = await tx
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.type, "vendor"))
      .limit(1);
    const [expense] = await tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.type, "expense"))
      .limit(1);
    const [actor] = await tx.select({ id: users.id }).from(users).limit(1);
    if (!vendorRow || !expense || !actor) throw new Error("Need a vendor, an expense account and a user");
    const vendor = await loadVendor(tx, vendorRow.id);

    // Bill 518's real shape: 40,790 kg of maize at ₹23.10, less a moisture
    // deduction the rules worked out at 1.1 points over 14.
    const GOODS = 40790 * 23.1; // 942,249.00
    const DEDUCTION = 6172.09;

    console.log("\n  ONE BILL, GOODS THEN DEDUCTION\n");

    const bill = await createBill(tx, {
      vendor,
      billDate: "2026-08-17",
      vendorBillNumber: "518-DEDUCTION-CHECK",
      lines: [
        { name: "Maize", accountId: expense.id, quantity: "40790.000", rate: "23.100000" },
        {
          name: "Moisture over 14%",
          accountId: expense.id,
          quantity: "1.000",
          rate: (-DEDUCTION).toFixed(6),
          description: "1.1% over 14 × 40,790 kg × ₹23.1/kg ÷ 100",
        },
      ],
      postedBy: actor.id,
    });

    const lines = await tx
      .select({ name: billLines.name, quantity: billLines.quantity, amount: billLines.amount })
      .from(billLines)
      .where(eq(billLines.billId, bill.id));

    const goods = lines.find((l) => l.name === "Maize");
    const cut = lines.find((l) => l.name.startsWith("Moisture"));

    check(
      "the goods line keeps the vendor's own figure",
      Number(goods?.amount) === GOODS,
      `${inr(goods?.amount ?? 0)} — their invoice ties line for line`,
    );
    check("the deduction line is negative", Number(cut?.amount) === -DEDUCTION, inr(cut?.amount ?? 0));
    check(
      "the bill total is the net, with nothing to net it against",
      Math.abs(Number(bill.total) - (GOODS - DEDUCTION)) <= 1,
      `${inr(bill.total)} = ${inr(GOODS)} − ${inr(DEDUCTION)}`,
    );
    check(
      "the balance due starts at the net, so one payment closes it",
      bill.balanceDue === bill.total,
      inr(bill.balanceDue),
    );
    check("no credit is raised, so nothing sits unapplied", bill.status === "open", bill.status);

    console.log("\n  THE JOURNAL\n");

    const je = await tx
      .select({ debit: journalEntryLines.debit, credit: journalEntryLines.credit, accountId: journalEntryLines.accountId })
      .from(journalEntryLines)
      .where(eq(journalEntryLines.entryId, bill.journalEntryId!));

    const dr = je.reduce((s, l) => s + Number(l.debit ?? 0), 0);
    const cr = je.reduce((s, l) => s + Number(l.credit ?? 0), 0);
    check("it balances", Math.abs(dr - cr) < 0.005, `dr ${inr(dr)} cr ${inr(cr)}`);
    check(
      "no amount is negative — posting refuses those by design",
      je.every((l) => Number(l.debit ?? 0) >= 0 && Number(l.credit ?? 0) >= 0),
    );

    // The deduction shares the goods account, so the two collapse into ONE
    // debit. A pair that cancel would balance too, and read as nonsense.
    const onExpense = je.filter((l) => l.accountId === expense.id);
    check(
      "the deduction nets into the goods debit, not a second line",
      onExpense.length === 1,
      `${onExpense.length} line(s) on the purchase account`,
    );
    check(
      "and that debit is the net expense",
      Math.abs(Number(onExpense[0]?.debit ?? 0) - (GOODS - DEDUCTION)) <= 1,
      inr(onExpense[0]?.debit ?? 0),
    );

    console.log("\n  WHEN A DEDUCTION OUTWEIGHS ITS OWN GOODS LINE\n");

    // Two accounts: the deduction sinks one of them below zero while the bill
    // as a whole stays positive. That account has to be CREDITED — posting
    // refuses a negative amount, so the sign lives in the side, not the figure.
    const [second] = await tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(sql`${accounts.type} = 'expense' AND ${accounts.id} <> ${expense.id}::uuid`)
      .limit(1);
    if (!second) throw new Error("Need a second expense account");

    const split = await createBill(tx, {
      vendor,
      billDate: "2026-08-17",
      lines: [
        { name: "DORB", accountId: second.id, quantity: "1000.000", rate: "18.500000" },
        { name: "Maize", accountId: expense.id, quantity: "100.000", rate: "10.000000" },
        { name: "Damage — maize", accountId: expense.id, quantity: "1.000", rate: "-4000.000000" },
      ],
      postedBy: actor.id,
    });
    const splitJe = await tx
      .select({ debit: journalEntryLines.debit, credit: journalEntryLines.credit, accountId: journalEntryLines.accountId })
      .from(journalEntryLines)
      .where(eq(journalEntryLines.entryId, split.journalEntryId!));
    const sunk = splitJe.find((l) => l.accountId === expense.id);
    check(
      "the account it sank is credited, not debited a negative",
      Number(sunk?.credit ?? 0) > 0 && Number(sunk?.debit ?? 0) === 0,
      `credit ${inr(sunk?.credit ?? 0)} on the maize account`,
    );
    check(
      "and the entry still balances",
      Math.abs(
        splitJe.reduce((s, l) => s + Number(l.debit ?? 0), 0) -
          splitJe.reduce((s, l) => s + Number(l.credit ?? 0), 0),
      ) < 0.005,
      `bill total ${inr(split.total)}`,
    );

    console.log("\n  WHEN A DEDUCTION OUTWEIGHS THE WHOLE BILL\n");

    // Then it is not a bill. Forcing it through would post a negative credit to
    // Accounts Payable and leave a payable the vendor owes US in the ledger.
    let refused = "";
    try {
      await tx.transaction(async (inner) =>
        createBill(inner, {
          vendor,
          billDate: "2026-08-17",
          lines: [
            { name: "Maize", accountId: expense.id, quantity: "100.000", rate: "10.000000" },
            { name: "Penalty", accountId: expense.id, quantity: "1.000", rate: "-4000.000000" },
          ],
          postedBy: actor.id,
        }),
      );
    } catch (e) {
      refused = (e as Error).message;
    }
    check(
      "a bill that comes to less than nothing is refused",
      refused.includes("cannot be owed to us"),
      refused.slice(0, 72) || "NOT REFUSED",
    );

    console.log("\n  WHAT A RULE HAS COST\n");

    const asked = await tx.execute(sql`
      SELECT count(*)::int AS lines, sum(-amount)::text AS total
      FROM bill_lines WHERE bill_id = ${bill.id}::uuid AND amount < 0
    `);
    const row = asked.rows[0] as { lines: number; total: string };
    check(
      "a deduction is findable as a negative line, and reads positive",
      row.lines === 1 && Number(row.total) === DEDUCTION,
      `${row.lines} line(s), ${inr(row.total)}`,
    );

    throw new Rollback();
  });
} catch (e) {
  if (!(e instanceof Rollback)) throw e;
}

// A distinctive marker: real bills carry vendor number 518 too, and matching
// those would report leftovers this run never created.
const stray = await db
  .select({ id: bills.id })
  .from(bills)
  .where(eq(bills.vendorBillNumber, "518-DEDUCTION-CHECK"));
check("nothing survives the run", stray.length === 0, `${stray.length} bill(s) left`);

console.log(failed === 0 ? "\n  All bill-deduction checks passed.\n" : `\n  ${failed} FAILED.\n`);
process.exit(failed ? 1 : 0);
