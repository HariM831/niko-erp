/**
 * Phase 0 of the Zoho migration: find out what is actually there.
 *
 * Counts every module, records the field names on a sample of each, and tests
 * whether account transactions — the general ledger — can be read through the
 * API. That last question decides how the migration handles postings: the CSV
 * backup carries manual journals only, so if the ledger is not reachable here
 * the balances have to come from exported reports instead.
 *
 * Read-only, and cheap: list endpoints only, no per-document fetches. Safe to
 * run repeatedly.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { ORG_ID, zohoGet, zohoPages, type ZohoError } from "./client";

const OUT_DIR = ".zoho-dump";

/** Endpoint path → the key its records arrive under. */
const MODULES: Array<{ path: string; key: string; note?: string }> = [
  { path: "chartofaccounts", key: "chartofaccounts" },
  { path: "contacts", key: "contacts" },
  { path: "items", key: "items" },
  { path: "invoices", key: "invoices" },
  { path: "creditnotes", key: "creditnotes" },
  { path: "customerpayments", key: "customerpayments" },
  { path: "bills", key: "bills" },
  { path: "vendorcredits", key: "vendorcredits" },
  { path: "vendorpayments", key: "vendorpayments" },
  { path: "purchaseorders", key: "purchaseorders" },
  { path: "expenses", key: "expenses" },
  { path: "journals", key: "journals" },
  { path: "bankaccounts", key: "bankaccounts" },
  { path: "banktransactions", key: "banktransactions" },
  { path: "settings/taxes", key: "taxes" },
  // Counted only to confirm we are ignoring them on purpose, not by accident.
  { path: "estimates", key: "estimates", note: "excluded from EGGSY" },
  { path: "salesorders", key: "salesorders", note: "excluded from EGGSY" },
];

interface ModuleReport {
  path: string;
  count: number | null;
  pages: number;
  fields: string[];
  sample: Record<string, unknown> | null;
  error: string | null;
  note?: string;
}

async function countModule(path: string, key: string, note?: string): Promise<ModuleReport> {
  const report: ModuleReport = {
    path,
    count: 0,
    pages: 0,
    fields: [],
    sample: null,
    error: null,
    note,
  };
  try {
    for await (const { records } of zohoPages<Record<string, unknown>>(path, key)) {
      report.pages += 1;
      report.count = (report.count ?? 0) + records.length;
      if (!report.sample && records[0]) {
        report.sample = records[0];
        report.fields = Object.keys(records[0]).sort();
      }
      process.stdout.write(`\r  ${path}: ${report.count}   `);
    }
    process.stdout.write(`\r  ${path}: ${report.count}${note ? `  (${note})` : ""}\n`);
  } catch (err) {
    const e = err as ZohoError;
    report.count = null;
    report.error = e.message;
    process.stdout.write(`\r  ${path}: unavailable — ${e.status ?? ""} ${e.message}\n`);
  }
  return report;
}

/**
 * Can the ledger be read? If it can, the migration can check every posting it
 * makes against Zoho's own; if it cannot, balances have to come from exported
 * reports and the plan changes.
 *
 * Only `reports/accounttransaction` answers this. An earlier version of this
 * function fell back to `banktransactions` and reported success — but that is
 * the bank feed, a different dataset entirely, and calling it "the ledger"
 * would have been a false all-clear on the one question Phase 0 exists to
 * settle. The date range is required: without it Zoho returns 400/101007,
 * which is a missing parameter and not a missing endpoint.
 */
async function probeLedger(accountId: string | null) {
  if (!accountId) return { reachable: false, reason: "no account id to test with" };
  try {
    const body = await zohoGet<Record<string, unknown>>("reports/accounttransaction", {
      account_id: accountId,
      from_date: "2000-01-01",
      to_date: new Date().toISOString().slice(0, 10),
    });
    const rows = (body.account_transactions ?? []) as Array<Record<string, unknown>>;
    return {
      reachable: true,
      endpoint: "reports/accounttransaction",
      returned: rows.length,
      fields: rows[0] ? Object.keys(rows[0]).sort() : [],
      sample: rows[0] ?? null,
    };
  } catch (err) {
    const e = err as ZohoError;
    return { reachable: false, reason: `${e.status ?? ""} ${e.message}` };
  }
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  // Confirm the credentials and the organisation before anything long-running.
  const orgs = await zohoGet<{ organizations: Array<Record<string, unknown>> }>("organizations");
  const org = orgs.organizations?.find((o) => String(o.organization_id) === ORG_ID());
  if (!org) {
    throw new Error(
      `ZOHO_ORG_ID ${ORG_ID()} is not among the organisations this token can see: ` +
        orgs.organizations?.map((o) => `${o.organization_id} (${o.name})`).join(", "),
    );
  }
  console.log(`Connected to: ${org.name}`);
  console.log(`  org id       ${org.organization_id}`);
  console.log(`  currency     ${org.currency_code}`);
  console.log(`  fiscal year  starts ${org.fiscal_year_start_month}`);
  console.log(`  time zone    ${org.time_zone}\n`);
  console.log("Counting modules (list endpoints only, no document fetches):\n");

  const reports: ModuleReport[] = [];
  for (const m of MODULES) reports.push(await countModule(m.path, m.key, m.note));

  const accounts = reports.find((r) => r.path === "chartofaccounts");
  const accountId = accounts?.sample ? String(accounts.sample.account_id) : null;
  console.log("\nTesting whether the general ledger is reachable:");
  const ledger = await probeLedger(accountId);
  console.log(
    ledger.reachable
      ? `  yes — ${"endpoint" in ledger ? ledger.endpoint : ""}`
      : `  no — ${"reason" in ledger ? ledger.reason : ""}`,
  );

  const out = { org, probedAt: new Date().toISOString(), modules: reports, ledger };
  await writeFile(`${OUT_DIR}/probe.json`, JSON.stringify(out, null, 2));

  const total = reports.reduce((s, r) => s + (r.count ?? 0), 0);
  console.log(`\nFull detail in ${OUT_DIR}/probe.json`);
  console.log(`${total.toLocaleString("en-IN")} records visible across ${reports.length} modules.`);

  const failed = reports.filter((r) => r.error);
  if (failed.length) {
    console.log(`\n${failed.length} endpoint(s) unavailable — likely scope or plan:`);
    for (const f of failed) console.log(`  ${f.path}: ${f.error}`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exit(1);
});
