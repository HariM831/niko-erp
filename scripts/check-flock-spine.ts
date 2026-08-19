/**
 * The flock spine, exercised end to end inside a transaction that is rolled
 * back. Nothing reaches the real ledger.
 *
 * The case that matters is the transfer. Place a flock in a pullet house, kill
 * some birds, move 80% to one layer house and the rest to another, kill more in
 * both — then assert the flock's lifetime mortality counts every bird that died
 * on either side of the move. That is precisely what the old model could not do,
 * because the count belonged to the shed and restarted when the birds walked
 * out of it.
 *
 * Run: npx tsx scripts/check-flock-spine.ts
 */
import { and, eq, isNull } from "drizzle-orm";
import {
  breeds,
  flockMovements,
  flockPlacements,
  flocks,
  hatchProfile,
  houses,
  movementDelta,
  standardSets,
} from "@shared/schema";
import { db } from "../server/db";
import {
  ageOn,
  createFlock,
  depleteFlock,
  placementCount,
  recordMovement,
  setFlockHatches,
  startLay,
  transferBirds,
} from "../server/services/flocks";
import { PostingError } from "../server/services/posting";

let failures = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!cond) failures++;
};

/** Asserts a call is refused, and that the refusal explains itself. */
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
    // ── Fixtures ──
    const [breed] = await tx
      .insert(breeds)
      .values({ code: "ZZCHK", name: "Check Breed" })
      .returning();
    const [set] = await tx
      .insert(standardSets)
      .values({ breedId: breed!.id, name: "Check set", version: 1, isDefault: true })
      .returning();

    const sheds = await tx.select().from(houses).where(eq(houses.isActive, true));
    const pullet = sheds.find((h) => h.purpose === "pullet");
    const layers = sheds.filter((h) => h.purpose === "layer");
    if (!pullet || layers.length < 2) throw new Error("Need a pullet house and two layer houses");
    const [l1, l2] = layers;
    const userId = (await tx.execute(`SELECT id FROM users LIMIT 1`)).rows[0] as
      | { id: string }
      | undefined;
    if (!userId) throw new Error("No users");

    // ── The weighted average, before anything touches the database ──
    ok(
      "a single hatch averages to itself",
      hatchProfile([{ hatchDate: "2026-01-01", qty: 10_000 }])?.hatchDate === "2026-01-01",
    );
    // 9,000 on the 1st and 1,000 on the 9th is 0.8 days, not 4 — the batch is
    // as old as most of its birds, which is the whole reason for weighting.
    const skew = hatchProfile([
      { hatchDate: "2026-01-01", qty: 9_000 },
      { hatchDate: "2026-01-09", qty: 1_000 },
    ]);
    ok("a lopsided batch leans to the bigger hatch", skew?.hatchDate === "2026-01-02", skew?.hatchDate);
    ok("spread is reported in days", skew?.spreadDays === 8);
    const even = hatchProfile([
      { hatchDate: "2026-01-01", qty: 5_000 },
      { hatchDate: "2026-01-05", qty: 5_000 },
    ]);
    ok("an even batch lands in the middle", even?.hatchDate === "2026-01-03", even?.hatchDate);

    console.log("\n  Placing 10,000 in", pullet.code, "over three hatches");
    const { flock, placement, profile } = await createFlock(tx, {
      code: "ZZ-CHECK-1",
      locationId: pullet.locationId,
      breedId: breed!.id,
      houseId: pullet.id,
      hatches: [
        { hatchDate: "2026-01-01", qty: 4_000 },
        { hatchDate: "2026-01-03", qty: 4_000 },
        { hatchDate: "2026-01-05", qty: 2_000 },
      ],
      userId: userId.id,
    });
    ok("placed count is the sum of the hatches", profile.placedCount === 10_000);
    ok("hatch date is the weighted average", profile.hatchDate === "2026-01-03", profile.hatchDate);
    ok("the placement opens on the first hatch", placement.fromDate === "2026-01-01");
    ok(
      "one place movement per hatch",
      (
        await tx
          .select()
          .from(flockMovements)
          .where(eq(flockMovements.placementId, placement.id))
      ).length === 3,
    );
    // Before the last hatch arrives the house genuinely holds fewer birds.
    ok("the count on 2 Jan is only what had hatched", (await placementCount(tx, placement.id, "2026-01-02")) === 4_000);
    ok("placed count derived from the ledger", (await placementCount(tx, placement.id)) === 10_000);
    ok("the breed's default set was pinned", flock.standardSetId === set!.id);

    await refuses("the same hatch date twice", () =>
      createFlock(tx, {
        code: "ZZ-CHECK-DUP",
        locationId: pullet.locationId,
        breedId: breed!.id,
        houseId: pullet.id,
        hatches: [
          { hatchDate: "2026-01-01", qty: 10 },
          { hatchDate: "2026-01-01", qty: 20 },
        ],
        userId: userId.id,
      }),
    );

    // ── Chicks keep arriving after the batch is opened ──
    console.log("\n  A fourth hatch lands a week later");
    const grown = await setFlockHatches(
      tx,
      flock.id,
      [
        { hatchDate: "2026-01-01", qty: 4_000 },
        { hatchDate: "2026-01-03", qty: 4_000 },
        { hatchDate: "2026-01-05", qty: 2_000 },
        { hatchDate: "2026-01-12", qty: 1_000 },
      ],
      userId.id,
    );
    ok("the extra hatch is counted", grown.placedCount === 11_000);
    // 4,000 on the 1st, 4,000 on the 3rd, 2,000 on the 5th, 1,000 on the 12th
    // is 2.45 days past the 1st — the late thousand barely shifts a batch that
    // is already mostly a week old, which is exactly what weighting is for.
    ok("and it barely moves the age", grown.hatchDate === "2026-01-03", grown.hatchDate);
    ok("the house holds them all", (await placementCount(tx, placement.id)) === 11_000);
    ok(
      "a place movement exists for the new date",
      (await placementCount(tx, placement.id, "2026-01-12")) === 11_000,
    );
    ok(
      "and none for the day before it",
      (await placementCount(tx, placement.id, "2026-01-11")) === 10_000,
    );

    // Correcting a hatch down, then back — the count follows.
    await setFlockHatches(
      tx,
      flock.id,
      [
        { hatchDate: "2026-01-01", qty: 4_000 },
        { hatchDate: "2026-01-03", qty: 4_000 },
        { hatchDate: "2026-01-05", qty: 2_000 },
      ],
      userId.id,
    );
    ok("removing a hatch removes its birds", (await placementCount(tx, placement.id)) === 10_000);

    // Placing the earliest hatch earlier drags the placement's start with it.
    await setFlockHatches(
      tx,
      flock.id,
      [
        { hatchDate: "2025-12-28", qty: 500 },
        { hatchDate: "2026-01-01", qty: 4_000 },
        { hatchDate: "2026-01-03", qty: 4_000 },
        { hatchDate: "2026-01-05", qty: 2_000 },
      ],
      userId.id,
    );
    const [moved] = await tx
      .select()
      .from(flockPlacements)
      .where(eq(flockPlacements.id, placement.id));
    ok("an earlier hatch moves the placement start", moved?.fromDate === "2025-12-28");

    // Back to the shape the rest of the checks expect.
    await setFlockHatches(
      tx,
      flock.id,
      [
        { hatchDate: "2026-01-01", qty: 4_000 },
        { hatchDate: "2026-01-03", qty: 4_000 },
        { hatchDate: "2026-01-05", qty: 2_000 },
      ],
      userId.id,
    );

    await refuses("hatches wiped out entirely", () =>
      setFlockHatches(tx, flock.id, [], userId.id),
    );

    // ── Refusals ──
    await refuses("mortality with no cause", () =>
      recordMovement(tx, {
        placementId: placement.id,
        kind: "mortality",
        qty: 5,
        eventDate: "2026-01-10",
        userId: userId.id,
      }),
    );
    await refuses("more deaths than birds", () =>
      recordMovement(tx, {
        placementId: placement.id,
        kind: "mortality",
        qty: 99_999,
        eventDate: "2026-01-10",
        causeCode: "unknown",
        userId: userId.id,
      }),
    );
    await refuses("a date before the flock arrived", () =>
      recordMovement(tx, {
        placementId: placement.id,
        kind: "mortality",
        qty: 1,
        eventDate: "2025-12-31",
        causeCode: "unknown",
        userId: userId.id,
      }),
    );
    await refuses("an adjustment with no direction", () =>
      recordMovement(tx, {
        placementId: placement.id,
        kind: "adjustment",
        qty: 5,
        eventDate: "2026-01-10",
        userId: userId.id,
      }),
    );

    // ── 200 dead during rearing ──
    await recordMovement(tx, {
      placementId: placement.id,
      kind: "mortality",
      qty: 150,
      eventDate: "2026-01-20",
      causeCode: "respiratory",
      userId: userId.id,
    });
    await recordMovement(tx, {
      placementId: placement.id,
      kind: "cull",
      qty: 50,
      eventDate: "2026-02-01",
      causeCode: "cull_weak",
      userId: userId.id,
    });
    ok("count after 200 lost", (await placementCount(tx, placement.id)) === 9_800);

    // The guard that makes editing hatches safe: cutting the batch to 100 birds
    // would leave the house holding minus 100 the day 150 of them died.
    await refuses("cutting hatches below what has already died", () =>
      setFlockHatches(tx, flock.id, [{ hatchDate: "2026-01-01", qty: 100 }], userId.id),
    );
    ok("and the refusal left the count alone", (await placementCount(tx, placement.id)) === 9_800);

    // ── The split: 80% to L1, remainder to L2 ──
    console.log(`\n  Splitting to ${l1!.code} and ${l2!.code}`);
    const t1 = await transferBirds(tx, {
      placementId: placement.id,
      toHouseId: l1!.id,
      qty: 7_840,
      eventDate: "2026-04-25",
      userId: userId.id,
    });
    ok("a partial transfer leaves the source open", t1.closed === false);
    ok("source holds the remainder", (await placementCount(tx, placement.id)) === 1_960);
    ok("destination holds what moved", (await placementCount(tx, t1.toPlacementId)) === 7_840);

    const t2 = await transferBirds(tx, {
      placementId: placement.id,
      toHouseId: l2!.id,
      qty: 1_960,
      eventDate: "2026-04-25",
      userId: userId.id,
    });
    ok("a full transfer closes the source", t2.closed === true);
    const [closed] = await tx
      .select()
      .from(flockPlacements)
      .where(eq(flockPlacements.id, placement.id));
    ok("the closed placement carries its end date", closed?.toDate === "2026-04-25");

    // ── The point of the whole exercise ──
    const all = await tx
      .select({
        kind: flockMovements.kind,
        qty: flockMovements.qty,
        sign: flockMovements.adjustmentSign,
      })
      .from(flockMovements)
      .innerJoin(flockPlacements, eq(flockPlacements.id, flockMovements.placementId))
      .where(eq(flockPlacements.flockId, flock.id));
    const birds = all.reduce((n, m) => n + movementDelta(m.kind, m.qty, m.sign), 0);
    ok("a transfer does not change the flock total", birds === 9_800, `${birds}`);

    // More deaths on both sides of the move.
    await recordMovement(tx, {
      placementId: t1.toPlacementId,
      kind: "mortality",
      qty: 40,
      eventDate: "2026-06-01",
      causeCode: "prolapse",
      userId: userId.id,
    });
    await recordMovement(tx, {
      placementId: t2.toPlacementId,
      kind: "mortality",
      qty: 10,
      eventDate: "2026-06-01",
      causeCode: "heat",
      userId: userId.id,
    });

    const after = await tx
      .select({
        kind: flockMovements.kind,
        qty: flockMovements.qty,
        sign: flockMovements.adjustmentSign,
      })
      .from(flockMovements)
      .innerJoin(flockPlacements, eq(flockPlacements.id, flockMovements.placementId))
      .where(eq(flockPlacements.flockId, flock.id));
    const lost = after
      .filter((m) => m.kind === "mortality" || m.kind === "cull")
      .reduce((n, m) => n + m.qty, 0);
    ok(
      "lifetime mortality spans the transfer",
      lost === 250,
      `${lost} of 10,000 = ${((lost / 10_000) * 100).toFixed(2)}%`,
    );
    ok(
      "flock total is continuous",
      after.reduce((n, m) => n + movementDelta(m.kind, m.qty, m.sign), 0) === 9_750,
    );

    // ── Lay and depletion ──
    await startLay(tx, flock.id, "2026-05-10");
    const [laying] = await tx.select().from(flocks).where(eq(flocks.id, flock.id));
    ok("start lay sets status and date", laying?.status === "laying" && laying?.layStartDate === "2026-05-10");

    ok("age reads in weeks and days", ageOn("2026-01-01", "2026-04-25").label === "16w 2d");
    ok(
      "the flock's own age runs from its weighted average, not its first hatch",
      ageOn(profile.hatchDate, "2026-04-25").label === "16w 0d",
      ageOn(profile.hatchDate, "2026-04-25").label,
    );

    const dep = await depleteFlock(tx, flock.id, "2027-01-15", userId.id);
    ok("depletion closes every open placement", dep.placementsClosed === 2);
    const stillOpen = await tx
      .select()
      .from(flockPlacements)
      .where(and(eq(flockPlacements.flockId, flock.id), isNull(flockPlacements.toDate)));
    ok("nothing left open", stillOpen.length === 0);
    const final = await tx
      .select({
        kind: flockMovements.kind,
        qty: flockMovements.qty,
        sign: flockMovements.adjustmentSign,
      })
      .from(flockMovements)
      .innerJoin(flockPlacements, eq(flockPlacements.id, flockMovements.placementId))
      .where(eq(flockPlacements.flockId, flock.id));
    ok(
      "the count reaches zero through the ledger",
      final.reduce((n, m) => n + movementDelta(m.kind, m.qty, m.sign), 0) === 0,
    );

    throw new Rollback();
  });
} catch (e) {
  if (!(e instanceof Rollback)) {
    console.error("\n  Aborted:", e instanceof Error ? e.message : e);
    process.exit(1);
  }
}

console.log(
  failures ? `\n  ${failures} check(s) failed.\n` : "\n  All checks passed. Rolled back.\n",
);
process.exit(failures ? 1 : 0);
