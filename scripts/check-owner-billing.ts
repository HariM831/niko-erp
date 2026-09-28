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
import { and, eq, gte, lte } from "drizzle-orm";
import {
  accounts,
  birdValuationRates,
  bills,
  breeds,
  contacts,
  eggBenchmarkPrices,
  feedTransfers,
  flocks,
  invoiceLines,
  invoices,
  items,
  journalEntryLines,
  ownerAgreements,
  ownerBillingRuns,
  preferences,
  standardSets,
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
import { createFlock, setFlockTransfers } from "../server/services/flocks";
import { saveDay } from "../server/services/daily";
import { getPreferences } from "../server/services/preferences";
import { PostingError } from "../server/services/posting";
import { istDate } from "../server/services/day-resolution";
import { scratchHouse } from "./lib/scratch-houses";

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

const addDays = (iso: string, k: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + k * 86_400_000).toISOString().slice(0, 10);

try {
  await db.transaction(async (tx) => {
    const userId = ((await tx.execute(`SELECT id FROM users LIMIT 1`)).rows[0] as { id: string }).id;
    const period = istDate().slice(0, 7);
    const { from, to } = monthBounds(period);
    console.log(`\n  billing period ${from} … ${to}\n`);

    // Its own owner, sheds and batches. The real owners' sheds hold real
    // batches and a real month of feed and eggs, and the spine rightly refuses
    // to house a test batch on top of one — so the check brings a world whose
    // every figure it put there itself.
    const [owner] = await tx
      .insert(contacts)
      .values({ type: "both", displayName: "ZZ Check Owner LLP" })
      .returning();
    const ownerId = owner!.id;
    const theirs = [
      await scratchHouse(tx, "ZZ-OL1", "layer", ownerId),
      await scratchHouse(tx, "ZZ-OL2", "layer", ownerId),
    ];
    const aminoPullet = await scratchHouse(tx, "ZZ-OP1", "pullet");
    const [breed] = await tx.insert(breeds).values({ code: "ZZOWN", name: "Owner Check" }).returning();
    await tx.insert(standardSets).values({ breedId: breed!.id, name: "set", isDefault: true });
    // A batch in lay in their first shed, and one still rearing in Amino's.
    const laying = await createFlock(tx, {
      locationId: theirs[0]!.locationId,
      breedId: breed!.id,
      houseId: theirs[0]!.id,
      hatches: [{ hatchDate: addDays(from, -210), qty: 20_000 }],
      userId,
    });
    const rearing = await createFlock(tx, {
      locationId: aminoPullet.locationId,
      breedId: breed!.id,
      houseId: aminoPullet.id,
      hatches: [{ hatchDate: addDays(from, -110), qty: 8_000 }],
      userId,
    });

    // What eggs and pullets are billed AS is a setting, and a database nobody
    // has configured has none. The real setting is reported, not assumed; for
    // the run the check names its own items.
    const real = await getPreferences(tx);
    console.log(
      `  · the real settings: eggs bill as ${real.eggPurchaseItemId ? "an item" : "NOTHING — set it in Settings"}, ` +
        `pullets as ${real.birdSaleItemId ? "an item" : "NOTHING — set it in Settings"}\n`,
    );
    // A bill line posts to its item's expense account; any expense account will do.
    const [expense] = await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.type, "expense")).limit(1);
    if (!expense) throw new Error("Need an expense account");
    const [eggItem, birdItem] = await tx
      .insert(items)
      .values([
        { name: "ZZ Check Eggs (Purchases)", category: "eggs", purchaseAccountId: expense.id },
        { name: "ZZ Check Layer Birds", category: "birds" },
      ])
      .returning();
    const billAs = { eggPurchaseItemId: eggItem!.id, birdSaleItemId: birdItem!.id };
    await tx.insert(preferences).values({ id: "default", ...billAs }).onConflictDoUpdate({ target: preferences.id, set: billAs });

    const list = await owners(tx);
    ok("owners are discovered from the houses", list.some((o) => o.id === ownerId), list.map((o) => o.name).join(", "));
    const amino = [aminoPullet];
    const runs = and(eq(ownerBillingRuns.period, from), eq(ownerBillingRuns.contactId, ownerId));

    /* ── Prices ───────────────────────────────────────────────────────────── */
    // The month's real rates are cleared (inside the rollback) so no day of it
    // is priced off anything but the rates set here.
    await tx.delete(eggBenchmarkPrices).where(and(gte(eggBenchmarkPrices.effectiveFrom, from), lte(eggBenchmarkPrices.effectiveFrom, to)));
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
        contactId: ownerId,
        effectiveFrom: from,
        eggSpreadPerEgg: "0.5000",
        createdBy: userId,
      });

    /* ── Feed: one real delivery and one voided ───────────────────────────── */
    //
    // Measured as a delta, though the owner is the check's own and starts at nothing.
    const [feedItem] = await tx.select().from(items).limit(1);
    const shed = theirs[0]!;
    const mid = `${period}-10`;

    const feedKgOf = (d: Awaited<ReturnType<typeof draftMonth>>, itemId?: string) =>
      d.feedLines
        .filter((l) => l.kind === "feed" && (!itemId || l.itemId === itemId))
        .reduce((s, l) => s + l.qty, 0);

    const baseline = await draftMonth(tx, ownerId, period);
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

    /* ── Eggs: two days' lay in their shed ───────────────────────────────── */
    // The 10th and the 20th, either side of the mid-month rate move below.
    const placement = laying.placement;
    const eggsRecorded = 9_000;
    for (const day of [mid, `${period}-20`]) {
      await saveDay(tx, { placementId: placement.id, day, eggsTotal: eggsRecorded, losses: [] }, userId);
    }

    /* ── The draft ────────────────────────────────────────────────────────── */
    const draft = await draftMonth(tx, ownerId, period);
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
      const pullet = aminoPullet;
      const layer = theirs[1]!; // the empty one — their first holds the laying batch
      const [flock] = await tx.select().from(flocks).where(eq(flocks.id, rearing.flock.id));
      const housedOn = `${period}-12`;
      const qty = 5_000;
      const beforeStage = await draftMonth(tx, ownerId, period);
      await setFlockTransfers(
        tx,
        flock!.id,
        [{ eventDate: housedOn, fromHouseId: pullet.id, toHouseId: layer.id, qty }],
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

      const withBirds = await draftMonth(tx, ownerId, period);
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
      await tx.delete(ownerBillingRuns).where(runs);
      const three = await raiseMonth(tx, ownerId, period, userId);
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
      const built = await buildStatements(tx, ownerId, period);
      ok("a pullet statement is built", !!built.birds, built.birds?.fileName ?? "");
      ok("it is a PDF", built.birds?.pdf.subarray(0, 5).toString() === "%PDF-");

      // Put the month back for the rest of the script.
      await tx.delete(ownerBillingRuns).where(runs);
      await setFlockTransfers(tx, flock!.id, [], userId);
    }

    /* ── A move between the owner's own sheds is not a second sale ─────────── */
    {
      const before = (await draftMonth(tx, ownerId, period)).birdLines.length;
      await setFlockTransfers(
        tx,
        laying.flock.id,
        [{ eventDate: mid, fromHouseId: theirs[0]!.id, toHouseId: theirs[1]!.id, qty: 100 }],
        userId,
      );
      const after = (await draftMonth(tx, ownerId, period)).birdLines.length;
      ok(
        "moving birds between the owner's own sheds raises no sale",
        after === before,
        `${before} → ${after} bird line(s)`,
      );
    }



    /* ── A benchmark that MOVES mid-month ─────────────────────────────────── */
    //
    // Eggs take the rate of the day they were laid. A month priced at its
    // closing rate would quietly restate every earlier day.
    {
      const before = await draftMonth(tx, ownerId, period);
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

      const after = await draftMonth(tx, ownerId, period);
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
    ok("the check's own items are what eggs and pullets bill as", prefs.eggPurchaseItemId === eggItem!.id && prefs.birdSaleItemId === birdItem!.id);

    const raised = await raiseMonth(tx, ownerId, period, userId);
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
    const after = await draftMonth(tx, ownerId, period);
    ok("the draft now says it has been billed", after.billed !== null);
    await refuses("billing the same month twice is refused", () =>
      raiseMonth(tx, ownerId, period, userId),
    );

    /* ── An unpriceable line shows a dash, never a zero ────────────────────── */
    await tx.delete(eggBenchmarkPrices);
    const unpriced = await draftMonth(tx, ownerId, period);
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
