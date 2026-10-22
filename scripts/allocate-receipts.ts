/**
 * Put niko's own receipts against the invoices they actually paid.
 *
 *   npx tsx scripts/allocate-receipts.ts
 *   npx tsx scripts/allocate-receipts.ts --customer "Tapan Saha" --verbose
 *   npx tsx scripts/allocate-receipts.ts --commit
 *
 * Two books were kept at once from August to October. Zoho's receipts carry
 * Zoho's allocation, which the user settled on 16 Oct 2026: Zoho wins. niko's
 * own receipts — the PMT- ones keyed from the bank statement — carry whatever
 * they were given at the time, and nobody reconciled the two. The result is
 * eighteen invoices with more against them than they are worth: Zoho settled
 * A-INV-EG-27-0829 with its two September receipts, and PMT-00019 settled it
 * again from the statement.
 *
 * So Zoho's applications are left exactly as they are, and only niko's own
 * receipts are re-placed, onto whatever each customer still genuinely owes.
 *
 * WHICH INVOICE A RECEIPT PAYS. The user, 17 Oct 2026: payment comes first and
 * the invoice on the same day or the next. So a receipt looks forward, never
 * back — same day, next day, the day after — and an invoice whose balance is
 * exactly the receipt is taken before anything else, because that is a load
 * paid for. Only once every receipt has had that chance does the leftover go
 * against older open invoices, oldest first, which is the second pass and what
 * drives receivables to nothing: there are no credit sales here, so a customer
 * still owing at the end means money we have not found, not credit we gave.
 *
 * Anything still unplaced stays where it belongs, as the customer's advance.
 *
 * THE LEDGER. Moving an application between two invoices of the same customer
 * changes nothing in the ledger — the money was already in receivables. Only
 * the total a receipt applies matters, and when that changes this posts the
 * same advance_application entry the invoice screen posts when it takes up an
 * advance: DR customer advances, CR receivables, or the reverse when a receipt
 * gives money back.
 *
 * Group companies are excluded by decision: their advances stay unapplied.
 */
import { eq, sql } from "drizzle-orm";
import { customerPayments, paymentApplications } from "@shared/schema";
import { postJournal } from "../server/services/posting";
import { db, pool } from "../server/db";

const COMMIT = process.argv.includes("--commit");
const VERBOSE = process.argv.includes("--verbose");
const custAt = process.argv.indexOf("--customer");
const ONLY = custAt > -1 ? process.argv[custAt + 1]! : undefined;
/**
 * How far forward a receipt looks for the sale it paid for. The user,
 * 22 Oct 2026: every payment usually comes the day before the invoice or on
 * the day itself. So a receipt of the 7th may settle an invoice of the 7th or
 * the 8th, and nothing else.
 *
 * It was two days, with a second pass that put whatever was left against the
 * oldest invoice still open. That pass is what went wrong: it reached
 * backwards for months — a receipt of 16 April settled a sale of 17 September
 * on A-INV-EG-27-0826 — and an allocation that can reach any distance will
 * always find something to settle, whether or not it is the right thing.
 * Money with no sale beside it stays where it is, as the customer's advance.
 */
const WINDOW = Number(process.env.ALLOCATE_WINDOW ?? 1);
/** The old mop-up, kept behind a flag for the day somebody wants it. */
const SETTLE_OLDER = process.argv.includes("--settle-older");

const P = (n: string | number) => Math.round(Number(n) * 100);
const R = (p: number) => (p / 100).toFixed(2);
const money = (p: number) => (p / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 });
const day = (s: string) => Date.parse(s) / 86_400_000;

interface Inv { id: string; number: string; date: string; totalP: number; fixedP: number; openP: number }
/**
 * `own` is a receipt keyed here, which is re-placed from scratch. `advance` is
 * the part of a Zoho receipt that Zoho never put against anything: its own
 * applications stand, because Zoho wins on allocation, but what it left loose
 * is loose. The two are written differently and allocated the same.
 */
interface Rec { id: string; number: string; date: string; kind: "own" | "advance";
                amountP: number; wasP: number; now: Array<{ invoiceId: string; p: number }> }

async function main() {
  console.log(`\n  Allocating niko's own receipts — ${COMMIT ? "COMMITTING" : "dry run"}\n`);

  const owners = (
    await db.execute(sql`
      SELECT c.id, c.display_name AS name
        FROM contacts c
       WHERE c.is_group_company = false
         AND EXISTS (SELECT 1 FROM customer_payments p
                      WHERE p.customer_id = c.id
                        AND (p.unapplied_amount::numeric > 0
                             OR NOT EXISTS (SELECT 1 FROM zoho_id_map z
                                             WHERE z.entity = 'customer_payment' AND z.eggsy_id = p.id)))
         ${ONLY ? sql`AND c.display_name = ${ONLY}` : sql``}
       ORDER BY c.display_name
    `)
  ).rows as Array<{ id: string; name: string }>;

  let movedRupees = 0, moves = 0, touched = 0;
  const before = { owedP: 0, advanceP: 0 };
  const after = { owedP: 0, advanceP: 0 };
  const changes: Array<{ cust: string; recs: Rec[] }> = [];
  const perCust: Array<{ name: string; wasP: number; nowP: number; advP: number; openInvs: Inv[] }> = [];

  for (const cust of owners) {
    const invs = (
      await db.execute(sql`
        SELECT i.id::text, i.number, i.invoice_date::text AS date, i.total::text AS total,
               coalesce((SELECT sum(pa.amount_applied) FROM payment_applications pa
                           JOIN customer_payments p ON p.id = pa.payment_id
                          WHERE pa.invoice_id = i.id
                            AND EXISTS (SELECT 1 FROM zoho_id_map z
                                         WHERE z.entity = 'customer_payment' AND z.eggsy_id = p.id)), 0)::text AS zoho_applied,
               coalesce((SELECT sum(cna.amount_applied) FROM credit_note_applications cna
                          WHERE cna.invoice_id = i.id), 0)::text AS credited
          FROM invoices i
         WHERE i.customer_id = ${cust.id} AND i.status NOT IN ('void', 'draft')
         ORDER BY i.invoice_date, i.number
      `)
    ).rows as Array<{ id: string; number: string; date: string; total: string; zoho_applied: string; credited: string }>;

    const recs = (
      await db.execute(sql`
        SELECT p.id::text, p.number, p.payment_date::text AS date, p.amount::text,
               coalesce((SELECT sum(pa.amount_applied) FROM payment_applications pa
                          WHERE pa.payment_id = p.id), 0)::text AS applied
          FROM customer_payments p
         WHERE p.customer_id = ${cust.id}
           AND NOT EXISTS (SELECT 1 FROM zoho_id_map z
                            WHERE z.entity = 'customer_payment' AND z.eggsy_id = p.id)
         ORDER BY p.payment_date, p.number
      `)
    ).rows as Array<{ id: string; number: string; date: string; amount: string; applied: string }>;

    /**
     * The money Zoho took and never put against a sale. On 17 Oct 2026 that
     * was Rs 1.31 crore of the trade's own advances sitting against Rs 1.98
     * crore of open invoices — the same customers, both sides. Zoho's
     * applications are left exactly as they are; only the remainder moves.
     */
    const loose = (
      await db.execute(sql`
        SELECT p.id::text, p.number, p.payment_date::text AS date, p.unapplied_amount::text AS spare
          FROM customer_payments p
         WHERE p.customer_id = ${cust.id}
           AND p.unapplied_amount::numeric > 0
           AND EXISTS (SELECT 1 FROM zoho_id_map z
                        WHERE z.entity = 'customer_payment' AND z.eggsy_id = p.id)
         ORDER BY p.payment_date, p.number
      `)
    ).rows as Array<{ id: string; number: string; date: string; spare: string }>;
    if (!recs.length && !loose.length) continue;

    const pool_: Inv[] = invs.map((i) => {
      const totalP = P(i.total);
      const fixedP = P(i.zoho_applied) + P(i.credited);
      return { id: i.id, number: i.number, date: i.date, totalP, fixedP, openP: Math.max(0, totalP - fixedP) };
    });
    const free: Rec[] = [
      ...recs.map((r) => ({
        id: r.id, number: r.number, date: r.date, kind: "own" as const,
        amountP: P(r.amount), wasP: P(r.applied), now: [],
      })),
      ...loose.map((r) => ({
        id: r.id, number: r.number, date: r.date, kind: "advance" as const,
        amountP: P(r.spare), wasP: 0, now: [],
      })),
    ].sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number));

    before.owedP += pool_.reduce((s, i) => s + i.openP, 0);
    before.advanceP += free.reduce((s, r) => s + (r.amountP - r.wasP), 0);

    const take = (r: Rec, inv: Inv, p: number) => {
      if (p <= 0) return 0;
      r.now.push({ invoiceId: inv.id, p });
      inv.openP -= p;
      return p;
    };
    const left = (r: Rec) => r.amountP - r.now.reduce((s, a) => s + a.p, 0);

    // Forward: the sale this money was sent for.
    for (const r of free) {
      const d = day(r.date);
      const window = pool_.filter((i) => day(i.date) >= d && day(i.date) <= d + WINDOW && i.openP > 0);
      const exact = window.find((i) => i.openP === r.amountP);
      if (exact) { take(r, exact, r.amountP); continue; }
      for (const inv of window) {
        if (left(r) <= 0) break;
        take(r, inv, Math.min(inv.openP, left(r)));
      }
    }
    // Then, only if asked, whatever the customer still owes, oldest first.
    if (SETTLE_OLDER) {
      for (const r of free) {
        for (const inv of pool_) {
          if (left(r) <= 0) break;
          if (inv.openP > 0) take(r, inv, Math.min(inv.openP, left(r)));
        }
      }
    }

    perCust.push({
      name: cust.name,
      wasP: pool_.reduce((s, i) => s + Math.max(0, i.totalP - i.fixedP), 0),
      nowP: pool_.reduce((s, i) => s + i.openP, 0),
      advP: free.reduce((s, r) => s + left(r), 0),
      openInvs: pool_.filter((i) => i.openP > 0),
    });
    after.owedP += pool_.reduce((s, i) => s + i.openP, 0);
    after.advanceP += free.reduce((s, r) => s + left(r), 0);
    const changed = free.filter(
      (r) => r.now.reduce((s, a) => s + a.p, 0) !== r.wasP || r.now.length !== 0,
    );
    if (changed.length) {
      touched += changed.length;
      moves += changed.reduce((s, r) => s + r.now.length, 0);
      movedRupees += changed.reduce((s, r) => s + r.now.reduce((t, a) => t + a.p, 0), 0);
      changes.push({ cust: cust.name, recs: free });
    }
  }

  console.log(`  ${owners.length} customer(s) with a receipt of their own or money sitting loose`);
  console.log(`    owed before .... Rs ${money(before.owedP).padStart(12)}      advances before  Rs ${money(before.advanceP)}`);
  console.log(`    owed after ..... Rs ${money(after.owedP).padStart(12)}      advances after   Rs ${money(after.advanceP)}`);
  console.log(`    ${touched} receipt(s) re-placed into ${moves} application(s), Rs ${money(movedRupees)}\n`);

  console.log(`  what each customer still owes once their money is placed:`);
  for (const c of [...perCust].sort((a, b) => b.nowP - a.nowP)) {
    if (!c.nowP && !c.advP) continue;
    console.log(`    ${c.name.slice(0, 28).padEnd(29)}owed ${money(c.wasP).padStart(11)} -> ${money(c.nowP).padStart(11)}` +
      `   advance left ${money(c.advP).padStart(10)}   ${c.openInvs.slice(0, 4).map((i) => `${i.number.slice(-4)} ${money(i.openP)}`).join(", ")}`);
  }
  console.log();

  if (VERBOSE) {
    for (const c of changes) {
      console.log(`  ${c.cust}`);
      for (const r of c.recs) {
        const now = r.now.reduce((s, a) => s + a.p, 0);
        console.log(`    ${r.number.padEnd(16)}${r.date}  ${money(r.amountP).padStart(11)}` +
          `   was applied ${money(r.wasP).padStart(11)}  now ${money(now).padStart(11)}  advance ${money(r.amountP - now)}`);
      }
      console.log();
    }
  }

  if (!COMMIT) {
    console.log(`  Dry run — nothing written. Re-run with --commit.\n`);
    await pool.end();
    return;
  }

  // Rows that come across from the other books are recorded as the zoho user,
  // and this correction belongs to the same catch-up.
  const [user] = (
    await db.execute(sql`SELECT id::text FROM users WHERE username = 'zoho' LIMIT 1`)
  ).rows as Array<{ id: string }>;
  if (!user) throw new Error("the zoho user is missing; the catch-up is recorded as that user");

  await db.transaction(async (tx) => {
    for (const c of changes) {
      for (const r of c.recs) {
        const nowP = r.now.reduce((s, a) => s + a.p, 0);
        if (r.kind === "own") {
          await tx.delete(paymentApplications).where(eq(paymentApplications.paymentId, r.id));
        } else if (!nowP) {
          continue;                       // a Zoho receipt whose spare money found nothing
        }
        for (const a of r.now) {
          await tx.insert(paymentApplications).values({
            paymentId: r.id, invoiceId: a.invoiceId, amountApplied: R(a.p),
          });
        }
        if (r.kind === "own") {
          await tx
            .update(customerPayments)
            .set({ unappliedAmount: R(r.amountP - nowP) })
            .where(eq(customerPayments.id, r.id));
        } else {
          // Its applications were left alone, so only the loose part shrinks.
          await tx.execute(sql`
            UPDATE customer_payments SET unapplied_amount = unapplied_amount - ${R(nowP)}::numeric
             WHERE id = ${r.id}::uuid
          `);
        }
        /**
         * Only the total matters to the ledger: moving an application from one
         * invoice to another of the same customer leaves receivables where it
         * was. A receipt that now settles more than it did takes that much out
         * of the customer's advances, exactly as the invoice screen does when
         * it picks up an advance; one that settles less hands it back.
         */
        const deltaP = nowP - r.wasP;
        if (deltaP !== 0) {
          await postJournal(tx, {
            entryDate: r.date,
            narration: `${r.number} re-allocated — ${c.cust}`,
            sourceType: "advance_application",
            sourceId: r.id,
            postedBy: user.id,
            lines:
              deltaP > 0
                ? [{ systemKey: "customer_advances", debit: R(deltaP) }, { systemKey: "ar", credit: R(deltaP) }]
                : [{ systemKey: "ar", debit: R(-deltaP) }, { systemKey: "customer_advances", credit: R(-deltaP) }],
          });
        }
      }
    }
    // Every invoice now says what its applications make it.
    await tx.execute(sql`
      UPDATE invoices i SET balance_due = greatest(round((i.total
        - coalesce((SELECT sum(amount_applied) FROM payment_applications WHERE invoice_id = i.id), 0)
        - coalesce((SELECT sum(amount_applied) FROM credit_note_applications WHERE invoice_id = i.id), 0))::numeric, 2), 0),
        status = CASE WHEN i.total
        - coalesce((SELECT sum(amount_applied) FROM payment_applications WHERE invoice_id = i.id), 0)
        - coalesce((SELECT sum(amount_applied) FROM credit_note_applications WHERE invoice_id = i.id), 0) <= 0 THEN 'paid'
        WHEN coalesce((SELECT sum(amount_applied) FROM payment_applications WHERE invoice_id = i.id), 0)
           + coalesce((SELECT sum(amount_applied) FROM credit_note_applications WHERE invoice_id = i.id), 0) > 0
        THEN 'partially_paid' ELSE 'sent' END::invoice_status
       WHERE i.status NOT IN ('void', 'draft')
    `);
  });
  console.log(`  Written: ${touched} receipt(s), ${moves} application(s).\n`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(`\n  ${e.message}\n`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
