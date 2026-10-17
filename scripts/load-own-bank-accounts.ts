/**
 * Fill in our own bank accounts — the paying side of a payment file.
 *
 *   npx tsx scripts/load-own-bank-accounts.ts <file.csv>
 *   npx tsx scripts/load-own-bank-accounts.ts <file.csv> --commit
 *
 * Columns: name, account_number, ifsc, bank_name, branch, bank_customer_code, create
 *
 * Vendors having account numbers is only half of it. The file also carries the
 * payer: its account number and the bank's own customer code, read off the
 * bank account the batch is raised from. Both were blank on every account, so
 * the file could not be produced however complete the vendors were.
 *
 * `create` makes an account niko has never held, with its own GL account under
 * Cash & Bank the way the Banking screen would — one GL per bank account, as
 * every existing one has. Everything else is matched by name and filled in.
 *
 * It refuses the whole run if a name matches nothing, matches twice, or already
 * holds a different number: an account number quietly changed under a bank
 * account is every future payment file sent from the wrong place.
 */
import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { accounts, bankAccounts } from "@shared/schema";
import { db, pool } from "../server/db";

const COMMIT = process.argv.includes("--commit");
const file = process.argv.slice(2).find((a) => !a.startsWith("--"));

const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;

function parse(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (ch !== "\r") cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

async function main() {
  if (!file) throw new Error("give the CSV of our own bank accounts");
  const [header, ...lines] = parse(readFileSync(file, "utf8"));
  const at = (n: string) => header!.findIndex((h) => h.trim() === n);
  if (at("name") < 0) throw new Error("the CSV needs a name column");
  const get = (l: string[], n: string) => (at(n) < 0 ? "" : (l[at(n)] ?? "").trim());
  const rows = lines.map((l) => ({
    name: get(l, "name"),
    account: get(l, "account_number"),
    ifsc: get(l, "ifsc").toUpperCase(),
    bank: get(l, "bank_name"),
    branch: get(l, "branch"),
    code: get(l, "bank_customer_code"),
    create: /^(y|yes|true|1)$/i.test(get(l, "create")),
  }));
  console.log(`\n  ${rows.length} account(s) from ${file} — ${COMMIT ? "WRITING" : "dry run"}\n`);

  const live = await db
    .select({
      id: bankAccounts.id, name: bankAccounts.name, kind: bankAccounts.kind,
      account: bankAccounts.accountNumber, ifsc: bankAccounts.ifsc,
      bank: bankAccounts.bankName, branch: bankAccounts.branch,
      code: bankAccounts.bankCustomerCode,
    })
    .from(bankAccounts);

  const problems: string[] = [];
  const fills: Array<{ id: string; name: string; set: Record<string, string>; }> = [];
  const makes: typeof rows = [];
  for (const r of rows) {
    if (r.ifsc && !IFSC.test(r.ifsc)) problems.push(`${r.name}: "${r.ifsc}" is not an IFSC`);
    const hits = live.filter((b) => b.name === r.name);
    if (r.create) {
      if (hits.length) problems.push(`${r.name}: already exists, so it cannot be created`);
      else makes.push(r);
      continue;
    }
    if (hits.length === 0) { problems.push(`${r.name}: no bank account by that name`); continue; }
    if (hits.length > 1) { problems.push(`${r.name}: ${hits.length} bank accounts by that name`); continue; }
    const b = hits[0]!;
    const set: Record<string, string> = {};
    for (const [field, want, held] of [
      ["accountNumber", r.account, b.account], ["ifsc", r.ifsc, b.ifsc],
      ["bankName", r.bank, b.bank], ["branch", r.branch, b.branch],
      ["bankCustomerCode", r.code, b.code],
    ] as const) {
      if (!want) continue;
      const have = (held ?? "").trim();
      if (have && have !== want) { problems.push(`${r.name}: ${field} is ${have}, the sheet says ${want}`); continue; }
      if (!have) set[field] = want;
    }
    if (Object.keys(set).length) fills.push({ id: b.id, name: r.name, set });
  }

  for (const f of fills) {
    console.log(`    fill   ${f.name.slice(0, 38).padEnd(39)} ${Object.entries(f.set).map(([k, v]) => `${k}=${v}`).join("  ")}`);
  }
  for (const m of makes) {
    console.log(`    create ${m.name.slice(0, 38).padEnd(39)} ${m.account}  ${m.ifsc}  ${m.bank}`);
  }
  console.log(`\n    to fill ... ${fills.length}`);
  console.log(`    to create . ${makes.length}`);
  if (problems.length) {
    console.log(`    problems .. ${problems.length}`);
    for (const p of problems) console.log(`      ${p}`);
    throw new Error("nothing written while a row is in doubt");
  }

  if (!COMMIT) {
    console.log("\n  Dry run — nothing written. Re-run with --commit.\n");
    await pool.end();
    return;
  }
  await db.transaction(async (tx) => {
    for (const f of fills) {
      await tx.update(bankAccounts).set(f.set).where(eq(bankAccounts.id, f.id));
    }
    for (const m of makes) {
      // The Banking screen's own numbering: BNK-001 upward, one GL per account.
      const [countRow] = await tx
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(accounts)
        .where(sql`${accounts.code} LIKE 'BNK-%'`);
      const [gl] = await tx
        .insert(accounts)
        .values({
          code: `BNK-${String((countRow?.count ?? 0) + 1).padStart(3, "0")}`,
          name: m.name,
          type: "asset",
          // Every other bank GL carries it; the reports group assets on type,
          // so this only makes the chart say what the account is.
          subtype: "bank",
          description: `Bank account: ${m.name}`,
        })
        .returning({ id: accounts.id, code: accounts.code });
      await tx.insert(bankAccounts).values({
        name: m.name, kind: "bank", bankName: m.bank || null,
        accountNumber: m.account || null, ifsc: m.ifsc || null, branch: m.branch || null,
        bankCustomerCode: m.code || null, glAccountId: gl!.id,
      });
      console.log(`    created ${m.name} with GL ${gl!.code}`);
    }
  });
  console.log(`\n  Filled ${fills.length}, created ${makes.length}.\n`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(`\n  ${e.message}\n`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
