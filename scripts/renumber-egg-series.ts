/**
 * Lay the egg invoice series back into one run, in dispatch-date order.
 *
 *   npx tsx scripts/renumber-egg-series.ts            # say what would change
 *   npx tsx scripts/renumber-egg-series.ts --apply    # change it
 *
 * Two books were kept at once. Zoho renumbered A-INV-EG-27-0589 to 0568 on
 * 5 August and from there the sequences ran six apart, so the same number
 * names a different sale in each. 815 invoices match between them, 126 exist
 * only in Zoho and 42 only here.
 *
 * The plan is not computed here. It is read from
 * docs/egg-series-renumber-2026-10.json, which was produced by matching the
 * two books on customer, date and amount and is the artefact that was
 * reviewed. This script's job is to apply it and to refuse if the database no
 * longer looks like the one the plan was built against.
 *
 * Everything dated 4 August or earlier keeps its number; 0566 is the last
 * frozen one. The date is the DISPATCH date, which niko already uses natively
 * — all 21 of its own dispatches carry invoice_date = dispatch_date. Where the
 * books disagreed Zoho's was earlier every single time, so Zoho's is the
 * dispatch day, and 87 invoices move back by one to six days.
 *
 * A renumber is a permutation, not a shift: 0805 becomes 0847 while 0847
 * becomes 0955. Applying it in one pass would collide with the unique index
 * halfway through, so every invoice moves to a temporary number first and to
 * its real one second, inside a single transaction.
 *
 * Re-dating carries the JOURNAL with it. An invoice whose date moves from
 * September to August while its journal entry stays put would shift the sale
 * between months on the invoice list and not in the ledger, which is the kind
 * of difference nobody finds until a return is filed.
 */
import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { invoices, journalEntries } from "@shared/schema";
import { db, pool } from "../server/db";

const APPLY = process.argv.includes("--apply");
const PLAN = "docs/egg-series-renumber-2026-10.json";
const PREFIX = "A-INV-EG-27-";

interface Move { current: string; new: string; date?: string }
interface Create { zoho: string; new: string; date: string; customer: string; amount: number }
interface Plan {
  frozenThrough: string;
  from: string;
  moves: Move[];
  creates: Create[];
}

async function main() {
  const plan = JSON.parse(readFileSync(PLAN, "utf8")) as Plan;
  console.log(`\n  Egg invoice series — ${APPLY ? "WRITING" : "dry run"}`);
  console.log(`  plan: ${PLAN}, frozen through ${plan.frozenThrough}, from ${plan.from}\n`);

  const live = await db
    .select({ number: invoices.number, date: invoices.invoiceDate, je: invoices.journalEntryId })
    .from(invoices)
    .where(sql`${invoices.number} LIKE ${PREFIX + "%"}`);
  const byNumber = new Map(live.map((r) => [r.number, r]));
  const frozenSeq = Number(plan.frozenThrough.slice(PREFIX.length));

  /**
   * The plan was built against a particular database. If somebody has raised
   * an invoice since, or one of the moves names a document that is no longer
   * there, the arithmetic behind every number in the plan is wrong — so this
   * refuses rather than applying most of it.
   */
  const problems: string[] = [];
  for (const m of plan.moves) {
    if (!byNumber.has(m.current)) problems.push(`${m.current} is in the plan and not in the database`);
  }
  const moving = new Set(plan.moves.map((m) => m.current));
  for (const r of live) {
    const seq = Number(r.number.slice(PREFIX.length));
    if (seq > frozenSeq && !moving.has(r.number)) {
      problems.push(`${r.number} is past ${plan.frozenThrough} and the plan says nothing about it`);
    }
  }
  const targets = new Set<string>();
  for (const t of [...plan.moves.map((m) => m.new), ...plan.creates.map((c) => c.new)]) {
    if (targets.has(t)) problems.push(`${t} is claimed twice by the plan`);
    targets.add(t);
    if (Number(t.slice(PREFIX.length)) <= frozenSeq) problems.push(`${t} would land inside the frozen run`);
  }

  const renumber = plan.moves.filter((m) => m.current !== m.new);
  const redate = plan.moves.filter((m) => m.date);
  const noJournal = plan.moves.filter((m) => m.date && !byNumber.get(m.current)?.je);
  console.log(`  ${live.length} egg invoices on file, ${frozenSeq} frozen`);
  console.log(`    renumber ....... ${renumber.length}`);
  console.log(`    re-date ........ ${redate.length}${noJournal.length ? `  (${noJournal.length} with no journal to move)` : ""}`);
  console.log(`    to create later  ${plan.creates.length}   (this script does not create them)`);

  if (problems.length) {
    console.log(`\n  REFUSING — the database is not the one the plan was built against:`);
    for (const p of problems.slice(0, 15)) console.log(`    ${p}`);
    if (problems.length > 15) console.log(`    ... and ${problems.length - 15} more`);
    throw new Error(`${problems.length} problem(s); rebuild the plan`);
  }
  console.log(`\n  the plan and the database agree`);

  console.log(`\n  first ten moves:`);
  for (const m of plan.moves.slice(0, 10)) {
    const now = byNumber.get(m.current)!;
    console.log(
      `    ${m.current} -> ${m.new}` +
        (m.date ? `   ${now.date} -> ${m.date}` : `   ${now.date}`),
    );
  }

  if (!APPLY) {
    console.log("\n  Dry run — nothing written. Re-run with --apply.\n");
    await pool.end();
    return;
  }

  await db.transaction(async (tx) => {
    // Out of the way first. "~" sorts past every real number and no document
    // has ever been issued under one, so a half-applied run is obvious.
    for (const m of plan.moves) {
      await tx.update(invoices).set({ number: `~${m.new}` }).where(eq(invoices.number, m.current));
    }
    for (const m of plan.moves) {
      await tx.update(invoices).set({ number: m.new }).where(eq(invoices.number, `~${m.new}`));
      if (m.date) {
        const [row] = await tx
          .select({ je: invoices.journalEntryId })
          .from(invoices)
          .where(eq(invoices.number, m.new));
        await tx.update(invoices).set({ invoiceDate: m.date }).where(eq(invoices.number, m.new));
        if (row?.je) {
          await tx.update(journalEntries).set({ entryDate: m.date }).where(eq(journalEntries.id, row.je));
        }
      }
    }
  });

  const [{ left }] = (
    await db.execute(sql`SELECT count(*)::int AS left FROM invoices WHERE number LIKE '~%'`)
  ).rows as Array<{ left: number }>;
  console.log(`\n  Done: ${renumber.length} renumbered, ${redate.length} re-dated.`);
  console.log(`  temporary numbers remaining: ${left}\n`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(`\n  ${e.message}\n`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
