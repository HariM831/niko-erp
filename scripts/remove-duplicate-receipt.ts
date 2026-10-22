/**
 * Remove a receipt somebody keyed for money the books already hold.
 *
 *   npx tsx scripts/remove-duplicate-receipt.ts PMT-00161=CP-2026-27/1453
 *   ... --commit
 *
 * The 7 October cash deposit of 1,30,000 from Josef Ali is in niko twice: once
 * as CP-2026-27/1453, loaded from Zoho on 17 Oct and applied to
 * A-INV-EG-27-0977, and once as PMT-00161, keyed from the SBI statement at
 * 06:27 on 22 Oct. Both debit the bank, so one deposit put 2,60,000 into the
 * account, and Josef appears to be holding a credit he never paid.
 *
 * This will keep happening. The Categorize screen shows every statement line
 * that stands for no journal, and a line whose receipt came from Zoho looks
 * exactly like a line nobody has dealt with. So removing the copy is only half
 * the job: the statement line moves onto the receipt that is kept, which is
 * what the line has always stood for, and the screen stops offering it.
 *
 * unload-selected.ts is the wrong tool here and refuses: it exists to take a
 * document out so the loader can put it back from Zoho, and this copy was
 * raised here. Nothing is coming back to replace it.
 *
 * It refuses to remove the Zoho copy of a pair — Zoho is the source, and a
 * receipt carrying its id is the one that must survive — and refuses any copy
 * with money applied to it, which is a question about which invoice is paid,
 * not about a duplicate.
 */
import { sql } from "drizzle-orm";
import { db, pool } from "../server/db";

const COMMIT = process.argv.includes("--commit");
const pairs = process.argv
  .slice(2)
  .filter((a) => a.includes("="))
  .map((a) => {
    const [drop, keep] = a.split("=");
    return { drop: drop!, keep: keep! };
  });

/** The same deposit is dated no further apart than this between the books. */
const DAYS = 3;
const money = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 0 });
const days = (a: string, b: string) => Math.abs((Date.parse(a) - Date.parse(b)) / 86_400_000);

interface Receipt {
  id: string; number: string; date: string; amount: number; customer_id: string;
  customer: string; bank: string | null; bank_name: string | null; je: string | null;
  zoho: string | null; applied: number; who: string | null; created: string;
}

async function main() {
  if (!pairs.length) {
    console.error("Usage: remove-duplicate-receipt.ts <keyed>=<kept> ... [--commit]");
    process.exitCode = 1;
    return;
  }
  console.log(`\n  ${pairs.length} pair(s) — ${COMMIT ? "REMOVING" : "dry run"}\n`);

  const rows = (
    await db.execute(sql`
      SELECT p.id::text, p.number, p.payment_date::text AS date, p.amount::float8 AS amount,
             p.customer_id::text, c.display_name AS customer,
             p.bank_account_id::text AS bank, b.name AS bank_name,
             p.journal_entry_id::text AS je, u.name AS who, p.created_at::text AS created,
             (SELECT z.zoho_id FROM zoho_id_map z
               WHERE z.entity = 'customer_payment' AND z.eggsy_id = p.id) AS zoho,
             coalesce((SELECT sum(amount_applied) FROM payment_applications WHERE payment_id = p.id), 0)::float8 AS applied
        FROM customer_payments p
        JOIN contacts c ON c.id = p.customer_id
        LEFT JOIN bank_accounts b ON b.id = p.bank_account_id
        LEFT JOIN users u ON u.id = p.created_by
       WHERE p.number IN (${sql.join(pairs.flatMap((p) => [sql`${p.drop}`, sql`${p.keep}`]), sql`, `)})
    `)
  ).rows as Receipt[];
  const byNumber = new Map(rows.map((r) => [r.number, r]));

  const ready: Array<{ drop: Receipt; keep: Receipt }> = [];
  for (const p of pairs) {
    const drop = byNumber.get(p.drop);
    const keep = byNumber.get(p.keep);
    if (!drop || !keep) throw new Error(`${!drop ? p.drop : p.keep} is not in the books`);
    if (drop.customer_id !== keep.customer_id) throw new Error(`${p.drop} and ${p.keep} are different customers`);
    if (Math.abs(drop.amount - keep.amount) > 1) throw new Error(`${p.drop} is ${money(drop.amount)}, ${p.keep} is ${money(keep.amount)}`);
    if (days(drop.date, keep.date) > DAYS) throw new Error(`${p.drop} is ${drop.date} and ${p.keep} is ${keep.date} — too far apart to be one deposit`);
    if (drop.bank && keep.bank && drop.bank !== keep.bank) throw new Error(`${p.drop} is in ${drop.bank_name}, ${p.keep} in ${keep.bank_name}`);
    if (drop.zoho) throw new Error(`${p.drop} carries Zoho's id ${drop.zoho} — Zoho's copy is the one that stays`);
    if (drop.applied > 1) throw new Error(`${p.drop} has ${money(drop.applied)} applied to it — move or release that first`);
    if (!keep.je) throw new Error(`${p.keep} has no journal entry; it cannot take the statement line`);
    console.log(
      `    ${drop.number} -> ${keep.number}   ${drop.date}  ${drop.customer.slice(0, 24).padEnd(25)}` +
        `${money(drop.amount).padStart(12)}   keyed by ${drop.who ?? "?"} on ${drop.created.slice(0, 16)}` +
        `   the copy kept applies ${money(keep.applied)}`,
    );
    ready.push({ drop, keep });
  }

  /** The statement lines that will change hands, named before anything moves. */
  for (const { drop, keep } of ready) {
    if (!drop.je) continue;
    const lines = (
      await db.execute(sql`
        SELECT t.txn_date::text AS date, t.amount::float8 AS amount, t.description, l.kind::text,
               b.name AS acct,
               EXISTS (SELECT 1 FROM bank_transaction_links k
                        WHERE k.journal_entry_id = ${keep.je}::uuid AND k.bank_account_id = l.bank_account_id) AS taken
          FROM bank_transaction_links l
          JOIN bank_transactions t ON t.id = l.bank_transaction_id
          JOIN bank_accounts b ON b.id = l.bank_account_id
         WHERE l.journal_entry_id = ${drop.je}::uuid
      `)
    ).rows as Array<{ date: string; amount: number; description: string | null; kind: string;
                      acct: string; taken: boolean }>;
    for (const l of lines) {
      console.log(
        `      statement line ${l.acct} ${l.date} ${money(l.amount)} (${l.kind})` +
          `${l.taken ? ` already stands for ${keep.number} — it will simply go` : ` moves onto ${keep.number}`}`,
      );
    }
    if (!lines.length) console.log(`      no statement line points at ${drop.number}`);
  }

  if (!COMMIT) {
    console.log(`\n  Dry run — nothing removed. Re-run with --commit.\n`);
    await pool.end();
    return;
  }

  await db.transaction(async (tx) => {
    for (const { drop, keep } of ready) {
      /**
       * The line stands for the money, and the money is still there — only the
       * receipt it was written against changes. "matched" is what it becomes:
       * the journal it now points at was not made from this line.
       */
      if (drop.je) {
        await tx.execute(sql`
          UPDATE bank_transaction_links
             SET journal_entry_id = ${keep.je}::uuid, kind = 'matched'
           WHERE journal_entry_id = ${drop.je}::uuid
             AND NOT EXISTS (SELECT 1 FROM bank_transaction_links k
                              WHERE k.journal_entry_id = ${keep.je}::uuid
                                AND k.bank_account_id = bank_transaction_links.bank_account_id)
        `);
      }
      await tx.execute(sql`UPDATE customer_payments SET journal_entry_id = NULL WHERE id = ${drop.id}::uuid`);
      if (drop.je) {
        // Any link left is one the kept receipt already had; it goes with the entry.
        await tx.execute(sql`DELETE FROM bank_transaction_links WHERE journal_entry_id = ${drop.je}::uuid`);
        await tx.execute(sql`DELETE FROM journal_entry_lines WHERE entry_id = ${drop.je}::uuid`);
        await tx.execute(sql`DELETE FROM journal_entries WHERE id = ${drop.je}::uuid`);
      }
      await tx.execute(sql`DELETE FROM payment_applications WHERE payment_id = ${drop.id}::uuid`);
      await tx.execute(sql`DELETE FROM customer_payments WHERE id = ${drop.id}::uuid`);
      console.log(`    ${drop.number} removed; the deposit stands as ${keep.number}`);
    }
  });
  console.log(`\n  ${ready.length} removed.\n`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(`\n  ${e.message}\n`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
