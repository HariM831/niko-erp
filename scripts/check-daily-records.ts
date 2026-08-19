/**
 * Daily records, exercised inside a rolled-back transaction.
 *
 * The behaviour worth testing is that a save REPLACES the day rather than
 * appending to it. Entering a house, noticing the mortality was wrong and
 * saving again is the most ordinary thing that happens on this screen, and an
 * append would silently double the deaths — a mistake nobody would spot until
 * the month-end mortality percentage looked strange.
 *
 * Run: npx tsx scripts/check-daily-records.ts
 */
import { and, eq } from "drizzle-orm";
import { breeds, flockMovements, houses, placementDays, standardSets } from "@shared/schema";
import { db } from "../server/db";
import { createFlock, placementCount } from "../server/services/flocks";
import { dayBoard, saveDay } from "../server/services/daily";
import { PostingError } from "../server/services/posting";

let failures = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!cond) failures++;
};
const refuses = async (label: string, fn: () => Promise<unknown>) => {
  try {
    await fn();
    console.log(`  ✗ ${label} — it was allowed`);
    failures++;
  } catch (e) {
    if (e instanceof PostingError) console.log(`  ✓ ${label} — "${e.message}"`);
    else {
      console.log(`  ✗ ${label} — threw ${String(e)}`);
      failures++;
    }
  }
};

class Rollback extends Error {}

try {
  await db.transaction(async (tx) => {
    const [breed] = await tx.insert(breeds).values({ code: "ZZDLY", name: "Daily Check" }).returning();
    await tx.insert(standardSets).values({ breedId: breed!.id, name: "set", isDefault: true });
    const [shed] = await tx.select().from(houses).where(eq(houses.purpose, "pullet"));
    const userId = ((await tx.execute(`SELECT id FROM users LIMIT 1`)).rows[0] as { id: string }).id;

    const { flock, placement } = await createFlock(tx, {
      locationId: shed!.locationId,
      breedId: breed!.id,
      houseId: shed!.id,
      hatches: [{ hatchDate: "2026-02-01", qty: 5_000 }],
      userId,
    });
    console.log(`\n  ${flock.code} — 5,000 in ${shed!.code}\n`);

    // ── A day, with losses ──
    await saveDay(
      tx,
      {
        placementId: placement.id,
        day: "2026-02-10",
        feedConsumedKg: "180.50",
        waterL: "340",
        losses: [
          { kind: "mortality", qty: 12, causeCode: "respiratory" },
          { kind: "cull", qty: 3, causeCode: "cull_weak" },
        ],
      },
      userId,
    );
    ok("the day is recorded", (await tx.select().from(placementDays).where(eq(placementDays.placementId, placement.id))).length === 1);
    ok("and the birds are gone from the ledger", (await placementCount(tx, placement.id)) === 4_985);

    // ── The point: saving again replaces, it does not append ──
    await saveDay(
      tx,
      {
        placementId: placement.id,
        day: "2026-02-10",
        feedConsumedKg: "185.00",
        waterL: "340",
        losses: [{ kind: "mortality", qty: 8, causeCode: "respiratory" }],
      },
      userId,
    );
    const movements = await tx
      .select()
      .from(flockMovements)
      .where(and(eq(flockMovements.placementId, placement.id), eq(flockMovements.eventDate, "2026-02-10")));
    ok("re-saving replaces the loss lines", movements.length === 1, `${movements.length} row(s)`);
    ok("the count follows the correction", (await placementCount(tx, placement.id)) === 4_992);
    const [row] = await tx
      .select()
      .from(placementDays)
      .where(and(eq(placementDays.placementId, placement.id), eq(placementDays.day, "2026-02-10")));
    ok("still one day row", !!row);
    ok("with the corrected feed", Number(row?.feedConsumedKg) === 185);

    // The re-save must compare against the count WITHOUT the rows it is about
    // to replace, or correcting 12 down to 8 would be measured against a house
    // that had already lost the 12.
    await saveDay(
      tx,
      {
        placementId: placement.id,
        day: "2026-02-10",
        losses: [{ kind: "mortality", qty: 4_992, causeCode: "unknown" }],
        feedConsumedKg: null,
      },
      userId,
    );
    ok("a correction is measured against the day's opening count", (await placementCount(tx, placement.id)) === 8);

    // Put it back.
    await saveDay(
      tx,
      {
        placementId: placement.id,
        day: "2026-02-10",
        feedConsumedKg: "185.00",
        losses: [{ kind: "mortality", qty: 8, causeCode: "respiratory" }],
      },
      userId,
    );

    // ── Refusals ──
    await refuses("a loss with no cause", () =>
      saveDay(
        tx,
        { placementId: placement.id, day: "2026-02-11", losses: [{ kind: "mortality", qty: 1 }] },
        userId,
      ),
    );
    await refuses("losing more birds than the house holds", () =>
      saveDay(
        tx,
        {
          placementId: placement.id,
          day: "2026-02-11",
          losses: [{ kind: "mortality", qty: 99_999, causeCode: "unknown" }],
        },
        userId,
      ),
    );
    await refuses("a day before the flock arrived", () =>
      saveDay(tx, { placementId: placement.id, day: "2026-01-01", losses: [] }, userId),
    );

    // ── The board ──
    const board = await dayBoard(tx, "2026-02-10");
    const mine = board.rows.find((r) => r.placementId === placement.id);
    ok("the board finds the house", !!mine);
    ok("and marks it entered", mine?.entered === true);
    ok("and carries its loss lines back for editing", mine?.losses.length === 1);
    ok("eggs are hidden for a one-week-old flock", mine?.expectEggs === false, mine?.age.label);

    const empty = await dayBoard(tx, "2026-02-11");
    const notYet = empty.rows.find((r) => r.placementId === placement.id);
    ok("an unentered day still lists the house", !!notYet);
    ok("marked not entered", notYet?.entered === false);
    ok("with yesterday's feed as a hint", Number(notYet?.feedHint) === 185);

    const old = await dayBoard(tx, "2026-06-01");
    const grown = old.rows.find((r) => r.placementId === placement.id);
    ok("eggs appear once the flock is old enough", grown?.expectEggs === true, grown?.age.label);

    throw new Rollback();
  });
} catch (e) {
  if (!(e instanceof Rollback)) {
    console.error("\n  Aborted:", e instanceof Error ? e.message : e);
    process.exit(1);
  }
}

console.log(failures ? `\n  ${failures} check(s) failed.\n` : "\n  All checks passed. Rolled back.\n");
process.exit(failures ? 1 : 0);
