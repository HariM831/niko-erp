/**
 * The whole chain, end to end, inside a rolled-back transaction.
 *
 * Every other check tests one link. This one runs the farm as it actually
 * works — mill a batch, send it to a shed, rear a flock, house it across the
 * ownership line, collect eggs, close the month — and then asks whether the
 * documents that come out the far end agree with the records that went in.
 *
 * The questions worth asking of a chain are the ones no single link can answer:
 *  · does the feed on the invoice equal the feed that was actually delivered
 *  · does the egg count on the bill equal what the sheds actually laid
 *  · does the PDF stapled to each document add up to that document's total
 *  · do all three journals balance, and does the ledger move by the right amount
 *  · is what the mill charged the same number the invoice charged
 *
 * Nothing is kept. It posts to the ledger and rolls the lot back, which is the
 * only honest way to exercise posting code against real data.
 *
 * Run: npx tsx scripts/e2e-owner-billing.ts
 */
import { and, asc, eq, gte, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import {
  attachments,
  billLines,
  bills,
  birdValuationRates,
  breeds,
  contacts,
  eggBenchmarkPrices,
  feedTransfers,
  flockDay,
  flockPlacements,
  flocks,
  formulaLines,
  formulas,
  houses,
  invoiceLines,
  invoices,
  items,
  journalEntryLines,
  journalEntries,
  ownerAgreements,
  ownerBillingRuns,
  placementDays,
  standardSets,
} from "@shared/schema";
import { db } from "../server/db";
import { produceOne } from "../server/routes/feed-production";
import { saveDay } from "../server/services/daily";
import { createFlock, setFlockTransfers } from "../server/services/flocks";
import { mainStore, postInventoryMovement } from "../server/services/inventory";
import { pdfText } from "../server/services/pdf-text";
import { PostingError } from "../server/services/posting";
import { getPreferences } from "../server/services/preferences";
import {
  buildStatements,
  draftMonth,
  monthBounds,
  raiseMonth,
} from "../server/services/owner-billing";

let failures = 0;
let step = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`   ${cond ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!cond) failures++;
};
const heading = (title: string) => console.log(`\n  ${++step}. ${title}`);
const near = (a: number, b: number, tol = 0.01) => Math.abs(a - b) <= tol;
const money = (v: number) =>
  `₹${v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const num = (v: number) => v.toLocaleString("en-IN");
/** Pull a figure like "9,76,770.90" back out of a PDF line. */
const parseInr = (s: string) => Number(s.replace(/,/g, ""));

class Rollback extends Error {}

const PERIOD = "2026-05";
const { from, to } = monthBounds(PERIOD);

try {
  await db.transaction(async (tx) => {
    const userId = ((await tx.execute(`SELECT id FROM users LIMIT 1`)).rows[0] as { id: string }).id;
    console.log(`\n  END TO END — ${from} to ${to}`);
    console.log("  nothing below is kept; the transaction is rolled back at the end");

    /* ═══ 1. The cast ═══════════════════════════════════════════════════ */
    heading("The farm");
    const [owner] = await tx
      .select()
      .from(contacts)
      .where(and(eq(contacts.id, sql`(SELECT owner_id FROM houses WHERE owner_id IS NOT NULL LIMIT 1)`)));
    if (!owner) throw new Error("no house has an owner — nothing to bill");
    // Amino buys their eggs, so they must be a vendor as well as a customer.
    if (!["vendor", "both"].includes(owner.type)) {
      await tx.update(contacts).set({ type: "both" }).where(eq(contacts.id, owner.id));
    }

    const theirHouses = await tx.select().from(houses).where(eq(houses.ownerId, owner.id));
    const layer = theirHouses.find((h) => h.purpose === "layer")!;
    const [rearing] = await tx
      .select()
      .from(houses)
      .where(and(eq(houses.purpose, "pullet"), isNull(houses.ownerId)));
    ok("an owner with a layer shed exists", !!layer, `${owner.displayName} · ${layer?.code}`);
    ok("Amino owns a rearing shed", !!rearing, rearing?.code ?? "");
    if (!layer || !rearing) throw new Rollback();

    // A clean slate for the month under test, so what is measured is what this
    // script did rather than whatever the demo data happens to hold.
    const theirIds = theirHouses.map((h) => h.id);
    await tx.delete(ownerBillingRuns).where(eq(ownerBillingRuns.period, from));
    await tx
      .delete(feedTransfers)
      .where(
        and(
          inArray(feedTransfers.toHouseId, theirIds),
          gte(feedTransfers.transferDate, from),
          lte(feedTransfers.transferDate, to),
        ),
      );

    /* ═══ 2. Mill a batch ═══════════════════════════════════════════════ */
    heading("The mill makes feed");
    const prefs = await getPreferences(tx);
    const [formula] = await tx.select().from(formulas).where(eq(formulas.isActive, true)).limit(1);
    if (!formula) throw new Error("no live formula");

    const recipe = await tx
      .select({ itemId: formulaLines.itemId, kg: formulaLines.quantityKg, cost: items.costPrice })
      .from(formulaLines)
      .innerJoin(items, eq(items.id, formulaLines.itemId))
      .where(and(eq(formulaLines.formulaId, formula.id), eq(items.trackInventory, true)));
    await postInventoryMovement(tx, {
      movements: recipe.map((r) => ({
        itemId: r.itemId,
        quantity: (Number(r.kg) * 40).toFixed(3),
        value: (Number(r.kg) * 40 * Number(r.cost ?? 0)).toFixed(2),
      })),
      transactionDate: from,
      sourceType: "e2e_silo_fill",
      contraSystemKey: "inventory_adjustment",
      narration: "Silos filled for the end-to-end run",
      postedBy: userId,
      stockLocationId: await mainStore(tx),
    });

    const order = await produceOne(tx, { formulaId: formula.id, batchCount: 20 }, { orderDate: from }, userId);
    const inputKg = Number(order.plannedOutputKg);
    const outputKg = Number(order.actualOutputKg);
    const millRate = Number(order.costPerKg);
    console.log(`      ${formula.name}: ${num(inputKg)} kg in → ${num(outputKg)} kg out @ ${money(millRate)}/kg`);
    ok(
      "the mill loses the 1% it says it loses",
      near(outputKg, inputKg * Number(prefs.millMoistureRetention), 0.05),
    );
    ok(
      "the overhead is a rupee a kilo",
      near(Number(order.overheadValue), outputKg * Number(prefs.millOverheadPerKg), 0.05),
      money(Number(order.overheadValue)),
    );

    /* ═══ 3. Send it to the owner's shed ════════════════════════════════ */
    heading("Feed goes out to the shed");
    const deliveries = [
      { day: `${PERIOD}-04`, kg: 9_000 },
      { day: `${PERIOD}-14`, kg: 9_500 },
      { day: `${PERIOD}-24`, kg: 8_800 },
    ];
    let deliveredKg = 0;
    let deliveredValue = 0;
    for (const [i, d] of deliveries.entries()) {
      deliveredKg += d.kg;
      deliveredValue += d.kg * millRate;
      await tx.insert(feedTransfers).values({
        number: `E2E-F${i + 1}`,
        transferDate: d.day,
        itemId: formula.outputItemId,
        quantityKg: String(d.kg),
        fromLocationId: layer.locationId,
        toLocationId: layer.locationId,
        toHouseId: layer.id,
        ratePerKg: millRate.toFixed(6),
        value: (d.kg * millRate).toFixed(2),
        status: "completed",
      });
    }
    // One that never happened, to prove a void is not charged.
    await tx.insert(feedTransfers).values({
      number: "E2E-VOID",
      transferDate: `${PERIOD}-15`,
      itemId: formula.outputItemId,
      quantityKg: "7777",
      fromLocationId: layer.locationId,
      toLocationId: layer.locationId,
      toHouseId: layer.id,
      ratePerKg: millRate.toFixed(6),
      value: (7777 * millRate).toFixed(2),
      status: "void",
    });
    // And one to AMINO's own shed, which must reach nobody's invoice.
    await tx.insert(feedTransfers).values({
      number: "E2E-OWN",
      transferDate: `${PERIOD}-05`,
      itemId: formula.outputItemId,
      quantityKg: "6000",
      fromLocationId: rearing.locationId,
      toLocationId: rearing.locationId,
      toHouseId: rearing.id,
      ratePerKg: millRate.toFixed(6),
      value: (6000 * millRate).toFixed(2),
      status: "completed",
    });
    console.log(
      `      ${deliveries.length} deliveries · ${num(deliveredKg)} kg · ${money(deliveredValue)}` +
        `  (plus 7,777 kg voided and 6,000 kg to ${rearing.code})`,
    );

    /* ═══ 4. Rear a flock and house it across the line ══════════════════ */
    heading("A batch is reared and housed");
    const [breed] = await tx.select().from(breeds).limit(1);
    const [stdSet] = await tx
      .select()
      .from(standardSets)
      .where(and(eq(standardSets.breedId, breed!.id), eq(standardSets.isDefault, true)));
    void stdSet;

    // Hatched far enough back that it is of housing age inside the month.
    const hatch = "2026-01-26";
    const { flock, placement } = await createFlock(tx, {
      code: `E2E-${PERIOD}`,
      locationId: rearing.locationId,
      breedId: breed!.id,
      houseId: rearing.id,
      hatches: [{ hatchDate: hatch, qty: 10_000 }],
      userId,
    });
    const housedOn = `${PERIOD}-10`;
    const housedQty = 9_400;
    await setFlockTransfers(
      tx,
      flock.id,
      [{ eventDate: housedOn, fromHouseId: rearing.id, toHouseId: layer.id, qty: housedQty }],
      userId,
    );
    const ageWeek =
      Math.floor((Date.parse(`${housedOn}T00:00:00Z`) - Date.parse(`${hatch}T00:00:00Z`)) / 86_400_000 / 7) + 1;
    const [rate] = await tx
      .select()
      .from(birdValuationRates)
      .where(
        and(
          eq(birdValuationRates.breedId, breed!.id),
          eq(birdValuationRates.ageWeek, ageWeek),
          lte(birdValuationRates.effectiveFrom, housedOn),
        ),
      )
      .orderBy(sql`${birdValuationRates.effectiveFrom} DESC`)
      .limit(1);
    console.log(
      `      ${flock.code}: ${num(housedQty)} birds → ${layer.code} at ${ageWeek} weeks` +
        `${rate ? ` @ ${money(Number(rate.rate))}/bird` : " (NO VALUATION)"}`,
    );
    ok("the valuation curve reaches the housing date", !!rate, rate?.effectiveFrom ?? "none in force");
    void placement;

    /* ═══ 5. The sheds lay ══════════════════════════════════════════════ */
    heading("Eggs are collected");
    const [layerPlacement] = await tx
      .select()
      .from(flockPlacements)
      .where(and(eq(flockPlacements.houseId, layer.id), isNull(flockPlacements.toDate)))
      .orderBy(asc(flockPlacements.fromDate))
      .limit(1);
    let eggsLaid = 0;
    if (layerPlacement) {
      for (let d = 1; d <= 20; d++) {
        const day = `${PERIOD}-${String(d).padStart(2, "0")}`;
        if (day < layerPlacement.fromDate) continue;
        const eggs = 8_000 + d * 7;
        eggsLaid += eggs;
        await saveDay(
          tx,
          { placementId: layerPlacement.id, day, eggsTotal: eggs, feedConsumedKg: "920", losses: [] },
          userId,
        );
      }
    }
    console.log(`      ${num(eggsLaid)} eggs over 20 days in ${layer.code}`);

    /* ═══ 6. Terms ══════════════════════════════════════════════════════ */
    heading("The month's terms");
    const BENCH = 5.4;
    const SPREAD = 0.5;
    await tx
      .insert(eggBenchmarkPrices)
      .values({ effectiveFrom: from, ratePerEgg: BENCH.toFixed(4), source: "e2e", createdBy: userId })
      .onConflictDoUpdate({
        target: eggBenchmarkPrices.effectiveFrom,
        set: { ratePerEgg: BENCH.toFixed(4) },
      });
    await tx
      .insert(ownerAgreements)
      .values({
        contactId: owner.id,
        effectiveFrom: from,
        eggSpreadPerEgg: SPREAD.toFixed(4),
        createdBy: userId,
      })
      .onConflictDoUpdate({
        target: [ownerAgreements.contactId, ownerAgreements.effectiveFrom],
        set: { eggSpreadPerEgg: SPREAD.toFixed(4) },
      });
    console.log(`      eggs at ${BENCH.toFixed(2)} + ${SPREAD.toFixed(2)} = ${money(BENCH + SPREAD)}/egg`);

    /* ═══ 7. The draft ══════════════════════════════════════════════════ */
    heading("The month, drafted");
    const draft = await draftMonth(tx, owner.id, PERIOD);
    console.log(
      `      feed ${money(draft.feedTotal)} · pullets ${money(draft.birdTotal)} · eggs ${money(draft.eggTotal)}`,
    );
    for (const p of draft.problems) console.log(`      ! ${p}`);

    ok("no problems block the month", draft.problems.length === 0);
    ok(
      "the feed billed is the feed delivered",
      near(draft.feedLines.reduce((s, l) => s + l.qty, 0), deliveredKg, 0.5),
      `${num(draft.feedLines.reduce((s, l) => s + l.qty, 0))} kg vs ${num(deliveredKg)} delivered`,
    );
    ok(
      "the voided delivery and Amino's own shed are both absent",
      !near(draft.feedLines.reduce((s, l) => s + l.qty, 0), deliveredKg + 7_777, 0.5) &&
        !near(draft.feedLines.reduce((s, l) => s + l.qty, 0), deliveredKg + 6_000, 0.5),
    );
    ok(
      "one feed line per delivery day",
      draft.feedLines.length === deliveries.length,
      `${draft.feedLines.length} line(s)`,
    );
    ok(
      "the pullets are billed once, at the curve",
      draft.birdLines.length === 1 && near(draft.birdLines[0]?.rate ?? 0, Number(rate?.rate ?? 0), 0.005),
      draft.birdLines[0]?.rate ? money(draft.birdLines[0].rate) : "unpriced",
    );
    ok(
      "the eggs billed are the eggs laid",
      near(draft.eggLines.reduce((s, l) => s + l.qty, 0), eggsLaid, 0.5),
      `${num(draft.eggLines.reduce((s, l) => s + l.qty, 0))} vs ${num(eggsLaid)} laid`,
    );
    ok(
      "eggs price at benchmark plus spread",
      near(draft.eggLines[0]?.rate ?? 0, BENCH + SPREAD, 0.0001),
    );
    ok(
      "feed is charged at exactly what the mill made it for",
      near(draft.feedLines[0]?.rate ?? 0, millRate, 0.0001),
      `${money(draft.feedLines[0]?.rate ?? 0)}/kg vs mill ${money(millRate)}`,
    );

    /* ═══ 8. flock_day agrees ═══════════════════════════════════════════ */
    heading("The rollup agrees with the bill");
    const [rolled] = await tx
      .select({ eggs: sql<string>`coalesce(sum(${flockDay.eggs}), 0)` })
      .from(flockDay)
      .where(
        and(
          eq(flockDay.houseId, layer.id),
          gte(flockDay.day, from),
          lte(flockDay.day, to),
        ),
      );
    ok(
      "flock_day holds the same eggs the bill charges",
      near(Number(rolled?.eggs ?? 0), eggsLaid, 0.5),
      `${num(Number(rolled?.eggs ?? 0))} in flock_day`,
    );

    /* ═══ 9. Raise ══════════════════════════════════════════════════════ */
    heading("The documents are raised");
    const raised = await raiseMonth(tx, owner.id, PERIOD, userId);
    const [feedInv] = await tx.select().from(invoices).where(eq(invoices.id, raised.feedInvoiceId!));
    const [birdInv] = await tx.select().from(invoices).where(eq(invoices.id, raised.birdInvoiceId!));
    const [eggBill] = await tx.select().from(bills).where(eq(bills.id, raised.billId!));
    console.log(`      ${feedInv!.number}  feed     ${money(Number(feedInv!.total))}`);
    console.log(`      ${birdInv!.number}  pullets  ${money(Number(birdInv!.total))}`);
    console.log(`      ${eggBill!.number}  eggs     ${money(Number(eggBill!.total))}`);

    ok("three separate documents", new Set([feedInv!.id, birdInv!.id, eggBill!.id]).size === 3);
    ok("both invoices are posted", feedInv!.status === "sent" && birdInv!.status === "sent");
    ok(
      "all three are dated inside the month",
      [feedInv!.invoiceDate, birdInv!.invoiceDate, eggBill!.billDate].every((d) => d >= from && d <= to),
    );
    ok(
      "the feed invoice totals the feed",
      near(Number(feedInv!.subTotal), draft.feedTotal, 1),
      `${money(Number(feedInv!.subTotal))}`,
    );
    ok(
      "the pullet invoice totals the pullets",
      near(Number(birdInv!.subTotal), draft.birdTotal, 1),
      `${money(Number(birdInv!.subTotal))}`,
    );
    ok("the egg bill totals the eggs", near(Number(eggBill!.subTotal), draft.eggTotal, 1));
    ok(
      "the feed invoice carries only feed lines",
      (await tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, feedInv!.id))).length ===
        draft.feedLines.length,
    );
    ok(
      "the egg bill carries only egg lines",
      (await tx.select().from(billLines).where(eq(billLines.billId, eggBill!.id))).length ===
        draft.eggLines.length,
    );

    /* ═══ 10. The books ═════════════════════════════════════════════════ */
    heading("The ledger");
    for (const [label, jeId] of [
      ["feed invoice", feedInv!.journalEntryId],
      ["pullet invoice", birdInv!.journalEntryId],
      ["egg bill", eggBill!.journalEntryId],
    ] as const) {
      if (!jeId) {
        ok(`the ${label} carries a journal`, false);
        continue;
      }
      const lines = await tx
        .select({ d: journalEntryLines.debit, c: journalEntryLines.credit })
        .from(journalEntryLines)
        .where(eq(journalEntryLines.entryId, jeId));
      const dr = lines.reduce((s, l) => s + Number(l.d ?? 0), 0);
      const cr = lines.reduce((s, l) => s + Number(l.c ?? 0), 0);
      ok(`the ${label} journal balances`, near(dr, cr, 0.005), `${money(dr)} / ${money(cr)}`);
    }

    // The receivable and the payable move by the document totals, and each in
    // the direction the trade went.
    const arMove = await tx.execute(sql`
      SELECT coalesce(sum(l.debit), 0) - coalesce(sum(l.credit), 0) AS net
      FROM journal_entry_lines l
      JOIN journal_entries e ON e.id = l.entry_id
      JOIN accounts a ON a.id = l.account_id
      WHERE a.system_key = 'ar' AND e.source_id IN (${feedInv!.id}, ${birdInv!.id})`);
    const apMove = await tx.execute(sql`
      SELECT coalesce(sum(l.credit), 0) - coalesce(sum(l.debit), 0) AS net
      FROM journal_entry_lines l
      JOIN journal_entries e ON e.id = l.entry_id
      JOIN accounts a ON a.id = l.account_id
      WHERE a.system_key = 'ap' AND e.source_id = ${eggBill!.id}`);
    const ar = Number((arMove.rows[0] as { net: string }).net);
    const ap = Number((apMove.rows[0] as { net: string }).net);
    ok(
      "the receivable rises by both invoices",
      near(ar, Number(feedInv!.total) + Number(birdInv!.total), 0.05),
      `${money(ar)}`,
    );
    ok("the payable rises by the bill", near(ap, Number(eggBill!.total), 0.05), `${money(ap)}`);
    void journalEntries;

    /* ═══ 11. The statements ════════════════════════════════════════════ */
    heading("The statements stapled to them");
    const built = await buildStatements(tx, owner.id, PERIOD);
    ok("a statement per document", !!built.feed && !!built.birds && !!built.eggs);

    for (const [kind, docTotal] of [
      ["feed", Number(feedInv!.subTotal)],
      ["birds", Number(birdInv!.subTotal)],
      ["eggs", Number(eggBill!.subTotal)],
    ] as const) {
      const doc = built[kind];
      if (!doc) continue;
      ok(`the ${kind} statement is a PDF`, doc.pdf.subarray(0, 5).toString() === "%PDF-");
      const text = pdfText(doc.pdf);
      /**
       * The total row is the run "Total" followed by its cells, and the value
       * is the last of them. Read forward from the label until the numbers stop
       * — taking the last run on the page instead picks up the footnote under
       * the table.
       */
      const i = text.findIndex((l) => l === "Total");
      let printed = NaN;
      for (let j = i + 1; j < text.length; j++) {
        const v = parseInr(text[j]!);
        if (!Number.isFinite(v)) break;
        printed = v;
      }
      ok(
        `the ${kind} statement totals what the document charges`,
        near(printed, docTotal, 1),
        `printed ${printed.toLocaleString("en-IN")} vs document ${money(docTotal)}`,
      );
      ok(
        `the ${kind} statement mentions the owner`,
        text.some((l) => l.includes(owner.displayName)),
      );
    }

    // Each statement must show ITS OWN trade and no other.
    const feedText = pdfText(built.feed!.pdf).join(" ");
    const birdText = pdfText(built.birds!.pdf).join(" ");
    const eggText = pdfText(built.eggs!.pdf).join(" ");
    ok("the feed statement is about feed", feedText.includes("Feed supplied"));
    ok("and says nothing about eggs", !feedText.includes("Eggs purchased"));
    ok("the pullet statement is about pullets", birdText.includes("Pullets supplied"));
    ok("and says nothing about feed", !birdText.includes("Feed supplied"));
    ok("the egg statement is about eggs", eggText.includes("Eggs purchased"));
    ok("and says nothing about pullets", !eggText.includes("Pullets supplied"));
    ok(
      "the feed statement lists every delivery day",
      deliveries.every((d) => feedText.includes(d.day.split("-").reverse().join("/"))),
    );

    /* ═══ 12. It cannot happen twice ════════════════════════════════════ */
    heading("The month closes behind itself");
    const after = await draftMonth(tx, owner.id, PERIOD);
    ok("the draft now reads as billed", after.billed !== null);
    ok(
      "and points at all three documents",
      after.billed?.feedInvoiceId === feedInv!.id &&
        after.billed?.birdInvoiceId === birdInv!.id &&
        after.billed?.billId === eggBill!.id,
    );
    try {
      await raiseMonth(tx, owner.id, PERIOD, userId);
      ok("raising the same month again is refused", false, "it was allowed");
    } catch (e) {
      ok("raising the same month again is refused", e instanceof PostingError, (e as Error).message);
    }

    /* ═══ 13. Nothing leaked ════════════════════════════════════════════ */
    heading("Nothing landed where it should not");
    const otherOwners = await tx
      .selectDistinct({ id: houses.ownerId })
      .from(houses)
      .where(and(sql`${houses.ownerId} IS NOT NULL`, ne(houses.ownerId, owner.id)));
    for (const o of otherOwners) {
      if (!o.id) continue;
      const theirs = await draftMonth(tx, o.id, PERIOD);
      ok(
        "another owner is not billed for this one's feed",
        !theirs.feedLines.some((l) => near(l.qty, deliveries[0]!.kg, 0.5)),
      );
      ok("and not billed for these pullets", theirs.birdLines.length === 0);
    }
    const orphaned = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(attachments)
      .where(inArray(attachments.entityId, [feedInv!.id, birdInv!.id, eggBill!.id]));
    // raiseMonth itself attaches nothing — the route does, after committing.
    ok(
      "raiseMonth attaches nothing inside the transaction",
      orphaned[0]!.n === 0,
      "statements are written after the commit, so a rollback leaves no file behind",
    );

    void placementDays;
    throw new Rollback();
  });
} catch (e) {
  if (!(e instanceof Rollback)) {
    console.error(e);
    failures++;
  }
}

console.log(
  failures ? `\n  ${failures} step(s) failed\n` : "\n  the whole chain holds — rolled back, nothing kept\n",
);
process.exit(failures ? 1 : 0);
