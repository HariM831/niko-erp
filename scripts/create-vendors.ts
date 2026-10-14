/**
 * Add a vendor the office pays but niko has never heard of.
 *
 *   npx tsx scripts/create-vendors.ts <file.csv>
 *   npx tsx scripts/create-vendors.ts <file.csv> --commit
 *
 * Columns: display_name, gst_treatment, place_of_supply, beneficiary_name,
 *          account_number, ifsc, bank_name   (everything after the name optional)
 *
 * Written for the parties in the office's bank sheet that production has no
 * contact for. A vendor created here has a name, a GST treatment and the
 * account its money goes to — no address, no PAN, nobody's phone number. That
 * is enough to raise a bill against and enough to pay, and inventing the rest
 * would only make it look verified.
 *
 * It refuses rather than risk a second row for a party niko already holds:
 * an exact name, a name differing only in case, punctuation or an M/S prefix,
 * or an account number another contact already uses. The duplicate vendors the
 * Zoho contact load left on staging are what that guard is for.
 */
import { readFileSync } from "node:fs";
import { inArray } from "drizzle-orm";
import { contacts, gstTreatment } from "@shared/schema";
import { db, pool } from "../server/db";

const COMMIT = process.argv.includes("--commit");
const file = process.argv.slice(2).find((a) => !a.startsWith("--"));

const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const ACCOUNT = /^[0-9A-Za-z]{5,30}$/;
/** Straight from the schema, so a renamed treatment cannot go stale here. */
const TREATMENTS: readonly string[] = gstTreatment.enumValues;

/** Same party, written differently: case, punctuation, an M/S or Ms. prefix. */
const squash = (s: string) =>
  s.toLowerCase().replace(/^(m\/s\.?|ms\.?)\s+/, "").replace(/[^a-z0-9]/g, "");

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
  if (!file) throw new Error("give the CSV of vendors to create");
  const [header, ...lines] = parse(readFileSync(file, "utf8"));
  const at = (name: string) => header!.findIndex((h) => h.trim() === name);
  if (at("display_name") < 0) throw new Error("the CSV needs a display_name column");
  const get = (l: string[], name: string) => {
    const i = at(name);
    return i < 0 ? "" : (l[i] ?? "").trim();
  };
  const rows = lines.map((l) => ({
    name: get(l, "display_name"),
    treatment: get(l, "gst_treatment") || "unregistered_business",
    pos: get(l, "place_of_supply"),
    benef: get(l, "beneficiary_name"),
    account: get(l, "account_number"),
    ifsc: get(l, "ifsc").toUpperCase(),
    bank: get(l, "bank_name"),
  }));
  console.log(`\n  ${rows.length} vendor(s) from ${file} — ${COMMIT ? "WRITING" : "dry run"}\n`);

  const problems: string[] = [];
  for (const r of rows) {
    if (!TREATMENTS.includes(r.treatment))
      problems.push(`${r.name}: "${r.treatment}" is not a GST treatment — one of ${TREATMENTS.join(", ")}`);
    if (r.account && !ACCOUNT.test(r.account)) problems.push(`${r.name}: "${r.account}" is not an account number`);
    if (r.ifsc && !IFSC.test(r.ifsc)) problems.push(`${r.name}: "${r.ifsc}" is not an IFSC`);
    if (r.account && !r.ifsc) problems.push(`${r.name}: an account number with no IFSC`);
    if (r.account && !r.benef) problems.push(`${r.name}: an account number with no beneficiary name`);
  }

  // The whole table, because the guard is about look-alikes, not exact names.
  const live = await db
    .select({ name: contacts.displayName, type: contacts.type, account: contacts.bankAccountNumber })
    .from(contacts);
  const byShape = new Map(live.map((c) => [squash(c.name), c]));
  const byAccount = new Map(live.filter((c) => c.account).map((c) => [c.account!.trim(), c]));
  for (const r of rows) {
    const twin = byShape.get(squash(r.name));
    if (twin) problems.push(`${r.name}: niko already has "${twin.name}"`);
    const held = r.account ? byAccount.get(r.account) : undefined;
    if (held) problems.push(`${r.name}: account ${r.account} already belongs to "${held.name}"`);
  }

  for (const r of rows) {
    console.log(`    ${r.name.slice(0, 40).padEnd(41)} ${r.treatment.padEnd(22)} ${r.account || "(no account)"}`);
  }
  if (problems.length) {
    console.log(`\n    problems ... ${problems.length}`);
    for (const p of problems) console.log(`      ${p}`);
    throw new Error("nothing created while a row is in doubt");
  }

  if (!COMMIT) {
    console.log("\n  Dry run — nothing written. Re-run with --commit.\n");
    await pool.end();
    return;
  }
  const made = await db
    .insert(contacts)
    .values(rows.map((r) => ({
      type: "vendor" as const,
      displayName: r.name,
      companyName: r.name,
      gstTreatment: r.treatment as "unregistered_business",
      placeOfSupplyState: r.pos || null,
      bankBeneficiaryName: r.benef || null,
      bankAccountNumber: r.account || null,
      bankIfsc: r.ifsc || null,
      bankName: r.bank || null,
    })))
    .returning({ id: contacts.id, name: contacts.displayName });
  for (const m of made) console.log(`    created ${m.name}`);
  console.log(`\n  Created ${made.length} vendor(s).\n`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(`\n  ${e.message}\n`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
