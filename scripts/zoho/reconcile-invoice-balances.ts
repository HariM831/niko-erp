/**
 * Bring niko's invoice balances into line with Zoho's — the cutover's last
 * reconciliation.
 *
 * Why this exists: the pull resumes by id and never re-fetches a detail it
 * already holds. A payment pulled in early August carries the applications it
 * had THEN; everything Zoho applied from it afterwards — old advances settling
 * newer invoices — is invisible to the import. The symptom is money that shows
 * unapplied here and used there, and invoices due here and paid there.
 *
 * The one thing that cannot go stale is what this asks for: Zoho's CURRENT
 * balance per invoice, fetched fresh from the list endpoint every run. Where
 * niko shows more due than Zoho, the difference is applied from that
 * customer's unapplied payments oldest-first, with the same DR advances / CR
 * AR journal the loading bay posts — because that is exactly what Zoho did,
 * whatever its own pairing was. Where niko shows LESS due than Zoho, nothing
 * is touched and it is reported: that would mean niko invented money.
 *
 *   npx tsx scripts/zoho/reconcile-invoice-balances.ts             # dry
 *   npx tsx scripts/zoho/reconcile-invoice-balances.ts --commit
 */
import { and, asc, eq, sql } from "drizzle-orm";
import { customerPayments, invoices, paymentApplications, users, zohoIdMap } from "@shared/schema";
import { db, pool } from "../../server/db";
import { postJournal } from "../../server/services/posting";
import { zohoPages } from "./client";

const paise = (n: number | string | undefined) => Math.round(Number(n ?? 0) * 100);
const money = (p: number) => (p / 100).toFixed(2);

interface ZohoListInvoice {
  invoice_id: string;
  invoice_number: string;
  status: string;
  balance: number;
  total: number;
  customer_name: string;
}

async function main() {
  const commit = process.argv.includes("--commit");

  console.log("  fetching fresh balances for every invoice…");
  const fresh: ZohoListInvoice[] = [];
  for await (const page of zohoPages<ZohoListInvoice>("invoices", "invoices", {})) {
    fresh.push(...page.records);
  }
  console.log(`  ${fresh.length} invoice(s) in Zoho`);

  const idMap = new Map(
    (
      await db
        .select({ zohoId: zohoIdMap.zohoId, eggsyId: zohoIdMap.eggsyId })
        .from(zohoIdMap)
        .where(eq(zohoIdMap.entity, "invoice"))
    ).map((r) => [r.zohoId, r.eggsyId]),
  );
  const [admin] = await db.select({ id: users.id }).from(users).limit(1);

  let short = 0;
  let shortP = 0;
  const overs: string[] = [];
  const today = new Date().toISOString().slice(0, 10);

  for (const z of fresh) {
    if (z.status === "void" || z.status === "draft") continue;
    const eggsyId = idMap.get(z.invoice_id);
    if (!eggsyId) continue; // not imported (should not happen after the tail load)
    const [inv] = await db.select().from(invoices).where(eq(invoices.id, eggsyId));
    if (!inv || inv.status === "void") continue;

    const zohoBalP = paise(z.balance);
    const oursP = paise(inv.balanceDue);
    if (oursP === zohoBalP) continue;

    if (oursP < zohoBalP) {
      // niko says more of it is paid than Zoho does. Never "fixed" silently.
      overs.push(`${z.invoice_number}: niko due ${money(oursP)} < Zoho due ${money(zohoBalP)}`);
      continue;
    }

    const needP = oursP - zohoBalP;
    console.log(
      `  ${z.invoice_number.padEnd(20)} ${z.customer_name.slice(0, 28).padEnd(28)} apply ₹${money(needP).padStart(12)}`,
    );
    short++;
    shortP += needP;
    if (!commit) continue;

    await db.transaction(async (tx) => {
      // Oldest unapplied money first, same as the bay.
      const open = await tx
        .select()
        .from(customerPayments)
        .where(
          and(
            eq(customerPayments.customerId, inv.customerId),
            sql`${customerPayments.unappliedAmount}::numeric > 0`,
          ),
        )
        .orderBy(asc(customerPayments.paymentDate), asc(customerPayments.createdAt));

      let remainingP = needP;
      let appliedP = 0;
      for (const p of open) {
        if (remainingP <= 0) break;
        const takeP = Math.min(paise(p.unappliedAmount), remainingP);
        if (takeP <= 0) continue;
        await tx.insert(paymentApplications).values({
          paymentId: p.id,
          invoiceId: inv.id,
          amountApplied: money(takeP),
        });
        await tx
          .update(customerPayments)
          .set({ unappliedAmount: money(paise(p.unappliedAmount) - takeP) })
          .where(eq(customerPayments.id, p.id));
        remainingP -= takeP;
        appliedP += takeP;
      }
      if (remainingP > 0) {
        // The customer does not hold enough unapplied money to reach Zoho's
        // balance — refused rather than partially papered over.
        throw new Error(
          `${z.invoice_number}: needs ₹${money(needP)} applied but only ₹${money(needP - remainingP)} is available`,
        );
      }
      const newBalP = oursP - appliedP;
      await tx
        .update(invoices)
        .set({
          balanceDue: money(newBalP),
          status: newBalP === 0 ? "paid" : "partially_paid",
          updatedAt: new Date(),
        })
        .where(eq(invoices.id, inv.id));
      await postJournal(tx, {
        entryDate: today,
        narration: `Advance applied to ${inv.number} (Zoho reconciliation)`,
        sourceType: "advance_application",
        sourceId: inv.id,
        postedBy: admin!.id,
        lines: [
          { systemKey: "customer_advances", debit: money(appliedP) },
          { systemKey: "ar", credit: money(appliedP) },
        ],
      });
    });
  }

  console.log(`\n  ${short} invoice(s) short by ₹${money(shortP)} in total`);
  if (overs.length) {
    console.log(`  !! ${overs.length} invoice(s) where niko shows MORE paid than Zoho:`);
    for (const o of overs) console.log(`     ${o}`);
  }
  console.log(commit ? "  applied." : "  dry run — nothing written. Add --commit.");
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
