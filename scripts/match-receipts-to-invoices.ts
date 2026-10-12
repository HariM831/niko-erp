/**
 * Put the money already received against the invoices it paid, oldest first.
 *
 *   npx tsx scripts/match-receipts-to-invoices.ts            # say what would happen
 *   npx tsx scripts/match-receipts-to-invoices.ts --apply    # do it
 *   npx tsx scripts/match-receipts-to-invoices.ts --customer "Sahil Egg Center"
 *
 * Zoho shows 103 invoices overdue and 86 lakh of receipts applied to nothing.
 * They are the same money: Sahil Egg Center "owes" 42,62,546 and has
 * 42,62,546 sitting unapplied against it, to the rupee. Nobody failed to pay —
 * somebody failed to tick a box. Imported as-is that becomes niko's problem
 * too, so the allocation is done here instead.
 *
 * Oldest invoice first, oldest receipt first, which is how a running account
 * actually settles and what the customer will have assumed. A receipt is spread
 * across as many invoices as it covers, and an invoice takes from as many
 * receipts as it needs.
 *
 * It goes through applyCredits — the same service behind the Apply Credits
 * screen — so the journal comes with it: DR customer advances, CR receivables.
 * Writing payment_applications directly would settle the invoice on the screen
 * and leave the ledger saying the money is still an advance.
 *
 * The group companies are left alone. Their balances are intra-group, nobody
 * is chasing them, and a FIFO sweep across 20 crore of LLP billing is not a
 * tidy-up — it is a decision that has not been taken yet.
 */
import { and, asc, eq, gt, ne, sql } from "drizzle-orm";
import { contacts, customerPayments, invoices } from "@shared/schema";
import { applyCredits } from "../server/services/apply-credits";
import { db, pool } from "../server/db";

const APPLY = process.argv.includes("--apply");
const only = process.argv.includes("--customer")
  ? process.argv[process.argv.indexOf("--customer") + 1]
  : undefined;

/** Intra-group; settled by agreement, not by FIFO. */
const SKIP = [/nandamuri/i, /luit valley/i];

const paise = (s: string | number) => Math.round(Number(s) * 100);
const rupees = (p: number) => (p / 100).toFixed(2);

async function main() {
  console.log(`\n  Matching receipts to invoices, oldest first — ${APPLY ? "WRITING" : "dry run"}\n`);

  const open = await db
    .select({
      id: invoices.id, number: invoices.number, date: invoices.invoiceDate,
      balance: invoices.balanceDue, customerId: invoices.customerId, name: contacts.displayName,
    })
    .from(invoices)
    .innerJoin(contacts, eq(contacts.id, invoices.customerId))
    .where(and(gt(invoices.balanceDue, "0"), ne(invoices.status, "void")))
    .orderBy(asc(invoices.invoiceDate), asc(invoices.number));

  const spare = await db
    .select({
      id: customerPayments.id, number: customerPayments.number,
      date: customerPayments.paymentDate, left: customerPayments.unappliedAmount,
      customerId: customerPayments.customerId,
    })
    .from(customerPayments)
    .where(gt(customerPayments.unappliedAmount, "0"))
    .orderBy(asc(customerPayments.paymentDate), asc(customerPayments.number));

  const byCustomer = new Map<string, { name: string; inv: typeof open; pay: typeof spare }>();
  for (const i of open) {
    if (SKIP.some((re) => re.test(i.name))) continue;
    if (only && i.name !== only) continue;
    const e = byCustomer.get(i.customerId) ?? { name: i.name, inv: [], pay: [] };
    e.inv.push(i);
    byCustomer.set(i.customerId, e);
  }
  for (const p of spare) {
    const e = byCustomer.get(p.customerId);
    if (e) e.pay.push(p);
  }

  let invoicesSettled = 0, partly = 0, totalP = 0, leftoverP = 0;
  const plan: Array<{ invoiceId: string; number: string; apps: Array<{ kind: "advance"; id: string; amount: string }>; label: string }> = [];

  for (const [, c] of byCustomer) {
    if (!c.pay.length) continue;
    const purse = c.pay.map((p) => ({ ...p, leftP: paise(p.left) }));
    for (const inv of c.inv) {
      let owedP = paise(inv.balance);
      const apps: Array<{ kind: "advance"; id: string; amount: string }> = [];
      const bits: string[] = [];
      for (const p of purse) {
        if (owedP <= 0) break;
        if (p.leftP <= 0) continue;
        // A receipt taken before the invoice existed is an advance against it,
        // which is ordinary on a running account — but it is worth seeing.
        const useP = Math.min(owedP, p.leftP);
        apps.push({ kind: "advance", id: p.id, amount: rupees(useP) });
        bits.push(`${p.number}${p.date < inv.date ? "*" : ""} ${rupees(useP)}`);
        p.leftP -= useP;
        owedP -= useP;
        totalP += useP;
      }
      if (!apps.length) continue;
      if (owedP === 0) invoicesSettled++; else partly++;
      plan.push({ invoiceId: inv.id, number: inv.number, apps,
                  label: `  ${inv.number}  ${inv.date}  ${c.name.slice(0, 24).padEnd(25)}` +
                         `${inv.balance.padStart(12)} <- ${bits.join(", ")}` });
    }
    leftoverP += purse.reduce((s, p) => s + Math.max(0, p.leftP), 0);
  }

  for (const p of plan.slice(0, 25)) console.log(p.label);
  if (plan.length > 25) console.log(`  ... and ${plan.length - 25} more invoices`);
  console.log(`\n    invoices settled in full ... ${invoicesSettled}`);
  console.log(`    invoices part-settled ...... ${partly}`);
  // paise, so a lakh is 1e7 and a crore is 1e9. Getting this wrong once
  // printed 3.23 crore for 3.23 lakh.
  const lakh = (p: number) => (p / 10000000).toFixed(2);
  console.log(`    cash allocated ............. Rs ${lakh(totalP)} lakh`);
  console.log(`    cash still unapplied ....... Rs ${lakh(leftoverP)} lakh`);
  console.log(`    (* = receipt predates the invoice, i.e. a true advance)`);

  if (!APPLY) {
    console.log("\n  Dry run — nothing written. Re-run with --apply.\n");
    await pool.end();
    return;
  }

  let done = 0;
  for (const p of plan) {
    // One transaction per invoice: a customer whose allocation is refused does
    // not take the other two hundred down with it.
    try {
      await db.transaction(async (tx) => {
        await applyCredits(tx, "customer", p.invoiceId, p.apps);
      });
      done++;
    } catch (e) {
      console.log(`  ! ${p.number}: ${(e as Error).message}`);
    }
  }
  console.log(`\n  Applied against ${done} of ${plan.length} invoice(s).\n`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(`\n  ${e.message}\n`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
