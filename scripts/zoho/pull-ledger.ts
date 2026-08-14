/**
 * Every posting Zoho ever made, in one sweep.
 *
 *   npx tsx scripts/zoho/pull-ledger.ts
 *
 * reports/accounttransaction ignores the account_id it is given and returns the
 * whole ledger regardless — two different accounts come back with byte-identical
 * rows, neither of them the account asked for. The first attempt at this walked
 * 398 accounts and so was fetching the entire ledger 398 times over, which is
 * what got the org rate-limited and blocked.
 *
 * Each row names the account it posts to, so one paged sweep is all that is
 * needed and the per-account split can be done here.
 *
 * Resumable: pages already on disk are skipped.
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { zohoGet } from "./client";

const OUT = ".zoho-dump/ledger/all-postings.jsonl";
const PER_PAGE = 200;

async function main() {
  await mkdir(".zoho-dump/ledger", { recursive: true });

  const existing = (await readFile(OUT, "utf8").catch(() => "")).trim();
  // Keyed on the whole row, not on transaction and account.
  //
  // One journal posts to the same account more than once as a matter of course
  // — a payment settling four bills debits Accounts Payable four times — so
  // treating (transaction, account) as unique silently discards real postings.
  // A row genuinely re-served across a page boundary is byte-identical.
  const have = new Set(existing ? existing.split("\n").filter(Boolean) : []);
  console.log(`${have.size} postings already on disk`);

  let page = Math.max(1, Math.floor(have.size / PER_PAGE) + (have.size % PER_PAGE ? 0 : 1));
  if (have.size === 0) page = 1;

  let fetched = 0;
  for (;;) {
    const body = await zohoGet<Record<string, unknown>>("reports/accounttransaction", {
      from_date: "2000-01-01",
      to_date: "2026-08-13",
      page,
      per_page: PER_PAGE,
    });
    // Nested one level deeper than the rest of the API: the outer array holds a
    // wrapper and the rows sit inside it.
    const wrapper = (body.account_transactions as Array<Record<string, unknown>> | undefined)?.[0];
    const rows = (wrapper?.account_transactions ?? []) as Array<Record<string, unknown>>;
    if (!rows.length) break;

    const fresh = rows.map((r) => JSON.stringify(r)).filter((line) => !have.has(line));
    if (fresh.length) {
      await appendFile(OUT, fresh.join("\n") + "\n");
      for (const line of fresh) have.add(line);
    }
    fetched += rows.length;
    process.stdout.write(`\r  page ${page}: ${fetched} rows seen, ${have.size} on disk   `);

    if (rows.length < PER_PAGE) break;
    page += 1;
  }

  console.log(`\n${have.size} postings written to ${OUT}`);
}

main().catch((e) => {
  console.error(`\n${e.message}`);
  console.error("Progress is on disk; re-running continues.");
  process.exitCode = 1;
});
