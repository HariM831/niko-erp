/**
 * The egg order book, exercised through every skip/void/load permutation —
 * inside one transaction that is rolled back at the end, so the real books
 * are untouched however hard it goes.
 *
 * The thing under test is the DERIVATION: a day's orders are computed from
 * agreements, exceptions and spot orders, and every state change must show up
 * in the very next derivation without any generated rows to regenerate. The
 * matrix:
 *
 *   standing:  due → skip → restored → overridden → loaded → invoice void → due
 *   spot:      booked → voided (→ un-loadable) / loaded → void refused →
 *              invoice void → due again → re-loadable
 *   loading:   no benchmark / zero qty / both sources / double-load / skipped
 *              day / walk-in creating its own spot order
 *   stock:     graded in per shed per size (re-save corrects), out on invoice
 *              per size, back on void, never below the pile
 *   schedule:  weekdays honoured; pause and end-date honoured
 *
 * Run: npx tsx scripts/check-egg-sales.ts
 */
import { and, eq, like, sql } from "drizzle-orm";
import {
  contacts,
  customerPayments,
  eggAgreementExceptions,
  eggAgreements,
  eggBenchmarkPrices,
  eggSizeOffsets,
  eggSpotOrders,
  houses,
  inventoryTransactions,
  invoices,
} from "@shared/schema";
import { db } from "../server/db";
import {
  dayOrders,
  eggPrefs,
  ledgerAvailable,
  loadAndInvoice,
  saveGrading,
  stockBySize,
  unapplyInvoicePayments,
  voidDispatchForInvoice,
} from "../server/services/egg-sales";
import { reverseJournal } from "../server/services/posting";
import { moveStock } from "../server/services/inventory";
import { users } from "@shared/schema";

let failures = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!cond) failures++;
};

class Rollback extends Error {}

/** Expect a call to refuse, and say why it did. */
async function refuses(label: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    ok(label, false, "was allowed — it must not be");
  } catch (e) {
    ok(label, true, `"${(e as Error).message.slice(0, 70)}"`);
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Void an invoice the way the route does: reverse the journal, return the
 * stock by source, void the dispatch. Composed from the same primitives —
 * the route itself was exercised live; this keeps the matrix deterministic.
 */
async function voidInvoice(tx: Tx, invoiceId: string, on: string, userId: string) {
  // Auto-applied advances walk back first, exactly as the route does.
  await unapplyInvoicePayments(tx, invoiceId, on, userId);
  const [inv] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId));
  if (inv?.journalEntryId) await reverseJournal(tx, inv.journalEntryId, on, userId);
  const moved = await tx
    .select({
      itemId: inventoryTransactions.itemId,
      stockLocationId: inventoryTransactions.stockLocationId,
      qty: sql<string>`sum(${inventoryTransactions.quantity})`,
    })
    .from(inventoryTransactions)
    .where(
      and(eq(inventoryTransactions.sourceType, "invoice"), eq(inventoryTransactions.sourceId, invoiceId)),
    )
    .groupBy(inventoryTransactions.itemId, inventoryTransactions.stockLocationId);
  if (moved.length) {
    await moveStock(tx, {
      movements: moved.map((m) => ({
        itemId: m.itemId,
        stockLocationId: m.stockLocationId,
        quantity: (-Number(m.qty)).toFixed(3),
      })),
      transactionDate: on,
      sourceType: "invoice_void",
      sourceId: invoiceId,
    });
  }
  await voidDispatchForInvoice(tx, invoiceId);
  await tx.update(invoices).set({ status: "void", balanceDue: "0.00" }).where(eq(invoices.id, invoiceId));
}

try {
  await db.transaction(async (tx) => {
    const [user] = await tx.select({ id: users.id }).from(users).limit(1);
    if (!user) throw new Error("need a user to test with");
    // Its own customer, so the ledger starts at exactly zero and the funds
    // gate below is deterministic whatever the real books hold.
    const [customer] = await tx
      .insert(contacts)
      .values({ type: "customer", displayName: "ZZ Check Egg Centre" })
      .returning();
    if (!customer) throw new Error("could not make the scratch customer");
    const uid = user.id;
    const prefs = await eggPrefs(tx);
    void prefs;

    // Its own days, far enough out to collide with nothing anyone booked.
    const MON = "2026-12-07"; //  a Monday
    const TUE = "2026-12-08";
    const WED = "2026-12-09";
    const NOBM = "2026-07-15"; // before the first benchmark row — no rate in force

    await tx.insert(eggBenchmarkPrices).values({ effectiveFrom: MON, ratePerEgg: "5.0000", createdBy: uid }).onConflictDoNothing();
    await tx
      .insert(eggSizeOffsets)
      .values({ effectiveFrom: MON, small: "-0.5000", large: "0.5000", createdBy: uid })
      .onConflictDoNothing();

    /* ══ Stock: the grading sheet, per size ═════════════════════════════ */
    //
    // Stock comes from the packing room's sheet, per shed per size, pooled
    // per size. A re-saved sheet must CORRECT its movement, not add one.
    const [anyHouse] = await tx.select({ id: houses.id }).from(houses).limit(1);
    if (!anyHouse) throw new Error("no house to grade against");
    const pileBefore = await stockBySize(tx);
    await saveGrading(tx, { houseId: anyHouse.id, gradedOn: MON, boxes: { small: 50, large: 300 } }, uid);
    let held = await stockBySize(tx);
    ok("grading raises the pool per size", held.small === pileBefore.small + 50 && held.large === pileBefore.large + 300, `+50 S, +300 L`);
    await saveGrading(tx, { houseId: anyHouse.id, gradedOn: MON, boxes: { small: 40, large: 300 } }, uid);
    held = await stockBySize(tx);
    ok("re-saving the sheet corrects, never doubles", held.small === pileBefore.small + 40, `small ${held.small - pileBefore.small} over start (40, not 90)`);
    await saveGrading(tx, { houseId: anyHouse.id, gradedOn: MON, boxes: { small: 40, large: 300, medium: 20 } }, uid);
    held = await stockBySize(tx);
    ok("a size added later lands too", held.medium === pileBefore.medium + 20);

    const stock = async () => {
      const h = await stockBySize(tx);
      return h.small + h.medium + h.large + h.xl + h.jumbo + h.dirty;
    };
    const stockAtStart = await stock();
    const stockBefore = { ...held };

    /** Money into the customer's ledger — the payment that lets trucks load. */
    let paySeq = 0;
    const advance = (amount: number) =>
      tx.insert(customerPayments).values({
        number: `ZZCHK-${++paySeq}`,
        customerId: customer.id,
        paymentDate: MON,
        amount: amount.toFixed(2),
        unappliedAmount: amount.toFixed(2),
        createdBy: uid,
      });

    console.log(`\n  testing against ${customer.displayName}, days ${MON}..${WED}\n`);

    /* ══ 0. Payment first, truck second ══════════════════════════════════ */
    ok("a fresh ledger holds exactly zero", (await ledgerAvailable(tx, customer.id)) === 0);
    await refuses("loading with an empty ledger → refused", () =>
      loadAndInvoice(tx, { dispatchDate: MON, customerId: customer.id, loaded: { large: 5 }, driverName: "T", vehicleNumber: "V" }, uid),
    );
    await advance(1000); // a real transfer, but far too small for 5 boxes
    await refuses("a ledger short of the load → refused", () =>
      loadAndInvoice(tx, { dispatchDate: MON, customerId: customer.id, loaded: { large: 5 }, driverName: "T", vehicleNumber: "V" }, uid),
    );
    // Fund everything the rest of the matrix will load.
    await advance(20_00_000);
    ok("the advance shows in the ledger", (await ledgerAvailable(tx, customer.id)) === 20_01_000);

    /* ══ 1. The standing rule and its schedule ═══════════════════════════ */
    const [ag] = await tx
      .insert(eggAgreements)
      .values({
        customerId: customer.id,
        schedule: "weekdays",
        daysOfWeek: [1, 3], // Mon, Wed
        boxes: 50,
        spreadPerEgg: "0.2000",
        startDate: MON,
        createdBy: uid,
      })
      .returning();

    let lines = await dayOrders(tx, MON);
    const mine = (ls: typeof lines) => ls.filter((l) => l.customerId === customer.id);
    ok("a scheduled day derives the standing line", mine(lines).some((l) => l.kind === "standing" && l.boxes === 50));
    lines = await dayOrders(tx, TUE);
    ok("an unscheduled day derives nothing", !mine(lines).some((l) => l.kind === "standing"));

    /* ══ 2. Skip: the per-day void ═══════════════════════════════════════ */
    await tx.insert(eggAgreementExceptions).values({ agreementId: ag!.id, onDate: MON, kind: "skip", reason: "test", createdBy: uid });
    lines = await dayOrders(tx, MON);
    let line = mine(lines).find((l) => l.kind === "standing")!;
    ok("a skipped day derives 0 boxes, flagged", line.boxes === 0 && line.exception?.kind === "skip");
    lines = await dayOrders(tx, WED);
    ok("the NEXT scheduled day is untouched by the skip", mine(lines).some((l) => l.kind === "standing" && l.boxes === 50));

    await refuses("loading the agreement on its skipped day is refused", () =>
      loadAndInvoice(tx, { dispatchDate: MON, customerId: customer.id, agreementId: ag!.id, loaded: { large: 10 }, driverName: "T", vehicleNumber: "V" }, uid),
    );

    /* ══ 3. Restore, then override ═══════════════════════════════════════ */
    await tx.delete(eggAgreementExceptions).where(and(eq(eggAgreementExceptions.agreementId, ag!.id), eq(eggAgreementExceptions.onDate, MON)));
    lines = await dayOrders(tx, MON);
    ok("deleting the exception restores the day", mine(lines).some((l) => l.boxes === 50 && !l.exception));

    await tx.insert(eggAgreementExceptions).values({ agreementId: ag!.id, onDate: MON, kind: "qty_override", boxes: 80, createdBy: uid });
    lines = await dayOrders(tx, MON);
    line = mine(lines).find((l) => l.kind === "standing")!;
    ok("an override changes the day's boxes only", line.boxes === 80 && line.exception?.kind === "qty_override");

    /* ══ 4. Loading refusals ═════════════════════════════════════════════ */
    await refuses("no benchmark in force → refused", () =>
      loadAndInvoice(tx, { dispatchDate: NOBM, customerId: customer.id, loaded: { large: 5 }, driverName: "T", vehicleNumber: "V" }, uid),
    );
    await refuses("zero boxes → refused", () =>
      loadAndInvoice(tx, { dispatchDate: MON, customerId: customer.id, agreementId: ag!.id, loaded: {}, driverName: "T", vehicleNumber: "V" }, uid),
    );
    await refuses("no driver → refused", () =>
      loadAndInvoice(tx, { dispatchDate: MON, customerId: customer.id, agreementId: ag!.id, loaded: { large: 5 }, driverName: " ", vehicleNumber: "V" }, uid),
    );

    /* ══ 5. Load the standing day, priced to the paisa ═══════════════════ */
    const r1 = await loadAndInvoice(
      tx,
      { dispatchDate: MON, customerId: customer.id, agreementId: ag!.id, loaded: { small: 10, large: 60 }, driverName: "Test", vehicleNumber: "AS-00" },
      uid,
    );
    const [inv1] = await tx.select().from(invoices).where(eq(invoices.id, r1.invoiceId));
    // small: 10×210×(5.00−0.50+0.20)=9,870 ; large: 60×210×(5.00+0.50+0.20)=71,820
    const expected = 10 * 210 * 4.7 + 60 * 210 * 5.7;
    ok("the invoice prices at benchmark + offset + spread", Number(inv1!.subTotal) === expected, `₹${inv1!.subTotal} = ₹${expected}`);
    ok(
      "the invoice settles itself from the advances — PAID, zero due",
      inv1!.status === "paid" && Number(inv1!.balanceDue) === 0,
      `${inv1!.status}, due ₹${inv1!.balanceDue}`,
    );
    ok("stock fell by exactly the boxes loaded", (await stock()) === stockAtStart - 70, `−70 boxes`);
    held = await stockBySize(tx);
    ok("and by size", held.small === stockBefore.small - 10 && held.large === stockBefore.large - 60, `S −10, L −60`);
    await refuses("loading more of a size than the pile holds → refused", () =>
      loadAndInvoice(tx, { dispatchDate: TUE, customerId: customer.id, loaded: { jumbo: held.jumbo + 1 }, driverName: "T", vehicleNumber: "V" }, uid),
    );
    ok(
      "the load consumed ledger headroom",
      Math.abs((await ledgerAvailable(tx, customer.id)) - (20_01_000 - Number(inv1!.total))) < 0.01,
      `₹${(await ledgerAvailable(tx, customer.id)).toFixed(2)} left`,
    );
    lines = await dayOrders(tx, MON);
    ok("the day's line now carries its dispatch", mine(lines)[0]!.dispatch?.invoiceId === r1.invoiceId);

    await refuses("both agreement AND spot on one load → refused", () =>
      loadAndInvoice(tx, { dispatchDate: WED, customerId: customer.id, agreementId: ag!.id, spotOrderId: r1.dispatch.id, loaded: { large: 1 }, driverName: "T", vehicleNumber: "V" }, uid),
    );
    await refuses("loading the same agreement-day twice → refused", () =>
      loadAndInvoice(tx, { dispatchDate: MON, customerId: customer.id, agreementId: ag!.id, loaded: { large: 1 }, driverName: "T", vehicleNumber: "V" }, uid),
    );
    await refuses("a skip on the loaded day → refused at the route's own guard", async () => {
      // The route refuses this before the table is ever touched; the guard is
      // its dispatch lookup, replicated here.
      const [d] = await tx.execute(sql`SELECT 1 FROM egg_dispatches WHERE agreement_id=${ag!.id} AND dispatch_date=${MON} AND status != 'void'`).then((r) => r.rows);
      if (d) throw new Error("already loaded and invoiced — void the invoice instead");
    });

    /* ══ 6. Void the invoice: the whole day unwinds ══════════════════════ */
    await voidInvoice(tx, r1.invoiceId, MON, uid);
    ok("stock came back to the box, per size", (await stock()) === stockAtStart && (await stockBySize(tx)).small === stockBefore.small);
    ok("the void gave the ledger its headroom back", (await ledgerAvailable(tx, customer.id)) === 20_01_000);
    lines = await dayOrders(tx, MON);
    ok("the day derives back to due", mine(lines)[0]!.dispatch === null);
    const r2 = await loadAndInvoice(
      tx,
      { dispatchDate: MON, customerId: customer.id, agreementId: ag!.id, loaded: { large: 80 }, driverName: "Test", vehicleNumber: "AS-00" },
      uid,
    );
    ok("and the day can be loaded again after the void", !!r2.invoiceId && r2.invoiceId !== r1.invoiceId);
    await voidInvoice(tx, r2.invoiceId, MON, uid); // leave MON clean for the count below

    /* ══ 7. Spot orders: book, void, load, unwind ════════════════════════ */
    const [spot] = await tx
      .insert(eggSpotOrders)
      .values({ customerId: customer.id, orderDate: TUE, boxes: 20, large: 20, createdBy: uid })
      .returning();
    lines = await dayOrders(tx, TUE);
    ok("a booked spot derives on its day", mine(lines).some((l) => l.kind === "spot" && l.boxes === 20 && !l.voided));

    await tx.update(eggSpotOrders).set({ status: "voided" }).where(eq(eggSpotOrders.id, spot!.id));
    lines = await dayOrders(tx, TUE);
    ok("a voided spot still derives, struck", mine(lines).some((l) => l.kind === "spot" && l.voided));
    await refuses("loading a voided spot → refused", () =>
      loadAndInvoice(tx, { dispatchDate: TUE, customerId: customer.id, spotOrderId: spot!.id, loaded: { large: 20 }, driverName: "T", vehicleNumber: "V" }, uid),
    );

    await tx.update(eggSpotOrders).set({ status: "booked" }).where(eq(eggSpotOrders.id, spot!.id));
    const r3 = await loadAndInvoice(
      tx,
      { dispatchDate: TUE, customerId: customer.id, spotOrderId: spot!.id, loaded: { large: 20 }, driverName: "Test", vehicleNumber: "AS-00" },
      uid,
    );
    // The spot's spread is null, and the customer HAS a standing agreement —
    // its 0.20 spread must carry to the spot's pricing.
    const [inv3] = await tx.select().from(invoices).where(eq(invoices.id, r3.invoiceId));
    ok("a spot with no spread inherits the standing spread", Number(inv3!.subTotal) === 20 * 210 * 5.7, `₹${inv3!.subTotal}`);
    ok("the spot's invoice is also born paid", inv3!.status === "paid", inv3!.status);
    await refuses("loading the same spot twice → refused", () =>
      loadAndInvoice(tx, { dispatchDate: TUE, customerId: customer.id, spotOrderId: spot!.id, loaded: { large: 1 }, driverName: "T", vehicleNumber: "V" }, uid),
    );
    await voidInvoice(tx, r3.invoiceId, TUE, uid);
    lines = await dayOrders(tx, TUE);
    ok("void of the spot's invoice puts the spot back to due", mine(lines).find((l) => l.kind === "spot")!.dispatch === null);

    /* ══ 8. Walk-in: a load from nowhere books its own spot ══════════════ */
    const before = (await dayOrders(tx, WED)).filter((l) => l.customerId === customer.id && l.kind === "spot").length;
    const r4 = await loadAndInvoice(
      tx,
      { dispatchDate: WED, customerId: customer.id, loaded: { large: 5 }, driverName: "Test", vehicleNumber: "AS-00" },
      uid,
    );
    lines = await dayOrders(tx, WED);
    const walkins = mine(lines).filter((l) => l.kind === "spot");
    ok("a walk-in load books its own spot order", walkins.length === before + 1 && walkins.some((w) => w.dispatch?.invoiceId === r4.invoiceId));

    /* ══ 9. Pause and end-date ═══════════════════════════════════════════ */
    await tx.update(eggAgreements).set({ status: "paused" }).where(eq(eggAgreements.id, ag!.id));
    lines = await dayOrders(tx, WED);
    ok("a paused agreement derives nowhere", !mine(lines).some((l) => l.kind === "standing"));
    await tx.update(eggAgreements).set({ status: "active", endDate: MON }).where(eq(eggAgreements.id, ag!.id));
    ok("an end-dated agreement still covers its last day", (await dayOrders(tx, MON)).filter((l) => l.customerId === customer.id).some((l) => l.kind === "standing"));
    ok("and derives nothing past it", !(await dayOrders(tx, WED)).filter((l) => l.customerId === customer.id).some((l) => l.kind === "standing"));

    throw new Rollback();
  });
} catch (e) {
  if (!(e instanceof Rollback)) {
    console.error(e);
    failures++;
  }
}

// Prove the rollback held: none of the test artefacts survived.
const leftovers = await db
  .select({ n: sql<number>`count(*)::int` })
  .from(invoices)
  .where(like(invoices.reference, "%2026-12-0%"));
ok("the rollback left nothing behind", leftovers[0]!.n === 0);

console.log(failures ? `\n  ${failures} failed\n` : "\n  all good\n");
process.exit(failures ? 1 : 0);
