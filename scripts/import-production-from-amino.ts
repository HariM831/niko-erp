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
 *   Receipts    a gate receipt settled before settlement moved stock (26 Sep
 *               2026) has a bill and no movement; it gets one now at the net
 *               kilos the weighbridge allocated, and its journal is reclassed
 *               from the expense to Feed Stock. Any other tracked bill line
 *               without a movement is only listed — a hand-keyed bill for a
 *               load whose receipt is still open is billed again when the
 *               office settles it.
 *   Opening     each raw material's stock on --opening (the day before
 *               --from), worked back from the count at the cutover: the
 *               mill's stock sheet (--count, a JSON of it) for everything the
 *               sheet can count, Amino's own figure for the bulk materials
 *               in silos (--major). Opening = count + what niko's recipes
 *               consume in the window − what the gate received up to the
 *               cutover, accepted lines at their net kilos, settled or not,
 *               because the office settles each one into stock later and the
 *               ledger must land on the count once it has. Valued at Amino's
 *               latest lot price. And each finished feed's opening, the least
 *               that lets every day's transfers go out before that day's
 *               milling. All posted as one inventory adjustment against 5007.
 *   Formula     a material niko's recipe carries that a slip drew none of,
 *   changes     while other slips of the same formula did, is a candidate
 *               for having been left out of that batch; named in --without
 *               it is left out here too (24–26 Sep 2026: no Cantaxanthin;
 *               23–26 Sep: no Sodium Bicarbonate), unnamed it is consumed
 *               as the recipe says and the run says so (21 Sep: soybean
 *               meal, two trucks at the gate that morning and no lot keyed).
 *   Short       a load unloaded but not yet settled is not in the ledger, so
 *               milling from it takes the material below zero until the
 *               office settles the receipt; a dry run shows how far, an
 *               apply refuses unless --allow-short.
 *   Production  every confirmed slip, as a production order on the day it
 *               was made, through produceOne — niko's live formula, Amino's
 *               batch count, costed at niko's ledger. A slip already brought
 *               across (its id is in an order's notes) is left alone.
 *   Transfers   one per house per day from the daily sheet's feed consumed,
 *               through transferOne, on the feed each house is on (Amino's
 *               own transfers say which). A day that already has a transfer
 *               for that house is left alone.
 *
 *   npx tsx scripts/import-production-from-amino.ts --file production-for-niko.json --count feed-stock.json
 *   npx tsx scripts/import-production-from-amino.ts --file production-for-niko.json --count feed-stock.json --apply
 *
 * --cutover defaults to the count's own date (asOn): the gate receipts that
 * arrived up to and including it are in the count. --major defaults to the
 * five bulk materials. A count row whose item is null names something niko
 * has no item for and is only listed.
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
  officeReceiptLines,
  officeReceipts,
  placementDays,
  productionOrders,
  roles,
  users,
} from "@shared/schema";
import { db, type Tx } from "../server/db";
import { nextDocumentNumber } from "../server/lib/numbering";
import { mainStore, moveStock, postInventoryMovement, stockUnitsPerKg } from "../server/services/inventory";
import { postJournal } from "../server/services/posting";
import { getPreferences } from "../server/services/preferences";
import { produceOne, transferOne } from "../server/routes/feed-production";

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : undefined; };
const APPLY = process.argv.includes("--apply");
const FILE = arg("file") ?? "production-for-niko.json";
const FROM = arg("from") ?? "2026-09-13";
const OPENING = arg("opening") ?? new Date(new Date(`${FROM}T00:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10);
const COUNT_FILE = arg("count");
/**
 * --allow-short: apply even while gate lines up to the cutover are unsettled.
 * A load unloaded at the mill but not yet settled is not in the ledger, so a
 * batch made from it takes the material below zero until the office settles
 * the receipt. A dry run always allows it and says how far below; an apply
 * refuses unless told.
 */
const ALLOW_SHORT = process.argv.includes("--allow-short");
/**
 * --without "Cantaxanthin:2026-09-24..2026-09-26,Sodium Bicarbonate:2026-09-23..2026-09-26"
 * The materials the mill really ran without, and when. A slip that drew
 * none of a recipe material is only a candidate: Amino also draws nothing
 * when it simply has no lot keyed yet (soybean meal on 21 Sep 2026, two
 * trucks at the gate that morning). Named here, the material is left out of
 * the slip; unnamed, it is consumed as the recipe says and the run says so.
 */
const WITHOUT = (arg("without") ?? "").split(",").map((x) => x.trim()).filter(Boolean).map((x) => { const m = /^(.+?):(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(x); if (!m) throw new Error(`--without entry "${x}" is not "Item:YYYY-MM-DD..YYYY-MM-DD"`); return { name: m[1]!, from: m[2]!, to: m[3]! }; });
const MAJOR = new Set((arg("major") ?? "Maize,Lime Stone Grits,DDGS (Rice),DORB (De-Oiled Rice Bran),Soybean Meal").split(",").map((x) => x.trim()));
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
    const nikoItems = await tx.select({ id: items.id, name: items.name, tracked: items.trackInventory, unit: items.unit, bag: items.unitBagWeightKg, costPrice: items.costPrice }).from(items);
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

    /* ── the slips, and what each one actually drew ── */
    const slips = (D.slips ?? []).filter((s) => s.status === "confirmed" && String(s.made_on) >= FROM).sort((a, b) => String(a.made_on).localeCompare(String(b.made_on)));
    const lotsOf = (slipId: unknown) => (D.lot_consumption ?? []).filter((l) => l.production_slip_id === slipId);
    const recipeLines = await tx.select({ formulaId: formulaLines.formulaId, itemId: formulaLines.itemId, name: items.name, unit: items.unit, bag: items.unitBagWeightKg, kg: formulaLines.quantityKg }).from(formulaLines).innerJoin(items, eq(items.id, formulaLines.itemId)).where(inArray(formulaLines.formulaId, live.map((f) => f.id)));
    const aminoNameOf = new Map(Object.entries(MATERIAL).map(([a, n]) => [n, a]));
    // A material the recipe carries that this slip drew none of, while other
    // slips of the same formula did, was left out of that batch: the formula
    // was changed for a while (24–26 Sep 2026, no Cantaxanthin: Amino had
    // none and the mill ran without it). Left out here too.
    const everDrew = new Map<string, Set<string>>();
    for (const s of slips) { const set = everDrew.get(String(s.formula_name)) ?? new Set<string>(); for (const l of lotsOf(s.id)) set.add(String(l.material_name)); everDrew.set(String(s.formula_name), set); }
    const omitted = new Map<unknown, Array<{ itemId: string; name: string; kg: number }>>();
    const unconfirmed: string[] = [];
    for (const s of slips) {
      const f = outputOf(String(s.formula_name)); const drew = new Set(lotsOf(s.id).map((l) => String(l.material_name)));
      const candidates = recipeLines.filter((r) => r.formulaId === f.id).filter((r) => { const a = aminoNameOf.get(r.name); return a && !drew.has(a) && everDrew.get(String(s.formula_name))?.has(a); });
      const omit = candidates.filter((r) => WITHOUT.some((w) => w.name === r.name && w.from <= String(s.made_on) && String(s.made_on) <= w.to)).map((r) => ({ itemId: r.itemId, name: r.name, kg: Number(r.kg) }));
      if (omit.length) omitted.set(s.id, omit);
      for (const r of candidates) if (!omit.some((o) => o.itemId === r.itemId)) unconfirmed.push(`${s.made_on} ${s.formula_name} ${s.batch_count} batch(es): drew no ${r.name} on Amino, consumed here as the recipe says (${kg(Number(r.kg) * Number(s.batch_count))}) — name it in --without if the mill really ran without it`);
    }
    for (const u of unconfirmed) say(`  ! ${u}`);
    const yieldOf = (s: (typeof slips)[number]) => ((inputPerBatch.get(outputOf(String(s.formula_name)).id) ?? 0) - (omitted.get(s.id) ?? []).reduce((a, o) => a + o.kg, 0)) * Number(s.batch_count) * retention;
    // What niko's recipes will take out, per item in kilos — the figure the opening is worked back from.
    const planned = new Map<string, number>();
    const takeByDay = new Map<string, Map<string, number>>();
    for (const s of slips) { const f = outputOf(String(s.formula_name)); const omit = new Set((omitted.get(s.id) ?? []).map((o) => o.itemId)); for (const r of recipeLines.filter((r) => r.formulaId === f.id && !omit.has(r.itemId))) { const kgTaken = Number(r.kg) * Number(s.batch_count); planned.set(r.name, (planned.get(r.name) ?? 0) + kgTaken); const byDay = takeByDay.get(r.name) ?? new Map<string, number>(); byDay.set(String(s.made_on), (byDay.get(String(s.made_on)) ?? 0) + kgTaken); takeByDay.set(r.name, byDay); } }
    if (omitted.size) { say(`  formula changes  ${omitted.size} slip(s) milled without a material the recipe carries:`); for (const s of slips) { const o = omitted.get(s.id); if (o) say(`    ${s.made_on} ${s.formula_name} ${s.batch_count} batch(es): without ${o.map((x) => x.name).join(", ")}`); } }

    /* ── 1. settled gate receipts whose bill never moved stock ── */
    const settledLines = await tx
      .select({ number: officeReceipts.number, billId: officeReceipts.billId, billDate: bills.billDate, billNumber: bills.number, jeId: bills.journalEntryId, itemId: officeReceiptLines.itemId, name: items.name, unit: items.unit, unitBagWeightKg: items.unitBagWeightKg, netKg: officeReceiptLines.allocatedNetKg, lineAmount: billLines.amount, receiptAmount: officeReceiptLines.billAmount })
      .from(officeReceiptLines).innerJoin(officeReceipts, eq(officeReceipts.id, officeReceiptLines.receiptId)).innerJoin(bills, eq(bills.id, officeReceipts.billId)).innerJoin(items, eq(items.id, officeReceiptLines.itemId)).leftJoin(billLines, and(eq(billLines.billId, bills.id), eq(billLines.itemId, officeReceiptLines.itemId)))
      .where(and(eq(officeReceipts.status, "settled"), gte(bills.billDate, OPENING), eq(items.trackInventory, true), sql`${officeReceiptLines.qcVerdict} IS DISTINCT FROM 'rejected'`, sql`${officeReceiptLines.allocatedNetKg} IS NOT NULL`, sql`NOT EXISTS (SELECT 1 FROM inventory_transactions t WHERE t.source_type = 'bill' AND t.source_id = ${bills.id} AND t.item_id = ${officeReceiptLines.itemId})`));
    say(`  receipts         ${settledLines.length} settled gate receipt line(s) whose bill never moved stock`);
    for (const u of settledLines) {
      const value = Number(u.lineAmount ?? u.receiptAmount ?? 0); const units = Number(u.netKg) * (stockUnitsPerKg(u) ?? 1);
      if (!(value > 0)) throw new Error(`${u.number} → ${u.billNumber}: no bill line for ${u.name}, nothing to value the stock at`);
      await moveStock(tx, { movements: [{ itemId: u.itemId!, quantity: units.toFixed(3), value: value.toFixed(2) }], transactionDate: u.billDate, sourceType: "bill", sourceId: u.billId!, stockLocationId: store });
      const debited = u.jeId ? await tx.select({ debit: journalEntryLines.debit }).from(journalEntryLines).where(and(eq(journalEntryLines.entryId, u.jeId), eq(journalEntryLines.accountId, feedExpense.id))) : [];
      const onExpense = debited.reduce((a, l) => a + Number(l.debit), 0);
      if (onExpense >= value - 0.005) {
        await postJournal(tx, { entryDate: u.billDate, narration: `Stock for bill ${u.billNumber} (${u.number}) — ${u.name}, settled before settlement moved stock`, sourceType: "bill", sourceId: u.billId!, postedBy: userId, lines: [{ accountId: feedStock.id, debit: value.toFixed(2) }, { accountId: feedExpense.id, credit: value.toFixed(2) }] });
        say(`    ${u.number} → ${u.billNumber} ${u.billDate}: ${u.name} ${kg(Number(u.netKg))} net ${rs(value)} into stock, reclassed 5007 → 1073`);
      } else say(`    ${u.number} → ${u.billNumber} ${u.billDate}: ${u.name} ${kg(Number(u.netKg))} net ${rs(value)} into stock (journal already on 1073)`);
    }
    const unmoved = await tx
      .select({ number: bills.number, date: bills.billDate, name: items.name, qty: billLines.quantity, unit: billLines.unit })
      .from(billLines).innerJoin(bills, eq(bills.id, billLines.billId)).innerJoin(items, eq(items.id, billLines.itemId))
      .where(and(gte(bills.billDate, FROM), eq(items.trackInventory, true), ne(bills.status, "void"), sql`NOT EXISTS (SELECT 1 FROM inventory_transactions t WHERE t.source_type = 'bill' AND t.source_id = ${bills.id} AND t.item_id = ${billLines.itemId})`));
    for (const u of unmoved) say(`    ! ${u.number} ${u.date}: ${u.name} ${Number(u.qty).toLocaleString("en-IN")} ${u.unit} has no stock movement and no settled receipt — left alone; if its gate receipt is still open, settling it bills the load a second time`);

    /* ── 2. raw-material stock: the count at the cutover, worked back to the opening ── */
    if (!COUNT_FILE) throw new Error("--count <feed-stock.json> is needed: the mill's stock count at the cutover");
    const count = JSON.parse(await readFile(COUNT_FILE, "utf8")) as { source: string; asOn: string; rows: Array<{ sheetName: string; item: string | null; closingKg: number }> };
    const CUTOVER = arg("cutover") ?? count.asOn;
    const lastPrice = new Map<string, { price: number; at: string }>();
    for (const l of D.lot_consumption ?? []) { const p = lastPrice.get(String(l.material_name)); if (!p || String(l.consumed_at) > p.at) lastPrice.set(String(l.material_name), { price: Number(l.price_per_kg), at: String(l.consumed_at) }); }
    const aminoConsumed = new Map<string, number>();
    for (const l of D.lot_consumption ?? []) aminoConsumed.set(String(l.material_name), (aminoConsumed.get(String(l.material_name)) ?? 0) + Number(l.quantity_consumed));
    const haveDeliveries = Array.isArray(D.deliveries);
    const aminoMaterial = new Map((D.materials ?? []).map((m) => [String(m.name), m]));
    // Amino's figure for a bulk material is its stock at the export; a load it
    // keyed after the cutover comes off, when the export says which those are.
    const aminoAt = (nikoName: string) => { const a = aminoNameOf.get(nikoName); const m = a ? aminoMaterial.get(a) : undefined; if (!m) throw new Error(`Amino holds no material for "${nikoName}", named among --major`); const after = haveDeliveries ? (D.deliveries ?? []).filter((d) => d.material_name === a && String(d.delivered_on) > CUTOVER).reduce((x, d) => x + Number(d.net_quantity ?? d.quantity), 0) : 0; return Number(m.current_stock ?? 0) - after; };
    if (!haveDeliveries) say(`  ! the export carries no deliveries: a bulk material's Amino figure may include a load keyed after ${CUTOVER}, and Amino's deliveries cannot be checked against the gate — re-export with the newer script to be sure`);
    // The gate: every accepted line since FROM at its allocated net kilos, by IST arrival day.
    const gate = await tx
      .select({ number: officeReceipts.number, arrived: sql<string>`to_char((${officeReceipts.arrivalAt} AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD')`, status: officeReceipts.status, settled: sql<boolean>`${officeReceipts.settledAt} IS NOT NULL`, name: items.name, netKg: officeReceiptLines.allocatedNetKg, qc: officeReceiptLines.qcVerdict, lineStatus: officeReceiptLines.status, billKg: officeReceiptLines.billQuantityKg })
      .from(officeReceiptLines).innerJoin(officeReceipts, eq(officeReceipts.id, officeReceiptLines.receiptId)).innerJoin(items, eq(items.id, officeReceiptLines.itemId))
      .where(and(sql`(${officeReceipts.arrivalAt} AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata' >= ${FROM}::date`, ne(officeReceipts.status, "rejected"), eq(items.trackInventory, true)))
      .orderBy(asc(officeReceipts.arrivalAt));
    const accepted = gate.filter((g) => g.qc !== "rejected" && g.netKg != null);
    const unallocated = gate.filter((g) => g.qc !== "rejected" && g.netKg == null);
    const gateUpTo = new Map<string, { kg: number; settledKg: number; open: string[] }>();
    for (const g of accepted.filter((g) => g.arrived <= CUTOVER)) { const e = gateUpTo.get(g.name) ?? { kg: 0, settledKg: 0, open: [] }; e.kg += Number(g.netKg); if (g.settled) e.settledKg += Number(g.netKg); else e.open.push(`${g.number} ${kg(Number(g.netKg))}`); gateUpTo.set(g.name, e); }
    const gateAfter = accepted.filter((g) => g.arrived > CUTOVER);
    // A load keyed as a bill by hand while its gate receipt is still open is
    // billed again, and stocked again, when the office settles the receipt.
    // Same item, same billed kilos, bill dated within ten days of the vendor's.
    const openLines = await tx
      .select({ number: officeReceipts.number, vendorBillDate: officeReceipts.vendorBillDate, itemId: officeReceiptLines.itemId, name: items.name, billKg: officeReceiptLines.billQuantityKg })
      .from(officeReceiptLines).innerJoin(officeReceipts, eq(officeReceipts.id, officeReceiptLines.receiptId)).innerJoin(items, eq(items.id, officeReceiptLines.itemId))
      .where(and(isNull(officeReceipts.billId), ne(officeReceipts.status, "rejected"), ne(officeReceipts.status, "settled"), eq(items.trackInventory, true)));
    const handBills = await tx
      .select({ number: bills.number, date: bills.billDate, itemId: billLines.itemId, qty: billLines.quantity, moved: sql<boolean>`EXISTS (SELECT 1 FROM inventory_transactions t WHERE t.source_type = 'bill' AND t.source_id = ${bills.id} AND t.item_id = ${billLines.itemId})` })
      .from(billLines).innerJoin(bills, eq(bills.id, billLines.billId))
      .where(and(gte(bills.billDate, OPENING), ne(bills.status, "void"), sql`NOT EXISTS (SELECT 1 FROM office_receipts r WHERE r.bill_id = ${bills.id})`));
    for (const o of openLines) {
      const twin = handBills.find((b) => b.itemId === o.itemId && Math.abs(Number(b.qty) - Number(o.billKg)) < 0.5 && Math.abs(new Date(String(b.date)).getTime() - new Date(String(o.vendorBillDate ?? b.date)).getTime()) <= 10 * 86_400_000);
      if (twin) say(`  ! ${o.number} ${o.name} ${kg(Number(o.billKg))} is still open at the gate and looks keyed by hand as ${twin.number} of ${twin.date}${twin.moved ? " (already in stock)" : ""} — settling the receipt bills and stocks the load a second time; void one of them`);
    }
    if (unallocated.length) say(`  ! ${unallocated.length} gate line(s) accepted but with no net kilos allocated yet, not counted: ${unallocated.map((g) => `${g.number} ${g.name} (bill ${kg(Number(g.billKg))})`).join("; ")}`);
    if (gateAfter.length) say(`  gate after ${CUTOVER}: ${gateAfter.map((g) => `${g.number} ${g.name} ${kg(Number(g.netKg))}${g.settled ? " settled" : ""}`).join("; ")} — on top of the count when settled`);
    if (haveDeliveries) {
      say(`\n  deliveries since ${FROM} — Amino vs the gate (accepted net kg)`);
      const names = new Set<string>([...(D.deliveries ?? []).map((d) => MATERIAL[String(d.material_name)] ?? String(d.material_name)), ...accepted.map((g) => g.name)]);
      for (const n of [...names].sort()) { const a = (D.deliveries ?? []).filter((d) => (MATERIAL[String(d.material_name)] ?? String(d.material_name)) === n).reduce((x, d) => x + Number(d.net_quantity ?? d.quantity), 0); const g = accepted.filter((g) => g.name === n).reduce((x, g) => x + Number(g.netKg), 0); say(`    ${n.padEnd(34)} Amino ${kg(a).padStart(12)}   gate ${kg(g).padStart(12)}${Math.abs(a - g) > 1 ? `   ${kg(g - a)} apart` : ""}`); }
    }
    const notItems = count.rows.filter((r) => !r.item && r.closingKg > 0);
    if (notItems.length) say(`  count rows with no niko item, not counted: ${notItems.map((r) => `${r.sheetName} ${kg(r.closingKg)}`).join(", ")}`);
    const targets = new Map<string, { kg: number; from: string }>();
    for (const r of count.rows) if (r.item) targets.set(r.item, MAJOR.has(r.item) ? { kg: aminoAt(r.item), from: "Amino" } : { kg: r.closingKg, from: "sheet" });
    for (const n of MAJOR) if (!targets.has(n)) targets.set(n, { kg: aminoAt(n), from: "Amino" });
    for (const n of planned.keys()) if (!targets.has(n)) { say(`  ! ${n} is in the recipes but on no count row and not among --major: counted as 0 at ${CUTOVER}`); targets.set(n, { kg: 0, from: "none" }); }
    const openingLines: Array<{ itemId: string; name: string; qty: number; value: number; note: string }> = [];
    // What is already in the ledger after the opening day, by item and day, in
    // kilos: the settled loads (and step 1's), which the day-by-day check
    // below counts on their dates.
    const inLedger = new Map<string, Array<{ day: string; kg: number }>>();
    for (const r of await tx.select({ name: items.name, day: inventoryTransactions.transactionDate, qty: sql<number>`sum(${inventoryTransactions.quantity})::float` }).from(inventoryTransactions).innerJoin(items, eq(items.id, inventoryTransactions.itemId)).where(and(sql`${inventoryTransactions.quantity} > 0`, sql`${inventoryTransactions.transactionDate} > ${OPENING}`)).groupBy(items.name, inventoryTransactions.transactionDate)) { const it = itemByName.get(r.name); const perUnit = it && it.unit !== "kg" ? Number(it.bag ?? 1) : 1; const list = inLedger.get(r.name) ?? []; list.push({ day: String(r.day), kg: Number(r.qty) * perUnit }); inLedger.set(r.name, list); }
    const lowest = (events: Array<{ day: string; kg: number }>) => { let run = 0, low = 0; for (const day of [...new Set(events.map((e) => e.day))].sort()) { run += events.filter((e) => e.day === day).reduce((a, e) => a + e.kg, 0); low = Math.min(low, run); } return low; };
    say(`\n  raw stock on ${OPENING}, worked back from the count at ${CUTOVER} — item | count (source) | recipes take | gate ≤ ${CUTOVER} (of it settled) | opening | niko holds at ${OPENING} | adjustment | ₹/kg`);
    const negatives: string[] = []; const shorts: string[] = [];
    for (const [name, t] of [...targets].sort((a, b) => a[0].localeCompare(b[0]))) {
      const it = itemByName.get(name); if (!it) throw new Error(`no niko item named "${name}"`);
      const perUnit = it.unit === "kg" ? 1 : Number(it.bag ?? 0);
      const take = planned.get(name) ?? 0; const g = gateUpTo.get(name) ?? { kg: 0, settledKg: 0, open: [] };
      const takes = [...(takeByDay.get(name) ?? [])].map(([day, k]) => ({ day, kg: -k }));
      const landed = inLedger.get(name) ?? [];
      const arriving = accepted.filter((x) => x.name === name && !x.settled && x.arrived <= CUTOVER).map((x) => ({ day: x.arrived, kg: Number(x.netKg) }));
      // The opening must also keep every day at or above zero once each load is in on its arrival day.
      const needEventually = -lowest([...landed, ...arriving, ...takes]);
      let openingKg = t.kg + take - g.kg;
      if (openingKg < Math.max(0, needEventually) - 0.5) { const was = openingKg; openingKg = Math.max(0, needEventually); negatives.push(`${name}: count ${kg(t.kg)} + recipes ${kg(take)} − gate ${kg(g.kg)} = ${kg(was)}; opened at ${kg(openingKg)} instead (${needEventually > 0 ? "the least that keeps every day at or above zero" : "nothing"}), so the ledger will sit ${kg(openingKg - was)} above the count once the gate is settled — the sheet's own usage of it since ${FROM}, or a gate weight above what was counted (${g.open.join(", ") || "all settled"})`); }
      // With only what is settled in the ledger, how far below zero the material goes before the open loads are settled.
      const shortNow = -lowest([...landed, ...takes]) - openingKg;
      if (shortNow > 0.5) shorts.push(`${name} dips to −${kg(shortNow)} until ${g.open.join(", ")} settle`);
      const [held] = await tx.select({ qty: sql<number>`coalesce(sum(${inventoryTransactions.quantity}),0)::float` }).from(inventoryTransactions).where(and(eq(inventoryTransactions.itemId, it.id), lte(inventoryTransactions.transactionDate, OPENING)));
      const heldKg = Number(held?.qty ?? 0) * (perUnit || 1);
      const adjKg = openingKg - heldKg;
      const a = aminoNameOf.get(name);
      const aminoPrice = lastPrice.get(a ?? "")?.price ?? (a && aminoMaterial.get(a) ? Number(aminoMaterial.get(a)!.cost_per_kg ?? 0) : 0);
      const price = aminoPrice > 0 ? aminoPrice : Number(it.costPrice ?? 0) * (perUnit ? 1 / perUnit : 1);
      if (adjKg > 0.0005 && !(price > 0)) say(`    ! ${name}: no price anywhere (Amino lots, Amino material, niko cost price) — opened at ₹0`);
      const adjUnits = perUnit ? adjKg / perUnit : adjKg;
      say(`    ${name.padEnd(32)} ${kg(t.kg).padStart(12)} (${t.from.padEnd(5)}) ${kg(take).padStart(12)} ${kg(g.kg).padStart(12)} (${kg(g.settledKg)}) ${kg(openingKg).padStart(12)} ${kg(heldKg).padStart(12)} ${kg(adjKg).padStart(12)}  ${price.toFixed(2)}`);
      if (Math.abs(adjUnits) > 0.0005) openingLines.push({ itemId: it.id, name, qty: adjUnits, value: adjUnits * price * (perUnit || 1), note: `Opening at the takeover, worked back from the count of ${CUTOVER} (${t.from}: ${kg(t.kg)}) + recipes ${kg(take)} − gate ${kg(g.kg)}` });
    }
    for (const n of negatives) say(`    ! ${n}`);
    const openGate = [...gateUpTo].filter(([, g]) => g.open.length);
    if (openGate.length) say(`  gate lines up to ${CUTOVER} still to settle (in the arithmetic, not yet in stock): ${openGate.map(([n, g]) => `${n}: ${g.open.join(", ")}`).join("; ")}`);
    if (shorts.length) { say(`  milling from loads not yet settled — the ledger goes below zero meanwhile:`); for (const x of shorts) say(`    ${x}`); }
    if (APPLY && shorts.length && !ALLOW_SHORT) throw new Error(`${shorts.length} material(s) would go below zero until the open gate lines are settled — settle them first, or pass --allow-short`);

    /* ── 3. opening finished feed: the least that lets each day's transfers out ── */
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
      for (const day of days) { stock += slips.filter((s) => s.formula_name === name && s.made_on === day).reduce((a, s) => a + yieldOf(s), 0); stock -= plannedTransfers.filter((t) => t.feed === name && t.day === day).reduce((a, t) => a + t.kg, 0); lowest = Math.min(lowest, stock); }
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
      const [adj] = await tx.insert(inventoryAdjustments).values({ number, adjustmentDate: OPENING, mode: "quantity", reason: "Opening stock at the mill's takeover by niko", description: `Worked back from the count of ${CUTOVER} (${count.source}) and Amino's export of ${raw.exportedAt}`, adjustmentAccountId: feedExpense.id, createdBy: userId }).returning();
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
        const omit = omitted.get(s.id) ?? [];
        const order = await produceOne(tx, { formulaId: f.id, batchCount: Number(s.batch_count), omitItemIds: omit.map((o) => o.itemId), allowShort: !APPLY || ALLOW_SHORT }, { orderDate: day, notes: `Amino slip ${s.id} — ${s.formula_name}, ${s.batch_count} batch(es), ${kg(Number(s.total_output))}, confirmed ${String(s.confirmed_at ?? s.generated_at).slice(0, 16)}Z${omit.length ? `; milled without ${omit.map((o) => o.name).join(", ")} (the slip drew none)` : ""}` }, userId);
        produced++; producedKg += Number(order.actualOutputKg); made.push(`${s.formula_name} ${kg(Number(order.actualOutputKg))} @₹${Number(order.costPerKg).toFixed(2)}${omit.length ? ` without ${omit.map((o) => o.name).join(", ")}` : ""}`);
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
    for (const name of [...new Set([...consumedNiko.keys(), ...[...aminoConsumed.keys()].map((a) => MATERIAL[a] ?? a)])].sort()) { const it = itemByName.get(name); const perUnit = it && it.unit !== "kg" ? Number(it.bag ?? 1) : 1; const n = (consumedNiko.get(name) ?? 0) * perUnit; const a = aminoNameOf.get(name); const cons = a ? (aminoConsumed.get(a) ?? 0) : 0; say(`    ${name.padEnd(34)} niko ${kg(n).padStart(12)}   Amino ${kg(cons).padStart(12)}   ${cons ? `${((n / cons - 1) * 100).toFixed(1)}%` : a ? "—" : "(no Amino material)"}`); }
    say(`\n  stock after the last day — item | niko now | + gate ≤ ${CUTOVER} unsettled | = once settled | count at ${CUTOVER} | apart`);
    const levels = await tx.select({ name: items.name, unit: items.unit, bag: items.unitBagWeightKg, qty: sql<number>`coalesce(sum(${inventoryTransactions.quantity}),0)::float`, value: sql<number>`coalesce(sum(${inventoryTransactions.value}),0)::float` }).from(inventoryTransactions).innerJoin(items, eq(items.id, inventoryTransactions.itemId)).groupBy(items.name, items.unit, items.unitBagWeightKg).orderBy(items.name);
    for (const l of levels) { const perUnit = l.unit === "kg" ? 1 : Number(l.bag ?? 1); const q = Number(l.qty) * perUnit; const t = targets.get(l.name); if (Math.abs(q) < 1 && !t) continue; const g = gateUpTo.get(l.name); const pending = g ? g.kg - g.settledKg : 0; const once = q + pending; say(`    ${l.name.padEnd(34)} ${kg(q).padStart(12)} ${rs(Number(l.value)).padStart(14)} ${kg(pending).padStart(12)} ${kg(once).padStart(12)} ${t ? kg(t.kg).padStart(12) : "".padStart(12)} ${t && Math.abs(once - t.kg) > 0.5 ? kg(once - t.kg).padStart(12) : ""}`); }

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
