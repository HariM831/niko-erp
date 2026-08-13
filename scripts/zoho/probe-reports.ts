/**
 * Which reporting endpoints this org's API actually exposes, called with the
 * parameters they need.
 *
 * The first pass called them bare and read 400s as "unavailable". They are not:
 * Zoho answers 400 with code 101007 when a required parameter is missing, and
 * 404 with code 5 when the URL genuinely does not exist. Only the second is a
 * closed door.
 *
 * A trial balance we can fetch is worth a lot — it turns Phase 4 reconciliation
 * from reading Zoho's screens by hand into an automated comparison.
 */
import { writeFile } from "node:fs/promises";
import { zohoGet, zohoPages, type ZohoError } from "./client";

const FROM = "2026-04-01";
const TO = "2026-08-13";

async function main() {
  const dated = { from_date: FROM, to_date: TO };
  const results: Array<Record<string, unknown>> = [];

  const CANDIDATES: Array<{ path: string; params: Record<string, string | number> }> = [
    { path: "reports/trialbalance", params: dated },
    { path: "reports/profitandloss", params: dated },
    { path: "reports/generalledger", params: dated },
    { path: "reports/balancesheet", params: { date: TO } },
    { path: "reports/cashflow", params: dated },
  ];

  for (const c of CANDIDATES) {
    try {
      const body = await zohoGet<Record<string, unknown>>(c.path, c.params);
      const keys = Object.keys(body).filter((k) => !["code", "message"].includes(k));
      console.log(`  ${c.path}: OK — ${keys.join(", ")}`);
      results.push({ path: c.path, ok: true, keys, sample: body });
    } catch (err) {
      const e = err as ZohoError;
      console.log(`  ${c.path}: ${e.status} (zoho code ${e.zohoCode}) ${e.message}`);
      results.push({ path: c.path, ok: false, status: e.status, zohoCode: e.zohoCode });
    }
  }

  // The general ledger, per account. Needs an account to ask about.
  console.log("\nAccount transactions (the ledger):");
  let accountId: string | null = null;
  for await (const { records } of zohoPages<Record<string, unknown>>(
    "chartofaccounts",
    "chartofaccounts",
  )) {
    const withActivity = records.find((r) => Number(r.balance ?? 0) !== 0) ?? records[0];
    if (withActivity) accountId = String(withActivity.account_id);
    break;
  }

  if (accountId) {
    try {
      const body = await zohoGet<Record<string, unknown>>("reports/accounttransaction", {
        account_id: accountId,
        ...dated,
      });
      const rows = (body.account_transactions ?? []) as Array<Record<string, unknown>>;
      console.log(`  reports/accounttransaction: OK — ${rows.length} rows for one account`);
      if (rows[0]) console.log(`  fields: ${Object.keys(rows[0]).sort().join(", ")}`);
      results.push({ path: "reports/accounttransaction", ok: true, rows: rows.length, sample: rows[0] ?? null });
    } catch (err) {
      const e = err as ZohoError;
      console.log(`  reports/accounttransaction: ${e.status} ${e.message}`);
      results.push({ path: "reports/accounttransaction", ok: false, status: e.status });
    }
  }

  await writeFile(".zoho-dump/probe-reports.json", JSON.stringify(results, null, 2));
  const ok = results.filter((r) => r.ok);
  console.log(`\n${ok.length} of ${results.length} reporting endpoints usable.`);
  console.log("Detail in .zoho-dump/probe-reports.json");
  process.exit(0);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
