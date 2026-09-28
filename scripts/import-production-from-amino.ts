/**
 * Bring the mill's production across from Amino, and derive the feed
 * transfers from the houses' own daily sheet — so niko's feed stock and feed
 * cost are right from 13 Sep 2026, the day the farm became niko's, even
 * though the mill stayed on Amino until the 28th.
 *
 * The file comes from `scripts/export-production-for-niko.ts` in the Amino
 * repo, run on Replit. Dry by default: it does everything inside one
 * transaction, reports, and rolls back. `--apply` commits.
 *
 * What it does, in date order:
 *
 *   Bills       a tracked material's bill line that never moved stock (the
 *               item was made tracked after the bill was keyed) gets its
 *               stock movement now, and its journal is reclassed from the
 *               expense to Feed Stock, so the delivery is on the pile.
 *   Opening     each material's stock on the day before niko took over,
 *               worked back from Amino: its stock now + what the slips
 *               consumed − what arrived since; valued at Amino's latest lot
 *               price. And each finished feed's opening, the least that lets
 *               every day's transfers go out before that day's milling.
 *               Both posted as one inventory adjustment against 5007, dated
 *               --opening (default the day before --from).
 *   Production  every confirmed slip, as a production order on the day it
 *               was made, through produceOne — niko's live formula, Amino's
 *               batch count, costed at niko's ledger. A slip already brought
 *               across (its id is in an order's notes) is left alone.
 *   Transfers   one per house per day from the daily sheet's feed consumed,
 *               through transferOne, on the feed each house is on (Amino's
 *               own transfers say which). A day that already has a transfer
 *               for that house is left alone.
 *
 *   npx tsx scripts/import-production-from-amino.ts --file production-for-niko.json
 *   npx tsx scripts/import-production-from-amino.ts --file production-for-niko.json --apply
 */
import { readFile } from "node:fs/promises";
import { and, asc, eq, gte, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import {
  accounts,
  billLines,
  bills,
  feedTransfers,
  flockDay,
  formulaLines,
  formulas,
  houses,
  inventoryAdjustmentLines,
  inventoryAdjustments,
  inventoryTransactions,
  items,
  journalEntryLines,
  placementDays,
  productionOrders,
  roles,
  users,
} from "@shared/schema";
import { db, type Tx } from "../server/db";
import { nextDocumentNumber } from "../server/lib/numbering";
import { mainStore, moveStock, postInventoryMovement } from "../server/services/inventory";
import { postJournal } from "../server/services/posting";
import { getPreferences } from "../server/services/preferences";
import { produceOne, transferOne } from "../server/routes/feed-production";

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : undefined; };
const APPLY = process.argv.includes("--apply");
const FILE = arg("file") ?? "production-for-niko.json";
const FROM = arg("from") ?? "2026-09-13";
const OPENING = arg("opening") ?? new Date(new Date(`${FROM}T00:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10);
const say = (s: string) => console.log(s);
const kg = (n: number) => `${Math.round(n).toLocaleString("en-IN")} kg`;
const rs = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

/** Amino's material names → niko's items. Names, not ids: the two systems never shared one. */
const MATERIAL: Record<string, string> = {
  "Cantaxanthin": "Cantaxanthin",
  "DCP (Di-Calcium Phosphate)": "Dicalcium Phosphate",
  "DDGS Rice": "DDGS (Rice)",
  "DL-Methionine": "DL-Methionine",
  "DOGN": "DOGN (De-Oiled Ground Nut)",
  "De-Oiled Rice Bran (DORB - 16)": "DORB (De-Oiled Rice Bran)",
  "Lime Stone Grit": "Lime Stone Grits",
  "Maize": "Maize",
  "MixiBlend P": "Mixiblend P Layer Premix (4Kg)",
  "Salt": "Salt",
  "Soda Bicarb": "Sodium Bicarbonate",
  "Soybean Meal": "Soybean Meal",
  "Soya Hipro": "Soya Hipro (DOC)",
  "L-Lysine": "L-Lysine",
};

type Row = Record<string, any>;
class Rollback extends Error {}

const raw = JSON.parse(await readFile(FILE, "utf8")) as { exportedAt: string; since: string; data: Record<string, Row[]> };
const D = raw.data;
say(`\n  IMPORT PRODUCTION FROM AMINO — export of ${raw.exportedAt}; from ${FROM}, opening on ${OPENING}${APPLY ? "" : " (dry run)"}\n`);

try {
  await db.transaction(async (tx) => {
    const [admin] = await tx.select({ id: users.id }).from(users).innerJoin(roles, eq(roles.id, users.roleId)).where(eq(roles.name, "Admin")).orderBy(asc(users.createdAt)).limit(1);
    if (!admin) throw new Error("no Admin user to post as");
    const userId = admin.id;
    const [feedExpense] = await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.code, "5007"));
    const [feedStock] = await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.code, "1073"));
    if (!feedExpense || !feedStock) throw new Error("accounts 5007 and 1073 are needed");
    const store = await mainStore(tx);

    /* ── names to ids ── */
    const nikoItems = await tx.select({ id: items.id, name: items.name, tracked: items.trackInventory, unit: items.unit, bag: items.unitBagWeightKg }).from(items);
    const itemByName = new Map(nikoItems.map((i) => [i.name, i]));
    const material = (aminoName: string) => { const n = MATERIAL[aminoName]; const it = n ? itemByName.get(n) : undefined; if (!it) throw new Error(`no niko item for Amino material "${aminoName}"`); return it; };
    const live = await tx.select().from(formulas).where(eq(formulas.isActive, true));
    const formulaByName = new Map(live.map((f) => [f.name, f]));
    const outputOf = (name: string) => { const f = formulaByName.get(name); if (!f?.outputItemId) throw new Error(`no live niko formula with an output item for "${name}"`); return f; };
    // What niko's mill will actually yield from a slip: the recipe's input per
    // batch times the moisture retention, as produceOne computes it — not
    // Amino's total_output, which is a whole 1% more. Four days of that gap
    // left Layer 2 975 kg short on the first dry run.
    const retention = Number((await getPreferences(tx)).millMoistureRetention);
    const inputPerBatch = new Map<string, number>();
    for (const r of await tx.select({ formulaId: formulaLines.formulaId, kg: sql<number>`sum(${formulaLines.quantityKg})::float` }).from(formulaLines).where(inArray(formulaLines.formulaId, live.map((f) => f.id))).groupBy(formulaLines.formulaId)) inputPerBatch.set(r.formulaId, Number(r.kg));
    const nikoYield = (name: string, batches: number) => (inputPerBatch.get(outputOf(name).id) ?? 0) * batches * retention;

    /* ── 1. bills that never moved stock ── */
    const unmoved = await tx
      .select({ billId: bills.id, number: bills.number, date: bills.billDate, jeId: bills.journalEntryId, itemId: billLines.itemId, name: items.name, qty: billLines.quantity, amount: billLines.amount, unit: billLines.unit })
      .from(billLines).innerJoin(bills, eq(bills.id, billLines.billId)).innerJoin(items, eq(items.id, billLines.itemId))
      .where(and(gte(bills.billDate, FROM), eq(items.trackInventory, true), ne(bills.status, "void"), sql`NOT EXISTS (SELECT 1 FROM inventory_transactions t WHERE t.source_type = 'bill' AND t.source_id = ${bills.id} AND t.item_id = ${billLines.itemId})`));
    say(`  bills            ${unmoved.length} tracked line(s) since ${FROM} never moved stock`);
    for (const u of unmoved) {
      const value = Number(u.amount);
      const qtyUnits = u.unit === "kg" || !itemByName.get(u.name)?.bag ? Number(u.qty) : Number(u.qty); // bills are in the item's own unit already
      await moveStock(tx, { movements: [{ itemId: u.itemId!, quantity: qtyUnits.toFixed(3), value: value.toFixed(2) }], transactionDate: u.date, sourceType: "bill", sourceId: u.billId, stockLocationId: store });
      // Where did the bill's journal put the value? If on the expense, move it to Feed Stock.
      const debited = u.jeId ? await tx.select({ accountId: journalEntryLines.accountId, debit: journalEntryLines.debit }).from(journalEntryLines).where(and(eq(journalEntryLines.entryId, u.jeId), eq(journalEntryLines.accountId, feedExpense.id))) : [];
      const onExpense = debited.reduce((s, l) => s + Number(l.debit), 0);
      if (onExpense >= value - 0.005) {
        await postJournal(tx, { entryDate: u.date, narration: `Stock for bill ${u.number} — ${u.name} keyed before the item tracked inventory`, sourceType: "bill", sourceId: u.billId, postedBy: userId, lines: [{ accountId: feedStock.id, debit: value.toFixed(2) }, { accountId: feedExpense.id, credit: value.toFixed(2) }] });
        say(`    ${u.number} ${u.date}: ${u.name} ${kg(Number(u.qty))} ${rs(value)} into stock, reclassed 5007 → 1073`);
      } else say(`    ${u.number} ${u.date}: ${u.name} ${kg(Number(u.qty))} ${rs(value)} into stock (journal already on 1073)`);
    }

    /* ── 2. opening raw-material stock, worked back from Amino ── */
    const consumed = new Map<string, number>(); const lastPrice = new Map<string, { price: number; at: string }>();
    for (const l of D.lot_consumption ?? []) { consumed.set(l.material_name, (consumed.get(l.material_name) ?? 0) + Number(l.quantity_consumed)); const p = lastPrice.get(l.material_name); if (!p || String(l.consumed_at) > p.at) lastPrice.set(l.material_name, { price: Number(l.price_per_kg), at: String(l.consumed_at) }); }
    const delivered = new Map<string, number>();
    const haveDeliveries = Array.isArray(D.deliveries);
    for (const d of D.deliveries ?? []) delivered.set(d.material_name, (delivered.get(d.material_name) ?? 0) + Number(d.net_quantity ?? d.quantity));
    if (!haveDeliveries) say(`  ! the export carries no deliveries: opening stock uses niko's own bills since ${FROM} as the deliveries — re-export with the newer script to be sure`);
    const nikoIn = new Map<string, number>();
    for (const r of await tx.select({ itemId: inventoryTransactions.itemId, qty: sql<number>`sum(${inventoryTransactions.quantity})::float` }).from(inventoryTransactions).where(and(eq(inventoryTransactions.sourceType, "bill"), gte(inventoryTransactions.transactionDate, FROM))).groupBy(inventoryTransactions.itemId)) nikoIn.set(r.itemId, Number(r.qty));
    const openingLines: Array<{ itemId: string; name: string; qty: number; value: number; note: string }> = [];
    say(`\n  opening raw stock on ${OPENING} (Amino now + consumed − delivered) — material | Amino now | consumed | delivered | opening | niko holds at ${OPENING} | adjustment | ₹/kg`);
    for (const m of D.materials ?? []) {
      if (!consumed.has(m.name)) continue;
      const it = material(m.name);
      const perUnit = it.unit === "kg" ? 1 : Number(it.bag ?? 0); // a pack item's stock is in packs
      const nowA = Number(m.current_stock ?? 0), cons = consumed.get(m.name) ?? 0;
      const deliv = haveDeliveries ? (delivered.get(m.name) ?? 0) : (nikoIn.get(it.id) ?? 0) * (perUnit || 1);
      const openingKg = nowA + cons - deliv;
      const [held] = await tx.select({ qty: sql<number>`coalesce(sum(${inventoryTransactions.quantity}),0)::float` }).from(inventoryTransactions).where(and(eq(inventoryTransactions.itemId, it.id), lte(inventoryTransactions.transactionDate, OPENING)));
      const heldKg = Number(held?.qty ?? 0) * (perUnit || 1);
      const adjKg = openingKg - heldKg;
      const price = lastPrice.get(m.name)?.price ?? 0;
      const adjUnits = perUnit ? adjKg / perUnit : adjKg;
      say(`    ${m.name.padEnd(34)} ${kg(nowA).padStart(12)} ${kg(cons).padStart(12)} ${kg(deliv).padStart(12)} ${kg(openingKg).padStart(12)} ${kg(heldKg).padStart(12)} ${kg(adjKg).padStart(12)}  ${price.toFixed(2)}`);
      if (Math.abs(adjUnits) >= 0.001) openingLines.push({ itemId: it.id, name: it.name, qty: adjUnits, value: adjKg * price, note: `Amino ${kg(nowA)} now + ${kg(cons)} consumed − ${kg(deliv)} delivered since ${FROM}; at ₹${price.toFixed(2)}/kg (Amino's latest lot)` });
    }

    /* ── 3. opening finished feed: the least that lets each day's transfers out ── */
    const slips = (D.slips ?? []).filter((s) => s.status === "confirmed" && String(s.made_on) >= FROM).sort((a, b) => String(a.made_on).localeCompare(String(b.made_on)));
    const houseRows = await tx.select({ id: houses.id, code: houses.code }).from(houses);
    const houseByCode = new Map(houseRows.map((h) => [h.code, h.id]));
    // which feed each house is on: Amino's most recent transfer to it
    const feedOfHouse = new Map<string, string>();
    for (const t of [...(D.transfers ?? [])].sort((a, b) => String(a.date).localeCompare(String(b.date)))) feedOfHouse.set(String(t.shed_name), String(t.formula_name));
    const sheet = await tx
      .select({ code: houses.code, day: placementDays.day, kg: placementDays.feedConsumedKg })
      .from(placementDays).innerJoin(flockDay, and(eq(flockDay.placementId, placementDays.placementId), eq(flockDay.day, placementDays.day))).innerJoin(houses, eq(houses.id, flockDay.houseId))
      .where(and(gte(placementDays.day, FROM), sql`${placementDays.feedConsumedKg} > 0`)).orderBy(asc(placementDays.day), asc(houses.code));
    const existing = await tx.select({ houseId: feedTransfers.toHouseId, day: feedTransfers.transferDate }).from(feedTransfers).where(and(gte(feedTransfers.transferDate, FROM), ne(feedTransfers.status, "void")));
    const existingKey = new Set(existing.map((e) => `${e.houseId}|${e.day}`));
    const plannedTransfers = sheet.filter((r) => !existingKey.has(`${houseByCode.get(r.code)}|${r.day}`)).map((r) => ({ code: r.code, day: String(r.day), kg: Number(r.kg), feed: feedOfHouse.get(r.code) ?? "" }));
    const missingFeed = plannedTransfers.filter((t) => !t.feed);
    if (missingFeed.length) throw new Error(`no feed known for ${[...new Set(missingFeed.map((t) => t.code))].join(", ")}: Amino's transfers name none`);
    const prefsOverhead = 1.0;
    const feedOpening = new Map<string, { kg: number; rate: number }>();
    for (const name of new Set([...plannedTransfers.map((t) => t.feed), ...slips.map((s) => String(s.formula_name))])) {
      const days = [...new Set([...plannedTransfers.filter((t) => t.feed === name).map((t) => t.day), ...slips.filter((s) => s.formula_name === name).map((s) => String(s.made_on))])].sort();
      let stock = 0, lowest = 0;
      for (const day of days) { stock += slips.filter((s) => s.formula_name === name && s.made_on === day).reduce((a, s) => a + nikoYield(name, Number(s.batch_count)), 0); stock -= plannedTransfers.filter((t) => t.feed === name && t.day === day).reduce((a, t) => a + t.kg, 0); lowest = Math.min(lowest, stock); }
      const first = slips.find((s) => s.formula_name === name);
      const lots = (D.lot_consumption ?? []).filter((l) => l.production_slip_id === first?.id);
      const rate = first ? lots.reduce((a, l) => a + Number(l.quantity_consumed) * Number(l.price_per_kg), 0) / Number(first.total_output) + prefsOverhead : 0;
      // Rounded up to the kilo: the transfers are written to the gram and a
      // float sum that lands a gram short refuses the day.
      feedOpening.set(name, { kg: Math.ceil(-lowest), rate });
    }
    say(`\n  opening finished feed on ${OPENING} — feed | needed so no day runs short | ₹/kg (first slip's lots + ₹${prefsOverhead.toFixed(2)} overhead)`);
    for (const [name, o] of feedOpening) { say(`    ${name.padEnd(12)} ${kg(o.kg).padStart(12)}  ${o.rate.toFixed(2)}`); if (o.kg > 0) { const f = outputOf(name); openingLines.push({ itemId: f.outputItemId!, name: `${name} Feed`, qty: o.kg, value: o.kg * o.rate, note: `Finished feed on hand at the takeover: the least that lets every day's transfers out before that day's milling` }); } }

    if (openingLines.length) {
      const number = await nextDocumentNumber(tx, "inventory_adjustment");
      const [adj] = await tx.insert(inventoryAdjustments).values({ number, adjustmentDate: OPENING, mode: "quantity", reason: "Opening stock at the mill's takeover by niko", description: `Worked back from Amino's export of ${raw.exportedAt}`, adjustmentAccountId: feedExpense.id, createdBy: userId }).returning();
      await tx.insert(inventoryAdjustmentLines).values(openingLines.map((l, i) => ({ adjustmentId: adj!.id, itemId: l.itemId, quantityChange: l.qty.toFixed(3), valueChange: l.value.toFixed(2), notes: l.note, lineOrder: i })));
      const jeId = await postInventoryMovement(tx, { movements: openingLines.map((l) => ({ itemId: l.itemId, quantity: l.qty.toFixed(3), value: l.value.toFixed(2), notes: l.note })), transactionDate: OPENING, sourceType: "inventory_adjustment", sourceId: adj!.id, stockLocationId: store, contraAccountId: feedExpense.id, narration: `Inventory adjustment ${number} — opening stock at the mill's takeover by niko`, postedBy: userId, preventNegative: false });
      if (jeId) await tx.update(inventoryAdjustments).set({ journalEntryId: jeId }).where(eq(inventoryAdjustments.id, adj!.id));
      say(`  adjustment ${number} on ${OPENING}: ${openingLines.length} line(s), ${rs(openingLines.reduce((a, l) => a + l.value, 0))} against 5007`);
    }

    /* ── 4. production and transfers, day by day ── */
    const already = new Set((await tx.select({ notes: productionOrders.notes }).from(productionOrders).where(sql`${productionOrders.notes} LIKE 'Amino slip %'`)).map((r) => String(r.notes).split(" ")[2]));
    const days = [...new Set([...slips.map((s) => String(s.made_on)), ...plannedTransfers.map((t) => t.day)])].sort();
    let produced = 0, producedKg = 0, transferred = 0, transferredKg = 0, skipped = 0;
    const consumedNiko = new Map<string, number>();
    say(`\n  day | milled (kg by formula) | sent (kg by house)`);
    for (const day of days) {
      const made: string[] = [], sent: string[] = [];
      for (const s of slips.filter((s) => s.made_on === day)) {
        if (already.has(String(s.id))) { skipped++; continue; }
        const f = outputOf(String(s.formula_name));
        const batchKg = Number(f.batchSizeKg) * Number(s.batch_count);
        if (Math.abs(batchKg - Number(s.total_output)) / Number(s.total_output) > 0.005) say(`    ! ${day} ${s.formula_name}: Amino ${kg(Number(s.total_output))} for ${s.batch_count} batches, niko's batch gives ${kg(batchKg)}`);
        const order = await produceOne(tx, { formulaId: f.id, batchCount: Number(s.batch_count) }, { orderDate: day, notes: `Amino slip ${s.id} — ${s.formula_name}, ${s.batch_count} batch(es), ${kg(Number(s.total_output))}, confirmed ${String(s.confirmed_at ?? s.generated_at).slice(0, 16)}Z` }, userId);
        produced++; producedKg += Number(order.actualOutputKg); made.push(`${s.formula_name} ${kg(Number(order.actualOutputKg))} @₹${Number(order.costPerKg).toFixed(2)}`);
      }
      for (const t of plannedTransfers.filter((t) => t.day === day)) {
        const f = outputOf(t.feed);
        await transferOne(tx, { itemId: f.outputItemId!, quantityKg: t.kg.toFixed(3), toHouseId: houseByCode.get(t.code)!, transferDate: day, notes: `From the house's daily sheet: feed consumed on ${day}` }, userId);
        transferred++; transferredKg += t.kg; sent.push(`${t.code} ${kg(t.kg)} ${t.feed}`);
      }
      say(`    ${day} | ${made.join(", ") || "—"} | ${sent.join(", ") || "—"}`);
    }
    for (const r of await tx.select({ name: items.name, qty: sql<number>`-sum(${inventoryTransactions.quantity})::float` }).from(inventoryTransactions).innerJoin(items, eq(items.id, inventoryTransactions.itemId)).where(and(eq(inventoryTransactions.sourceType, "feed_mill"), gte(inventoryTransactions.transactionDate, FROM), sql`${inventoryTransactions.quantity} < 0`)).groupBy(items.name)) consumedNiko.set(r.name, Number(r.qty));

    /* ── 5. the state after ── */
    say(`\n  production       ${produced} order(s), ${kg(producedKg)}${skipped ? `; ${skipped} slip(s) already across` : ""}`);
    say(`  transfers        ${transferred} from the daily sheet, ${kg(transferredKg)}; Amino's own in the window: ${(D.transfers ?? []).length}, ${kg((D.transfers ?? []).reduce((a, t) => a + Number(t.quantity_kg), 0))}`);
    say(`\n  materials consumed — niko vs Amino's lots`);
    for (const [aminoName, cons] of consumed) { const it = material(aminoName); const perUnit = it.unit === "kg" ? 1 : Number(it.bag ?? 1); const n = (consumedNiko.get(it.name) ?? 0) * perUnit; say(`    ${it.name.padEnd(34)} niko ${kg(n).padStart(12)}   Amino ${kg(cons).padStart(12)}   ${cons ? ((n / cons - 1) * 100).toFixed(1) : "—"}%`); }
    say(`\n  stock after the last day — item | niko | Amino now`);
    const levels = await tx.select({ name: items.name, unit: items.unit, bag: items.unitBagWeightKg, qty: sql<number>`coalesce(sum(${inventoryTransactions.quantity}),0)::float`, value: sql<number>`coalesce(sum(${inventoryTransactions.value}),0)::float` }).from(inventoryTransactions).innerJoin(items, eq(items.id, inventoryTransactions.itemId)).groupBy(items.name, items.unit, items.bag).orderBy(items.name);
    const aminoNow = new Map((D.materials ?? []).map((m) => [MATERIAL[m.name] ?? m.name, Number(m.current_stock ?? 0)]));
    for (const l of levels) { const perUnit = l.unit === "kg" ? 1 : Number(l.bag ?? 1); const q = Number(l.qty) * perUnit; if (Math.abs(q) < 1 && !aminoNow.has(l.name)) continue; say(`    ${l.name.padEnd(34)} ${kg(q).padStart(12)} ${rs(Number(l.value)).padStart(14)}   ${aminoNow.has(l.name) ? kg(aminoNow.get(l.name)!).padStart(12) : ""}`); }

    if (!APPLY) throw new Rollback();
  });
  say(`\n  ${APPLY ? "Applied." : "Dry run — nothing written. Re-run with --apply."}\n`);
} catch (e) {
  if (e instanceof Rollback) say(`\n  Dry run — nothing written. Re-run with --apply.\n`);
  else {
    console.error(`\n  FAILED: ${e instanceof Error ? e.message : e}\n`);
    if (process.argv.includes("--stack") && e instanceof Error) console.error(e.stack);
    process.exit(1);
  }
}
process.exit(0);
