/**
 * Phase 1: pull the whole Zoho org to disk as JSONL.
 *
 * Runs for an hour or two unattended, so the design assumption is that it will
 * be interrupted — by the hourly token expiring, by a rate limit, by Zoho's
 * daily API cap, or by the machine sleeping. Every page is flushed as it
 * arrives and every record carries its Zoho id, so a re-run skips what is
 * already on disk and picks up where it stopped. Deleting a file re-pulls just
 * that module.
 *
 * Nothing is written to Zoho and nothing is written to the niko database.
 * This step only produces files.
 *
 * The ledger is not pulled here. It used to be, account by account, and that
 * endpoint ignores the account it is given — so it fetched the whole ledger
 * once per account and got the org blocked. pull-ledger.ts does it in one sweep.
 *
 *   npx tsx scripts/zoho/pull.ts            # everything outstanding
 *   npx tsx scripts/zoho/pull.ts invoices   # one module
 */
import { createReadStream } from "node:fs";
import { appendFile, mkdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { zohoGet, zohoPages, type ZohoError } from "./client";

const DIR = ".zoho-dump";

interface Module {
  /** Endpoint path and the key its records arrive under. */
  path: string;
  key: string;
  /** Field holding the record's id, used for resume and for detail fetches. */
  idField: string;
  /**
   * Whether each record needs a second fetch. Zoho's list endpoints omit line
   * items, so an invoice from a list has no lines — useless for a migration.
   */
  detail: boolean;
  /** The key the detail response arrives under, when it differs from the singular. */
  detailKey?: string;
}

const MODULES: Module[] = [
  { path: "chartofaccounts", key: "chartofaccounts", idField: "account_id", detail: false },
  { path: "settings/taxes", key: "taxes", idField: "tax_id", detail: false },
  { path: "bankaccounts", key: "bankaccounts", idField: "account_id", detail: false },
  { path: "contacts", key: "contacts", idField: "contact_id", detail: true, detailKey: "contact" },
  { path: "items", key: "items", idField: "item_id", detail: true, detailKey: "item" },
  { path: "invoices", key: "invoices", idField: "invoice_id", detail: true, detailKey: "invoice" },
  { path: "bills", key: "bills", idField: "bill_id", detail: true, detailKey: "bill" },
  { path: "expenses", key: "expenses", idField: "expense_id", detail: true, detailKey: "expense" },
  { path: "journals", key: "journals", idField: "journal_id", detail: true, detailKey: "journal" },
  {
    path: "customerpayments",
    key: "customerpayments",
    idField: "payment_id",
    detail: true,
    detailKey: "payment",
  },
  {
    path: "vendorpayments",
    key: "vendorpayments",
    idField: "payment_id",
    detail: true,
    detailKey: "vendorpayment",
  },
  {
    path: "purchaseorders",
    key: "purchaseorders",
    idField: "purchaseorder_id",
    detail: true,
    detailKey: "purchaseorder",
  },
  {
    // Pulled after all: these are not only the bank feed. Alongside rows that
    // mirror an imported document — a customer_payment row carries the same
    // transaction_id as the payment itself — they hold transfers between own
    // accounts, loan drawdowns and repayments, and money recorded straight in
    // banking with no document behind it. Skipping them left the banks out by
    // crores, so they come in and the duplicates are filtered at load time.
    path: "banktransactions",
    key: "banktransactions",
    idField: "transaction_id",
    detail: false,
  },
];

const listFile = (m: Module) => `${DIR}/list/${m.path.replace(/\//g, "-")}.jsonl`;
const detailFile = (m: Module) => `${DIR}/detail/${m.path.replace(/\//g, "-")}.jsonl`;

/** Ids already on disk, so a resumed run does not re-fetch them. */
async function idsInFile(file: string, idField: string): Promise<Set<string>> {
  const seen = new Set<string>();
  try {
    await stat(file);
  } catch {
    return seen;
  }
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const id = JSON.parse(line)[idField];
      if (id) seen.add(String(id));
    } catch {
      /* a half-written final line from a killed run; ignore it */
    }
  }
  return seen;
}

const write = (file: string, records: unknown[]) =>
  appendFile(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");

async function pullList(m: Module) {
  const file = listFile(m);
  const have = await idsInFile(file, m.idField);
  let fetched = 0;

  for await (const { records } of zohoPages<Record<string, unknown>>(m.path, m.key)) {
    const fresh = records.filter((r) => !have.has(String(r[m.idField])));
    if (fresh.length) {
      await write(file, fresh);
      for (const r of fresh) have.add(String(r[m.idField]));
    }
    fetched += records.length;
    process.stdout.write(`\r  ${m.path} list: ${fetched} seen, ${have.size} on disk   `);
  }
  process.stdout.write(`\r  ${m.path} list: ${have.size} records\n`);
  return have;
}

async function pullDetail(m: Module, ids: Set<string>) {
  const file = detailFile(m);
  const have = await idsInFile(file, m.idField);
  const todo = [...ids].filter((id) => !have.has(id));
  if (!todo.length) {
    console.log(`  ${m.path} detail: complete (${have.size})`);
    return;
  }

  console.log(`  ${m.path} detail: ${todo.length} to fetch (${have.size} already done)`);
  const started = Date.now();
  let done = 0;
  const batch: unknown[] = [];

  for (const id of todo) {
    const body = await zohoGet<Record<string, unknown>>(`${m.path}/${id}`);
    const record = body[m.detailKey ?? m.key] ?? body;
    batch.push(record);
    done += 1;

    // Flushed in small batches: frequent enough that a kill loses seconds of
    // work, not so frequent that the disk is hit for every single record.
    if (batch.length >= 25) {
      await write(file, batch.splice(0));
    }
    if (done % 25 === 0 || done === todo.length) {
      const rate = done / ((Date.now() - started) / 1000);
      const left = Math.round((todo.length - done) / rate / 60);
      process.stdout.write(
        `\r  ${m.path} detail: ${done}/${todo.length}  ~${left} min left      `,
      );
    }
  }
  if (batch.length) await write(file, batch);
  process.stdout.write(`\r  ${m.path} detail: ${todo.length} fetched                    \n`);
}

async function main() {
  const only = process.argv[2];
  for (const sub of ["list", "detail"]) {
    await mkdir(`${DIR}/${sub}`, { recursive: true });
  }

  const selected = only ? MODULES.filter((m) => m.path === only) : MODULES;
  if (only && !selected.length) {
    console.error(`No module "${only}". Known: ${MODULES.map((m) => m.path).join(", ")}`);
    process.exitCode = 1;
    return;
  }

  for (const m of selected) {
    const ids = await pullList(m);
    if (m.detail) await pullDetail(m, ids);
  }

  console.log(`\nDone. Files are under ${DIR}/`);
}

main().catch((err) => {
  const e = err as ZohoError;
  console.error(`\n\nStopped: ${e.message}`);
  if (/limit|credit/i.test(e.message)) {
    console.error(
      "That reads like Zoho's daily API allowance. Progress is on disk — " +
        "re-run the same command tomorrow and it continues from here.",
    );
  } else {
    console.error("Progress is on disk. Re-running continues from where it stopped.");
  }
  process.exitCode = 1;
});
