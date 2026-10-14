/**
 * Fill in where money owed to a vendor is sent.
 *
 *   npx tsx scripts/load-vendor-bank-details.ts <file.csv>
 *   npx tsx scripts/load-vendor-bank-details.ts <file.csv> --commit
 *
 * Columns: niko_vendor, beneficiary_name, account_number, ifsc, bank_name, sheet_row
 *
 * The CSV is reviewed data, not a dump to be re-derived here: the hard part was
 * deciding which of 172 rows in the office's workbook land on exactly one
 * vendor, and that decision is recorded in the file rather than guessed at by a
 * fuzzy match at load time. Rows whose party was in any doubt are not in it.
 *
 * A wrong row here is money sent to a stranger, so the whole run refuses on any
 * problem at all: a vendor name that matches nothing, a name that matches two
 * contacts, a malformed IFSC, or a contact that already holds a DIFFERENT
 * account number. Nothing is half-applied.
 *
 * The beneficiary name comes from the workbook, not from niko's display name:
 * a bank credits on the name it holds, and the office keyed these off the
 * passbooks. The workbook's branch column has nowhere to go — contacts have no
 * branch field and the payment file never asks for one.
 */
import { readFileSync } from "node:fs";
import { eq, inArray, sql } from "drizzle-orm";
import { contacts } from "@shared/schema";
import { db, pool } from "../server/db";

const COMMIT = process.argv.includes("--commit");
const file = process.argv.slice(2).find((a) => !a.startsWith("--"));

const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const ACCOUNT = /^[0-9A-Za-z]{5,30}$/;

/** Enough CSV for a reviewed file: quoted fields, doubled quotes inside them. */
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
  if (!file) throw new Error("give the CSV of vendor bank details");
  const [header, ...lines] = parse(readFileSync(file, "utf8"));
  const want = ["niko_vendor", "beneficiary_name", "account_number", "ifsc", "bank_name"];
  const col = want.map((w) => header!.findIndex((h) => h.trim() === w));
  if (col.some((i) => i < 0)) throw new Error(`the CSV needs the columns ${want.join(", ")}`);

  const rows = lines.map((l) => ({
    vendor: l[col[0]!]!.trim(), benef: l[col[1]!]!.trim(), account: l[col[2]!]!.trim(),
    ifsc: l[col[3]!]!.trim().toUpperCase(), bank: l[col[4]!]!.trim(),
    sheetRow: (l[header!.findIndex((h) => h.trim() === "sheet_row")] ?? "").trim(),
  }));
  console.log(`\n  ${rows.length} vendor(s) from ${file} — ${COMMIT ? "WRITING" : "dry run"}\n`);

  const problems: string[] = [];
  const seen = new Map<string, string>();
  for (const r of rows) {
    const where = r.sheetRow ? `sheet row ${r.sheetRow}` : r.vendor;
    if (!IFSC.test(r.ifsc)) problems.push(`${where}: "${r.ifsc}" is not an IFSC`);
    if (!ACCOUNT.test(r.account)) problems.push(`${where}: "${r.account}" is not an account number`);
    if (!r.benef) problems.push(`${where}: no beneficiary name`);
    const twin = seen.get(r.vendor);
    if (twin) problems.push(`${where}: ${r.vendor} is also on ${twin} — one vendor, one account`);
    else seen.set(r.vendor, where);
  }

  const live = await db
    .select({
      id: contacts.id, name: contacts.displayName, type: contacts.type,
      account: contacts.bankAccountNumber, ifsc: contacts.bankIfsc, benef: contacts.bankBeneficiaryName,
    })
    .from(contacts)
    .where(inArray(contacts.displayName, rows.map((r) => r.vendor)));
  const byName = new Map<string, typeof live>();
  for (const c of live) byName.set(c.name, [...(byName.get(c.name) ?? []), c]);

  const todo: Array<{ id: string; r: (typeof rows)[number]; was: string }> = [];
  let unchanged = 0;
  for (const r of rows) {
    const where = r.sheetRow ? `sheet row ${r.sheetRow}` : r.vendor;
    const hits = byName.get(r.vendor) ?? [];
    if (hits.length === 0) { problems.push(`${where}: no contact named "${r.vendor}"`); continue; }
    if (hits.length > 1) { problems.push(`${where}: ${hits.length} contacts named "${r.vendor}"`); continue; }
    const c = hits[0]!;
    if (c.type === "customer") problems.push(`${where}: "${r.vendor}" is a customer, not a vendor`);
    const held = (c.account ?? "").trim();
    if (held && held !== r.account) {
      problems.push(`${where}: "${r.vendor}" already holds ${held}, the sheet says ${r.account}`);
      continue;
    }
    if (held === r.account && (c.ifsc ?? "") === r.ifsc && (c.benef ?? "") === r.benef) { unchanged++; continue; }
    todo.push({ id: c.id, r, was: held ? "same account, filling the rest" : "" });
  }

  for (const t of todo.slice(0, 10)) {
    console.log(`    ${t.r.vendor.slice(0, 40).padEnd(41)} ${t.r.account.padEnd(20)} ${t.r.ifsc}  ${t.r.bank}`);
  }
  if (todo.length > 10) console.log(`    ... and ${todo.length - 10} more`);
  console.log(`\n    to fill in ..... ${todo.length}`);
  console.log(`    already right .. ${unchanged}`);
  if (problems.length) {
    console.log(`    problems ....... ${problems.length}`);
    for (const p of problems) console.log(`      ${p}`);
    throw new Error("nothing written while a row is in doubt");
  }

  if (!COMMIT) {
    console.log("\n  Dry run — nothing written. Re-run with --commit.\n");
    await pool.end();
    return;
  }
  // One transaction: the office gets all of it or none of it.
  await db.transaction(async (tx) => {
    for (const t of todo) {
      await tx
        .update(contacts)
        .set({
          bankBeneficiaryName: t.r.benef, bankAccountNumber: t.r.account,
          bankIfsc: t.r.ifsc, bankName: t.r.bank, updatedAt: sql`now()`,
        })
        .where(eq(contacts.id, t.id));
    }
  });
  console.log(`\n  Filled in bank details for ${todo.length} vendor(s).\n`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(`\n  ${e.message}\n`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
