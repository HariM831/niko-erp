/**
 * Zoho's own statements, kept as the thing the migration is checked against.
 *
 * Pulled separately from the documents because they serve a different purpose:
 * the documents become EGGSY's data, these stay as evidence. Phase 4 compares
 * what EGGSY derived against what Zoho reported, and any difference that is not
 * the folded-in GST is a defect.
 *
 * Also used to settle the account mapping: when several accounts share a
 * plausible name, the one carrying actual balances is the one the business
 * uses, which is a far better signal than the name.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { zohoGet } from "./client";

const DIR = ".zoho-dump/reports";
const EPOCH = "2000-01-01";
const TODAY = new Date().toISOString().slice(0, 10);

/** Flatten Zoho's nested section/account report shape into one row per account. */
function flatten(node: unknown, out: Array<Record<string, unknown>> = []) {
  if (Array.isArray(node)) {
    for (const n of node) flatten(n, out);
    return out;
  }
  if (node && typeof node === "object") {
    const o = node as Record<string, unknown>;
    if (o.account_id || o.account_name) out.push(o);
    for (const key of ["account_transactions", "sub_sections", "sections", "children"]) {
      if (o[key]) flatten(o[key], out);
    }
  }
  return out;
}

async function main() {
  await mkdir(DIR, { recursive: true });

  const wanted: Array<{ name: string; path: string; params: Record<string, string>; key: string }> = [
    {
      name: "trialbalance-all-time",
      path: "reports/trialbalance",
      params: { from_date: EPOCH, to_date: TODAY },
      key: "trialbalance",
    },
    {
      name: "balancesheet-today",
      path: "reports/balancesheet",
      params: { date: TODAY },
      key: "balance_sheet",
    },
    {
      name: "profitandloss-all-time",
      path: "reports/profitandloss",
      params: { from_date: EPOCH, to_date: TODAY },
      key: "profit_and_loss",
    },
  ];

  const collected: Array<{ key: string; rows: Array<Record<string, unknown>> }> = [];

  for (const w of wanted) {
    const body = await zohoGet<Record<string, unknown>>(w.path, w.params);
    await writeFile(`${DIR}/${w.name}.json`, JSON.stringify(body, null, 2));
    const rows = flatten(body[w.key]);
    console.log(`  ${w.name}: ${rows.length} account rows`);
    collected.push({ key: w.key, rows });
  }

  /**
   * Which accounts have ever been used.
   *
   * Not from the trial balance alone, which was the first attempt and was
   * wrong: Zoho ignores from_date/to_date on that report and answers as at
   * today, so a profit-and-loss account with no movement in the current
   * financial year drops out. Depreciation — ₹83.7 lakh in FY25-26 — read as
   * unused, which would have sent the reviewer looking at the wrong accounts.
   *
   * The all-time profit and loss covers income and expense over every year, and
   * the balance sheet covers the rest. Both omit zero rows (`show_rows:
   * non_zero`), so presence here means used and absence means "not in these
   * statements" rather than a guarantee of never.
   */
  const num = (v: unknown) => (v === "" || v == null ? 0 : Number(v));
  const index: Record<string, { name: string; balance: number; source: string }> = {};
  for (const { key, rows } of collected) {
    for (const r of rows) {
      const id = String(r.account_id ?? "");
      if (!id) continue;
      const balance =
        key === "trialbalance"
          ? num(r.net_debit_total) - num(r.net_credit_total)
          : num(r.total);
      if (!balance && index[id]) continue;
      index[id] = { name: String(r.name ?? r.account_name ?? ""), balance, source: key };
    }
  }

  await writeFile(`${DIR}/account-activity.json`, JSON.stringify(index, null, 2));
  console.log(`\naccount-activity.json: ${Object.keys(index).length} accounts ever used`);
  console.log(`\nWritten to ${DIR}/`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
