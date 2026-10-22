/**
 * Match the statement lines whose money is already in the books.
 *
 *   npx tsx scripts/match-statement-lines.ts
 *   npx tsx scripts/match-statement-lines.ts --account "Amino SBI CC" --commit
 *
 * The Zoho catch-up loaded receipts without touching the bank statement, so
 * its deposits left their lines looking as though nobody had dealt with them.
 * Fourteen lines on 7 Oct 2026, Rs 40,65,840, each with a receipt sitting in
 * the books unlinked — and a line in that state invites a second receipt, which
 * is how PMT-00161 came to debit SBI for Josef Ali's 1,30,000 twice.
 *
 * This is the Auto-match screen's own reckoning, run from the command line
 * because fourteen lines are quicker to read in one list than one pane at a
 * time: the same exactFits query, the same pickConfident rule, and
 * linkStatementLine for the writing, so every check a person would meet in the
 * pane is met here. It pairs only what nobody would stop to think about — one
 * fit for the line, that line the only one it fits, sharing the bank's
 * reference or naming the same payer.
 *
 * Everything it will not pair is listed with the reason, because that is the
 * part somebody has to look at: two customers paid 2,62,013 on 7 October, and
 * only the statement's own order can say which receipt is which.
 */
import { sql } from "drizzle-orm";
import {
  exactFits, linePartyNames, lineText, loadPartyLabels, partyVerdict,
} from "../server/routes/banking";
import { linkStatementLine, pickConfident, sharesBankRef } from "../server/services/bank-links";
import { db, pool } from "../server/db";

const COMMIT = process.argv.includes("--commit");
const at = process.argv.indexOf("--account");
const ACCOUNT = at > -1 ? process.argv[at + 1] : undefined;
/** The same window the pane and Auto-match use. */
const DAYS = 3;

const money = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 0 });

interface Line {
  id: string; bank: string; bank_name: string; date: string;
  direction: "credit" | "debit"; amount: string;
  description: string | null; utr: string | null; counterparty: string | null;
}

async function main() {
  const lines = (
    await db.execute(sql`
      SELECT t.id::text, t.bank_account_id::text AS bank, b.name AS bank_name,
             t.txn_date::text AS date, t.direction::text, t.amount::text,
             t.description, t.utr, t.counterparty
        FROM bank_transactions t JOIN bank_accounts b ON b.id = t.bank_account_id
       WHERE t.match_status = 'unmatched'
         ${ACCOUNT ? sql`AND (b.name ILIKE ${`%${ACCOUNT}%`} OR b.id::text = ${ACCOUNT})` : sql``}
       ORDER BY t.txn_date, t.amount
    `)
  ).rows as unknown as Line[];
  console.log(`\n  ${lines.length} uncategorized line(s)${ACCOUNT ? ` on ${ACCOUNT}` : ""} — ${COMMIT ? "MATCHING" : "dry run"}\n`);
  if (!lines.length) {
    await pool.end();
    return;
  }

  const fits = await exactFits(lines.map((l) => l.id), DAYS);
  const labels = await loadPartyLabels(fits.map((r) => ({ sourceType: r.source_type, sourceId: r.source_id })));
  const named = await linePartyNames(lines);
  const byLine = new Map(lines.map((l) => [l.id, l]));
  const byFit = new Map(fits.map((r) => [`${r.line_id}:${r.entry_id}`, r]));

  const signals = fits.map((r) => ({
    lineId: r.line_id,
    entryId: r.entry_id,
    party: partyVerdict(labels.get(`${r.source_type}:${r.source_id}`), named.get(r.line_id)),
    sharedRef: sharesBankRef(r.reference, lineText(byLine.get(r.line_id)!)),
  }));
  const picks = pickConfident(signals);
  const picked = new Set(picks.map((p) => p.lineId));

  console.log(`  TO MATCH — ${picks.length} line(s):`);
  for (const p of picks) {
    const l = byLine.get(p.lineId)!;
    const f = byFit.get(`${p.lineId}:${p.entryId}`)!;
    console.log(
      `    ${l.date}  ${money(Number(l.amount)).padStart(12)}  ${l.bank_name.slice(0, 18).padEnd(19)}` +
        `-> ${f.entry_number.padEnd(12)}${labels.get(`${f.source_type}:${f.source_id}`)?.slice(0, 22) ?? "-"}` +
        `   ${[p.sameRef ? "same bank reference" : "", p.samePayer ? "names the payer" : ""].filter(Boolean).join(", ")}`,
    );
  }
  if (!picks.length) console.log(`    none`);

  /** What is left, and why — the part that needs a person. */
  const held = new Map<string, typeof signals>();
  for (const s of signals) {
    if (picked.has(s.lineId)) continue;
    held.set(s.lineId, [...(held.get(s.lineId) ?? []), s]);
  }
  if (held.size) {
    console.log(`\n  LEFT FOR SOMEBODY — ${held.size} line(s) whose money looks to be in the books already:`);
    for (const [lineId, ss] of held) {
      const l = byLine.get(lineId)!;
      const useful = ss.filter((s) => s.party !== "other");
      console.log(
        `    ${l.date}  ${money(Number(l.amount)).padStart(12)}  ${l.bank_name.slice(0, 18).padEnd(19)}` +
          `${(l.description ?? "").slice(0, 34).padEnd(35)}` +
          (useful.length > 1
            ? `${useful.length} fits, none of them the only one`
            : !useful.length
              ? `its only fit names another party`
              : `fits ${byFit.get(`${lineId}:${useful[0]!.entryId}`)!.entry_number} on neither the reference nor the payer`),
      );
      for (const s of ss.slice(0, 4)) {
        const f = byFit.get(`${lineId}:${s.entryId}`)!;
        console.log(
          `        ${f.entry_number.padEnd(12)}${f.entry_date}  ${(labels.get(`${f.source_type}:${f.source_id}`) ?? "-").slice(0, 24).padEnd(25)}` +
            `${s.party === "same" ? "same payer" : s.party === "other" ? "another party" : "payer not named"}` +
            `${s.sharedRef ? ", same reference" : ""}`,
        );
      }
    }
  }

  if (!COMMIT) {
    console.log(`\n  Dry run — nothing matched. Re-run with --commit.\n`);
    await pool.end();
    return;
  }

  let done = 0;
  const failed: string[] = [];
  for (const p of picks) {
    const l = byLine.get(p.lineId)!;
    try {
      await db.transaction(async (tx) => {
        await linkStatementLine(tx, {
          bankTransactionId: p.lineId,
          journalEntryIds: [p.entryId],
          kind: "matched",
        });
      });
      done += 1;
    } catch (e) {
      failed.push(`${l.date} ${money(Number(l.amount))}: ${(e as Error).message}`);
    }
  }
  console.log(`\n  Matched ${done} line(s).`);
  for (const f of failed) console.log(`    not matched — ${f}`);
  console.log();
  await pool.end();
}

main().catch(async (e) => {
  console.error(`\n  ${e.message}\n`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
