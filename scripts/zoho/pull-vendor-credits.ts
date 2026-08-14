/**
 * The vendor credits Zoho's list endpoint will not admit to.
 *
 * GET /vendorcredits returns zero under every filter tried, yet twelve credits
 * worth ₹37,32,360 are applied to bills and are why seven vendors read as still
 * owing money that Zoho considers settled. Fetching one by id works and reports
 * status "closed", so the list simply omits fully applied credits.
 *
 * Their ids come from two places, because neither alone is complete. The bills
 * name the credits applied to them; the ledger names every credit that ever
 * posted, applied or not. Bills alone missed two — #54 and #32, both United
 * Army Supply Syndicate, ₹1,065 between them — which sat unapplied and so were
 * referenced by no bill at all. That ₹1,065 was the gap I had wrongly written
 * off as Zoho's balance sheet disagreeing with its own bills.
 *
 * A reminder that a list count is not the population.
 */
import { appendFile, readFile } from "node:fs/promises";
import { zohoGet, type ZohoError } from "./client";

const OUT = ".zoho-dump/detail/vendorcredits.jsonl";

async function readJsonl(path: string) {
  try {
    return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

async function main() {
  const bills = await readJsonl(".zoho-dump/detail/bills.jsonl");
  const ids = new Set<string>();
  for (const b of bills) {
    for (const c of b.vendor_credits ?? []) ids.add(String(c.vendor_credit_id));
  }
  const fromBills = ids.size;
  for (const p of await readJsonl(".zoho-dump/ledger/all-postings.jsonl")) {
    if (p.transaction_type === "vendor_credit") ids.add(String(p.transaction_id));
  }
  console.log(`${fromBills} referenced by bills, ${ids.size - fromBills} more found only in the ledger`);
  const have = new Set((await readJsonl(OUT)).map((r) => String(r.vendorcredit_id ?? r.vendor_credit_id)));
  const todo = [...ids].filter((id) => !have.has(id));

  console.log(`${ids.size} vendor credits referenced by bills, ${todo.length} to fetch`);
  let ok = 0;
  for (const id of todo) {
    try {
      const body = await zohoGet<Record<string, unknown>>(`vendorcredits/${id}`);
      const rec = (body.vendor_credit ?? body.vendorcredit) as Record<string, unknown>;
      if (!rec) {
        console.log(`  ${id}: no credit in the response`);
        continue;
      }
      await appendFile(OUT, JSON.stringify(rec) + "\n");
      ok += 1;
      console.log(
        `  + ${rec.vendor_credit_number} ${rec.date} ${rec.vendor_name} ${rec.total} (${rec.status})`,
      );
    } catch (err) {
      console.log(`  ${id}: ${(err as ZohoError).message.slice(0, 90)}`);
    }
  }
  console.log(`\n${ok} written to ${OUT}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
