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
 *   npx tsx scripts/zoho/pull.ts                      # everything outstanding
 *   npx tsx scripts/zoho/pull.ts invoices             # one module
 *   npx tsx scripts/zoho/pull.ts --since=2026-09-17   # everything changed since
 *
 * Resume is by record id, which is what makes an interrupted run cheap — and
 * what makes it blind to a record it already holds. An invoice edited in Zoho
 * after it was pulled is never asked for again, so the copy here goes stale
 * without a word: on 12 Oct 2026, 971 of 990 invoices had been modified since
 * the September pull and not one had been re-read. `--since` is the answer to
 * that. It asks each module what Zoho has touched since the date given and
 * overwrites those records in place, so the dump catches up without re-reading
 * the whole organisation.
 */
import { createReadStream } from "node:fs";
import { appendFile, mkdir, rename, stat, writeFile } from "node:fs/promises";
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

/**
 * Replace records already in a file, keeping everything else as it was.
 *
 * The files are append-only, which is what makes a killed run cheap to resume
 * — but a refresh re-fetches records that are already on disk, and appending
 * those would leave two copies of one invoice with no way to tell which is
 * current. The file is rewritten through a temporary and renamed, so a crash
 * mid-write leaves the original intact rather than half a dump.
 */
async function replaceInFile(file: string, idField: string, fresh: Map<string, unknown>) {
  if (!fresh.size) return { replaced: 0, added: 0 };
  let replaced = 0;
  const tmp = `${file}.rewriting`;
  const out: string[] = [];
  try {
    await stat(file);
    const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let id: string | undefined;
      try {
        id = String(JSON.parse(line)[idField]);
      } catch {
        continue;
      }
      const f = id !== undefined ? fresh.get(id) : undefined;
      if (f) {
        out.push(JSON.stringify(f));
        fresh.delete(id);
        replaced += 1;
      } else {
        out.push(line);
      }
    }
  } catch {
    /* nothing on disk yet: everything fresh is simply new */
  }
  const added = fresh.size;
  for (const r of fresh.values()) out.push(JSON.stringify(r));
  await writeFile(tmp, out.join("\n") + "\n");
  await rename(tmp, file);
  return { replaced, added };
}

async function pullList(m: Module, since?: string) {
  const file = listFile(m);
  const have = await idsInFile(file, m.idField);
  let fetched = 0;

  // A refresh asks Zoho what it has touched instead of walking the whole
  // module. Everything it answers with is taken as current and overwrites what
  // is on disk, because the reason for asking is that this copy has gone stale.
  const params = since ? { last_modified_time: `${since}T00:00:00+0530` } : {};
  const touched = new Map<string, unknown>();

  for await (const { records } of zohoPages<Record<string, unknown>>(m.path, m.key, params)) {
    if (since) {
      for (const r of records) touched.set(String(r[m.idField]), r);
    } else {
      const fresh = records.filter((r) => !have.has(String(r[m.idField])));
      if (fresh.length) {
        await write(file, fresh);
        for (const r of fresh) have.add(String(r[m.idField]));
      }
    }
    fetched += records.length;
    process.stdout.write(
      `\r  ${m.path} list: ${fetched} seen${since ? "" : `, ${have.size} on disk`}   `,
    );
  }

  if (since) {
    const { replaced, added } = await replaceInFile(file, m.idField, new Map(touched));
    process.stdout.write(
      `\r  ${m.path} list: ${touched.size} changed since ${since} (${replaced} updated, ${added} new)      \n`,
    );
    return { universe: new Set(touched.keys()), refresh: true };
  }
  process.stdout.write(`\r  ${m.path} list: ${have.size} records                    \n`);
  return { universe: have, refresh: false };
}

async function pullDetail(m: Module, ids: Set<string>, refresh = false) {
  const file = detailFile(m);
  const have = await idsInFile(file, m.idField);
  // A refresh re-reads everything the list said had changed, already on disk
  // or not; an ordinary run only fills in what is missing.
  const todo = refresh ? [...ids] : [...ids].filter((id) => !have.has(id));
  if (!todo.length) {
    console.log(`  ${m.path} detail: complete (${have.size})`);
    return;
  }

  console.log(`  ${m.path} detail: ${todo.length} to fetch (${have.size} already done)`);
  const started = Date.now();
  let done = 0;
  const batch: unknown[] = [];
  /**
   * Records the list knows about and Zoho no longer has.
   *
   * The list file only ever grows — a record pulled in September stays in it
   * forever — so an id deleted in Zoho since is still asked for, and answered
   * with a 404. That used to stop the whole run: re-pulling every invoice died
   * on A-INV-EG-27-0779, deleted from Zoho on 10 October, with 995 details
   * still to fetch. A deletion is news, not a failure. It is collected and
   * reported, because an invoice that exists in niko and no longer exists in
   * Zoho is exactly the kind of thing a reconciliation has to be told about.
   */
  const gone: string[] = [];

  for (const id of todo) {
    let body: Record<string, unknown>;
    try {
      body = await zohoGet<Record<string, unknown>>(`${m.path}/${id}`);
    } catch (err) {
      if ((err as ZohoError).status === 404) {
        gone.push(id);
        done += 1;
        continue;
      }
      throw err;
    }
    const record = body[m.detailKey ?? m.key] ?? body;
    batch.push(record);
    done += 1;

    // Flushed in small batches: frequent enough that a kill loses seconds of
    // work, not so frequent that the disk is hit for every single record. A
    // refresh holds them all instead, because they replace rows rather than
    // extend the file.
    if (!refresh && batch.length >= 25) {
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
  if (refresh) {
    const fresh = new Map<string, unknown>();
    for (const r of batch) fresh.set(String((r as Record<string, unknown>)[m.idField]), r);
    const { replaced, added } = await replaceInFile(file, m.idField, fresh);
    process.stdout.write(
      `\r  ${m.path} detail: ${replaced} updated, ${added} new                    \n`,
    );
  } else {
    if (batch.length) await write(file, batch);
    process.stdout.write(
      `\r  ${m.path} detail: ${todo.length - gone.length} fetched                    \n`,
    );
  }
  if (gone.length) {
    // Written where a reconciliation can find them, not just printed into a
    // log that scrolls away.
    await appendFile(`${DIR}/detail/${m.path.replace(/\//g, "-")}-deleted.txt`, gone.join("\n") + "\n");
    console.log(`  ${m.path} detail: ${gone.length} no longer exist in Zoho — ids written to ${m.path}-deleted.txt`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const sinceArg = args.find((a) => a.startsWith("--since"));
  const since = sinceArg?.includes("=") ? sinceArg.split("=")[1] : undefined;
  if (sinceArg && !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(since ?? "")) {
    console.error("Use --since=YYYY-MM-DD, the day to collect changes from.");
    process.exitCode = 1;
    return;
  }
  const only = args.find((a) => !a.startsWith("--"));
  for (const sub of ["list", "detail"]) {
    await mkdir(`${DIR}/${sub}`, { recursive: true });
  }

  const selected = only ? MODULES.filter((m) => m.path === only) : MODULES;
  if (only && !selected.length) {
    console.error(`No module "${only}". Known: ${MODULES.map((m) => m.path).join(", ")}`);
    process.exitCode = 1;
    return;
  }

  if (since) console.log(`Refreshing everything Zoho has touched since ${since}.\n`);
  for (const m of selected) {
    const { universe, refresh } = await pullList(m, since);
    if (m.detail) await pullDetail(m, universe, refresh);
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
