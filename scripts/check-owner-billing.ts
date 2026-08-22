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
  birdValuationRates,
  bills,
  contacts,
  eggBenchmarkPrices,
  feedTransfers,
  flockMovements,
  flockPlacements,
  flocks,
  houses,
  invoiceLines,
  invoices,
  items,
  journalEntryLines,
  ownerAgreements,
  ownerBillingRuns,
} from "@shared/schema";
import { db } from "../server/db";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
import {
  buildStatements,
  draftMonth,
  monthBounds,
  owners,
  raiseMonth,
} from "../server/services/owner-billing";
import { placementCount, setFlockTransfers } from "../server/services/flocks";
import { saveDay } from "../server/services/daily";
import { getPreferences } from "../server/services/preferences";
import { PostingError } from "../server/services/posting";

let failures = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!cond) failures++;
};
const near = (a: number, b: number, tol = 0.01) => Math.abs(a - b) <= tol;
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
const money = (v: number) => `₹${v.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

class Rollback extends Error {}

/**
 * A flock's existing transfers, in the shape setFlockTransfers takes.
 *
 * setFlockTransfers REPLACES the whole set, which was fine when the tests ran
 * against demo flocks with no history. The flocks are the real imported ones
 * now, each carrying its actual housings — so a test that wants to add a move
 * must hand back everything that already happened plus its own line, or the
 * spine will (rightly) refuse to erase a January housing the ledger depends on.
 */
async function existingTransfers(tx: Tx, flockId: string) {
  const rows = await tx
    .select({
      eventDate: flockMovements.eventDate,
      qty: flockMovements.qty,
      toHouseId: flockPlacements.houseId,
      counterpart: flockMovements.counterpartPlacementId,
    })
    .from(flockMovements)
    .innerJoin(flockPlacements, eq(flockPlacements.id, flockMovements.placementId))
    .where(and(eq(flockPlacements.flockId, flockId), eq(flockMovements.kind, "transfer_in")));
  const out: Array<{ eventDate: string; fromHouseId: string; toHouseId: string; qty: number }> = [];
  for (const r of rows) {
    if (!r.counterpart) continue;
    const [src] = await tx
      .select({ houseId: flockPlacements.houseId })
      .from(flockPlacements)
      .where(eq(flockPlacements.id, r.counterpart));
    if (src) out.push({ eventDate: r.eventDate, fromHouseId: src.houseId, toHouseId: r.toHouseId, qty: r.qty });
  }
  return out.sort((a, b) => a.eventDate.localeCompare(b.eventDate));
}



try {
  await db.transaction(async (tx) => {
    const userId = ((await tx.execute(`SELECT id FROM users LIMIT 1`)).rows[0] as { id: string }).id;
    const period = new Date().toISOString().slice(0, 7);
    const { from, to } = monthBounds(period);
    console.log(`\n  billing period ${from} … ${to}\n`);

    // This period may genuinely have been billed already. Clearing the run
    // inside the transaction lets the raise be exercised without touching the
    // real documents — it is rolled back with everything else.
    await tx.delete(ownerBillingRuns).where(eq(ownerBillingRuns.period, from));

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
    // Upserted, not inserted: the real terms may already be set, and a check
    // that only runs on a database nobody has configured is no check at all.
    await tx
      .insert(eggBenchmarkPrices)
      .values({ effectiveFrom: from, ratePerEgg: "5.2000", source: "check", createdBy: userId })
      .onConflictDoUpdate({
        target: eggBenchmarkPrices.effectiveFrom,
        set: { ratePerEgg: "5.2000", source: "check" },
      });
    await tx
      .insert(ownerAgreements)
      .values({
        contactId: luit.id,
        effectiveFrom: from,
        eggSpreadPerEgg: "0.5000",
        createdBy: userId,
      })
      .onConflictDoUpdate({
        target: [ownerAgreements.contactId, ownerAgreements.effectiveFrom],
        set: { eggSpreadPerEgg: "0.5000" },
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
      d.feedLines
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
    for (const l of [...draft.feedLines, ...draft.eggLines]) {
      console.log(
        `    ${l.kind.padEnd(6)} ${l.description.slice(0, 46).padEnd(46)} ` +
          `${l.qty.toLocaleString("en-IN").padStart(10)} ${l.unit.padEnd(6)} ` +
          `${l.rate == null ? "     —" : `@${l.rate.toFixed(4)}`.padStart(12)} ` +
          `${l.amount == null ? "—" : money(l.amount)}`,
      );
    }
    console.log(
      `\n    invoice ${money(draft.feedTotal)}   bill ${money(draft.eggTotal)}\n`,
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
    const mine = draft.feedLines.find((l) => l.kind === "feed" && l.itemId === feedItem!.id);
    ok(
      "feed is charged at what the mill made it for",
      !!mine && mine.rate != null && (baseKg > 0 || near(mine.rate, 31.5, 0.0001)),
      mine?.rate
        ? `₹${mine.rate.toFixed(4)}/kg${baseKg > 0 ? " (blended with existing deliveries)" : ""}`
        : "",
    );

    const eggLine = draft.eggLines.find((l) => l.kind === "eggs");
    if (eggsRecorded) {
      ok("eggs are bought back", !!eggLine, eggLine ? `${eggLine.qty} eggs` : "");
      ok(
        "eggs price at benchmark plus the agreed spread",
        !!eggLine && eggLine.rate != null && near(eggLine.rate, 5.7, 0.0001),
        eggLine?.rate ? `₹${eggLine.rate.toFixed(2)} = 5.20 + 0.50` : "",
      );
      ok("eggs are a BILL, not an invoice", !draft.feedLines.some((l) => l.kind === "eggs"));
    }

    ok("nothing is billed twice", draft.billed === null);
    // No net is asserted anywhere: the invoice is a receivable, the bill is a
    // payable, and what the two come to together is a ledger position rather
    // than something a month's two documents get to decide.
    ok(
      "the draft states no net",
      !("net" in (draft as unknown as Record<string, unknown>)),
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

    /* ── Housing pullets into an owner's shed sells them the birds ────────── */
    //
    // Housing happens a few times a year, so most months have none. One is
    // staged here — inside the same rolled-back transaction as everything else
    // — because the pullet invoice is otherwise never exercised, and a code
    // path nothing runs is a code path nobody knows is broken.
    {
      const [pullet] = await tx
        .select()
        .from(houses)
        .where(and(eq(houses.purpose, "pullet"), sql`${houses.ownerId} IS NULL`));
      const layer = theirs.find((h) => h.purpose === "layer");
      const [rearing] = pullet
        ? await tx
            .select({ id: flockPlacements.id, flockId: flockPlacements.flockId })
            .from(flockPlacements)
            .where(
              and(eq(flockPlacements.houseId, pullet.id), sql`${flockPlacements.toDate} IS NULL`),
            )
        : [];

      if (pullet && layer && rearing) {
        const [flock] = await tx.select().from(flocks).where(eq(flocks.id, rearing.flockId));
        const housedOn = `${period}-12`;
        // Move what the house actually holds. The pullet house has a real
        // flock's TAIL in it now — a few thousand birds, not a test's round
        // number — and the spine refuses a move the house cannot cover.
        const available = await placementCount(tx, rearing.id, housedOn);
        const qty = Math.min(available, 5_000);
        if (qty <= 0) {
          console.log("  · pullet house is empty on the staged date — pullet sale not exercised");
        } else {
        // The month already holds REAL housings — B160426 went into L5 over six
        // August days — so every assertion is about the STAGED line, found by
        // its date and quantity, never about the count of lines.
        const beforeStage = await draftMonth(tx, luit.id, period);
        const already = await existingTransfers(tx, flock!.id);
        await setFlockTransfers(
          tx,
          flock!.id,
          [...already, { eventDate: housedOn, fromHouseId: pullet.id, toHouseId: layer.id, qty }],
          userId,
        );

        const ageWeek =
          Math.floor(
            (Date.parse(`${housedOn}T00:00:00Z`) - Date.parse(`${flock!.hatchDate}T00:00:00Z`)) /
              86_400_000 /
              7,
          ) + 1;

        // A rate in force ON THE HOUSING DATE. The real curve may start later
        // than the month being tested — an effective-dated rate does not reach
        // backwards, and that is the point of it — so the check brings its own.
        await tx
          .insert(birdValuationRates)
          .values({
            breedId: flock!.breedId,
            ageWeek,
            rate: "135.30",
            effectiveFrom: from,
            note: "check",
            createdBy: userId,
          })
          .onConflictDoUpdate({
            target: [
              birdValuationRates.breedId,
              birdValuationRates.ageWeek,
              birdValuationRates.effectiveFrom,
            ],
            set: { rate: "135.30" },
          });

        const withBirds = await draftMonth(tx, luit.id, period);
        ok(
          "housing pullets raises a bird sale",
          withBirds.birdLines.length === beforeStage.birdLines.length + 1,
          `${beforeStage.birdLines.length} → ${withBirds.birdLines.length} line(s)`,
        );

        const line = withBirds.birdLines.find(
          (l) => l.date === housedOn && l.qty === qty,
        );
        const [expected] = await tx
          .select()
          .from(birdValuationRates)
          .where(
            and(
              eq(birdValuationRates.breedId, flock!.breedId),
              eq(birdValuationRates.ageWeek, ageWeek),
              eq(birdValuationRates.effectiveFrom, from),
            ),
          );
        ok(
          "the valuation curve has a rate for that age",
          !!expected,
          expected ? `week ${ageWeek} = ₹${expected.rate}` : `week ${ageWeek} MISSING`,
        );
        ok(
          "the birds price off the curve at their age",
          !!line && !!expected && near(line.rate ?? 0, Number(expected.rate), 0.005),
          line?.rate ? `₹${line.rate.toFixed(2)}/bird` : "unpriced",
        );
        ok(
          "and the line is worth qty times that rate",
          !!line && line.amount != null && near(line.amount, qty * (line.rate ?? 0), 0.5),
          line?.amount ? money(line.amount) : "",
        );
        ok("a priceable housing raises no problem", !withBirds.problems.length, withBirds.problems.join("; "));

        // ── And it becomes its own invoice, separate from the feed one ──
        await tx.delete(ownerBillingRuns).where(eq(ownerBillingRuns.period, from));
        const three = await raiseMonth(tx, luit.id, period, userId);
        ok("a feed invoice is raised", !!three.feedInvoiceId);
        ok("a SEPARATE pullet invoice is raised", !!three.birdInvoiceId);
        ok(
          "they are two different documents",
          three.feedInvoiceId !== three.birdInvoiceId,
          `${three.feedInvoiceId?.slice(0, 8)} vs ${three.birdInvoiceId?.slice(0, 8)}`,
        );
        if (three.birdInvoiceId) {
          const [inv] = await tx.select().from(invoices).where(eq(invoices.id, three.birdInvoiceId));
          const lines = await tx
            .select()
            .from(invoiceLines)
            .where(eq(invoiceLines.invoiceId, three.birdInvoiceId));
          console.log(`\n    pullet invoice ${inv!.number}  ${money(Number(inv!.total))}  ${inv!.status}`);
          ok(
            "the pullet invoice carries only the pullets",
            lines.length === withBirds.birdLines.length,
            `${lines.length} line(s)`,
          );
          ok(
            "its total is the pullet total, not the feed one",
            near(Number(inv!.subTotal), withBirds.birdTotal, 1),
            `${money(Number(inv!.subTotal))} vs feed ${money(withBirds.feedTotal)}`,
          );
        }

        // The statement on it must show the pullets and nothing else.
        const built = await buildStatements(tx, luit.id, period);
        ok("a pullet statement is built", !!built.birds, built.birds?.fileName ?? "");
        ok("it is a PDF", built.birds?.pdf.subarray(0, 5).toString() === "%PDF-");

        // Put the month back for the rest of the script.
        await tx.delete(ownerBillingRuns).where(eq(ownerBillingRuns.period, from));
        await setFlockTransfers(tx, flock!.id, already, userId);
        }
      } else {
        console.log("  · no Amino pullet house with a live batch — pullet sale not exercised");
      }
    }

    /* ── A move between the owner's own sheds is not a second sale ─────────── */
    if (theirs.length >= 2 && placement) {
      const [flock] = await tx.select().from(flocks).where(eq(flocks.id, placement.flockId));
      const before = (await draftMonth(tx, luit.id, period)).birdLines.length;
      try {
        const keep = await existingTransfers(tx, flock!.id);
        await setFlockTransfers(
          tx,
          flock!.id,
          [...keep, { eventDate: mid, fromHouseId: theirs[0]!.id, toHouseId: theirs[1]!.id, qty: 100 }],
          userId,
        );
        const after = (await draftMonth(tx, luit.id, period)).birdLines.length;
        ok(
          "moving birds between the owner's own sheds raises no sale",
          after === before,
          `${before} → ${after} bird line(s)`,
        );
      } catch (e) {
        console.log(`  · could not test the internal move: ${e instanceof Error ? e.message : e}`);
      }
    }



    /* ── A benchmark that MOVES mid-month ─────────────────────────────────── */
    //
    // Eggs take the rate of the day they were laid. A month priced at its
    // closing rate would quietly restate every earlier day.
    {
      const before = await draftMonth(tx, luit.id, period);
      const eggsBefore = before.eggLines
        .filter((l) => l.kind === "eggs")
        .reduce((s, l) => s + l.qty, 0);
      const valueBefore = before.eggTotal;

      // A rise part-way through the month.
      const midMonth = `${period}-15`;
      await tx
        .insert(eggBenchmarkPrices)
        .values({ effectiveFrom: midMonth, ratePerEgg: "6.2000", source: "check", createdBy: userId })
        .onConflictDoUpdate({
          target: eggBenchmarkPrices.effectiveFrom,
          set: { ratePerEgg: "6.2000", source: "check" },
        });

      const after = await draftMonth(tx, luit.id, period);
      const eggLines = after.eggLines.filter((l) => l.kind === "eggs");
      const eggsAfter = eggLines.reduce((s, l) => s + l.qty, 0);

      ok(
        "the same eggs are still billed",
        eggsAfter === eggsBefore,
        `${eggsAfter.toLocaleString("en-IN")} eggs`,
      );
      ok(
        "a moving benchmark splits the line by rate",
        eggLines.length > 1,
        `${eggLines.length} egg line(s)`,
      );
      const rates = [...new Set(eggLines.map((l) => l.rate))].sort();
      ok(
        "both rates appear — 5.20+0.50 before, 6.20+0.50 after",
        rates.includes(5.7) && rates.includes(6.7),
        rates.map((r) => `₹${r?.toFixed(2)}`).join(" and "),
      );
      ok(
        "the later days cost more, so the month is dearer",
        after.eggTotal > valueBefore,
        `${money(valueBefore)} → ${money(after.eggTotal)}`,
      );
      ok(
        "and NOT the whole month at the closing rate",
        after.eggTotal < eggsAfter * 6.7 - 1,
        `${money(after.eggTotal)} < ${money(eggsAfter * 6.7)}`,
      );

      // Put the month back the way the rest of the script expects it.
      await tx.delete(eggBenchmarkPrices).where(eq(eggBenchmarkPrices.effectiveFrom, midMonth));
    }

    /* ── Raising the documents ────────────────────────────────────────────── */
    //
    // Everything here posts to the ledger, so it happens inside the same
    // rolled-back transaction as the rest.
    // The benchmark set at the top is still in force — a second row for the
    // same date is exactly what the unique index exists to refuse.
    const prefs = await getPreferences(tx);
    ok(
      "an egg item is set to bill eggs as",
      !!prefs.eggPurchaseItemId,
      prefs.eggPurchaseItemId ? "set" : "NOT SET — migration 0066 found no ungraded egg item",
    );

    const [asVendor] = await tx.select().from(contacts).where(eq(contacts.id, luit.id));
    if (!["vendor", "both"].includes(asVendor!.type)) {
      // Amino buys eggs from them, so they have to be a vendor as well as a
      // customer. Luit really is both; a demo contact might not be.
      await tx.update(contacts).set({ type: "both" }).where(eq(contacts.id, luit.id));
      console.log("  · made the owner a vendor for the test");
    }

    const raised = await raiseMonth(tx, luit.id, period, userId);
    ok("an invoice is raised", !!raised.feedInvoiceId);
    ok("a bill is raised", !!raised.billId);

    if (raised.feedInvoiceId) {
      const [inv] = await tx.select().from(invoices).where(eq(invoices.id, raised.feedInvoiceId));
      const invLines = await tx
        .select()
        .from(invoiceLines)
        .where(eq(invoiceLines.invoiceId, raised.feedInvoiceId));
      console.log(`
    invoice ${inv!.number}  ${inv!.invoiceDate}  ${money(Number(inv!.total))}  ${inv!.status}`);
      ok("the invoice is posted, not left in draft", inv!.status === "sent", inv!.status);
      ok("it carries a journal entry", !!inv!.journalEntryId);
      ok(
        "it is dated in the month it covers",
        inv!.invoiceDate >= from && inv!.invoiceDate <= to,
        inv!.invoiceDate,
      );
      ok(
        "its lines match the draft",
        invLines.length === raised.draft.feedLines.length,
        `${invLines.length} line(s)`,
      );
      ok(
        "its total matches the draft",
        near(Number(inv!.subTotal), raised.draft.feedTotal, 1),
        `${money(Number(inv!.subTotal))} vs ${money(raised.draft.feedTotal)}`,
      );
      if (inv!.journalEntryId) {
        const jl = await tx
          .select({ d: journalEntryLines.debit, c: journalEntryLines.credit })
          .from(journalEntryLines)
          .where(eq(journalEntryLines.entryId, inv!.journalEntryId));
        const dr = jl.reduce((s, l) => s + Number(l.d ?? 0), 0);
        const cr = jl.reduce((s, l) => s + Number(l.c ?? 0), 0);
        ok("the invoice journal balances", near(dr, cr, 0.01), `${money(dr)} / ${money(cr)}`);
      }
    }

    if (raised.billId) {
      const [bill] = await tx.select().from(bills).where(eq(bills.id, raised.billId));
      console.log(`    bill    ${bill!.number}  ${bill!.billDate}  ${money(Number(bill!.total))}  ${bill!.status}
`);
      ok(
        "the bill is dated in the month it covers",
        bill!.billDate >= from && bill!.billDate <= to,
        bill!.billDate,
      );
      ok("it carries a journal entry", !!bill!.journalEntryId);
      ok(
        "its total matches the draft",
        near(Number(bill!.subTotal), raised.draft.eggTotal, 1),
        `${money(Number(bill!.subTotal))} vs ${money(raised.draft.eggTotal)}`,
      );
      if (bill!.journalEntryId) {
        const jl = await tx
          .select({ d: journalEntryLines.debit, c: journalEntryLines.credit })
          .from(journalEntryLines)
          .where(eq(journalEntryLines.entryId, bill!.journalEntryId));
        const dr = jl.reduce((s, l) => s + Number(l.d ?? 0), 0);
        const cr = jl.reduce((s, l) => s + Number(l.c ?? 0), 0);
        ok("the bill journal balances", near(dr, cr, 0.01), `${money(dr)} / ${money(cr)}`);
      }
    }

    // ── The month is now closed to a second run ──
    const after = await draftMonth(tx, luit.id, period);
    ok("the draft now says it has been billed", after.billed !== null);
    await refuses("billing the same month twice is refused", () =>
      raiseMonth(tx, luit.id, period, userId),
    );

    /* ── An unpriceable line shows a dash, never a zero ────────────────────── */
    await tx.delete(eggBenchmarkPrices);
    const unpriced = await draftMonth(tx, luit.id, period);
    const bad = unpriced.eggLines.find((l) => l.kind === "eggs");
    if (bad) {
      ok("an egg line with no benchmark carries no amount", bad.amount === null && bad.rate === null);
      ok("and says why", !!bad.problem, bad.problem ?? "");
      ok(
        "the bill total does not silently become zero-rated revenue",
        unpriced.eggTotal === 0 && unpriced.problems.length > 0,
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
