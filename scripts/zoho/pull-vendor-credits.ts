/**
 * The vendor credits Zoho's list endpoint will not admit to.
 *
 * GET /vendorcredits returns zero under every filter tried, yet twelve credits
 * worth ₹37,32,360 are applied to bills and are why seven vendors read as still
 * owing money that Zoho considers settled. Fetching one by id works and reports
 * status "closed", so the list simply omits fully applied credits.
 *
 * Their ids are recoverable from the bills that reference them, which is what
 * this uses. A reminder that a list count is not the population.
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
