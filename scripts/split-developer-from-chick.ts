/**
 * Developer feed out from under Chick Feed.
 *
 * The mill's sheet heads its first recipe "Chick", and the import filed it that
 * way: formula "Chick", stage chick_starter, making the item "Chick Feed". But
 * that recipe is the DEVELOPER feed, the second stage. Chick feed proper is
 * bought in ready-made, in bags — "Chick Feed" is that item, counted in pcs and
 * untracked — and the mill never makes it. Confirmed by the user 26 Sep 2026.
 *
 * So, in one transaction:
 *   1. a "Developer Feed" item, set up like the other milled feeds;
 *   2. formula "Chick" becomes "Developer", stage developer, making it —
 *      changed in place, because it has never been milled (refused otherwise);
 *   3. the Amino lorries noted "Amino Chick" move to Developer Feed — they came
 *      off the mill, so they carried developer feed (the user's call);
 *   4. the two standards' notes stop saying the mill makes chick feed and no
 *      developer feed.
 *
 * Chick Feed itself is left exactly as it is, bills and all.
 *
 *   npx tsx scripts/split-developer-from-chick.ts           # report only
 *   npx tsx scripts/split-developer-from-chick.ts --apply   # and change
 *
 * Idempotent: a second run finds nothing left to do.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { feedStandards, feedTransfers, formulas, items, productionOrders } from "@shared/schema";
import { db, pool } from "../server/db";

const APPLY = process.argv.includes("--apply");

/** The same text changes made to server/db/standards/hyline-w80-feed.json. */
const NOTE_FIXES: Array<{ stage: "chick_starter" | "developer"; from: string; to: string }> = [
  {
    stage: "chick_starter",
    from: "The mill makes one chick feed covering both, so this holds the stricter of the pair;",
    to: "Chick feed is bought in ready-made, not milled, and one feed covers both, so this holds the stricter of the pair;",
  },
  {
    stage: "developer",
    from: "The mill makes no developer feed today; the spec is held so a recipe can be judged if one is ever made.",
    to: "The mill makes it: the recipe its sheet heads 'Chick' is this developer feed.",
  },
];

async function main() {
  console.log(`\n  Developer feed out from under Chick Feed — ${APPLY ? "APPLYING" : "report only"}\n`);

  const [chickFeed] = await db.select().from(items).where(eq(items.name, "Chick Feed"));
  if (!chickFeed) throw new Error('No item "Chick Feed"');
  // The pattern for a milled feed: whatever Grower Feed carries.
  const [grower] = await db.select().from(items).where(eq(items.name, "Grower Feed"));
  if (!grower?.trackInventory || !grower.inventoryAccountId) {
    throw new Error("Grower Feed is not a tracked feed with a stock account — no pattern to copy");
  }
  const [developerFeed] = await db.select().from(items).where(eq(items.name, "Developer Feed"));
  console.log(
    developerFeed
      ? `  Developer Feed exists — reused`
      : `  + Developer Feed: ${grower.unit}, ${grower.category}, tracked, same stock account as Grower Feed`,
  );

  const chick = await db.select().from(formulas).where(eq(formulas.name, "Chick"));
  const milled = chick.length
    ? await db
        .select({ n: sql<number>`count(*)::int` })
        .from(productionOrders)
        .where(inArray(productionOrders.formulaId, chick.map((f) => f.id)))
    : [{ n: 0 }];
  if (Number(milled[0]!.n) > 0) {
    throw new Error(`Formula "Chick" has ${milled[0]!.n} production order(s) — needs a new version, not an edit`);
  }
  for (const f of chick) {
    console.log(`  ~ formula Chick v${f.version} (${f.stage}) → Developer, developer, making Developer Feed`);
  }
  if (!chick.length) console.log("  formula Chick: none left to change");

  const lorries = await db
    .select({ id: feedTransfers.id, kg: feedTransfers.quantityKg, posted: feedTransfers.journalEntryId })
    .from(feedTransfers)
    .where(and(eq(feedTransfers.itemId, chickFeed.id), eq(feedTransfers.notes, "Amino Chick")));
  const movable = lorries.filter((l) => !l.posted);
  const kg = movable.reduce((s, l) => s + Number(l.kg), 0);
  console.log(`  ~ ${movable.length} "Amino Chick" transfer(s), ${kg.toLocaleString("en-IN")} kg → Developer Feed`);
  if (lorries.length > movable.length) {
    console.log(`  ! ${lorries.length - movable.length} posted to the ledger — left alone, a reversal is needed`);
  }

  const standards = await db.select().from(feedStandards);
  const notes = NOTE_FIXES.flatMap((fix) =>
    standards
      .filter((s) => s.stage === fix.stage && s.notes?.includes(fix.from))
      .map((s) => ({ id: s.id, stage: s.stage, notes: s.notes!.replace(fix.from, fix.to) })),
  );
  for (const n of notes) console.log(`  ~ ${n.stage} standard: note corrected`);

  if (!APPLY) {
    console.log("\n  Report only. Run with --apply to change.\n");
    return;
  }

  await db.transaction(async (tx) => {
    let devId = developerFeed?.id;
    if (!devId) {
      const [made] = await tx
        .insert(items)
        .values({
          name: "Developer Feed",
          unit: grower.unit,
          category: grower.category,
          isFeedIngredient: false,
          isPurchased: false,
          isSold: false,
          trackInventory: true,
          inventoryAccountId: grower.inventoryAccountId,
          isActive: true,
        } as typeof items.$inferInsert)
        .returning({ id: items.id });
      devId = made!.id;
    }
    if (chick.length) {
      await tx
        .update(formulas)
        .set({ name: "Developer", stage: "developer", outputItemId: devId })
        .where(inArray(formulas.id, chick.map((f) => f.id)));
    }
    if (movable.length) {
      await tx
        .update(feedTransfers)
        .set({ itemId: devId })
        .where(and(inArray(feedTransfers.id, movable.map((l) => l.id)), isNull(feedTransfers.journalEntryId)));
    }
    for (const n of notes) {
      await tx.update(feedStandards).set({ notes: n.notes }).where(eq(feedStandards.id, n.id));
    }
  });
  console.log("\n  Done.\n");
}

main()
  .catch((e) => {
    console.error(`\n  ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
