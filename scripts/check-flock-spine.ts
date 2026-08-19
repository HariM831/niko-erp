/**
 * The flock spine, exercised end to end inside a transaction that is rolled
 * back. Nothing reaches the real ledger.
 *
 * Three things in a batch's life are SETS of dated lines rather than single
 * acts — the chicks arrive over a week, the move to the layer house takes a
 * week of lorries, the cull-out takes several days. All three are edited the
 * same way, and the behaviour worth testing is the same for all three: saving
 * replaces the set instead of appending to it, and a refusal changes nothing.
 *
 * The case that matters most is the transfer. Place a flock in a pullet house,
 * lose some birds, move it to two layer houses over three days, lose more in
 * both — then assert lifetime mortality counts every bird that died on either
 * side of the move. That is precisely what the old model could not do, because
 * the count belonged to the shed and restarted when the birds walked out.
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
  handoverSummary,
  nextFlockCode,
  placementCount,
  recordMovement,
  setFlockCulls,
  setFlockHatches,
  setFlockTransfers,
  startLay,
} from "../server/services/flocks";
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

/** Every bird in or out, across every house the flock has stood in. */
async function flockLedger(tx: never, flockId: string) {
  const rows = await (tx as never as typeof db)
    .select({
      kind: flockMovements.kind,
      qty: flockMovements.qty,
      sign: flockMovements.adjustmentSign,
    })
    .from(flockMovements)
    .innerJoin(flockPlacements, eq(flockPlacements.id, flockMovements.placementId))
    .where(eq(flockPlacements.flockId, flockId));
  return {
    birds: rows.reduce((n, m) => n + movementDelta(m.kind, m.qty, m.sign), 0),
    lost: rows
      .filter((m) => m.kind === "mortality" || m.kind === "cull")
      .reduce((n, m) => n + m.qty, 0),
  };
}

try {
  await db.transaction(async (tx) => {
    const [breed] = await tx.insert(breeds).values({ code: "ZZCHK", name: "Check Breed" }).returning();
    const [set] = await tx
      .insert(standardSets)
      .values({ breedId: breed!.id, name: "Check set", version: 1, isDefault: true })
      .returning();

    const sheds = await tx.select().from(houses).where(eq(houses.isActive, true));
    const pullets = sheds.filter((h) => h.purpose === "pullet");
    const layers = sheds.filter((h) => h.purpose === "layer");
    if (pullets.length < 2 || layers.length < 2) {
      throw new Error("Need two pullet houses and two layer houses");
    }
    const [p1, p2] = pullets;
    const [l1, l2] = layers;
    const userId = ((await tx.execute(`SELECT id FROM users LIMIT 1`)).rows[0] as { id: string }).id;

    // ── Generated codes ──
    const firstCode = await nextFlockCode(tx, p1!.locationId, 2026);
    ok("a code is site, year and sequence", /^[A-Z]{1,3}-2026-\d\d$/.test(firstCode), firstCode);
    const auto = await createFlock(tx, {
      locationId: p1!.locationId,
      breedId: breed!.id,
      houseId: p2!.id,
      hatches: [{ hatchDate: "2026-03-01", qty: 10 }],
      userId,
    });
    ok("createFlock generates one when none is given", auto.flock.code === firstCode, auto.flock.code);
    ok("and the next steps past it", (await nextFlockCode(tx, p1!.locationId, 2026)) !== firstCode);
    ok(
      "each year has its own sequence",
      (await nextFlockCode(tx, p1!.locationId, 2027)).endsWith("-01"),
    );

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

    // ── Hatches ──
    console.log("\n  Placing 10,000 in", p1!.code, "over three hatches");
    const { flock, placement, profile } = await createFlock(tx, {
      code: "ZZ-CHECK-1",
      locationId: p1!.locationId,
      breedId: breed!.id,
      houseId: p1!.id,
      hatches: [
        { hatchDate: "2026-01-01", qty: 4_000 },
        { hatchDate: "2026-01-03", qty: 4_000 },
        { hatchDate: "2026-01-05", qty: 2_000 },
      ],
      userId,
    });
    ok("placed count is the sum of the hatches", profile.placedCount === 10_000);
    ok("hatch date is the weighted average", profile.hatchDate === "2026-01-03", profile.hatchDate);
    ok("the placement opens on the first hatch", placement.fromDate === "2026-01-01");
    ok("before the last hatch the house holds less", (await placementCount(tx, placement.id, "2026-01-02")) === 4_000);
    ok("the breed's default set was pinned", flock.standardSetId === set!.id);

    await refuses("the same hatch date twice", () =>
      setFlockHatches(
        tx,
        flock.id,
        [
          { hatchDate: "2026-01-01", qty: 10 },
          { hatchDate: "2026-01-01", qty: 20 },
        ],
        userId,
      ),
    );

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
      userId,
    );
    ok("the extra hatch is counted", grown.placedCount === 11_000);
    ok("and it barely moves the age", grown.hatchDate === "2026-01-03", grown.hatchDate);
    ok("saving replaces rather than appends", (await placementCount(tx, placement.id)) === 11_000);

    await setFlockHatches(
      tx,
      flock.id,
      [
        { hatchDate: "2026-01-01", qty: 4_000 },
        { hatchDate: "2026-01-03", qty: 4_000 },
        { hatchDate: "2026-01-05", qty: 2_000 },
      ],
      userId,
    );
    ok("removing a hatch removes its birds", (await placementCount(tx, placement.id)) === 10_000);
    await refuses("hatches wiped out entirely", () => setFlockHatches(tx, flock.id, [], userId));

    // ── 200 lost in rearing ──
    for (const [qty, cause, date] of [
      [150, "respiratory", "2026-01-20"],
      [50, "cull_weak", "2026-02-01"],
    ] as const) {
      await recordMovement(tx, {
        placementId: placement.id,
        kind: cause === "cull_weak" ? "cull" : "mortality",
        qty,
        eventDate: date,
        causeCode: cause,
        userId,
      });
    }
    ok("count after 200 lost", (await placementCount(tx, placement.id)) === 9_800);

    await refuses("cutting hatches below what has already died", () =>
      setFlockHatches(tx, flock.id, [{ hatchDate: "2026-01-01", qty: 100 }], userId),
    );
    ok("and the refusal changed nothing", (await placementCount(tx, placement.id)) === 9_800);

    // ── Transfer: a week of lorries into two layer houses ──
    console.log(`\n  Moving to ${l1!.code} and ${l2!.code} over three days`);
    await refuses("a line that moves birds to the house they are in", () =>
      setFlockTransfers(
        tx,
        flock.id,
        [{ eventDate: "2026-04-25", fromHouseId: p1!.id, toHouseId: p1!.id, qty: 10 }],
        userId,
      ),
    );
    await refuses("moving more birds than the house holds", () =>
      setFlockTransfers(
        tx,
        flock.id,
        [{ eventDate: "2026-04-25", fromHouseId: p1!.id, toHouseId: l1!.id, qty: 99_999 }],
        userId,
      ),
    );
    ok("and that refusal changed nothing", (await placementCount(tx, placement.id)) === 9_800);

    const lorries = [
      { eventDate: "2026-04-25", fromHouseId: p1!.id, toHouseId: l1!.id, qty: 4_000 },
      { eventDate: "2026-04-26", fromHouseId: p1!.id, toHouseId: l1!.id, qty: 3_840 },
      { eventDate: "2026-04-27", fromHouseId: p1!.id, toHouseId: l2!.id, qty: 1_960 },
    ];
    const moved = await setFlockTransfers(tx, flock.id, lorries, userId);
    ok("the rearing house is empty", (await placementCount(tx, placement.id)) === 0);
    ok("and closed on the last lorry", (await tx.select().from(flockPlacements).where(eq(flockPlacements.id, placement.id)))[0]?.toDate === "2026-04-27");
    ok("housed on the day the last bird left", moved.housedOn === "2026-04-27", String(moved.housedOn));

    const openNow = await tx
      .select({ id: flockPlacements.id, houseId: flockPlacements.houseId })
      .from(flockPlacements)
      .where(and(eq(flockPlacements.flockId, flock.id), isNull(flockPlacements.toDate)));
    ok("two layer houses are open", openNow.length === 2);
    const inL1 = openNow.find((p) => p.houseId === l1!.id);
    ok("the first holds both its lorries", (await placementCount(tx, inL1!.id)) === 7_840);

    let led = await flockLedger(tx as never, flock.id);
    ok("a transfer does not change the flock total", led.birds === 9_800, String(led.birds));

    // Correcting a lorry mid-move is the ordinary case.
    await setFlockTransfers(
      tx,
      flock.id,
      [
        { eventDate: "2026-04-25", fromHouseId: p1!.id, toHouseId: l1!.id, qty: 4_000 },
        { eventDate: "2026-04-26", fromHouseId: p1!.id, toHouseId: l1!.id, qty: 3_800 },
        { eventDate: "2026-04-27", fromHouseId: p1!.id, toHouseId: l2!.id, qty: 2_000 },
      ],
      userId,
    );
    ok("a corrected lorry re-splits the birds", (await placementCount(tx, inL1!.id)) === 7_800);
    led = await flockLedger(tx as never, flock.id);
    ok("and the flock total is untouched", led.birds === 9_800);

    // ── Deaths on both sides of the move ──
    const inL2 = openNow.find((p) => p.houseId === l2!.id)!;
    await recordMovement(tx, { placementId: inL1!.id, kind: "mortality", qty: 40, eventDate: "2026-06-01", causeCode: "prolapse", userId });
    await recordMovement(tx, { placementId: inL2.id, kind: "mortality", qty: 10, eventDate: "2026-06-01", causeCode: "heat", userId });

    led = await flockLedger(tx as never, flock.id);
    ok("lifetime mortality spans the move", led.lost === 250, `${led.lost} of 10,000 = ${((led.lost / 10_000) * 100).toFixed(2)}%`);
    ok("and the total is continuous", led.birds === 9_750);

    const sheet = await handoverSummary(tx, flock.id, "2026-04-27");
    ok("the handover counts what was handed over", sheet.birds === 9_800);
    ok("and breaks the losses down by cause", sheet.causes.length === 2, sheet.causes.map((c) => `${c.label} ${c.qty}`).join(", "));
    ok("16 weeks is inside the housing window", sheet.inWindow === true, sheet.age.label);

    await startLay(tx, flock.id, "2026-05-10");
    ok("start lay sets status and date", (await tx.select().from(flocks).where(eq(flocks.id, flock.id)))[0]?.status === "laying");
    // 3 Jan to 25 Apr is 112 days — exactly 16 weeks. The age runs from the
    // weighted average of the hatches, not from the first of them.
    ok(
      "age reads from the weighted average",
      ageOn(grown.hatchDate, "2026-04-25").label === "16w 0d",
      ageOn(grown.hatchDate, "2026-04-25").label,
    );

    // ── Culling out over several days ──
    console.log("\n  Culling out");
    await refuses("culling more than a house holds", () =>
      setFlockCulls(tx, flock.id, [{ eventDate: "2027-01-15", houseId: l1!.id, qty: 99_999 }], userId),
    );

    const partial = await setFlockCulls(
      tx,
      flock.id,
      [
        { eventDate: "2027-01-15", houseId: l1!.id, qty: 3_000 },
        { eventDate: "2027-01-16", houseId: l1!.id, qty: 4_760 },
      ],
      userId,
    );
    ok("a part-culled flock is still live", partial.flock.status === "laying", partial.flock.status);
    ok("with the rest still standing", partial.remaining === 1_990, String(partial.remaining));

    const done = await setFlockCulls(
      tx,
      flock.id,
      [
        { eventDate: "2027-01-15", houseId: l1!.id, qty: 3_000 },
        { eventDate: "2027-01-16", houseId: l1!.id, qty: 4_760 },
        { eventDate: "2027-01-18", houseId: l2!.id, qty: 1_990 },
      ],
      userId,
    );
    ok("the last lorry depletes the flock", done.flock.status === "depleted");
    ok("dated on the last day", done.flock.depletedOn === "2027-01-18");
    ok("and nothing is left", done.remaining === 0);
    ok(
      "no placement is left open",
      (
        await tx
          .select()
          .from(flockPlacements)
          .where(and(eq(flockPlacements.flockId, flock.id), isNull(flockPlacements.toDate)))
      ).length === 0,
    );

    // Removing a cull line brings the flock back — what correcting a mistyped
    // lorry actually means.
    const undone = await setFlockCulls(
      tx,
      flock.id,
      [
        { eventDate: "2027-01-15", houseId: l1!.id, qty: 3_000 },
        { eventDate: "2027-01-16", houseId: l1!.id, qty: 4_760 },
      ],
      userId,
    );
    ok("removing a cull line revives the flock", undone.flock.status === "laying");
    ok("and its birds come back", undone.remaining === 1_990);
    ok(
      "and its house is open again",
      (
        await tx
          .select()
          .from(flockPlacements)
          .where(and(eq(flockPlacements.flockId, flock.id), isNull(flockPlacements.toDate)))
      ).length === 1,
    );

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
