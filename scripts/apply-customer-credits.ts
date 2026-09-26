/**
 * Clear the customers whose money on account settles everything they owe.
 *
 * The Zoho load carried 3,489 payment applications across and left the rest
 * on account, faithfully — Zoho holds them unapplied too. But for most small
 * customers the reason is simply that nobody ever linked the receipt to the
 * invoice: Ali Whiz's three advances come to ₹10,80,500 against one invoice
 * for ₹10,80,500.
 *
 * This does only the unambiguous ones: a customer whose spare credit is at
 * least everything they have open. Every document ends settled and nothing is
 * left over, so there is no allocation anybody could disagree with. A customer
 * whose credit falls short is a real choice about which invoice it clears, and
 * belongs on the screen with a person in front of it.
 *
 * Group companies are skipped whatever their numbers say: the two LLPs are one
 * intra-group relationship with a set-off question still open.
 *
 * Each customer is posted in their OWN transaction, through the same service
 * the dialog uses, so its guards hold and a failure on the eleventh leaves the
 * first ten done rather than undoing them.
 *
 *   npx tsx scripts/apply-customer-credits.ts            # say what would happen
 *   npx tsx scripts/apply-customer-credits.ts --apply    # do it
 */
import { sql } from "drizzle-orm";
import { db } from "../server/db";
import { applyCreditPlan, creditPlanFor } from "../server/services/apply-credits";

const APPLY = process.argv.includes("--apply");

const money = (v: string | number) =>
  Number(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const candidates = (
  await db.execute(sql`
    WITH credit AS (
      SELECT customer_id AS id, sum(unapplied_amount) AS spare
        FROM customer_payments WHERE unapplied_amount > 0 GROUP BY 1
    ),
    owed AS (
      SELECT customer_id AS id, sum(balance_due) AS open
        FROM invoices
       WHERE status IN ('sent', 'partially_paid') AND balance_due > 0
       GROUP BY 1
    )
    SELECT c.id, c.display_name AS name, credit.spare, owed.open
      FROM credit
      JOIN owed ON owed.id = credit.id
      JOIN contacts c ON c.id = credit.id
     WHERE credit.spare >= owed.open
       AND COALESCE(c.is_group_company, FALSE) = FALSE
     ORDER BY c.display_name
  `)
).rows as Array<{ id: string; name: string; spare: string; open: string }>;

console.log(`\n  CUSTOMERS WHOSE CREDIT COVERS EVERYTHING THEY OWE — ${candidates.length}\n`);

let totalApplied = 0;
let done = 0;
const failures: string[] = [];

for (const c of candidates) {
  const plan = await creditPlanFor("customer", c.id);
  console.log(`  ${c.name}`);
  console.log(`    open ${money(plan.totalOwed)} · spare ${money(plan.totalAvailable)}`);
  for (const line of plan.plan) {
    console.log(`      ${line.documentNumber.padEnd(18)} ← ${line.number.padEnd(18)} ${money(line.amount).padStart(14)}`);
  }
  if (!plan.plan.length) {
    console.log("      nothing to apply — skipped");
    console.log();
    continue;
  }
  // Belt and braces: this script is only for the ones that end clean.
  if (Number(plan.owedAfter) !== 0) {
    console.log(`      ! would leave ${money(plan.owedAfter)} open — skipped, do this one on the screen`);
    console.log();
    continue;
  }
  console.log(`    → settles everything; ${money(plan.availableAfter)} left on account`);

  if (APPLY) {
    try {
      const out = await db.transaction((tx) => applyCreditPlan(tx, "customer", plan.plan));
      console.log(`    applied ${money(out.applied)} across ${out.documents} invoice(s)`);
      totalApplied += Number(out.applied);
      done++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`    ! FAILED: ${message}`);
      failures.push(`${c.name}: ${message}`);
    }
  }
  console.log();
}

if (!APPLY) {
  console.log("  dry run — nothing written. Re-run with --apply.\n");
} else {
  console.log(`  ${done} customer(s) cleared, ${money(totalApplied)} applied.`);
  if (failures.length) {
    console.log(`\n  ${failures.length} failed:`);
    for (const f of failures) console.log(`    ${f}`);
  }
  console.log();
}

process.exit(0);
