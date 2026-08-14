/**
 * Phase 4: EGGSY's postings against Zoho's, account by account and day by day.
 *
 *   npx tsx scripts/zoho/verify-ledger.ts
 *
 * The trial balance compares net balances, which two offsetting errors inside
 * one account will pass. This compares the movements themselves: for every
 * account on every day, the debits and the credits, separately.
 *
 * Zoho's ledger endpoint is throttled hard and the sweep gets blocked partway,
 * but it returns rows in date order, so a partial pull is a complete record up
 * to the date it reached rather than a random half. The comparison runs over
 * exactly that window and says where it ends.
 */
import { readFile } from "node:fs/promises";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { accounts, journalEntries, journalEntryLines, zohoIdMap } from "@shared/schema";
import { db, pool } from "../../server/db";

/** The to_date pull-ledger.ts asks Zoho for; reaching it means nothing is missing. */
const PULLED_TO = "2026-08-13";

interface Posting {
  date: string;
  account_id: string;
  account_name: string;
  transaction_type: string;
  debit: number | string;
  credit: number | string;
}

const paise = (v: number | string | undefined) =>
  v === "" || v == null ? 0 : Math.round(Number(v) * 100);
const money = (p: number) =>
  (p / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function main() {
  const rows: Posting[] = (await readFile(".zoho-dump/ledger/all-postings.jsonl", "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

  const dates = rows.map((r) => r.date).sort();
  const from = dates[0]!;
  const lastDay = dates[dates.length - 1]!;
  // A pull that stopped early stopped part-way through a day, and comparing
  // that day would report the edge of the fetch as a difference. A pull that
  // reached its own end date has that day whole, so it counts.
  const complete = lastDay >= PULLED_TO;
  const to = complete
    ? lastDay
    : rows.filter((r) => r.date < lastDay).map((r) => r.date).sort().pop()!;

  const inWindow = rows.filter((r) => r.date <= to);
  console.log(`Zoho postings from ${from} to ${to}: ${inWindow.length}`);
  console.log(
    complete
      ? "(the pull ran to completion, so every day is compared)\n"
      : `(the pull stopped inside ${lastDay}, so that day is left out)\n`,
  );

  // Zoho's export drops lines. 163 vendor payments come back with three legs of
  // a four-leg journal: the advance (Dr Prepaid, Cr Bank) and its application
  // (Dr Payable) but not the Cr Prepaid joining them, so the payment reports
  // twice the debit it has credit. The missing leg is reconstructed here —
  // strictly where the imbalance equals the payable debit on that same payment,
  // which is the only reading that closes it — and anything else is reported.
  const legsOf = new Map<string, Posting[]>();
  for (const r of inWindow) legsOf.set(r.transaction_id, [...(legsOf.get(r.transaction_id) ?? []), r]);

  // Applications come in pairs and the export drops one leg of the pair, so the
  // control-account movement left without a partner is the gap. Reconstructing
  // it needs no guesswork about which account: an unpaired payable debit can
  // only have come out of the advance that funded it, and likewise a receivable
  // credit can only have been settled from the advance held against it.
  const PAIRS = [
    { control: "Accounts Payable", advance: "Prepaid Expenses", sign: 1 },
    { control: "Accounts Receivable", advance: "Unearned Revenue", sign: -1 },
  ] as const;

  const repaired: Posting[] = [];
  const unexplained: Array<{ id: string; date: string; gap: number }> = [];
  for (const [id, legs] of legsOf) {
    const gap = legs.reduce((s, l) => s + paise(l.debit) - paise(l.credit), 0);
    if (gap === 0) continue;
    const sum = (name: string, side: "debit" | "credit") =>
      legs.filter((l) => l.account_name === name).reduce((s, l) => s + paise(l[side]), 0);

    const rule = PAIRS.find((p) => {
      if (Math.sign(gap) !== p.sign) return false;
      // The advance account must already be in play, and the unpaired movement
      // must be the whole gap — otherwise this is a shape I have not seen.
      const unpaired =
        p.sign > 0
          ? sum(p.control, "debit") - sum(p.advance, "credit")
          : sum(p.advance, "debit") - sum(p.control, "credit");
      return sum(p.advance, p.sign > 0 ? "debit" : "credit") > 0 && unpaired === gap;
    });
    const seed = rule && legs.find((l) => l.account_name === rule.advance);
    if (rule && seed) {
      // Vendor side: the missing leg credits the advance. Customer side: debits it.
      repaired.push(
        rule.sign > 0
          ? { ...seed, debit: 0, credit: gap / 100 }
          : { ...seed, debit: -gap / 100, credit: 0 },
      );
    } else {
      unexplained.push({ id, date: legs[0]!.date, gap });
    }
  }
  console.log(
    `Zoho journals that do not balance in the export: ${repaired.length + unexplained.length}`,
  );
  console.log(`  missing credit reconstructed  ${repaired.length}`);
  console.log(`  left as-is, pattern differs   ${unexplained.length}`);
  for (const u of unexplained.sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap)).slice(0, 8)) {
    console.log(`    ${u.date}  ${u.id}  out by ${money(u.gap)}`);
  }
  console.log();
  inWindow.push(...repaired);

  // Zoho: account + day -> debit, credit
  const zoho = new Map<string, { dr: number; cr: number; name: string }>();
  for (const r of inWindow) {
    const k = `${r.account_id}|${r.date}`;
    const e = zoho.get(k) ?? { dr: 0, cr: 0, name: r.account_name };
    e.dr += paise(r.debit);
    e.cr += paise(r.credit);
    zoho.set(k, e);
  }

  const eggsyRows = await db
    .select({
      zohoId: zohoIdMap.zohoId,
      name: accounts.name,
      code: accounts.code,
      date: journalEntries.entryDate,
      dr: sql<string>`SUM(${journalEntryLines.debit})::numeric(16,2)`,
      cr: sql<string>`SUM(${journalEntryLines.credit})::numeric(16,2)`,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalEntryLines.entryId))
    .innerJoin(accounts, eq(accounts.id, journalEntryLines.accountId))
    .leftJoin(zohoIdMap, and(eq(zohoIdMap.eggsyId, accounts.id), eq(zohoIdMap.entity, "account")))
    .where(and(gte(journalEntries.entryDate, from), lte(journalEntries.entryDate, to)))
    .groupBy(zohoIdMap.zohoId, accounts.name, accounts.code, journalEntries.entryDate);

  const eggsy = new Map<string, { dr: number; cr: number; name: string; code: string }>();
  for (const r of eggsyRows) {
    if (!r.zohoId) continue;
    eggsy.set(`${r.zohoId}|${r.date}`, {
      dr: paise(r.dr),
      cr: paise(r.cr),
      name: r.name,
      code: r.code,
    });
  }

  const keys = new Set([...zoho.keys(), ...eggsy.keys()]);
  const diffs: Array<{ key: string; name: string; date: string; drDiff: number; crDiff: number }> = [];
  let agreeing = 0;
  let grossOnly = 0;
  for (const k of keys) {
    const z = zoho.get(k) ?? { dr: 0, cr: 0, name: "" };
    const e = eggsy.get(k) ?? { dr: 0, cr: 0, name: "", code: "" };
    const drDiff = e.dr - z.dr;
    const crDiff = e.cr - z.cr;
    if (drDiff === 0 && crDiff === 0) agreeing += 1;
    // Zoho routes an advance in and straight out again through the same account
    // on the same day; EGGSY posts where the money ends up. Equal net movement
    // and unequal gross is that, and it changes no balance.
    else if (drDiff === crDiff) grossOnly += 1;
    else {
      diffs.push({
        key: k,
        name: e.name || z.name,
        date: k.split("|")[1]!,
        drDiff,
        crDiff,
      });
    }
  }

  console.log(`account-days compared     ${keys.size}`);
  console.log(`  agreeing exactly        ${agreeing}`);
  console.log(`  same net, gross differs ${grossOnly}`);
  console.log(`  net movement differs    ${diffs.length}`);
  console.log(
    `  net difference          ${money(diffs.reduce((s, d) => s + d.drDiff - d.crDiff, 0))}`,
  );

  // Which accounts are involved matters more than which days. A timing
  // difference shows up as a pair of accounts whose differences cancel; a real
  // error does not cancel against anything.
  const byAccount = new Map<string, { name: string; days: number; dr: number; cr: number }>();
  for (const d of diffs) {
    const acct = d.key.split("|")[0]!;
    const e = byAccount.get(acct) ?? { name: d.name, days: 0, dr: 0, cr: 0 };
    e.days += 1;
    e.dr += d.drDiff;
    e.cr += d.crDiff;
    byAccount.set(acct, e);
  }

  console.log("\nDifferences by account (EGGSY minus Zoho, over the whole window):");
  console.log(
    `  ${"account".padEnd(38)}${"days".padStart(6)}${"debit".padStart(18)}${"credit".padStart(18)}${"net".padStart(18)}`,
  );
  const ranked = [...byAccount.values()].sort(
    (a, b) => Math.abs(b.dr - b.cr) - Math.abs(a.dr - a.cr) || Math.abs(b.dr) - Math.abs(a.dr),
  );
  for (const a of ranked) {
    console.log(
      `  ${a.name.slice(0, 36).padEnd(38)}${String(a.days).padStart(6)}${money(a.dr).padStart(18)}${money(a.cr).padStart(18)}${money(a.dr - a.cr).padStart(18)}`,
    );
  }
  console.log(
    `  ${"".padEnd(38)}${"".padStart(6)}${money(ranked.reduce((s, a) => s + a.dr, 0)).padStart(18)}${money(ranked.reduce((s, a) => s + a.cr, 0)).padStart(18)}${money(ranked.reduce((s, a) => s + a.dr - a.cr, 0)).padStart(18)}`,
  );
  await pool.end();
}

main().catch(async (e) => {
  console.error(e.message);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
