/**
 * Merge one contact into another.
 *
 * "Luit Valley" existed twice: a customer carrying the feed we invoiced out and
 * a vendor carrying the eggs we billed in — one company entered under two legal
 * forms, so its ledger read as two halves that never met.
 *
 * The FK list is read from the catalogue rather than typed out. There are 16
 * columns pointing at `contacts` today and there will be more; a hand-written
 * list is a merge that silently leaves rows behind the next time somebody adds
 * a table.
 *
 * The loser is RETIRED, never deleted. Nothing points at it once this finishes,
 * but a deleted row cannot answer "where did these seven invoices come from"
 * six months from now.
 *
 * Refuses rather than guesses: differing GSTIN, PAN or opening balance means
 * these are two real companies, not one entered twice.
 *
 * Run: npx tsx scripts/merge-contacts.ts "<loser name>" "<winner name>"
 */
import { eq, sql } from "drizzle-orm";
import { contacts } from "@shared/schema";
import { db } from "../server/db";

const [loserName, winnerName] = process.argv.slice(2);
if (!loserName || !winnerName) {
  console.log('\n  Usage: npx tsx scripts/merge-contacts.ts "<loser>" "<winner>"\n');
  process.exit(1);
}

await db.transaction(async (tx) => {
  const found = await tx
    .select()
    .from(contacts)
    .where(sql`${contacts.displayName} IN (${loserName}, ${winnerName})`);
  const loser = found.find((c) => c.displayName === loserName);
  const winner = found.find((c) => c.displayName === winnerName);
  if (!loser) throw new Error(`No contact named "${loserName}"`);
  if (!winner) throw new Error(`No contact named "${winnerName}"`);
  if (loser.id === winner.id) throw new Error("Those are the same contact");

  // ── Refuse if they look like two real companies ───────────────────────────
  const clash = (field: string, a: unknown, b: unknown) =>
    a && b && String(a).trim() !== String(b).trim()
      ? `${field}: "${a}" vs "${b}"`
      : null;
  const clashes = [
    clash("GSTIN", loser.gstin, winner.gstin),
    clash("PAN", loser.pan, winner.pan),
  ].filter((v): v is string => !!v);
  if (clashes.length) {
    throw new Error(
      `These look like two different companies — ${clashes.join("; ")}. Merge by hand.`,
    );
  }
  const openings = [loser.openingBalance, winner.openingBalance].map((v) => Number(v ?? 0));
  if (openings.some((v) => v !== 0)) {
    throw new Error(
      `Opening balances are ${openings.join(" and ")} — merging would move one onto the other's ledger. Do this by hand.`,
    );
  }

  console.log(`\n  ${loser.displayName} (${loser.type})  →  ${winner.displayName} (${winner.type})\n`);

  // ── Every column in the database that points at a contact ─────────────────
  const fks = (
    await tx.execute(sql`
      SELECT tc.table_name AS tbl, kcu.column_name AS col
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
      JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY' AND ccu.table_name = 'contacts'
      ORDER BY tc.table_name, kcu.column_name`)
  ).rows as Array<{ tbl: string; col: string }>;

  let total = 0;
  for (const { tbl, col } of fks) {
    const res = await tx.execute(
      sql`UPDATE ${sql.identifier(tbl)} SET ${sql.identifier(col)} = ${winner.id}
          WHERE ${sql.identifier(col)} = ${loser.id}`,
    );
    const n = res.rowCount ?? 0;
    if (n) {
      console.log(`  moved   ${String(n).padStart(4)}  ${tbl}.${col}`);
      total += n;
    }
  }
  if (!total) console.log("  moved      0  nothing pointed at the loser");

  // ── The surviving record has to work in both directions ───────────────────
  // It is now invoiced AND billed; a one-sided type would make half its own
  // history unreachable from the screens that filter by type.
  if (winner.type !== "both") {
    await tx.update(contacts).set({ type: "both" }).where(eq(contacts.id, winner.id));
    console.log(`\n  ${winner.displayName}: type ${winner.type} → both`);
  }

  const note = `Merged from "${loser.displayName}" — ${total} row(s) repointed.`;
  await tx
    .update(contacts)
    .set({ notes: winner.notes ? `${winner.notes}\n${note}` : note })
    .where(eq(contacts.id, winner.id));

  await tx
    .update(contacts)
    .set({
      isActive: false,
      notes: `Merged into "${winner.displayName}". Kept so its history stays traceable.`,
    })
    .where(eq(contacts.id, loser.id));
  console.log(`  ${loser.displayName}: retired\n`);

  // ── Nothing may still point at the loser ──────────────────────────────────
  for (const { tbl, col } of fks) {
    const left = (
      await tx.execute(
        sql`SELECT count(*)::int AS n FROM ${sql.identifier(tbl)} WHERE ${sql.identifier(col)} = ${loser.id}`,
      )
    ).rows[0] as { n: number };
    if (left.n) throw new Error(`${left.n} row(s) still on ${tbl}.${col} — rolling back.`);
  }
  console.log(`  ✓ ${total} row(s) moved, nothing left pointing at the retired record.\n`);
});

process.exit(0);
