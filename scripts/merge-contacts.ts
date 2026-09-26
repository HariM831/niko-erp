/**
 * Merge one contact into another.
 *
 * "Luit Valley" exists twice: a customer carrying the feed we invoiced out and
 * a vendor carrying the eggs we billed in — one company entered under two legal
 * forms, so its ledger reads as two halves that never meet. niko's own farm
 * billing cannot work with that: closing a month raises the feed invoice AND
 * the egg bill against ONE contact, and refuses unless that contact is a vendor
 * too (`server/services/owner-billing.ts`).
 *
 * The FK list is read from the catalogue rather than typed out. There are 23
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
 * Moves no money. Not one invoice, bill, payment or balance changes — the same
 * documents hang off one name instead of two.
 *
 * Dry by default; `--apply` writes, in one transaction.
 *
 *   npx tsx scripts/merge-contacts.ts "<loser>" "<winner>"
 *   npx tsx scripts/merge-contacts.ts "<loser>" "<winner>" --name "Real Name LLP" --group --apply
 *
 *   --name   what the survivor should be called, once the "(Customer)" suffix
 *            Zoho's two-sided entry left behind is meaningless
 *   --group  also flag the survivor as a group company, which takes it out of
 *            every customer- and vendor-scoped view. Read
 *            docs/group-companies-plan.md before passing this.
 */
import { eq, sql } from "drizzle-orm";
import { contacts } from "@shared/schema";
import { db } from "../server/db";

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const value = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i > -1 ? argv[i + 1] : undefined;
};
/** The two names are the bare arguments — not a flag, and not a flag's value. */
const names = argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
const [loserName, winnerName] = names;
const NEW_NAME = value("name");
const GROUP = flag("group");
const APPLY = flag("apply");

if (!loserName || !winnerName) {
  console.log('\n  Usage: npx tsx scripts/merge-contacts.ts "<loser>" "<winner>" [--name "X"] [--group] [--apply]\n');
  process.exit(1);
}

/** Thrown to roll a dry run back; never an error anybody needs to see. */
class DryRun extends Error {}

await db
  .transaction(async (tx) => {
    const found = await tx
      .select()
      .from(contacts)
      .where(sql`${contacts.displayName} IN (${loserName}, ${winnerName})`);
    const loser = found.find((c) => c.displayName === loserName);
    const winner = found.find((c) => c.displayName === winnerName);
    if (!loser) throw new Error(`No contact named "${loserName}"`);
    if (!winner) throw new Error(`No contact named "${winnerName}"`);
    if (loser.id === winner.id) throw new Error("Those are the same contact");

    /* ── Refuse if they look like two real companies ─────────────────────── */
    const clash = (field: string, a: unknown, b: unknown) =>
      a && b && String(a).trim() !== String(b).trim() ? `${field}: "${a}" vs "${b}"` : null;
    const clashes = [
      clash("GSTIN", loser.gstin, winner.gstin),
      clash("PAN", loser.pan, winner.pan),
    ].filter((v): v is string => !!v);
    if (clashes.length) {
      throw new Error(`These look like two different companies — ${clashes.join("; ")}. Merge by hand.`);
    }
    const openings = [loser.openingBalance, winner.openingBalance].map((v) => Number(v ?? 0));
    if (openings.some((v) => v !== 0)) {
      throw new Error(
        `Opening balances are ${openings.join(" and ")} — merging would move one onto the other's ledger. Do this by hand.`,
      );
    }

    console.log(`\n  ${loser.displayName} (${loser.type})  →  ${winner.displayName} (${winner.type})\n`);

    /* ── Every column in the database that points at a contact ───────────── */
    const fks = (
      await tx.execute(sql`
        SELECT c.conrelid::regclass::text AS tbl, a.attname AS col
          FROM pg_constraint c
          JOIN unnest(c.conkey) WITH ORDINALITY k(att, ord) ON TRUE
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.att
         WHERE c.contype = 'f' AND c.confrelid = 'contacts'::regclass
         ORDER BY 1, 2`)
    ).rows as Array<{ tbl: string; col: string }>;

    let total = 0;
    for (const { tbl, col } of fks) {
      const count = (
        await tx.execute(
          sql`SELECT count(*)::int AS n FROM ${sql.identifier(tbl)} WHERE ${sql.identifier(col)} = ${loser.id}`,
        )
      ).rows[0] as { n: number };
      if (!count.n) continue;
      console.log(`  move    ${String(count.n).padStart(4)}  ${tbl}.${col}`);
      total += count.n;
      await tx.execute(
        sql`UPDATE ${sql.identifier(tbl)} SET ${sql.identifier(col)} = ${winner.id}
            WHERE ${sql.identifier(col)} = ${loser.id}`,
      );
    }
    if (!total) console.log("  move       0  nothing pointed at the loser");

    /* ── The addresses, which are now doubled ──────────────────────────────
     * Both halves were entered from the same letterhead, so the survivor ends
     * up with two billing and two shipping addresses saying the same thing.
     * One of each pair is dropped — but anything the two disagreed about is
     * printed rather than silently resolved, because a difference is either a
     * typo on the row being kept or a second real address being thrown away,
     * and only a person can tell which.
     */
    const addrs = (
      await tx.execute(sql`
        SELECT id, kind,
               coalesce(line1,'') || '|' || coalesce(line2,'') || '|' || coalesce(city,'') || '|' ||
               coalesce(state,'') || '|' || coalesce(country,'') AS shape,
               coalesce(pincode,'') AS pincode
          FROM contact_addresses WHERE contact_id = ${winner.id} ORDER BY kind, id`)
    ).rows as Array<{ id: string; kind: string; shape: string; pincode: string }>;

    const byKind = new Map<string, Array<(typeof addrs)[number]>>();
    for (const a of addrs) byKind.set(a.kind, [...(byKind.get(a.kind) ?? []), a]);
    for (const [kind, rows] of byKind) {
      if (rows.length < 2) continue;
      const keep = rows[0]!;
      const same = rows.filter((r) => r.id !== keep.id && r.shape === keep.shape);
      const different = rows.filter((r) => r.shape !== keep.shape);
      for (const d of same) {
        if (d.pincode !== keep.pincode) {
          console.log(
            `  !             the two ${kind} addresses disagree on the pincode: keeping ${keep.pincode || "(blank)"}, dropping ${d.pincode || "(blank)"} — check which is right`,
          );
        }
        await tx.execute(sql`DELETE FROM contact_addresses WHERE id = ${d.id}`);
      }
      if (same.length) console.log(`  drop    ${String(same.length).padStart(4)}  duplicate ${kind} address`);
      if (different.length) {
        console.log(`  kept          ${different.length} second, DIFFERENT ${kind} address — read it and delete the wrong one by hand`);
      }
    }

    /* ── The surviving record has to work in both directions ─────────────────
     * It is now invoiced AND billed; a one-sided type would make half its own
     * history unreachable from the screens that filter by type.
     */
    const set: Record<string, unknown> = {};
    if (winner.type !== "both") {
      set.type = "both";
      console.log(`\n  type          ${winner.type} → both`);
    }
    if (NEW_NAME && NEW_NAME !== winner.displayName) {
      set.displayName = NEW_NAME;
      set.companyName = NEW_NAME;
      console.log(`  name          "${winner.displayName}" → "${NEW_NAME}"`);
    }
    if (GROUP && !winner.isGroupCompany) {
      set.isGroupCompany = true;
      console.log("  group         flagged — this contact now leaves every customer- and vendor-scoped view");
    }
    const note = `Merged from "${loser.displayName}" — ${total} row(s) repointed.`;
    set.notes = winner.notes ? `${winner.notes}\n${note}` : note;
    await tx.update(contacts).set(set).where(eq(contacts.id, winner.id));

    await tx
      .update(contacts)
      .set({
        isActive: false,
        notes: `Merged into "${NEW_NAME ?? winner.displayName}". Kept so its history stays traceable.`,
      })
      .where(eq(contacts.id, loser.id));
    console.log(`  retire        ${loser.displayName}`);

    /* ── Nothing may still point at the loser ─────────────────────────────── */
    for (const { tbl, col } of fks) {
      const left = (
        await tx.execute(
          sql`SELECT count(*)::int AS n FROM ${sql.identifier(tbl)} WHERE ${sql.identifier(col)} = ${loser.id}`,
        )
      ).rows[0] as { n: number };
      if (left.n) throw new Error(`${left.n} row(s) still on ${tbl}.${col} — rolling back.`);
    }
    console.log(`\n  ${total} row(s) move, nothing left pointing at the retired record.`);

    if (!APPLY) {
      console.log("\n  dry run — nothing written. Re-run with --apply.\n");
      throw new DryRun();
    }
    console.log("  applied.\n");
  })
  .catch((e) => {
    if (e instanceof DryRun) return;
    throw e;
  });

process.exit(0);
