/**
 * Write off the birds a shed still shows after its batch has gone.
 *
 * A batch leaves as a set of transfer_out movements, and the count that goes is
 * the count the lorry was told to take. What the next shed actually receives is
 * counted on arrival, and the two disagree — a hundred here, a thousand there.
 * The remainder stays behind in the ledger as birds in a shed that is standing
 * empty, and nothing in the daily sheet ever clears it, because nobody enters a
 * sheet for an empty house.
 *
 * That is why P1 and P2 read 1,314 and 605 after an import that reconciles: the
 * export's own summary says both are empty, and its movement ledger does not.
 * Both are "right"; only the ledger is what niko can arithmetic on.
 *
 * The write-off is dated to the placement's LAST RECORD — the day the batch
 * actually left — not to the day somebody noticed. Dating it today would put a
 * loss in this month that happened in March, and every report that cuts by date
 * would be wrong on both sides of the cut.
 *
 * Sheds are named explicitly. A placement holding birds is usually a flock in a
 * house, and only a person knows which sheds are supposed to be empty.
 *
 *   npx tsx scripts/write-off-stranded.ts --sheds P1,P2
 *   npx tsx scripts/write-off-stranded.ts --sheds P1,P2 --apply
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { flockMovements, flockPlacements, flocks, houses, placementDays, users } from "@shared/schema";
import { db, pool } from "../server/db";
import { recordMovement } from "../server/services/flocks";

const NOTE = "Counted after transfer out — birds not found";

const arg = (flag: string) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main() {
  const apply = process.argv.includes("--apply");
  const sheds = (arg("--sheds") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!sheds.length) throw new Error("Name the sheds: --sheds P1,P2");

  await db.transaction(async (tx) => {
    const [actor] = await tx.select().from(users).orderBy(users.createdAt).limit(1);
    if (!actor) throw new Error("No user to attribute the write-off to");

    const rows = await tx
      .select({
        placementId: flockPlacements.id,
        flockId: flockPlacements.flockId,
        shed: houses.code,
        batch: flocks.code,
        fromDate: flockPlacements.fromDate,
        held: sql<number>`coalesce((
          SELECT sum(m.qty * CASE
                   WHEN m.kind IN ('place','transfer_in') THEN 1
                   WHEN m.kind = 'adjustment' THEN coalesce(m.adjustment_sign, 1)
                   ELSE -1 END)
            FROM flock_movements m WHERE m.placement_id = ${flockPlacements.id}), 0)::int`,
        lastRecord: sql<string | null>`greatest(
          (SELECT max(pd.day)::text FROM placement_days pd WHERE pd.placement_id = ${flockPlacements.id}),
          (SELECT max(mv.event_date)::text FROM flock_movements mv WHERE mv.placement_id = ${flockPlacements.id})
        )`,
      })
      .from(flockPlacements)
      .innerJoin(houses, eq(houses.id, flockPlacements.houseId))
      .innerJoin(flocks, eq(flocks.id, flockPlacements.flockId))
      .where(inArray(houses.code, sheds));

    const stranded = rows.filter((r) => r.held > 0);
    if (!stranded.length) {
      console.log(`  Nothing stranded in ${sheds.join(", ")}.`);
      return;
    }

    let total = 0;
    for (const s of stranded) {
      // Fall back to the placement's start rather than to today: a write-off
      // must never be dated outside the placement it belongs to.
      const on = s.lastRecord ?? s.fromDate;
      console.log(
        `  ${s.shed.padEnd(3)} ${s.batch.padEnd(8)} ${String(s.held).padStart(6)} bird(s)   on ${on}`,
      );
      total += s.held;
      if (apply) {
        await recordMovement(tx, {
          placementId: s.placementId,
          flockId: s.flockId,
          kind: "adjustment",
          qty: s.held,
          adjustmentSign: -1,
          eventDate: on,
          note: NOTE,
          userId: actor.id,
        });
      }
    }

    console.log(`\n  ${stranded.length} placement(s), ${total.toLocaleString("en-IN")} bird(s)`);
    if (!apply) console.log("\n  Report only — nothing written. Re-run with --apply.");
    else console.log("  Written.");
  });

  await pool.end();
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.message : e);
  await pool.end();
  process.exit(1);
});
