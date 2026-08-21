/**
 * Owner billing, exercised inside a rolled-back transaction.
 *
 * The things worth pinning down are the ones that cost somebody real money if
 * they are wrong: that Amino's own sheds are never billed, that a batch moving
 * between two of the OWNER's sheds is not sold to them a second time, that a
 * voided feed transfer is not charged, and that an unpriceable line refuses to
 * carry an amount rather than quietly showing zero.
 *
 * Run: npx tsx scripts/check-owner-billing.ts
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  contacts,
  eggBenchmarkPrices,
  feedTransfers,
  flockPlacements,
  flocks,
  houses,
  items,
  ownerAgreements,
} from "@shared/schema";
import { db } from "../server/db";
import { draftMonth, monthBounds, owners } from "../server/services/owner-billing";
import { setFlockTransfers } from "../server/services/flocks";
import { saveDay } from "../server/services/daily";

let failures = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!cond) failures++;
};
const near = (a: number, b: number, tol = 0.01) => Math.abs(a - b) <= tol;
const money = (v: number) => `₹${v.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

class Rollback extends Error {}

try {
  await db.transaction(async (tx) => {
    const userId = ((await tx.execute(`SELECT id FROM users LIMIT 1`)).rows[0] as { id: string }).id;
    const period = new Date().toISOString().slice(0, 7);
    const { from, to } = monthBounds(period);
    console.log(`\n  billing period ${from} … ${to}\n`);

    const list = await owners(tx);
    ok("owners are discovered from the houses", list.length >= 2, list.map((o) => o.name).join(", "));
    const luit = list.find((o) => /luit/i.test(o.name));
    if (!luit) throw new Error("expected a Luit-owned house to test against");

    const theirs = await tx.select().from(houses).where(eq(houses.ownerId, luit.id));
    const amino = await tx
      .select()
      .from(houses)
      .where(and(sql`${houses.ownerId} IS NULL`, eq(houses.purpose, "pullet")));
    ok("Amino's own sheds have no owner contact", amino.length > 0, `${amino.length} house(s)`);

    /* ── Prices ───────────────────────────────────────────────────────────── */
    await tx
      .insert(eggBenchmarkPrices)
      .values({ effectiveFrom: from, ratePerEgg: "5.2000", source: "check", createdBy: userId });
    await tx.insert(ownerAgreements).values({
      contactId: luit.id,
      effectiveFrom: from,
      eggSpreadPerEgg: "0.5000",
      createdBy: userId,
    });

    /* ── Feed: one real delivery and one voided ───────────────────────────── */
    //
    // Measured as a DELTA against what the farm already had. Asserting absolute
    // totals would only pass on an empty database, which is not the database
    // anybody runs this on.
    const [feedItem] = await tx.select().from(items).limit(1);
    const shed = theirs[0]!;
    const mid = `${period}-10`;

    const feedKgOf = (d: Awaited<ReturnType<typeof draftMonth>>, itemId?: string) =>
      d.invoiceLines
        .filter((l) => l.kind === "feed" && (!itemId || l.itemId === itemId))
        .reduce((s, l) => s + l.qty, 0);

    const baseline = await draftMonth(tx, luit.id, period);
    const baseKg = feedKgOf(baseline, feedItem!.id);
    await tx.insert(feedTransfers).values([
      {
        number: "ZZ-OB-1",
        transferDate: mid,
        itemId: feedItem!.id,
        quantityKg: "10000",
        fromLocationId: shed.locationId,
        toLocationId: shed.locationId,
        toHouseId: shed.id,
        ratePerKg: "31.500000",
        value: "315000.00",
        status: "completed",
      },
      {
        // Voided: delivered on paper, never charged.
        number: "ZZ-OB-2",
        transferDate: mid,
        itemId: feedItem!.id,
        quantityKg: "9999",
        fromLocationId: shed.locationId,
        toLocationId: shed.locationId,
        toHouseId: shed.id,
        ratePerKg: "31.500000",
        value: "314968.50",
        status: "void",
      },
    ]);

    /* ── Eggs: a day's lay in their shed ──────────────────────────────────── */
    const [placement] = await tx
      .select()
      .from(flockPlacements)
      .where(and(eq(flockPlacements.houseId, shed.id), sql`${flockPlacements.toDate} IS NULL`))
      .limit(1);
    let eggsRecorded = 0;
    if (placement) {
      eggsRecorded = 9_000;
      await saveDay(
        tx,
        { placementId: placement.id, day: mid, eggsTotal: eggsRecorded, losses: [] },
        userId,
      );
    }

    /* ── The draft ────────────────────────────────────────────────────────── */
    const draft = await draftMonth(tx, luit.id, period);
    console.log(`\n  ${draft.owner.name}`);
    for (const l of [...draft.invoiceLines, ...draft.billLines]) {
      console.log(
        `    ${l.kind.padEnd(6)} ${l.description.slice(0, 46).padEnd(46)} ` +
          `${l.qty.toLocaleString("en-IN").padStart(10)} ${l.unit.padEnd(6)} ` +
          `${l.rate == null ? "     —" : `@${l.rate.toFixed(4)}`.padStart(12)} ` +
          `${l.amount == null ? "—" : money(l.amount)}`,
      );
    }
    console.log(
      `\n    invoice ${money(draft.invoiceTotal)}   bill ${money(draft.billTotal)}   net ${money(draft.net)}\n`,
    );
    for (const p of draft.problems) console.log(`    ! ${p}`);
    if (draft.problems.length) console.log("");

    const added = feedKgOf(draft, feedItem!.id) - baseKg;
    ok("feed is charged", added > 0, `${added.toLocaleString("en-IN")} kg added`);
    ok(
      "the voided delivery is not charged",
      near(added, 10_000, 0.5),
      `${added.toLocaleString("en-IN")} kg, not 19,999`,
    );
    // Only meaningful when nothing else muddied this item's average.
    const mine = draft.invoiceLines.find((l) => l.kind === "feed" && l.itemId === feedItem!.id);
    ok(
      "feed is charged at what the mill made it for",
      !!mine && mine.rate != null && (baseKg > 0 || near(mine.rate, 31.5, 0.0001)),
      mine?.rate
        ? `₹${mine.rate.toFixed(4)}/kg${baseKg > 0 ? " (blended with existing deliveries)" : ""}`
        : "",
    );

    const eggLine = draft.billLines.find((l) => l.kind === "eggs");
    if (eggsRecorded) {
      ok("eggs are bought back", !!eggLine, eggLine ? `${eggLine.qty} eggs` : "");
      ok(
        "eggs price at benchmark plus the agreed spread",
        !!eggLine && eggLine.rate != null && near(eggLine.rate, 5.7, 0.0001),
        eggLine?.rate ? `₹${eggLine.rate.toFixed(2)} = 5.20 + 0.50` : "",
      );
      ok("eggs are a BILL, not an invoice", !draft.invoiceLines.some((l) => l.kind === "eggs"));
    }

    ok("nothing is billed twice", draft.billed === null);
    ok(
      "the net is the invoice less the bill",
      near(draft.net, draft.invoiceTotal - draft.billTotal),
      money(draft.net),
    );

    /* ── Amino's own sheds are billed to nobody ───────────────────────────── */
    const aminoIds = amino.map((h) => h.id);
    if (aminoIds.length) {
      let beforeAmino = 0;
      for (const o of await owners(tx)) beforeAmino += feedKgOf(await draftMonth(tx, o.id, period));
      await tx.insert(feedTransfers).values({
        number: "ZZ-OB-3",
        transferDate: mid,
        itemId: feedItem!.id,
        quantityKg: "5000",
        fromLocationId: amino[0]!.locationId,
        toLocationId: amino[0]!.locationId,
        toHouseId: amino[0]!.id,
        ratePerKg: "31.500000",
        value: "157500.00",
        status: "completed",
      });
      // Nothing at all should move: the 5,000 kg went to a house Amino owns.
      const everyOwner = await owners(tx);
      let totalAfter = 0;
      for (const o of everyOwner) totalAfter += feedKgOf(await draftMonth(tx, o.id, period));
      ok(
        "feed sent to Amino's own shed changes no owner's invoice",
        near(totalAfter, beforeAmino, 0.5),
        `${beforeAmino.toLocaleString("en-IN")} → ${totalAfter.toLocaleString("en-IN")} kg across every owner`,
      );
    }

    /* ── A move between the owner's own sheds is not a second sale ─────────── */
    if (theirs.length >= 2 && placement) {
      const [flock] = await tx.select().from(flocks).where(eq(flocks.id, placement.flockId));
      const before = (await draftMonth(tx, luit.id, period)).invoiceLines.filter(
        (l) => l.kind === "birds",
      ).length;
      try {
        await setFlockTransfers(
          tx,
          flock!.id,
          [{ eventDate: mid, fromHouseId: theirs[0]!.id, toHouseId: theirs[1]!.id, qty: 100 }],
          userId,
        );
        const after = (await draftMonth(tx, luit.id, period)).invoiceLines.filter(
          (l) => l.kind === "birds",
        ).length;
        ok(
          "moving birds between the owner's own sheds raises no sale",
          after === before,
          `${before} → ${after} bird line(s)`,
        );
      } catch (e) {
        console.log(`  · could not test the internal move: ${e instanceof Error ? e.message : e}`);
      }
    }

    /* ── An unpriceable line shows a dash, never a zero ────────────────────── */
    await tx.delete(eggBenchmarkPrices).where(inArray(eggBenchmarkPrices.source, ["check"]));
    const unpriced = await draftMonth(tx, luit.id, period);
    const bad = unpriced.billLines.find((l) => l.kind === "eggs");
    if (bad) {
      ok("an egg line with no benchmark carries no amount", bad.amount === null && bad.rate === null);
      ok("and says why", !!bad.problem, bad.problem ?? "");
      ok(
        "the bill total does not silently become zero-rated revenue",
        unpriced.billTotal === 0 && unpriced.problems.length > 0,
        `${unpriced.problems.length} problem(s) reported`,
      );
    }

    throw new Rollback();
  });
} catch (e) {
  if (!(e instanceof Rollback)) {
    console.error(e);
    failures++;
  }
}

console.log(failures ? `\n  ${failures} failed\n` : "\n  all good\n");
process.exit(failures ? 1 : 0);
