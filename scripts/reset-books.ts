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
 * AFTER RUNNING THIS, niko CANNOT POST ANYTHING. The posting engine resolves
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

  /*
   * Config that points *into* the books has to let go first.
   *
   * A kept table is allowed to reference a cleared one — `preferences` names
   * the item used for egg purchases and the one used for bird sales. Those are
   * settings, not books, so the row stays; but the item it names is about to
   * cease existing, and Postgres will not truncate a table something outside
   * the list still points at.
   *
   * Found by asking the database rather than listing them, for the same reason
   * the target list is discovered: a hardcoded pair here would be silently
   * wrong the day somebody adds a third.
   */
  const links = await db.execute(sql`
    SELECT tc.table_name AS from_table, kcu.column_name AS from_column,
           ccu.table_name AS to_table, c.is_nullable
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_name = tc.constraint_name
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
      JOIN information_schema.columns c
        ON c.table_name = tc.table_name AND c.column_name = kcu.column_name
     WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
  `);
  const dangling = (
    links.rows as Array<{
      from_table: string;
      from_column: string;
      to_table: string;
      is_nullable: string;
    }>
  ).filter((l) => KEEP.has(l.from_table) && !KEEP.has(l.to_table));

  const notNullable = dangling.filter((l) => l.is_nullable !== "YES");
  if (notNullable.length) {
    const names = notNullable.map((l) => `${l.from_table}.${l.from_column}`).join(", ");
    throw new Error(
      `Cannot empty the books: ${names} is NOT NULL but points at a table being cleared. ` +
        `Either make it nullable or move its table out of KEEP.`,
    );
  }

  await db.transaction(async (tx) => {
    for (const l of dangling) {
      await tx.execute(
        sql.raw(`UPDATE "${l.from_table}" SET "${l.from_column}" = NULL WHERE "${l.from_column}" IS NOT NULL`),
      );
      console.log(`  ${l.from_table}.${l.from_column} cleared (pointed at ${l.to_table})`);
    }

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
