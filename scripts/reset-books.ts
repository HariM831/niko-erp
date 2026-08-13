/**
 * Empty the books completely — every transaction, every master record, the
 * chart of accounts included. Intended for a migration or a pre-go-live reset.
 *
 * The table list is discovered from the database rather than written down, so
 * this cannot go stale the way the previous version did: it was authored before
 * fixed assets, inventory, reporting tags, custom fields, budgets and locations
 * existed, and silently left all of them behind.
 *
 * What survives is the things that are not "the books": who can sign in, what
 * the organisation is called, and the numbering configuration (its counters are
 * wound back to 1, but the series themselves stay).
 *
 * AFTER RUNNING THIS, EGGSY CANNOT POST ANYTHING. The posting engine resolves
 * accounts by system key — `ap`, `ar`, `sales`, `cash_bank` and the rest — and
 * this removes them along with everything else. Either run `npm run db:seed` to
 * rebuild the standard chart, or load a chart from the migration and assign the
 * system keys as part of it.
 */
import { sql } from "drizzle-orm";
import { db, pool } from "../server/db";

/**
 * Configuration and identity, not books. Anything else in `public` is data and
 * goes. Drizzle's own migration table lives in the `drizzle` schema, so it is
 * out of scope already.
 */
const KEEP = new Set([
  "users",
  "roles",
  "user_sessions",
  "org_profile",
  "number_series",
  "document_series",
  "preferences",
  "financial_years",
]);

async function main() {
  if (!process.argv.includes("--yes")) {
    console.error(
      "This erases every transaction, contact, item and account in the database.\n" +
        "Take a backup first:  pg_dump \"$DATABASE_URL\" > backup.sql\n" +
        "Then re-run with --yes to confirm.",
    );
    process.exit(1);
  }

  const found = await db.execute(sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);
  const targets = (found.rows as Array<{ table_name: string }>)
    .map((r) => r.table_name)
    .filter((t) => !KEEP.has(t));

  const before = new Map<string, number>();
  for (const t of targets) {
    const r = await db.execute(sql.raw(`SELECT COUNT(*)::int AS n FROM "${t}"`));
    before.set(t, (r.rows[0] as { n: number }).n);
  }

  await db.transaction(async (tx) => {
    // One TRUNCATE for the whole set. Postgres refuses to truncate a table that
    // something outside the list still points at, so an incomplete list fails
    // loudly here instead of leaving orphans behind — which is the point of
    // listing them all rather than cascading.
    const list = targets.map((t) => `"${t}"`).join(", ");
    await tx.execute(sql.raw(`TRUNCATE ${list} RESTART IDENTITY`));
    // Fresh books start their numbering at 1 again.
    await tx.execute(sql`UPDATE document_series SET next_number = 1`);
  });

  const cleared = [...before.entries()].filter(([, n]) => n > 0);
  for (const [t, n] of cleared) console.log(`  ${t}: ${n} row${n === 1 ? "" : "s"} deleted`);
  console.log(
    `\nCleared ${cleared.reduce((s, [, n]) => s + n, 0)} rows across ${cleared.length} tables ` +
      `(${targets.length} emptied in total).`,
  );
  console.log("Kept: " + [...KEEP].join(", ") + " — numbering counters reset to 1.");
  console.log("\nThe books have no chart of accounts. Nothing can post until one is loaded.");

  await pool.end();
  process.exit(0);
}

main();
