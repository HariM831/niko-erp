/**
 * Bring niko's older vendor payments onto the advances convention.
 *
 *   npx tsx scripts/move-vendor-advances.ts
 *   npx tsx scripts/move-vendor-advances.ts --commit
 *
 * Until 22 Oct 2026 a vendor payment raised in niko debited payables for the
 * whole of itself, so whatever it left unapplied sat inside payables as a
 * debit, while Zoho's payments held theirs in Vendor Advances. One convention
 * now (docs/vendor-advances-and-batches-plan.md): each old payment with money
 * spare gets one entry, dated today and tied to the payment —
 * DR Vendor Advances / CR Accounts Payable for its unapplied amount — and is
 * marked advances_in_ledger, so its later applications move between the two
 * accounts like everyone else's (services/payment-ledger.ts). The payments'
 * own journals are left as they are, so past balances stay as they were.
 *
 * A payment with nothing spare has nothing to move and is only marked.
 *
 * Dry run by default: lists every payment and amount. Afterwards run
 * check-document-balances, check-control-accounts --account ap and
 * fix-control-drift, and expect payables and vendor advances to agree.
 */
import { sql } from "drizzle-orm";
import { db, pool } from "../server/db";
import { postJournal } from "../server/services/posting";
import { istDate } from "../server/services/day-resolution";

const COMMIT = process.argv.includes("--commit");
const AS = process.argv.find((a) => a.startsWith("--as="))?.slice(5) ?? "admin";
const money = (n: number) => n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function main() {
  const rows = (
    await db.execute(sql`
      SELECT p.id::text, p.number, p.payment_date::text AS date, c.display_name AS vendor,
             p.amount::float8 AS amount, p.unapplied_amount::float8 AS unapplied,
             p.unapplied_amount::text AS unapplied_text
        FROM vendor_payments p
        JOIN contacts c ON c.id = p.vendor_id
       WHERE NOT p.advances_in_ledger
       ORDER BY p.payment_date, p.number`)
  ).rows as Array<{ id: string; number: string; date: string; vendor: string; amount: number; unapplied: number; unapplied_text: string }>;

  const moving = rows.filter((r) => r.unapplied > 0);
  const total = moving.reduce((s, r) => s + r.unapplied, 0);
  const on = istDate();
  console.log(`${rows.length} niko payments still hold advances inside payables; ${moving.length} have money spare.\n`);
  for (const r of moving) {
    console.log(`  ${r.number.padEnd(16)}${r.date}  ${r.vendor.slice(0, 40).padEnd(40)}${money(r.unapplied).padStart(16)}`);
  }
  console.log(`\n  ${"".padEnd(16)}${"".padEnd(10)}  ${"Total".padEnd(40)}${money(total).padStart(16)}`);
  console.log(`\nEach: DR Vendor Advances / CR Accounts Payable, dated ${on}.`);

  if (!COMMIT) {
    console.log("\nDry run — nothing written. Add --commit to post.");
    await pool.end();
    return;
  }

  const [user] = (
    await db.execute(sql`SELECT id::text FROM users WHERE username = ${AS} LIMIT 1`)
  ).rows as Array<{ id: string }>;
  if (!user) throw new Error(`no user '${AS}' to record the entries as`);

  await db.transaction(async (tx) => {
    for (const r of moving) {
      await postJournal(tx, {
        entryDate: on,
        narration: `${r.number} — ${r.unapplied_text} paid ahead, moved from payables to vendor advances`,
        sourceType: "vendor_payment",
        sourceId: r.id,
        postedBy: user.id,
        lines: [
          { systemKey: "vendor_advances", debit: r.unapplied_text },
          { systemKey: "ap", credit: r.unapplied_text },
        ],
      });
    }
    await tx.execute(sql`UPDATE vendor_payments SET advances_in_ledger = true WHERE NOT advances_in_ledger`);
  });
  console.log(`\nPosted ${moving.length} entries, ${money(total)}; ${rows.length} payments marked.`);
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
