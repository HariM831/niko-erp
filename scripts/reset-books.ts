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
    SELECT con.conname AS name,
           src.relname AS from_table,
           tgt.relname AS to_table,
           pg_get_constraintdef(con.oid) AS definition
      FROM pg_constraint con
      JOIN pg_class src ON src.oid = con.conrelid
      JOIN pg_class tgt ON tgt.oid = con.confrelid
      JOIN pg_namespace n ON n.oid = src.relnamespace
     WHERE con.contype = 'f' AND n.nspname = 'public'
  `);
  const dangling = (
    links.rows as Array<{
      name: string;
      from_table: string;
      to_table: string;
      definition: string;
    }>
  ).filter((l) => KEEP.has(l.from_table) && !KEEP.has(l.to_table));

  await db.transaction(async (tx) => {
    /*
     * The constraint has to go, not just the values in it.
     *
     * Nulling the columns is not enough: TRUNCATE's check is structural, so
     * Postgres refuses while a foreign key merely *exists* pointing at a table
     * in the list, however few rows actually use it. Dropping and restoring it
     * around the truncate is the only way to keep the referencing row — and
     * DDL is transactional here, so a failure anywhere puts the constraint
     * back with the data.
     */
    for (const l of dangling) {
      await tx.execute(sql.raw(`ALTER TABLE "${l.from_table}" DROP CONSTRAINT "${l.name}"`));
    }

    // One TRUNCATE for the whole set. Postgres refuses to truncate a table that
    // something outside the list still points at, so an incomplete list fails
    // loudly here instead of leaving orphans behind — which is the point of
    // listing them all rather than cascading.
    const list = targets.map((t) => `"${t}"`).join(", ");
    await tx.execute(sql.raw(`TRUNCATE ${list} RESTART IDENTITY`));

    // The rows in the kept table survived; what they pointed at did not, so
    // the column is emptied before the constraint goes back on — otherwise
    // restoring it would fail against an id that no longer exists.
    for (const l of dangling) {
      const cols = /FOREIGN KEY \(([^)]+)\)/.exec(l.definition)?.[1] ?? "";
      for (const col of cols.split(",").map((c) => c.trim().replace(/"/g, ""))) {
        await tx.execute(sql.raw(`UPDATE "${l.from_table}" SET "${col}" = NULL`));
      }
      await tx.execute(
        sql.raw(`ALTER TABLE "${l.from_table}" ADD CONSTRAINT "${l.name}" ${l.definition}`),
      );
      console.log(`  ${l.from_table} → ${l.to_table}: link cleared, constraint restored`);
    }
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
