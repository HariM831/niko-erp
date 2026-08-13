/**
 * The accounts Zoho's chart endpoint does not return.
 *
 * `GET /chartofaccounts` gives 398 accounts for this org, and that is not the
 * whole chart. Six more are referenced by real data: five carrying balances in
 * the statements — Audit fee, SBI General Insurance Expenses, Postage &
 * Courier, Cook room Electricity, Office Expenses, ₹3.04 lakh between them —
 * and Zoho's built-in "Inventory Asset", which two items use. Each fetches
 * happily by id; they are simply absent from the list.
 *
 * Left unfound, the document import would have hit postings against accounts
 * that do not exist in EGGSY, several hundred documents in.
 *
 * This scans everything already pulled for account ids, fetches any the chart
 * did not include, and writes them alongside it. Re-run it as more data lands —
 * it only fetches what it has not seen.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { zohoGet, type ZohoError } from "./client";

const DIR = ".zoho-dump";
const EXTRA = `${DIR}/list/chartofaccounts-extra.jsonl`;

/** Any 16-plus digit Zoho id sitting on a key that names an account. */
const ACCOUNT_KEY = /account_id$|^account_id$/;

function harvest(node: unknown, into: Set<string>) {
  if (Array.isArray(node)) {
    for (const n of node) harvest(n, into);
    return;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (ACCOUNT_KEY.test(k) && typeof v === "string" && /^\d{10,}$/.test(v)) into.add(v);
      else harvest(v, into);
    }
  }
}

async function readJsonl(path: string): Promise<unknown[]> {
  try {
    const raw = await readFile(path, "utf8");
    return raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

async function main() {
  const known = new Set(
    (await readJsonl(`${DIR}/list/chartofaccounts.jsonl`)).map(
      (a) => (a as { account_id: string }).account_id,
    ),
  );
  const have = new Set(
    (await readJsonl(EXTRA)).map((a) => (a as { account_id: string }).account_id),
  );
  console.log(`chart endpoint gave ${known.size} accounts; ${have.size} extras already fetched`);

  const referenced = new Set<string>();
  for (const sub of ["list", "detail", "ledger", "reports"]) {
    let files: string[] = [];
    try {
      files = await readdir(`${DIR}/${sub}`);
    } catch {
      continue;
    }
    for (const f of files) {
      if (f === "chartofaccounts.jsonl" || f === "chartofaccounts-extra.jsonl") continue;
      const path = `${DIR}/${sub}/${f}`;
      const records = f.endsWith(".jsonl")
        ? await readJsonl(path)
        : [JSON.parse(await readFile(path, "utf8"))];
      harvest(records, referenced);
    }
  }

  const missing = [...referenced].filter((id) => !known.has(id) && !have.has(id));
  console.log(`${referenced.size} account ids referenced across the dump`);
  console.log(`${missing.length} not in the chart and not yet fetched`);
  if (!missing.length) {
    console.log("Nothing to do.");
    return;
  }

  const fetched: Array<Record<string, unknown>> = [];
  for (const id of missing) {
    try {
      const body = await zohoGet<Record<string, unknown>>(`chartofaccounts/${id}`);
      const a = (body.chart_of_account ?? body.chartofaccount) as Record<string, unknown>;
      if (!a) {
        console.log(`  ${id}: no account in the response`);
        continue;
      }
      // The single-account response omits the list-only fields the mapper
      // relies on, so they are filled with what a root account would have.
      fetched.push({
        account_id: id,
        account_name: a.account_name ?? `Zoho account ${id}`,
        account_code: a.account_code ?? "",
        account_type: a.account_type,
        description: a.description ?? "",
        parent_account_id: a.parent_account_id ?? "",
        depth: 0,
        is_system_account: a.is_system_account ?? true,
        is_child_present: false,
        is_active: a.is_active ?? true,
      });
      console.log(`  + ${a.account_name} (${a.account_type})`);
    } catch (err) {
      console.log(`  ${id}: ${(err as ZohoError).message.slice(0, 80)}`);
    }
  }

  if (fetched.length) {
    const existing = await readFile(EXTRA, "utf8").catch(() => "");
    await writeFile(EXTRA, existing + fetched.map((r) => JSON.stringify(r)).join("\n") + "\n");
  }
  console.log(`\n${fetched.length} written to ${EXTRA}`);
}

// No process.exit on success. Node does not flush a piped stdout before
// exiting, so an exit here silently discards everything logged above — which
// is exactly what happened on the first run: the accounts were fetched and
// written, and the log came back empty.
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
