/**
 * Checks statement-line matching and categorizing (docs/banking-categorize-plan.md)
 * against the real database — then rolls back.
 *
 * Every account, bank, contact, journal and statement line it reads is made
 * here, inside the transaction, with made-up names and numbers, so nothing in
 * the books can match it.
 *
 * Run: npx tsx scripts/check-bank-links.ts
 */
import { and, eq } from "drizzle-orm";
import { accounts, bankAccounts, bankTransactionLinks, bankTransactions, contacts, customerPayments, users } from "@shared/schema";
import { db, type Tx } from "../server/db";
import { postJournal, reverseJournal, PostingError } from "../server/services/posting";
import {
  assertLineFits,
  bankRefTokens,
  carryLinks,
  pickConfident,
  sharesBankRef,
  linkStatementLine,
  linkedStatementLine,
  squeezeName,
  suggestParties,
} from "../server/services/bank-links";
import { deleteCustomerPayment } from "../server/routes/sales";

let failed = 0;
const check = (name: string, pass: boolean, actual = "") => {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${actual ? `   → ${actual}` : ""}`);
  if (!pass) failed++;
};
const refuses = async (name: string, fn: () => Promise<unknown>, needle: string) => {
  try {
    await fn();
    check(name, false, "was allowed");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    check(name, err instanceof PostingError && msg.includes(needle), msg);
  }
};

class Rollback extends Error {}

async function main() {
  // ── Pure rules ──
  console.log("Party names");
  check("and = n", squeezeName("CHOWDHURY AND SONS") === squeezeName("Chowdhury n Sons"), squeezeName("CHOWDHURY AND SONS"));
  check("spaced initials", squeezeName("D N STORE /") === squeezeName("DN Store"), squeezeName("D N STORE /"));
  check("M/s dropped", squeezeName("M/s Annapurna Bakery") === "annapurnabakery", squeezeName("M/s Annapurna Bakery"));
  const people = [
    { id: "a", displayName: "Zqx Plorb n Sons" },
    { id: "b", displayName: "Wibble Store", accountNumber: "0031704866695" },
    { id: "c", displayName: "Abc" },
    { id: "d", displayName: "Plorb" },
  ];
  const s1 = suggestParties("BY TRANSFER- RTGS UTR NO: XYZ123 · TRANSFER FROM 99 / ZQX PLORB AND SONS", people);
  check("name found, longest first", s1[0]?.id === "a" && s1[0]?.reason === "name", JSON.stringify(s1));
  check("short names ignored", !s1.some((s) => s.id === "c"));
  const s2 = suggestParties("TO TRANSFER- CMPIFT/0710 · TRANSFER TO 31704866695 Mr. SOMEONE ELSE /", people);
  check("account number wins", s2[0]?.id === "b" && s2[0]?.reason === "bank account number", JSON.stringify(s2));

  console.log("Bank references");
  check("RTGS UTR the PDF wrapped", sharesBankRef("PSIBR22026100700876935", "BY TRANSFER- RTGS UTR NO: PSIBR22026100700 876935- CHOWDHURY"));
  check("IMPS number inside Zoho's reference", sharesBankRef("IMPS/628012734673/iob", "BY TRANSFER- IMPS/628012734673 /CNB-XX097- DEBAJEET"));
  check("an IFSC alone ties nothing", !sharesBankRef("NEFT*CBIN0281346*CBINH26", "BY TRANSFER- NEFT*CBIN0281346 *CBINH2699999999 2*MS PROTIEN"));
  check("short codes ignored", bankRefTokens("RE1 iob 12345").length === 0, JSON.stringify(bankRefTokens("RE1 iob 12345")));

  console.log("Auto-match picks");
  const picks = pickConfident([
    { lineId: "L1", entryId: "E1", party: "same", sharedRef: false }, // payer only: yes
    { lineId: "L2", entryId: "E2", party: undefined, sharedRef: true }, // reference only: yes
    { lineId: "L3", entryId: "E3", party: undefined, sharedRef: false }, // amount only: no
    { lineId: "L4", entryId: "E4", party: "other", sharedRef: true }, // someone else's: no
    { lineId: "L5", entryId: "E5", party: "same", sharedRef: false }, // two fits: no
    { lineId: "L5", entryId: "E6", party: "same", sharedRef: true },
    { lineId: "L6", entryId: "E7", party: "same", sharedRef: false }, // one document, two lines: neither
    { lineId: "L7", entryId: "E7", party: "same", sharedRef: false },
  ]);
  check("payer or reference, alone and unique", JSON.stringify(picks.map((p) => p.lineId)) === JSON.stringify(["L1", "L2"]), JSON.stringify(picks));

  const [actor] = await db.select({ id: users.id }).from(users).limit(1);
  if (!actor) throw new Error("No user to attribute the documents to");

  await db
    .transaction(async (tx) => {
      const tag = `ZQ${Date.now() % 100000}`;
      const glA = await account(tx, `${tag}A`, "asset", "bank");
      const glB = await account(tx, `${tag}B`, "asset", "bank");
      const income = await account(tx, `${tag}I`, "income", null);
      const [bankA] = await tx.insert(bankAccounts).values({ name: `${tag} Bank A`, glAccountId: glA }).returning();
      const [bankB] = await tx.insert(bankAccounts).values({ name: `${tag} Bank B`, glAccountId: glB }).returning();
      const line = async (bank: string, direction: "credit" | "debit", amount: string, txnDate = "2026-10-07") =>
        (await tx.insert(bankTransactions).values({ bankAccountId: bank, txnDate, direction, amount, description: tag }).returning())[0]!;
      const je = (lines: Array<{ accountId: string; debit?: string; credit?: string }>, date = "2026-10-07") =>
        postJournal(tx, { entryDate: date, narration: tag, sourceType: "manual", postedBy: actor.id, lines: lines as never });

      console.log("Match");
      const l1 = await line(bankA!.id, "credit", "1000.00");
      const j600 = await je([{ accountId: glA, debit: "600.00" }, { accountId: income, credit: "600.00" }]);
      const j400 = await je([{ accountId: glA, debit: "400.00" }, { accountId: income, credit: "400.00" }], "2026-10-08");
      await refuses("one short of the line", () => linkStatementLine(tx, { bankTransactionId: l1.id, journalEntryIds: [j600], kind: "matched" }), "come to 600.00 in");
      const noBank = await je([{ accountId: income, debit: "5.00" }, { accountId: glB, credit: "5.00" }]);
      await refuses("a journal that does not move this bank", () => linkStatementLine(tx, { bankTransactionId: l1.id, journalEntryIds: [j600, noBank], kind: "matched" }), "does not move");
      const m = await linkStatementLine(tx, { bankTransactionId: l1.id, journalEntryIds: [j600, j400], kind: "matched" });
      check("two journals make up one deposit", m.matchStatus === "matched");
      const links = await tx.select().from(bankTransactionLinks).where(eq(bankTransactionLinks.bankTransactionId, l1.id));
      check("both linked", links.length === 2, String(links.length));
      const l1b = await line(bankA!.id, "credit", "600.00");
      await refuses("a journal matched once per bank", () => linkStatementLine(tx, { bankTransactionId: l1b.id, journalEntryIds: [j600], kind: "matched" }), "already matched");
      await refuses("a matched line cannot be matched again", () => linkStatementLine(tx, { bankTransactionId: l1.id, journalEntryIds: [j600], kind: "matched" }), "already matched or categorized");

      console.log("Deposit met by a receipt less a payment");
      const l2 = await line(bankA!.id, "credit", "700.00");
      const jIn = await je([{ accountId: glA, debit: "1000.00" }, { accountId: income, credit: "1000.00" }]);
      const jOut = await je([{ accountId: income, debit: "300.00" }, { accountId: glA, credit: "300.00" }]);
      const m2 = await linkStatementLine(tx, { bankTransactionId: l2.id, journalEntryIds: [jIn, jOut], kind: "matched" });
      check("net of in and out", m2.matchStatus === "matched");

      console.log("Transfer, one journal on two statements");
      const tr = await je([{ accountId: glB, debit: "500.00" }, { accountId: glA, credit: "500.00" }]);
      const outA = await line(bankA!.id, "debit", "500.00");
      const inB = await line(bankB!.id, "credit", "500.00");
      await linkStatementLine(tx, { bankTransactionId: outA.id, journalEntryIds: [tr], kind: "categorized" });
      const mB = await linkStatementLine(tx, { bankTransactionId: inB.id, journalEntryIds: [tr], kind: "matched" });
      check("matched on the other bank too", mB.matchStatus === "matched");

      console.log("Made from the line");
      const l3 = await line(bankA!.id, "credit", "250.00");
      await refuses("wrong bank", () => assertLineFits(tx, l3.id, { bankAccountId: bankB!.id, date: "2026-10-07" }), "that line's bank account");
      await refuses("wrong date", () => assertLineFits(tx, l3.id, { bankAccountId: bankA!.id, date: "2026-10-06" }), "statement date");
      await assertLineFits(tx, l3.id, { bankAccountId: bankA!.id, date: "2026-10-07" });
      check("right bank and date pass", true);

      console.log("Edits follow the line");
      const jEdit = await je([{ accountId: glA, debit: "250.00" }, { accountId: income, credit: "250.00" }]);
      await linkStatementLine(tx, { bankTransactionId: l3.id, journalEntryIds: [jEdit], kind: "categorized" });
      await reverseJournal(tx, jEdit, "2026-10-07", actor.id);
      const jSame = await je([{ accountId: glA, debit: "250.00" }, { accountId: income, credit: "250.00" }]);
      await carryLinks(tx, jEdit, jSame, "TEST-1");
      const moved = await tx.select().from(bankTransactionLinks).where(eq(bankTransactionLinks.bankTransactionId, l3.id));
      check("same amount: link moves to the new journal", moved[0]?.journalEntryId === jSame);
      await reverseJournal(tx, jSame, "2026-10-07", actor.id);
      const jMore = await je([{ accountId: glA, debit: "260.00" }, { accountId: income, credit: "260.00" }]);
      await refuses("changed amount refused", () => carryLinks(tx, jSame, jMore, "TEST-1"), "unmatch it in Banking");

      console.log("Uncategorizing a customer payment");
      const [customer] = await tx.insert(contacts).values({ type: "customer", displayName: `${tag} Traders` }).returning();
      const l4 = await line(bankA!.id, "credit", "900.00");
      const [pay] = await tx
        .insert(customerPayments)
        .values({ number: `${tag}-P1`, customerId: customer!.id, paymentDate: "2026-10-07", amount: "900.00", unappliedAmount: "900.00", bankAccountId: bankA!.id, createdBy: actor.id })
        .returning();
      const jPay = await postJournal(tx, {
        entryDate: "2026-10-07",
        narration: tag,
        sourceType: "customer_payment",
        sourceId: pay!.id,
        postedBy: actor.id,
        lines: [{ accountId: glA, debit: "900.00" }, { systemKey: "customer_advances", credit: "900.00" }] as never,
      });
      await tx.update(customerPayments).set({ journalEntryId: jPay }).where(eq(customerPayments.id, pay!.id));
      await linkStatementLine(tx, { bankTransactionId: l4.id, journalEntryIds: [jPay], kind: "categorized" });
      check("linked payment is found", !!(await linkedStatementLine(tx, [jPay])));
      await refuses("deleting a matched payment refused", () => deleteCustomerPayment(tx, pay!.id), "matched to a bank statement line");
      // What unmatch does: let go of the links, then delete what the line made.
      await tx.delete(bankTransactionLinks).where(eq(bankTransactionLinks.bankTransactionId, l4.id));
      const gone = await deleteCustomerPayment(tx, pay!.id);
      check("then deleted", gone.number === `${tag}-P1`);
      const left = await tx.select().from(customerPayments).where(and(eq(customerPayments.id, pay!.id)));
      check("payment row gone", left.length === 0);

      throw new Rollback();
    })
    .catch((err) => {
      if (!(err instanceof Rollback)) throw err;
    });

  console.log(failed ? `\n${failed} FAILED` : "\nAll passed (rolled back)");
  process.exit(failed ? 1 : 0);
}

async function account(tx: Tx, code: string, type: "asset" | "income", subtype: "bank" | null) {
  const [a] = await tx
    .insert(accounts)
    .values({ code, name: `Check ${code}`, type, subtype: subtype as never })
    .returning({ id: accounts.id });
  return a!.id;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
