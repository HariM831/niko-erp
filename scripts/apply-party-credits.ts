/**
 * Clear the parties whose money on account settles everything that is open.
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
 * whose credit falls short is a real choice about which document it clears,
 * and belongs on the screen with a person in front of it. The vendor ledger
 * is the same shape: a payment sent before the bill ever arrived.
 *
 * Group companies are skipped whatever their numbers say: the two LLPs are one
 * intra-group relationship with a set-off question still open.
 *
 * Each customer is posted in their OWN transaction, through the same service
 * the dialog uses, so its guards hold and a failure on the eleventh leaves the
 * first ten done rather than undoing them.
 *
 *   npx tsx scripts/apply-party-credits.ts --side customer
 *   npx tsx scripts/apply-party-credits.ts --side vendor --apply
 */
import { sql } from "drizzle-orm";
import { db } from "../server/db";
import { applyCreditPlan, creditPlanFor } from "../server/services/apply-credits";

const APPLY = process.argv.includes("--apply");
const SIDE = process.argv[process.argv.indexOf("--side") + 1] as "customer" | "vendor";
if (SIDE !== "customer" && SIDE !== "vendor") {
  console.log("\n  Say which ledger: --side customer | --side vendor\n");
  process.exit(1);
}
const DOC = SIDE === "customer" ? "invoice" : "bill";

const money = (v: string | number) =>
  Number(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/* The two ledgers differ only in their table names and their open statuses. */
const credits = SIDE === "customer" ? sql`customer_payments` : sql`vendor_payments`;
const party = SIDE === "customer" ? sql`customer_id` : sql`vendor_id`;
const documents = SIDE === "customer" ? sql`invoices` : sql`bills`;
const openStatus = SIDE === "customer" ? sql`('sent', 'partially_paid')` : sql`('open', 'partially_paid')`;

const candidates = (
  await db.execute(sql`
    WITH credit AS (
      SELECT ${party} AS id, sum(unapplied_amount) AS spare
        FROM ${credits} WHERE unapplied_amount > 0 GROUP BY 1
    ),
    owed AS (
      SELECT ${party} AS id, sum(balance_due) AS open
        FROM ${documents}
       WHERE status IN ${openStatus} AND balance_due > 0
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

const who = SIDE === "customer" ? "CUSTOMERS" : "VENDORS";

console.log(`\n  ${who} WHOSE CREDIT COVERS EVERYTHING OPEN — ${candidates.length}\n`);

let totalApplied = 0;
let done = 0;
const failures: string[] = [];

for (const c of candidates) {
  const plan = await creditPlanFor(SIDE, c.id);
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
      const out = await db.transaction((tx) => applyCreditPlan(tx, SIDE, plan.plan));
      console.log(`    applied ${money(out.applied)} across ${out.documents} ${DOC}(s)`);
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
  console.log(`  ${done} ${SIDE}(s) cleared, ${money(totalApplied)} applied.`);
  if (failures.length) {
    console.log(`\n  ${failures.length} failed:`);
    for (const f of failures) console.log(`    ${f}`);
  }
  console.log();
}

process.exit(0);
