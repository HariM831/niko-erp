/**
 * Exercises the extracted bill / vendor-credit services against the real
 * database — then rolls back.
 *
 * The rollback is deliberate. These books hold live imported data, and a bill
 * posts to the general ledger: leaving test documents behind would move the
 * trial balance. Everything below runs inside one transaction that always
 * throws at the end, so the assertions see real SQL, real numbering and real
 * journal posting without a single row surviving.
 *
 * Run: npx tsx scripts/check-purchases-services.ts
 */
import { and, eq, inArray } from "drizzle-orm";
import { accounts, bills, contacts, journalEntryLines, users } from "@shared/schema";
import { db } from "../server/db";
import {
  applyVendorCredit,
  createBill,
  createVendorCredit,
  loadVendor,
} from "../server/services/purchases";

let failed = 0;
const check = (name: string, pass: boolean, actual = "") => {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${actual ? `   → ${actual}` : ""}`);
  if (!pass) failed++;
};

class Rollback extends Error {}

async function main() {
  const [vendor] = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(inArray(contacts.type, ["vendor", "both"]), eq(contacts.isActive, true)))
    .limit(1);
  if (!vendor) throw new Error("No active vendor in the database to test against");

  const [expenseAccount] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.type, "expense"), eq(accounts.isActive, true), eq(accounts.isGroup, false)))
    .limit(1);
  if (!expenseAccount) throw new Error("No postable expense account found");

  const [actor] = await db.select({ id: users.id }).from(users).limit(1);
  if (!actor) throw new Error("No user to attribute the documents to");

  try {
    await db.transaction(async (tx) => {
      const v = await loadVendor(tx, vendor.id);

      // A two-line bill, no tax — the shape office settlement will produce.
      const bill = await createBill(tx, {
        vendor: v,
        billDate: "2026-08-15",
        vendorBillNumber: "SELFTEST-524",
        lines: [
          { accountId: expenseAccount.id, name: "Maize", quantity: "24380", rate: "23.10" },
          { accountId: expenseAccount.id, name: "De-oiled rice bran", quantity: "6000", rate: "18.50" },
        ],
        postedBy: actor.id,
      });

      check("bill draws a number", /^BILL-/.test(bill.number), bill.number);
      // 24,380 × 23.10 = 563,178 ; 6,000 × 18.50 = 111,000
      check("bill total is the sum of its lines", bill.total === "674178.00", bill.total);
      check("balance due starts at the total", bill.balanceDue === bill.total, bill.balanceDue);
      check("bill posted a journal", !!bill.journalEntryId);

      const jl = await tx
        .select({ debit: journalEntryLines.debit, credit: journalEntryLines.credit })
        .from(journalEntryLines)
        .where(eq(journalEntryLines.entryId, bill.journalEntryId!));
      const dr = jl.reduce((s, l) => s + Math.round(Number(l.debit) * 100), 0);
      const cr = jl.reduce((s, l) => s + Math.round(Number(l.credit) * 100), 0);
      check("bill journal balances", dr === cr && dr === 67417800, `dr=${dr} cr=${cr}`);

      // A shortage deduction, the way settlement will raise it.
      const credit = await createVendorCredit(tx, {
        vendor: v,
        creditDate: "2026-08-15",
        billId: bill.id,
        lines: [{ accountId: expenseAccount.id, name: "Shortage — Maize 90 kg", quantity: "90", rate: "23.10" }],
        postedBy: actor.id,
      });
      check("credit total", credit.total === "2079.00", credit.total);

      const cl = await tx
        .select({ debit: journalEntryLines.debit, credit: journalEntryLines.credit })
        .from(journalEntryLines)
        .where(eq(journalEntryLines.entryId, credit.journalEntryId!));
      const cdr = cl.reduce((s, l) => s + Math.round(Number(l.debit) * 100), 0);
      const ccr = cl.reduce((s, l) => s + Math.round(Number(l.credit) * 100), 0);
      check("credit journal balances", cdr === ccr && cdr === 207900, `dr=${cdr} cr=${ccr}`);

      const applied = await applyVendorCredit(tx, {
        vendorCreditId: credit.id,
        applications: [{ billId: bill.id, amount: "2079.00" }],
      });
      check("credit is fully consumed", applied.balance === "0.00" && applied.status === "closed",
        `${applied.balance}/${applied.status}`);

      const [after] = await tx
        .select({ balanceDue: bills.balanceDue, status: bills.status })
        .from(bills)
        .where(eq(bills.id, bill.id));
      // 674,178 − 2,079 = 672,099 — the net payable after the deduction.
      check("bill balance falls by the credit", after?.balanceDue === "672099.00", String(after?.balanceDue));
      // Applying a credit is not a payment. The bill owes less, but nobody has
      // paid anything, so it stays open — only a receipt of money moves it to
      // partially_paid.
      check("a credit alone does not make the bill partially paid", after?.status === "open", String(after?.status));

      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }

  console.log(failed === 0 ? "\nAll checks passed (transaction rolled back)." : `\n${failed} check(s) FAILED.`);
  process.exit(failed ? 1 : 0);
}

void main();
