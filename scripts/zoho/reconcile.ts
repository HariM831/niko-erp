/**
 * Phase 4: EGGSY's trial balance against Zoho's, account by account.
 *
 *   npx tsx scripts/zoho/reconcile.ts
 *
 * Zoho has no usable trial balance over a date range — that endpoint ignores
 * from_date and to_date and answers as at today, which drops any profit and
 * loss account with no movement in the current year. So the comparison is
 * built from the two reports that do honour their parameters: the balance
 * sheet as at the cutoff for the position accounts, and the all-time profit
 * and loss for the rest. Between them they cover every account Zoho reports.
 *
 * Sign conventions differ and are converted rather than eyeballed. EGGSY
 * stores debit minus credit throughout; Zoho reports every figure positive in
 * its natural direction, so liabilities, equity and income are negated to
 * compare.
 */
import { readFile, writeFile } from "node:fs/promises";
import { and, eq, lte, sql } from "drizzle-orm";
import { accounts, journalEntries, journalEntryLines, zohoIdMap } from "@shared/schema";
import { db, pool } from "../../server/db";

/** Zoho's reports are as at this date; EGGSY is measured to the same day. */
const AS_AT = "2026-08-13";

interface ZohoNode {
  account_id?: string;
  name?: string;
  total?: number | string;
  account_transactions?: ZohoNode[];
  sub_sections?: ZohoNode[];
  sections?: ZohoNode[];
  children?: ZohoNode[];
}

function flatten(node: unknown, into: Map<string, number>) {
  if (Array.isArray(node)) {
    for (const n of node) flatten(n, into);
    return;
  }
  if (!node || typeof node !== "object") return;
  const o = node as ZohoNode;
  if (o.account_id) {
    const v = o.total === "" || o.total == null ? 0 : Number(o.total);
    // A parent appears with its own figure and again inside its children; the
    // first value wins so a rollup never double-counts.
    if (!into.has(String(o.account_id))) into.set(String(o.account_id), v);
  }
  for (const k of ["account_transactions", "sub_sections", "sections", "children"] as const) {
    if (o[k]) flatten(o[k], into);
  }
}

const money = (n: number) =>
  n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function main() {
  const zoho = new Map<string, number>();
  for (const f of ["balancesheet-today", "profitandloss-all-time"]) {
    const body = JSON.parse(await readFile(`.zoho-dump/reports/${f}.json`, "utf8"));
    flatten(body.balance_sheet ?? body.profit_and_loss, zoho);
  }
  console.log(`Zoho reports ${zoho.size} accounts`);

  const rows = await db
    .select({
      zohoId: zohoIdMap.zohoId,
      code: accounts.code,
      name: accounts.name,
      type: accounts.type,
      balance: sql<string>`COALESCE(SUM(${journalEntryLines.debit} - ${journalEntryLines.credit}), 0)::numeric(16,2)`,
    })
    .from(accounts)
    .leftJoin(zohoIdMap, and(eq(zohoIdMap.eggsyId, accounts.id), eq(zohoIdMap.entity, "account")))
    .leftJoin(journalEntryLines, eq(journalEntryLines.accountId, accounts.id))
    .leftJoin(
      journalEntries,
      and(eq(journalEntries.id, journalEntryLines.entryId), lte(journalEntries.entryDate, AS_AT)),
    )
    .groupBy(zohoIdMap.zohoId, accounts.code, accounts.name, accounts.type)
    .orderBy(accounts.code);

  const compared: Array<{
    code: string;
    name: string;
    type: string;
    eggsy: number;
    zoho: number | null;
    diff: number | null;
  }> = [];

  for (const r of rows) {
    const eggsy = Number(r.balance);
    const raw = r.zohoId ? zoho.get(r.zohoId) : undefined;
    // Zoho prints everything positive in its natural direction.
    const zo =
      raw === undefined
        ? null
        : ["liability", "equity", "income"].includes(r.type)
          ? -raw
          : raw;
    compared.push({
      code: r.code,
      name: r.name,
      type: r.type,
      eggsy,
      zoho: zo,
      diff: zo === null ? null : Number((eggsy - zo).toFixed(2)),
    });
  }

  const matched = compared.filter((c) => c.diff !== null && Math.abs(c.diff) < 0.005);
  const differing = compared
    .filter((c) => c.diff !== null && Math.abs(c.diff) >= 0.005)
    .sort((a, b) => Math.abs(b.diff!) - Math.abs(a.diff!));
  // An account Zoho does not report is not necessarily wrong: its reports omit
  // zero rows, so an account at nil in both systems simply is not there.
  const notInZoho = compared.filter((c) => c.zoho === null && Math.abs(c.eggsy) >= 0.005);
  const zeroBoth = compared.filter((c) => c.zoho === null && Math.abs(c.eggsy) < 0.005);

  const out: string[] = [];
  out.push(`TRIAL BALANCE — EGGSY against Zoho, as at ${AS_AT}`);
  out.push("");
  out.push(`  accounts compared        ${compared.length - zeroBoth.length}`);
  out.push(`  agreeing exactly         ${matched.length}`);
  out.push(`  differing                ${differing.length}`);
  out.push(`  carrying a balance Zoho does not report   ${notInZoho.length}`);
  out.push(`  nil in both, not reported                 ${zeroBoth.length}`);
  out.push("");
  out.push(`  total difference         ${money(differing.reduce((s, c) => s + c.diff!, 0))}`);
  out.push("");

  if (differing.length) {
    out.push("DIFFERENCES");
    out.push("");
    out.push(`  ${"code".padEnd(7)}${"account".padEnd(40)}${"EGGSY".padStart(18)}${"Zoho".padStart(18)}${"difference".padStart(16)}`);
    for (const c of differing) {
      out.push(
        `  ${c.code.padEnd(7)}${c.name.slice(0, 38).padEnd(40)}${money(c.eggsy).padStart(18)}${money(c.zoho!).padStart(18)}${money(c.diff!).padStart(16)}`,
      );
    }
    out.push("");
  }

  if (notInZoho.length) {
    out.push("CARRYING A BALANCE ZOHO DOES NOT REPORT");
    out.push("");
    for (const c of notInZoho) {
      out.push(`  ${c.code.padEnd(7)}${c.name.slice(0, 38).padEnd(40)}${money(c.eggsy).padStart(18)}`);
    }
    out.push("");
  }

  out.push("AGREEING EXACTLY");
  out.push("");
  for (const c of matched) {
    out.push(`  ${c.code.padEnd(7)}${c.name.slice(0, 38).padEnd(40)}${money(c.eggsy).padStart(18)}`);
  }

  await writeFile(".zoho-dump/trial-balance.txt", out.join("\n"));

  console.log(`\n  agreeing exactly   ${matched.length}`);
  console.log(`  differing          ${differing.length}`);
  console.log(`  in EGGSY only      ${notInZoho.length}`);
  console.log(`  nil in both        ${zeroBoth.length}`);
  console.log(`  net difference     ${money(differing.reduce((s, c) => s + c.diff!, 0))}`);
  if (differing.length) {
    console.log("\nLargest differences:");
    for (const c of differing.slice(0, 15)) {
      console.log(
        `  ${c.code.padEnd(7)}${c.name.slice(0, 34).padEnd(36)}${money(c.eggsy).padStart(18)}${money(c.zoho!).padStart(18)}${money(c.diff!).padStart(16)}`,
      );
    }
  }
  console.log("\nFull statement in .zoho-dump/trial-balance.txt");
  await pool.end();
}

main().catch(async (e) => {
  console.error(e.message);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
