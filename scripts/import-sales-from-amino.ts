/**
 * Bring Amino's egg sales across — what niko's 18 Sep copy of the books lacks
 * — so niko can take over selling on 28 Sep 2026 (docs/sales-go-live-plan.md).
 *
 * The file comes from `scripts/export-sales-for-niko.ts` in the Amino repo,
 * run on Replit. Dry by default: it resolves everything, reports, and rolls
 * back. `--apply` commits, in one transaction.
 *
 * What it does, in order:
 *
 *   Customers   matched to niko's contacts, never created — Zoho contact id
 *               (Amino's zoho_customer_map → niko's zoho_id_map), then GSTIN,
 *               then exact name. A customer it cannot place is listed and
 *               their rows are skipped, never guessed at.
 *   Benchmark   every VIJ day niko has not got, source "amino".
 *   Agreements  with each customer's spread; Amino's weekly/specific days
 *               become niko's weekdays. Skipped days come as skip exceptions.
 *   Invoices    from --from (default 2026-09-17, the day after niko's Zoho
 *               copy ends), under Zoho's own number, one line per size for an
 *               egg invoice (Amino's "dirty" is niko's Dirty), posted to the
 *               books like any invoice — and NOT moving egg stock: the
 *               opening count already reflects what those trucks took. A
 *               number niko already holds is left alone.
 *   Payments    from the same day, into the niko bank the money went to (by
 *               account number, else Cash for cash, else the SBI CC account
 *               every egg receipt since August went to).
 *   Netting     payments against invoices, oldest first — Amino's own rule —
 *               each application dated when both existed. Old niko money is
 *               never re-paired with an old niko invoice: only pairs where
 *               one side is imported.
 *   Credit notes  listed for keying by hand; they carry lines niko needs.
 *   Bookings    Amino spot orders from today, not yet loaded.
 *   Opening stock  only with --opening-stock: Amino's last closing count per
 *               size, as the size items' opening balance, valued the way
 *               niko values egg stock. Refused for an item that has moved.
 *
 *   npx tsx scripts/import-sales-from-amino.ts --file sales-for-niko.json
 *   npx tsx scripts/import-sales-from-amino.ts --file sales-for-niko.json --apply
 */
import { readFile } from "node:fs/promises";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  bankAccounts,
  contacts,
  customerPayments,
  eggAgreementExceptions,
  eggAgreements,
  eggBenchmarkPrices,
  eggSpotOrders,
  invoiceLines,
  invoices,
  items,
  paymentApplications,
} from "@shared/schema";
import { EGG_SIZE_LABEL, type EggSize } from "@shared/egg-sizes";
import { db } from "../server/db";
import { nextDocumentNumber } from "../server/lib/numbering";
import { applyDefaultSalesAccounts, computeDocumentTotals, type DocLineInput } from "../server/services/documents";
import { eggStockRatePerBoxP, sizeItems } from "../server/services/egg-sales";
import { PostingError, postJournal } from "../server/services/posting";
import { istDate } from "../server/services/day-resolution";
import { loadCustomer, postInvoiceJournal } from "../server/routes/sales";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const FILE = arg("file");
const FROM = arg("from") ?? "2026-09-17";
const APPLY = process.argv.includes("--apply");
const OPENING = process.argv.includes("--opening-stock");
if (!FILE) {
  console.error("\n  --file <sales-for-niko.json> is required\n");
  process.exit(1);
}

type Row = Record<string, any>;
const exp = JSON.parse(await readFile(FILE, "utf8")) as { exportedAt: string; exportedOn: string; data: Record<string, Row[]> };
const D = exp.data;
const today = istDate();

const say = (s = "") => console.log(s);
const paise = (v: unknown) => Math.round(Number(v ?? 0) * 100);
const rupees = (p: number) => (p / 100).toFixed(2);
const norm = (s: unknown) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
const gstinOf = (s: unknown) => String(s ?? "").trim().toUpperCase();

/** Amino's size columns, and the niko grade each becomes. */
const SIZES: Array<[string, EggSize]> = [
  ["small", "small"], ["medium", "medium"], ["large", "large"], ["xl", "xl"], ["jumbo", "jumbo"], ["dirty", "dirty"],
];

class DryRun extends Error {}

try {
  await db.transaction(async (tx) => {
    // What came from Amino is recorded as Replit, where it came from, not as
    // whichever person happens to be first (29 Sep 2026); an admin if not.
    const [actor] = (
      await tx.execute(sql`
        (SELECT id FROM users WHERE username = 'replit')
        UNION ALL
        (SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
          WHERE u.is_active AND r.permissions ? '*' ORDER BY u.created_at LIMIT 1)
        LIMIT 1`)
    ).rows as Array<{ id: string }>;
    if (!actor) throw new Error("No active admin user to record the import as");

    say(`\n  IMPORT SALES FROM AMINO — export of ${exp.exportedAt}; documents from ${FROM}\n`);

    /* ── Customers ─────────────────────────────────────────────────────── */
    const niko = await tx
      .select({ id: contacts.id, name: contacts.displayName, gstin: contacts.gstin, type: contacts.type })
      .from(contacts)
      .where(inArray(contacts.type, ["customer", "both"]));
    const zoho = new Map(
      ((await tx.execute(sql`SELECT zoho_id, eggsy_id FROM zoho_id_map WHERE entity = 'contact'`)).rows as Array<{ zoho_id: string; eggsy_id: string }>).map(
        (r) => [r.zoho_id, r.eggsy_id],
      ),
    );
    const nikoIds = new Set(niko.map((c) => c.id));
    const byGstin = new Map(niko.filter((c) => c.gstin).map((c) => [gstinOf(c.gstin), c.id]));
    const byName = new Map(niko.map((c) => [norm(c.name), c.id]));
    const person = new Map<string, string>();
    const how = { zoho: 0, gstin: 0, name: 0 };
    const unmatched: Row[] = [];
    for (const c of D.customers ?? []) {
      const zid = String(c.zoho_contact_id ?? c.zoho_raw_contact_id ?? "");
      const viaZoho = zid ? zoho.get(zid) : undefined;
      if (viaZoho && nikoIds.has(viaZoho)) { person.set(String(c.id), viaZoho); how.zoho++; continue; }
      const viaGstin = c.gstn ? byGstin.get(gstinOf(c.gstn)) : undefined;
      if (viaGstin) { person.set(String(c.id), viaGstin); how.gstin++; continue; }
      const viaName = byName.get(norm(c.business_name));
      if (viaName) { person.set(String(c.id), viaName); how.name++; continue; }
      unmatched.push(c);
    }
    const usedBy = (id: string) =>
      (D.invoices ?? []).filter((i) => String(i.customer_id) === id && String(i.invoice_date) >= FROM).length +
      (D.payments ?? []).filter((p) => String(p.customer_id) === id && String(p.payment_date) >= FROM).length +
      (D.agreements ?? []).filter((a) => String(a.customer_id) === id && a.status !== "ended").length +
      (D.spot_orders ?? []).filter((o) => String(o.customer_id) === id).length;
    say(`  customers        ${person.size} of ${(D.customers ?? []).length} matched (Zoho id ${how.zoho}, GSTIN ${how.gstin}, name ${how.name})`);
    const mattering = unmatched.map((c) => ({ c, n: usedBy(String(c.id)) })).filter((x) => x.n > 0);
    for (const { c, n } of mattering) say(`    ! not in niko: ${c.business_name}${c.gstn ? ` (${c.gstn})` : ""} — ${n} record(s) skipped`);
    if (unmatched.length > mattering.length) say(`    (${unmatched.length - mattering.length} other unmatched customer(s) have nothing to bring)`);

    /* ── Benchmark ─────────────────────────────────────────────────────── */
    const haveDays = new Set(
      (await tx.select({ d: eggBenchmarkPrices.effectiveFrom }).from(eggBenchmarkPrices)).map((r) => String(r.d)),
    );
    let benchmarks = 0;
    for (const b of D.benchmarks ?? []) {
      const day = String(b.price_date);
      if (haveDays.has(day) || !(Number(b.rate) > 0)) continue;
      await tx.insert(eggBenchmarkPrices).values({ effectiveFrom: day, ratePerEgg: Number(b.rate).toFixed(4), source: "amino", note: "From Amino (VIJ)" });
      haveDays.add(day);
      benchmarks++;
    }
    const lastBm = (D.benchmarks ?? []).at(-1);
    say(`  benchmark        ${benchmarks} day(s) added; Amino's latest ${lastBm ? `${lastBm.price_date} at ₹${Number(lastBm.rate).toFixed(2)}/egg` : "—"}`);

    /* ── Agreements ────────────────────────────────────────────────────── */
    const haveAgreements = new Set((await tx.select({ id: eggAgreements.id }).from(eggAgreements)).map((r) => r.id));
    let agreements = 0;
    const agreementSkipped: string[] = [];
    const importedAgreements = new Set<string>();
    for (const a of D.agreements ?? []) {
      const id = String(a.id);
      const customerId = person.get(String(a.customer_id));
      if (!customerId) continue;
      if (haveAgreements.has(id)) { importedAgreements.add(id); continue; }
      const boxes = Number(a.total_boxes_committed ?? 0);
      if (!(boxes > 0)) { agreementSkipped.push(`${id.slice(0, 8)}: no boxes committed`); continue; }
      const days = (a.days_of_week ?? []) as number[];
      const weekly = a.schedule_type !== "daily";
      if (weekly && !days.length) { agreementSkipped.push(`${id.slice(0, 8)}: ${a.schedule_type} with no days`); continue; }
      const status = ["active", "paused", "ended"].includes(String(a.status)) ? String(a.status) : "active";
      await tx.insert(eggAgreements).values({
        id,
        customerId,
        schedule: weekly ? "weekdays" : "daily",
        daysOfWeek: weekly ? days : null,
        boxes,
        spreadPerEgg: Number(a.spread ?? 0).toFixed(4),
        startDate: String(a.start_date),
        endDate: a.end_date ? String(a.end_date) : null,
        status,
        notes: a.notes ? String(a.notes) : null,
        createdBy: actor.id,
      });
      importedAgreements.add(id);
      agreements++;
    }
    let skips = 0;
    for (const v of D.agreement_voids ?? []) {
      const agreementId = String(v.agreement_id);
      if (!importedAgreements.has(agreementId)) continue;
      const done = await tx
        .insert(eggAgreementExceptions)
        .values({ agreementId, onDate: String(v.void_date), kind: "skip", reason: "Skipped in Amino", createdBy: actor.id })
        .onConflictDoNothing()
        .returning({ id: eggAgreementExceptions.id });
      skips += done.length;
    }
    say(`  agreements       ${agreements} added, ${skips} skipped day(s)${agreementSkipped.length ? `; ${agreementSkipped.length} not added` : ""}`);
    for (const s of agreementSkipped) say(`    ! ${s}`);

    /* ── Invoices ──────────────────────────────────────────────────────── */
    const sizeItem = await sizeItems(tx);
    const itemByName = new Map(
      (await tx.select({ id: items.id, name: items.name }).from(items).where(eq(items.isActive, true))).map((i) => [norm(i.name), i.id]),
    );
    const numberOf = (i: Row) => String(i.zoho_invoice_number ?? String(i.invoice_number ?? "").replace(/^Z-/, ""));
    const wanted = (D.invoices ?? []).filter((i) => String(i.invoice_date) >= FROM);
    const haveNumbers = new Set(
      (await tx.select({ n: invoices.number }).from(invoices).where(inArray(invoices.number, wanted.map(numberOf).concat(["—"])))).map((r) => r.n),
    );
    const haveInvoiceIds = new Set(
      (await tx.select({ id: invoices.id }).from(invoices).where(inArray(invoices.id, wanted.map((i) => String(i.id)).concat(["00000000-0000-0000-0000-000000000000"])))).map((r) => r.id),
    );
    const linesOf = new Map<string, Row[]>();
    for (const l of D.invoice_lines ?? []) linesOf.set(String(l.invoice_id), [...(linesOf.get(String(l.invoice_id)) ?? []), l]);

    const inv = { added: 0, already: 0, voidOrDraft: 0, noCustomer: 0, unresolved: [] as string[], totalMismatch: [] as string[] };
    const importedInvoiceIds = new Set<string>();
    const touched = new Set<string>();
    for (const i of wanted) {
      const number = numberOf(i);
      if (haveNumbers.has(number) || haveInvoiceIds.has(String(i.id))) { inv.already++; continue; }
      if (["void", "draft"].includes(String(i.payment_status))) { inv.voidOrDraft++; continue; }
      const customerId = person.get(String(i.customer_id));
      if (!customerId) { inv.noCustomer++; continue; }

      let lines: DocLineInput[] = [];
      let unresolved = "";
      if (i.invoice_type === "egg" || i.invoice_type == null) {
        for (const [col, size] of SIZES) {
          const boxes = Number(i[`loaded_${col}`] ?? 0);
          if (!(boxes > 0)) continue;
          const itemId = sizeItem.get(size);
          if (!itemId) { unresolved = `no niko item for ${size}`; break; }
          lines.push({ itemId, name: `Eggs — ${EGG_SIZE_LABEL[size]}`, quantity: String(boxes), unit: "boxes", rate: Number(i[`price_${col}`] ?? 0).toFixed(4) });
        }
      } else if (i.invoice_type === "feed") {
        const itemId = itemByName.get(norm(i.item_description));
        if (!itemId) unresolved = `feed item "${i.item_description}" is not a niko item`;
        else lines = [{ itemId, name: String(i.item_description), quantity: String(i.quantity ?? 1), rate: Number(i.unit_price ?? 0).toFixed(4) }];
      } else {
        for (const l of linesOf.get(String(i.id)) ?? []) {
          const itemId = itemByName.get(norm(l.description));
          if (!itemId) { unresolved = `line "${l.description}" is not a niko item`; break; }
          lines.push({ itemId, name: String(l.description), quantity: String(l.quantity ?? 1), rate: Number(l.rate ?? 0).toFixed(4) });
        }
      }
      if (!unresolved && !lines.length) unresolved = "no lines";
      if (unresolved) { inv.unresolved.push(`${number} ${i.invoice_date}: ${unresolved}`); continue; }

      let customer;
      try {
        customer = await loadCustomer(tx, customerId);
      } catch (e) {
        inv.unresolved.push(`${number}: ${e instanceof Error ? e.message : e}`);
        continue;
      }
      const totals = await computeDocumentTotals(tx, lines, customer.placeOfSupplyState);
      if (Math.abs(paise(totals.total) - paise(i.total_amount)) > 100) {
        inv.totalMismatch.push(`${number}: niko ₹${totals.total} against Amino ₹${Number(i.total_amount).toFixed(2)}`);
      }
      const [row] = await tx
        .insert(invoices)
        .values({
          id: String(i.id),
          number,
          customerId: customer.id,
          status: "draft",
          invoiceDate: String(i.invoice_date),
          dueDate: String(i.due_date ?? i.invoice_date),
          reference: `Amino ${i.invoice_type ?? "egg"} invoice`,
          placeOfSupplyState: customer.placeOfSupplyState,
          subTotal: totals.subTotal,
          discountTotal: totals.discountTotal,
          cgst: totals.cgst,
          sgst: totals.sgst,
          igst: totals.igst,
          adjustment: totals.adjustment,
          adjustmentAccountId: totals.adjustmentAccountId,
          adjustmentDescription: totals.adjustmentDescription,
          roundOff: totals.roundOff,
          total: totals.total,
          balanceDue: totals.total,
          customerNotes: i.notes ? String(i.notes) : null,
          createdBy: actor.id,
        })
        .returning();
      const withAccounts = await applyDefaultSalesAccounts(tx, totals.lines);
      await tx.insert(invoiceLines).values(withAccounts.map((l) => ({ ...l, invoiceId: row!.id })));
      const jeId = await postInvoiceJournal(tx, row!, customer.displayName, actor.id);
      await tx.update(invoices).set({ status: "sent", journalEntryId: jeId }).where(eq(invoices.id, row!.id));
      importedInvoiceIds.add(row!.id);
      touched.add(customer.id);
      inv.added++;
    }
    say(`  invoices         ${inv.added} added from ${wanted.length} dated ${FROM} on; ${inv.already} already in niko, ${inv.voidOrDraft} void/draft, ${inv.noCustomer} for customers not in niko`);
    for (const u of inv.unresolved) say(`    ! not added: ${u}`);
    for (const m of inv.totalMismatch) say(`    ! total differs: ${m}`);

    /* ── Payments ──────────────────────────────────────────────────────── */
    const banks = await tx.select().from(bankAccounts);
    const cash = banks.find((b) => norm(b.name) === "cash");
    const fallback = banks.find((b) => b.name.includes("44656290967"));
    const bankFor = (p: Row) => {
      const digits = String(p.bank_account_number ?? "").replace(/\D/g, "");
      if (digits.length >= 6) {
        const hit = banks.find((b) => b.name.replace(/\D/g, "").includes(digits));
        if (hit) return { bank: hit, via: "account number" };
      }
      if (String(p.method) === "cash" && cash) return { bank: cash, via: "cash" };
      return fallback ? { bank: fallback, via: "SBI CC default" } : null;
    };
    const modeOf = (m: unknown) => {
      const v = String(m ?? "").toLowerCase();
      if (v === "cash") return "cash" as const;
      if (v === "upi") return "upi" as const;
      if (v === "cheque") return "cheque" as const;
      return "bank_transfer" as const;
    };
    const zohoPayments = new Set(
      ((await tx.execute(sql`SELECT zoho_id FROM zoho_id_map WHERE entity IN ('customer_payment', 'payment')`)).rows as Array<{ zoho_id: string }>).map((r) => r.zoho_id),
    );
    const wantedPayments = (D.payments ?? []).filter((p) => String(p.payment_date) >= FROM);
    const havePaymentIds = new Set(
      (await tx.select({ id: customerPayments.id }).from(customerPayments).where(inArray(customerPayments.id, wantedPayments.map((p) => String(p.id)).concat(["00000000-0000-0000-0000-000000000000"])))).map((r) => r.id),
    );
    const pay = { added: 0, already: 0, noCustomer: 0, noBank: 0, via: new Map<string, number>(), amountP: 0 };
    const importedPaymentIds = new Set<string>();
    for (const p of wantedPayments) {
      if (havePaymentIds.has(String(p.id)) || (p.zoho_payment_id && zohoPayments.has(String(p.zoho_payment_id)))) { pay.already++; continue; }
      const customerId = person.get(String(p.customer_id));
      if (!customerId) { pay.noCustomer++; continue; }
      const b = bankFor(p);
      if (!b) { pay.noBank++; continue; }
      const amountP = paise(p.amount);
      if (amountP <= 0) continue;
      const customer = await loadCustomer(tx, customerId);
      const number = await nextDocumentNumber(tx, "customer_payment");
      const [row] = await tx
        .insert(customerPayments)
        .values({
          id: String(p.id),
          number,
          customerId,
          paymentDate: String(p.payment_date),
          amount: rupees(amountP),
          unappliedAmount: rupees(amountP),
          mode: modeOf(p.method),
          reference: p.reference ? String(p.reference) : null,
          bankAccountId: b.bank.id,
          notes: [p.notes, "From Amino"].filter(Boolean).join(" — "),
          createdBy: actor.id,
        })
        .returning();
      const jeId = await postJournal(tx, {
        entryDate: String(p.payment_date),
        narration: `Payment ${number} — ${customer.displayName}`,
        sourceType: "customer_payment",
        sourceId: row!.id,
        postedBy: actor.id,
        lines: [
          { accountId: b.bank.glAccountId, debit: rupees(amountP), description: `Payment ${number}` },
          { systemKey: "customer_advances", credit: rupees(amountP) },
        ] as never,
      });
      await tx.update(customerPayments).set({ journalEntryId: jeId }).where(eq(customerPayments.id, row!.id));
      importedPaymentIds.add(row!.id);
      touched.add(customerId);
      pay.added++;
      pay.amountP += amountP;
      pay.via.set(b.via, (pay.via.get(b.via) ?? 0) + 1);
    }
    say(`  payments         ${pay.added} added (₹${rupees(pay.amountP)}), ${pay.already} already in niko, ${pay.noCustomer} for customers not in niko${pay.noBank ? `, ${pay.noBank} with no bank to post to` : ""}`);
    if (pay.via.size) say(`    banked by ${[...pay.via].map(([k, n]) => `${k} ${n}`).join(", ")}`);

    /* ── Netting, oldest first ─────────────────────────────────────────── */
    let applications = 0;
    let appliedP = 0;
    for (const customerId of touched) {
      const open = await tx
        .select()
        .from(invoices)
        .where(and(eq(invoices.customerId, customerId), inArray(invoices.status, ["sent", "partially_paid"])))
        .orderBy(invoices.invoiceDate, invoices.number);
      const money = await tx
        .select()
        .from(customerPayments)
        .where(and(eq(customerPayments.customerId, customerId), sql`${customerPayments.unappliedAmount}::numeric > 0`))
        .orderBy(customerPayments.paymentDate, customerPayments.number);
      const left = new Map(money.map((m) => [m.id, paise(m.unappliedAmount)]));
      for (const i of open) {
        let dueP = paise(i.balanceDue);
        for (const m of money) {
          if (dueP <= 0) break;
          const avail = left.get(m.id) ?? 0;
          if (avail <= 0) continue;
          // Only pairs with an imported side: niko's own open money and
          // invoices stay exactly as the Zoho copy left them.
          if (!importedInvoiceIds.has(i.id) && !importedPaymentIds.has(m.id)) continue;
          const takeP = Math.min(avail, dueP);
          const on = String(i.invoiceDate) > String(m.paymentDate) ? String(i.invoiceDate) : String(m.paymentDate);
          await tx.insert(paymentApplications).values({ paymentId: m.id, invoiceId: i.id, amountApplied: rupees(takeP) });
          left.set(m.id, avail - takeP);
          dueP -= takeP;
          await postJournal(tx, {
            entryDate: on,
            narration: `Advance applied to ${i.number}`,
            sourceType: "advance_application",
            sourceId: i.id,
            postedBy: actor.id,
            lines: [
              { systemKey: "customer_advances", debit: rupees(takeP) },
              { systemKey: "ar", credit: rupees(takeP) },
            ] as never,
          });
          applications++;
          appliedP += takeP;
        }
        if (dueP !== paise(i.balanceDue)) {
          await tx
            .update(invoices)
            .set({ balanceDue: rupees(dueP), status: dueP === 0 ? "paid" : "partially_paid", updatedAt: new Date() })
            .where(eq(invoices.id, i.id));
        }
      }
      for (const m of money) {
        const l = left.get(m.id) ?? 0;
        if (l !== paise(m.unappliedAmount)) {
          await tx.update(customerPayments).set({ unappliedAmount: rupees(l) }).where(eq(customerPayments.id, m.id));
        }
      }
    }
    say(`  netting          ${applications} application(s), ₹${rupees(appliedP)} of money on account settled against invoices`);

    /* ── Credit notes: listed, not posted ──────────────────────────────── */
    const notes = (D.credit_notes ?? []).filter((c) => String(c.note_date) >= FROM);
    say(`  credit notes     ${notes.length} to key by hand`);
    for (const c of notes) {
      const who = (D.customers ?? []).find((x) => String(x.id) === String(c.customer_id));
      say(`    - ${c.note_number} ${c.note_date} ${who?.business_name ?? c.customer_id} ₹${Number(c.amount).toFixed(2)}${c.reason ? ` — ${c.reason}` : ""}`);
    }

    /* ── Bookings from today ───────────────────────────────────────────── */
    const haveSpots = new Set((await tx.select({ id: eggSpotOrders.id }).from(eggSpotOrders)).map((r) => r.id));
    let spots = 0;
    for (const o of D.spot_orders ?? []) {
      if (String(o.order_date) < today || haveSpots.has(String(o.id))) continue;
      const customerId = person.get(String(o.customer_id));
      if (!customerId) continue;
      const q = (col: string) => Math.max(0, Number(o[`qty_${col}`] ?? 0));
      const boxes = SIZES.reduce((a, [col]) => a + q(col), 0);
      if (boxes <= 0) continue;
      await tx.insert(eggSpotOrders).values({
        id: String(o.id),
        customerId,
        orderDate: String(o.order_date),
        boxes,
        small: q("small"),
        medium: q("medium"),
        large: q("large"),
        xl: q("xl"),
        jumbo: q("jumbo"),
        dirty: q("dirty"),
        spreadPerEgg: o.spread == null ? null : Number(o.spread).toFixed(4),
        notes: [o.notes, "From Amino"].filter(Boolean).join(" — "),
        status: "booked",
        createdBy: actor.id,
      });
      spots++;
    }
    say(`  bookings         ${spots} spot order(s) from ${today}`);

    /* ── Opening egg stock, only when asked ────────────────────────────── */
    const last = (D.closings ?? [])[0];
    if (last) {
      const counts = SIZES.map(([col, size]) => [size, Number(last[`${col}_boxes`] ?? 0)] as const);
      say(`  Amino's last closing count, ${last.entry_date}: ${counts.map(([s, n]) => `${EGG_SIZE_LABEL[s]} ${n}`).join(", ")}`);
      if (OPENING) {
        const rateP = await eggStockRatePerBoxP(tx, String(last.entry_date));
        for (const [size, n] of counts) {
          const itemId = sizeItem.get(size);
          if (!itemId) continue;
          const [moved] = (await tx.execute(sql`SELECT count(*)::int AS n FROM inventory_transactions WHERE item_id = ${itemId}`)).rows as Array<{ n: number }>;
          if ((moved?.n ?? 0) > 0) throw new PostingError(`${EGG_SIZE_LABEL[size]} already has stock movements — set its opening count on the Egg stock page instead`);
          await tx.update(items).set({ openingStock: n.toFixed(3), openingStockRate: rupees(rateP), updatedAt: new Date() }).where(eq(items.id, itemId));
        }
        say(`    set as opening stock at ₹${rupees(rateP)} a box`);
      } else {
        say(`    not used — pass --opening-stock to set it as the opening stock`);
      }
    }

    say();
    if (!APPLY) throw new DryRun();
  });
  say(`  Written. Next: scripts/continue-invoice-series.ts --apply, so the next invoice number follows the last one imported.\n`);
} catch (e) {
  if (e instanceof DryRun) say(`  Dry run — nothing written. Re-run with --apply.\n`);
  else { console.error(e); process.exitCode = 1; }
}
process.exit(process.exitCode ?? 0);
