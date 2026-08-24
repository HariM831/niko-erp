/**
 * Phase 3: invoices, posted through niko's own engine.
 *
 *   npx tsx scripts/zoho/load-invoices.ts             # say what would happen
 *   npx tsx scripts/zoho/load-invoices.ts --commit    # do it
 *
 * Totals come from Zoho verbatim rather than being recomputed. niko would
 * re-derive them under its own rounding preference and drift by a rupee per
 * document, which across 614 invoices is a reconciliation nobody can finish.
 * The journal, though, is built by the same postInvoiceJournal the application
 * uses, so an imported invoice posts exactly as one keyed in today would.
 *
 * Safe to re-run: an invoice already in zoho_id_map is skipped.
 */
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { contacts, invoiceLines, invoices, users, zohoIdMap } from "@shared/schema";
import { db, pool } from "../../server/db";
import { postInvoiceJournal } from "../../server/routes/sales";

interface ZohoLine {
  item_id?: string;
  name: string;
  description?: string;
  unit?: string;
  quantity: number;
  rate: number;
  discount_amount?: number;
  item_total: number;
  account_id?: string;
  hsn_or_sac?: string;
}

interface ZohoInvoice {
  invoice_id: string;
  invoice_number: string;
  customer_id: string;
  status: string;
  date: string;
  due_date: string;
  reference_number?: string;
  place_of_supply?: string;
  notes?: string;
  sub_total: number;
  discount_total?: number;
  adjustment?: number;
  adjustment_description?: string;
  adjustment_account_id?: string;
  discount_account_id?: string;
  total: number;
  balance: number;
  line_items: ZohoLine[];
}

/**
 * Zoho tracks overdue as a status; niko derives it from the due date, so an
 * overdue invoice is simply one that was sent and is not yet paid.
 */
const STATUS: Record<string, "draft" | "sent" | "partially_paid" | "paid" | "void"> = {
  draft: "draft",
  sent: "sent",
  viewed: "sent",
  unpaid: "sent",
  overdue: "sent",
  partially_paid: "partially_paid",
  paid: "paid",
  void: "void",
  voided: "void",
};

const money = (n: number | undefined) => (n ?? 0).toFixed(2);
const paise = (n: number | undefined) => Math.round((n ?? 0) * 100);

/**
 * Sixteen invoice lines carry no item and no description at all, and between
 * them hold ₹4.45cr of revenue. Nothing in the data names what was sold, so
 * each was identified from the rate, the date and the customer, and confirmed
 * by the user before being written down here.
 *
 * Every one of these invoices has exactly one blank line, which is why the
 * invoice number alone is enough to key on — asserted below rather than
 * assumed.
 */
const EXTRA_LARGE = "1849356000003055003"; // Eggs — Extra Large
const LAYER_BIRDS = "1849356000001634783"; // Layer Birds (Layer Commercial Bovans).

const MANUAL_ITEM: Record<string, string> = {
  // ₹1,310–1,312 to egg retailers in the same week. Egg's Large has never been
  // sold at that price; the only two lines in the whole book priced ₹1,312 are
  // Eggs — Extra Large, dated 6 Aug, to two of these same customers.
  "A-INV-EG-27-0567": EXTRA_LARGE,
  "A-INV-EG-27-0573": EXTRA_LARGE,
  "A-INV-EG-27-0576": EXTRA_LARGE,
  "A-INV-EG-27-0577": EXTRA_LARGE,
  "A-INV-EG-27-0578": EXTRA_LARGE,
  "A-INV-EG-27-0579": EXTRA_LARGE,
  "A-INV-EG-27-0584": EXTRA_LARGE,
  "A-INV-EG-27-0585": EXTRA_LARGE,
  "A-INV-EG-27-0589": EXTRA_LARGE,
  // Seven consecutive daily invoices to Nandamuri, 15–21k birds at ₹341. No
  // item was ever priced at ₹341 — the earlier bird sales are all ₹379 — which
  // is why this could not be inferred: a bird's price tracks the age it is sold
  // at, so the rate moves between batches and matches nothing on file.
  "INV-2026-27/0274": LAYER_BIRDS,
  "INV-2026-27/0275": LAYER_BIRDS,
  "INV-2026-27/0276": LAYER_BIRDS,
  "INV-2026-27/0277": LAYER_BIRDS,
  "INV-2026-27/0278": LAYER_BIRDS,
  "INV-2026-27/0279": LAYER_BIRDS,
  "INV-2026-27/0280": LAYER_BIRDS,
};

/**
 * How a document-level discount reaches the ledger.
 *
 * Zoho lets a discount sit on the invoice header and posts it to a Discount
 * account of its own. niko has no header discount — its posting credits
 * revenue with the sum of the lines — so the first attempt spread it across
 * them instead. That balanced, but it classified the money differently from
 * Zoho: ₹50 came off Sales rather than landing in Discount, and the two
 * ledgers disagreed on an income account while agreeing on the total.
 *
 * A discount is just a negative adjustment: a signed amount posted to a named
 * account, which niko already models. One invoice in 614 has one.
 */
function discountAsAdjustment(inv: ZohoInvoice) {
  const discountP = Math.round(Number(inv.discount_total ?? 0) * 100);
  const adjustmentP = Math.round(Number(inv.adjustment ?? 0) * 100);
  if (!discountP) return { amountP: adjustmentP, accountId: inv.adjustment_account_id ?? null };
  if (adjustmentP) {
    // Both would need two extra postings and niko has one slot. No invoice in
    // these books does it; refuse rather than silently drop one.
    throw new Error(
      `${inv.invoice_number} carries both a header discount and an adjustment, which cannot both be represented`,
    );
  }
  return { amountP: -discountP, accountId: inv.discount_account_id ?? null };
}

async function main() {
  const commit = process.argv.includes("--commit");
  const raw = await readFile(".zoho-dump/detail/invoices.jsonl", "utf8");
  const all: ZohoInvoice[] = raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

  // Oldest first, and a stable tiebreak so a re-run walks them in the same
  // order — which is what makes generated numbering reproducible downstream.
  all.sort((a, b) => a.date.localeCompare(b.date) || a.invoice_id.localeCompare(b.invoice_id));

  const idsOf = async (entity: string) =>
    new Map(
      (
        await db
          .select({ zohoId: zohoIdMap.zohoId, eggsyId: zohoIdMap.eggsyId })
          .from(zohoIdMap)
          .where(eq(zohoIdMap.entity, entity))
      ).map((r) => [r.zohoId, r.eggsyId]),
    );
  const contactFor = await idsOf("contact");
  const itemFor = await idsOf("item");
  const accountFor = await idsOf("account");
  const done = await idsOf("invoice");

  /**
   * Revenue is classified by what was sold, not by what the data-entry left
   * blank.
   *
   * Zoho falls back to a catch-all "Sales" account whenever an invoice line
   * names none, and in these books that swallowed ₹14.58cr — 192 lines of
   * Egg's Large, 10 of Poultry Feed, 2 of Layer Birds — while identical lines
   * on other invoices went to Eggs (Sales), feed and Chicks(Sales). The split
   * is an artefact of who typed the invoice, not a fact about the business.
   *
   * So a line sitting on the catch-all is re-pointed at its item's own default
   * account. A line that explicitly chose some other account is left alone, and
   * a line with no item has nothing to go on and stays where it is.
   *
   * The consequence, accepted deliberately: niko's revenue accounts no longer
   * match Zoho's P&L account by account. Total revenue is identical, and that
   * is what reconciliation checks.
   */
  const CATCH_ALL_SALES = "1849356000000000486";
  const itemDefaultAccount = new Map<string, string>();
  for (const line of (await readFile(".zoho-dump/detail/items.jsonl", "utf8")).trim().split("\n")) {
    if (!line.trim()) continue;
    const it = JSON.parse(line) as { item_id: string; account_id?: string };
    if (it.account_id) itemDefaultAccount.set(it.item_id, it.account_id);
  }

  /** The item a line is for: its own, or the one identified for a blank line. */
  const itemForLine = (invoiceNumber: string, l: ZohoLine): string | undefined =>
    l.item_id || MANUAL_ITEM[invoiceNumber];

  /** The Zoho account a line should post to, after the corrections above. */
  const accountForLine = (invoiceNumber: string, l: ZohoLine): string | undefined => {
    const item = itemForLine(invoiceNumber, l);
    if (item && (!l.account_id || l.account_id === CATCH_ALL_SALES)) {
      return itemDefaultAccount.get(item) ?? l.account_id;
    }
    return l.account_id;
  };
  let reclassified = 0;
  let identified = 0;

  // The manual list keys on the invoice number, which is only safe while each
  // of those invoices has exactly one line missing an item.
  for (const inv of all) {
    if (!MANUAL_ITEM[inv.invoice_number]) continue;
    const blanks = (inv.line_items ?? []).filter((l) => !l.item_id).length;
    if (blanks !== 1) {
      throw new Error(
        `${inv.invoice_number} has ${blanks} lines without an item; the manual classification ` +
          `assumes exactly one and cannot say which it means`,
      );
    }
  }

  const todo = all.filter((i) => !done.has(i.invoice_id));

  const problems: string[] = [];
  for (const inv of todo) {
    if (!contactFor.has(inv.customer_id)) {
      problems.push(`${inv.invoice_number}: customer ${inv.customer_id} not imported`);
    }
    if (!STATUS[inv.status]) problems.push(`${inv.invoice_number}: unknown status "${inv.status}"`);
    for (const l of inv.line_items ?? []) {
      if (l.item_id && !itemFor.has(l.item_id)) {
        problems.push(`${inv.invoice_number}: item ${l.item_id} not imported`);
      }
      const resolved = accountForLine(inv.invoice_number, l);
      if (resolved && !accountFor.has(resolved)) {
        problems.push(`${inv.invoice_number}: account ${resolved} not imported`);
      }
    }
    if (Number(inv.adjustment ?? 0) !== 0 && !accountFor.has(inv.adjustment_account_id ?? "")) {
      problems.push(`${inv.invoice_number}: adjustment account not imported`);
    }
  }
  if (problems.length) {
    throw new Error(`Cannot import — unresolved references:\n  ${problems.slice(0, 20).join("\n  ")}`);
  }

  const totalValue = todo.reduce((s, i) => s + Number(i.total), 0);
  console.log(`${all.length} invoices — ${todo.length} to import, ${done.size} already done`);
  console.log(`  value ${totalValue.toLocaleString("en-IN")}`);
  console.log(`  dates ${todo[0]?.date} .. ${todo[todo.length - 1]?.date}`);
  console.log(`  lines ${todo.reduce((s, i) => s + (i.line_items?.length ?? 0), 0)}`);
  console.log(`  with an adjustment ${todo.filter((i) => Number(i.adjustment ?? 0) !== 0).length}`);
  const wouldMove = todo.flatMap((i) =>
    (i.line_items ?? []).filter(
      (l) =>
        accountForLine(i.invoice_number, l) &&
        accountForLine(i.invoice_number, l) !== l.account_id,
    ),
  );
  console.log(
    `  lines re-pointed from the catch-all to their item's account: ${wouldMove.length}` +
      ` (${wouldMove.reduce((s, l) => s + Number(l.item_total ?? 0), 0).toLocaleString("en-IN")})`,
  );

  if (!commit) {
    console.log("\nDry run — nothing written. Re-run with --commit to apply.");
    await pool.end();
    return;
  }

  const [admin] = await db.select({ id: users.id }).from(users).limit(1);
  if (!admin) throw new Error("No user to attribute the import to");

  let posted = 0;
  await db.transaction(async (tx) => {
    for (const inv of todo) {
      const customerId = contactFor.get(inv.customer_id)!;
      const adj = discountAsAdjustment(inv);
      const [row] = await tx
        .insert(invoices)
        .values({
          number: inv.invoice_number,
          customerId,
          status: STATUS[inv.status]!,
          invoiceDate: inv.date,
          dueDate: inv.due_date || inv.date,
          reference: inv.reference_number?.trim() || null,
          placeOfSupplyState: inv.place_of_supply?.slice(0, 4) || null,
          subTotal: money(inv.sub_total),
          discountTotal: money(inv.discount_total),
          // Nothing in these books carries tax or round-off; both were verified
          // zero across all 614 invoices before this was written.
          cgst: "0",
          sgst: "0",
          igst: "0",
          adjustment: (adj.amountP / 100).toFixed(2),
          adjustmentAccountId: adj.amountP !== 0 ? (accountFor.get(adj.accountId ?? "") ?? null) : null,
          adjustmentDescription:
            adj.amountP < 0 && Number(inv.discount_total ?? 0) !== 0
              ? "Discount"
              : inv.adjustment_description?.trim() || null,
          roundOff: "0",
          total: money(inv.total),
          balanceDue: money(inv.balance),
          customerNotes: inv.notes?.trim() || null,
          createdBy: admin.id,
        })
        .returning();

      const src = inv.line_items ?? [];
      const lines = src.map((l, i) => ({
        invoiceId: row!.id,
        itemId: (() => {
          const item = itemForLine(inv.invoice_number, l);
          if (item && !l.item_id) identified += 1;
          return item ? (itemFor.get(item) ?? null) : null;
        })(),
        accountId: (() => {
          const target = accountForLine(inv.invoice_number, l);
          if (target && target !== l.account_id) reclassified += 1;
          return target ? (accountFor.get(target) ?? null) : null;
        })(),
        name: l.name?.trim() || "Item",
        description: l.description?.trim() || null,
        hsnOrSac: l.hsn_or_sac?.trim().slice(0, 10) || null,
        quantity: String(l.quantity ?? 0),
        unit: l.unit?.trim().slice(0, 20) || null,
        rate: money(l.rate),
        discountPercent: "0",
        taxAmount: "0",
        // Already net of any line discount, which is what niko's `amount`
        // means. A header discount is not netted here — it posts to its own
        // account through the adjustment.
        amount: money(l.item_total),
        lineOrder: i,
      }));
      if (lines.length) await tx.insert(invoiceLines).values(lines);

      // The posting credits revenue with the sum of the lines and debits the
      // receivable with the total, so a mismatch here is a silent imbalance
      // waiting to be found. Cheaper to catch it on the document than in a
      // trial balance three thousand rows later.
      const lineSum = lines.reduce((s, l) => s + paise(Number(l.amount)), 0);
      const expected = paise(inv.total) - adj.amountP;
      if (lineSum !== expected) {
        throw new Error(
          `${inv.invoice_number}: lines total ${lineSum / 100} but the invoice, less its ` +
            `adjustment, is ${expected / 100}`,
        );
      }

      const [customer] = await tx
        .select({ displayName: contacts.displayName })
        .from(contacts)
        .where(eq(contacts.id, customerId))
        .limit(1);

      // Void invoices never posted in Zoho and must not post here.
      if (STATUS[inv.status] !== "void" && STATUS[inv.status] !== "draft") {
        const jeId = await postInvoiceJournal(tx, row!, customer?.displayName ?? "", admin.id);
        await tx.update(invoices).set({ journalEntryId: jeId }).where(eq(invoices.id, row!.id));
        posted += 1;
      }

      await tx.insert(zohoIdMap).values({
        entity: "invoice",
        zohoId: inv.invoice_id,
        eggsyId: row!.id,
        label: inv.invoice_number,
      });
    }
  });

  console.log(`\nCommitted ${todo.length} invoices, ${posted} posted to the ledger.`);
  await pool.end();
}

main().catch(async (err) => {
  console.error(`\n${err.message}`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
