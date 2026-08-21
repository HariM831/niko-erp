/**
 * What Amino owes an owner, and what the owner owes Amino.
 *
 * Nandamuri owns L2–L3 and Luit Valley owns L4–L5; the rearing houses are
 * Amino's. So a batch crosses an ownership line when it is housed, and three
 * things pass between the two companies each month:
 *
 *   feed   Amino sells it to them, at what the mill made it for
 *   birds  Amino sells them the pullets on the day they are housed
 *   eggs   Amino buys the eggs back, at the benchmark plus an agreed spread
 *
 * Feed and birds go on ONE invoice, eggs on ONE bill, per owner per month. A
 * shed takes feed several times a week and lays every day; a document per
 * event would bury the office in paper for no gain.
 *
 * `draftMonth` computes and posts nothing. That separation is the point: the
 * figures can be read, argued with and corrected before anything reaches the
 * books, and a period that has been billed is recorded in `owner_billing_runs`
 * so the same feed cannot be invoiced twice.
 */
import { and, asc, desc, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";
import {
  birdValuationRates,
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
  ownerAgreements,
  ownerBillingRuns,
  placementDays,
} from "@shared/schema";
import type { db as Db } from "../db";
import { PostingError } from "./posting";
import { applyDefaultSalesAccounts, computeDocumentTotals, type DocLineInput } from "./documents";
import { createBill } from "./purchases";
import { getPreferences } from "./preferences";
import { nextDocumentNumber } from "../lib/numbering";
import { computeDueDate, loadCustomer, postInvoiceJournal } from "../routes/sales";

type Tx = Parameters<Parameters<typeof Db.transaction>[0]>[0];
type Conn = Tx | typeof Db;

const n = (v: string | number | null | undefined) => (v == null ? 0 : Number(v));

/** The first of the month, and the first of the next one. */
export function monthBounds(period: string) {
  const from = `${period.slice(0, 7)}-01`;
  const d = new Date(`${from}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  const next = d.toISOString().slice(0, 10);
  const to = new Date(Date.parse(`${next}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  return { from, to, next };
}

/**
 * The agreement in force on a date — the latest one starting on or before it.
 *
 * Effective-dated rather than a single current value, because a spread
 * renegotiated in March must not restate January. January is closed.
 */
export async function agreementOn(tx: Conn, contactId: string, on: string) {
  const [row] = await tx
    .select()
    .from(ownerAgreements)
    .where(and(eq(ownerAgreements.contactId, contactId), lte(ownerAgreements.effectiveFrom, on)))
    .orderBy(desc(ownerAgreements.effectiveFrom))
    .limit(1);
  return row ?? null;
}

/** The benchmark egg price in force on a date. */
export async function eggBenchmarkOn(tx: Conn, on: string) {
  const [row] = await tx
    .select()
    .from(eggBenchmarkPrices)
    .where(lte(eggBenchmarkPrices.effectiveFrom, on))
    .orderBy(desc(eggBenchmarkPrices.effectiveFrom))
    .limit(1);
  return row ?? null;
}

/** What a bird of this breed is worth at this age, on this date. */
export async function birdRateOn(tx: Conn, breedId: string, ageWeek: number, on: string) {
  const [row] = await tx
    .select()
    .from(birdValuationRates)
    .where(
      and(
        eq(birdValuationRates.breedId, breedId),
        eq(birdValuationRates.ageWeek, ageWeek),
        lte(birdValuationRates.effectiveFrom, on),
      ),
    )
    .orderBy(desc(birdValuationRates.effectiveFrom))
    .limit(1);
  return row ?? null;
}

/**
 * The rate for any day in a range: that day's benchmark plus that day's spread.
 *
 * Both are effective-dated and carried forward, so a rate entered on the 3rd
 * prices the 3rd through to whenever the next one starts. Resolved once for the
 * whole range and answered from memory — a query per day would be thirty-one
 * round trips per house to say the same thing.
 *
 * Returns null for a day with no benchmark in force. Null, not zero: eggs
 * bought before anybody entered a price are unpriced, not free.
 */
export async function dailyEggRate(
  tx: Conn,
  contactId: string,
  from: string,
  to: string,
): Promise<(day: string) => number | null> {
  // Everything effective on or before the end of the range, newest first, so
  // the first row at or below a day is the one in force on it.
  const marks = await tx
    .select({ on: eggBenchmarkPrices.effectiveFrom, rate: eggBenchmarkPrices.ratePerEgg })
    .from(eggBenchmarkPrices)
    .where(lte(eggBenchmarkPrices.effectiveFrom, to))
    .orderBy(desc(eggBenchmarkPrices.effectiveFrom));

  const spreads = await tx
    .select({ on: ownerAgreements.effectiveFrom, spread: ownerAgreements.eggSpreadPerEgg })
    .from(ownerAgreements)
    .where(and(eq(ownerAgreements.contactId, contactId), lte(ownerAgreements.effectiveFrom, to)))
    .orderBy(desc(ownerAgreements.effectiveFrom));

  void from;
  return (day: string) => {
    const mark = marks.find((m) => m.on <= day);
    if (!mark) return null;
    const spread = spreads.find((s) => s.on <= day);
    // No agreement is a missing term, not a zero spread — the caller reports it.
    if (!spread) return null;
    return n(mark.rate) + n(spread.spread);
  };
}

export interface DraftLine {
  kind: "feed" | "birds" | "eggs";
  description: string;
  qty: number;
  unit: string;
  rate: number | null;
  amount: number | null;
  itemId?: string;
  /** Why this line cannot be priced. A line with one of these must not post. */
  problem?: string;
}

export interface OwnerDraft {
  owner: { id: string; name: string };
  period: string;
  from: string;
  to: string;
  /** Amino → owner. Feed and the pullets they were sold. */
  invoiceLines: DraftLine[];
  /** Owner → Amino. The eggs. */
  billLines: DraftLine[];
  invoiceTotal: number;
  billTotal: number;
  /*
   * No net here, deliberately.
   *
   * The invoice is a receivable and the bill is a payable; each stands on its
   * own and settles on its own terms. What the two come to together is the
   * owner's LEDGER position — it moves with every payment, credit note and
   * other transaction on that contact, and a figure worked out from one month's
   * two documents would be a different number wearing the same name.
   */
  /** Already billed — the run that did it. */
  billed: { invoiceId: string | null; billId: string | null; at: Date } | null;
  problems: string[];
}

/** Every contact that owns at least one house. */
export async function owners(tx: Conn) {
  return tx
    .selectDistinct({ id: contacts.id, name: contacts.displayName })
    .from(houses)
    .innerJoin(contacts, eq(contacts.id, houses.ownerId))
    .orderBy(asc(contacts.displayName));
}

/**
 * What one owner's month comes to. Reads only; posts nothing.
 */
export async function draftMonth(tx: Conn, contactId: string, period: string): Promise<OwnerDraft> {
  const { from, to } = monthBounds(period);

  const [owner] = await tx
    .select({ id: contacts.id, name: contacts.displayName })
    .from(contacts)
    .where(eq(contacts.id, contactId));
  if (!owner) throw new PostingError("No such owner");

  const theirs = await tx
    .select({ id: houses.id, code: houses.code })
    .from(houses)
    .where(eq(houses.ownerId, contactId));
  if (!theirs.length) {
    throw new PostingError(`${owner.name} does not own any house`);
  }
  const houseIds = theirs.map((h) => h.id);
  const codeOf = new Map(theirs.map((h) => [h.id, h.code]));

  const agreement = await agreementOn(tx, contactId, to);
  const problems: string[] = [];
  const invoiceLines: DraftLine[] = [];
  const billLines: DraftLine[] = [];

  /* ── Feed sold to them ────────────────────────────────────────────────── */
  //
  // At what the mill made it for — the rate stamped on the transfer, which
  // already carries the ₹1/kg milling charge and the 1% the mill loses. An
  // agreement may override it with a fixed rate.
  const feed = await tx
    .select({
      itemId: feedTransfers.itemId,
      itemName: items.name,
      kg: sql<string>`sum(${feedTransfers.quantityKg})`,
      value: sql<string>`sum(coalesce(${feedTransfers.value}, 0))`,
      unpriced: sql<number>`sum(CASE WHEN ${feedTransfers.value} IS NULL THEN 1 ELSE 0 END)::int`,
    })
    .from(feedTransfers)
    .innerJoin(items, eq(items.id, feedTransfers.itemId))
    .where(
      and(
        inArray(feedTransfers.toHouseId, houseIds),
        gte(feedTransfers.transferDate, from),
        lte(feedTransfers.transferDate, to),
        ne(feedTransfers.status, "void"),
      ),
    )
    .groupBy(feedTransfers.itemId, items.name);

  for (const f of feed) {
    const kg = n(f.kg);
    if (kg <= 0) continue;
    const fixed = agreement?.feedRatePerKg == null ? null : n(agreement.feedRatePerKg);
    const rate = fixed ?? (n(f.value) > 0 ? n(f.value) / kg : null);
    const problem =
      rate == null
        ? `${f.itemName} was delivered without a cost, so it cannot be priced`
        : f.unpriced > 0
          ? `${f.unpriced} ${f.itemName} transfer(s) had no value — the rate is an average of the rest`
          : undefined;
    if (problem && rate == null) problems.push(problem);
    invoiceLines.push({
      kind: "feed",
      description: f.itemName,
      qty: kg,
      unit: "kg",
      rate,
      amount: rate == null ? null : kg * rate,
      itemId: f.itemId,
      problem,
    });
  }

  /* ── Pullets sold to them ─────────────────────────────────────────────── */
  //
  // Only birds arriving from a house Amino owns. A move between two of the
  // owner's own sheds is theirs to make and nobody's to bill; a move from
  // another company's shed is not Amino's to sell.
  const arrivals = await tx
    .select({
      day: flockMovements.eventDate,
      qty: flockMovements.qty,
      houseId: flockPlacements.houseId,
      flockCode: flocks.code,
      breedId: flocks.breedId,
      hatchDate: flocks.hatchDate,
      fromOwner: sql<string | null>`(
        SELECT h.owner_id::text FROM flock_placements fp
        JOIN houses h ON h.id = fp.house_id
        WHERE fp.id = ${flockMovements.counterpartPlacementId})`,
    })
    .from(flockMovements)
    .innerJoin(flockPlacements, eq(flockPlacements.id, flockMovements.placementId))
    .innerJoin(flocks, eq(flocks.id, flockPlacements.flockId))
    .where(
      and(
        inArray(flockPlacements.houseId, houseIds),
        eq(flockMovements.kind, "transfer_in"),
        gte(flockMovements.eventDate, from),
        lte(flockMovements.eventDate, to),
      ),
    )
    .orderBy(asc(flockMovements.eventDate));

  for (const a of arrivals) {
    // Amino's houses carry no owner contact — Amino is the org, not a contact.
    if (a.fromOwner !== null) continue;
    const ageWeek =
      Math.floor(
        (Date.parse(`${a.day}T00:00:00Z`) - Date.parse(`${a.hatchDate}T00:00:00Z`)) / 86_400_000 / 7,
      ) + 1;
    const valuation = await birdRateOn(tx, a.breedId, ageWeek, a.day);
    const rate = valuation ? n(valuation.rate) : null;
    const problem = rate == null ? `No bird valuation for week ${ageWeek} on ${a.day}` : undefined;
    if (problem) problems.push(problem);
    invoiceLines.push({
      kind: "birds",
      description: `${a.flockCode} — ${a.qty.toLocaleString("en-IN")} pullets into ${codeOf.get(a.houseId)} at ${ageWeek} weeks`,
      qty: a.qty,
      unit: "birds",
      rate,
      amount: rate == null ? null : a.qty * rate,
      problem,
    });
  }

  /* ── Eggs bought from them ────────────────────────────────────────────── */
  //
  // Priced at the benchmark of the DAY THEY WERE LAID, not one rate for the
  // month. Egg prices move daily; charging a month at its closing rate quietly
  // rewrites what every earlier day was worth.
  const eggDays = await tx
    .select({
      day: placementDays.day,
      houseId: flockPlacements.houseId,
      eggs: placementDays.eggsTotal,
    })
    .from(placementDays)
    .innerJoin(flockPlacements, eq(flockPlacements.id, placementDays.placementId))
    .where(
      and(
        inArray(flockPlacements.houseId, houseIds),
        gte(placementDays.day, from),
        lte(placementDays.day, to),
      ),
    )
    .orderBy(asc(placementDays.day));

  const rateFor = await dailyEggRate(tx, contactId, from, to);
  if (eggDays.some((d) => (d.eggs ?? 0) > 0)) {
    const anyPriced = eggDays.some((d) => (d.eggs ?? 0) > 0 && rateFor(d.day) != null);
    if (!anyPriced) {
      problems.push(`No egg benchmark price is in force during ${from.slice(0, 7)}`);
      if (!agreement) problems.push(`${owner.name} has no agreement, so the egg spread is unknown`);
    }
  }

  /**
   * One line per house per RATE.
   *
   * A month at a steady price is one line per house, as before. A month where
   * the benchmark moved twice is three, each showing the rate it was actually
   * bought at — which is the only way the line and the amount agree. The
   * day-by-day working is on the statement attached to the bill.
   */
  const buckets = new Map<string, { houseId: string; rate: number | null; qty: number; days: string[] }>();
  for (const d of eggDays) {
    const count = d.eggs ?? 0;
    if (count <= 0) continue;
    const rate = rateFor(d.day);
    const key = `${d.houseId}|${rate ?? "none"}`;
    const b = buckets.get(key) ?? { houseId: d.houseId, rate, qty: 0, days: [] };
    b.qty += count;
    b.days.push(d.day);
    buckets.set(key, b);
  }

  for (const b of [...buckets.values()].sort((x, y) => (x.days[0] ?? "").localeCompare(y.days[0] ?? ""))) {
    const span =
      b.days.length === 1
        ? b.days[0]!
        : `${b.days[0]} to ${b.days[b.days.length - 1]}`;
    billLines.push({
      kind: "eggs",
      description:
        buckets.size > theirs.length
          ? `Eggs from ${codeOf.get(b.houseId)} — ${span}`
          : `Eggs from ${codeOf.get(b.houseId)}`,
      qty: b.qty,
      unit: "eggs",
      rate: b.rate,
      amount: b.rate == null ? null : b.qty * b.rate,
      problem:
        b.rate == null
          ? `No benchmark price was in force on ${span} — those eggs cannot be priced`
          : undefined,
    });
  }

  const sum = (ls: DraftLine[]) => ls.reduce((s, l) => s + (l.amount ?? 0), 0);
  const invoiceTotal = sum(invoiceLines);
  const billTotal = sum(billLines);

  const [run] = await tx
    .select()
    .from(ownerBillingRuns)
    .where(and(eq(ownerBillingRuns.contactId, contactId), eq(ownerBillingRuns.period, from)));

  return {
    owner,
    period: from,
    from,
    to,
    invoiceLines,
    billLines,
    invoiceTotal,
    billTotal,
    billed: run ? { invoiceId: run.invoiceId, billId: run.billId, at: run.createdAt } : null,
    problems: [...new Set(problems)],
  };
}

/** Every owner's month, for the review screen. */
export async function draftAll(tx: Conn, period: string) {
  const list = await owners(tx);
  const drafts: OwnerDraft[] = [];
  for (const o of list) drafts.push(await draftMonth(tx, o.id, period));
  return drafts;
}



/* ── Raising the documents ────────────────────────────────────────────────── */

/**
 * Turn a month's draft into an invoice and a bill.
 *
 * Refuses rather than guesses. A month already billed, a line that cannot be
 * priced, an item setting nobody has chosen — each stops the whole run, because
 * a half-billed month is worse than an unbilled one: the second attempt has no
 * way to know which half was done.
 *
 * Both documents post. A bill in this app has no draft state, and a posted
 * invoice against an unposted bill would show the owner owing Amino a gross
 * amount that the eggs were meant to offset.
 */
export async function raiseMonth(
  tx: Tx,
  contactId: string,
  period: string,
  userId: string,
): Promise<{
  draft: OwnerDraft;
  invoiceId: string | null;
  billId: string | null;
  /** The supporting statement, for the caller to attach once it has committed. */
  statement: string;
}> {
  const draft = await draftMonth(tx, contactId, period);
  const { from, to } = monthBounds(period);

  if (draft.billed) {
    throw new PostingError(
      `${draft.owner.name} has already been billed for ${from.slice(0, 7)}. Void the invoice and the bill first if it needs redoing.`,
    );
  }
  if (draft.problems.length) {
    throw new PostingError(
      `${draft.owner.name}'s ${from.slice(0, 7)} cannot be billed yet — ${draft.problems.join("; ")}`,
    );
  }
  if (!draft.invoiceLines.length && !draft.billLines.length) {
    throw new PostingError(`Nothing passed between Amino and ${draft.owner.name} in ${from.slice(0, 7)}`);
  }

  const prefs = await getPreferences(tx);
  if (draft.invoiceLines.some((l) => l.kind === "birds") && !prefs.birdSaleItemId) {
    throw new PostingError("Pullets were housed, but no bird item is set to bill them as");
  }
  if (draft.billLines.length && !prefs.eggPurchaseItemId) {
    throw new PostingError("Eggs were collected, but no egg item is set to bill them as");
  }

  // Dated the last day of the month it covers: the trade happened in that
  // month, and dating it "today" would push December's feed into January.
  const docDate = to;

  /* ── Amino → owner: feed and pullets ──────────────────────────────────── */
  let invoiceId: string | null = null;
  if (draft.invoiceLines.length) {
    const customer = await loadCustomer(tx, contactId);
    const lines: DocLineInput[] = draft.invoiceLines.map((l) => ({
      itemId: l.kind === "feed" ? l.itemId : (prefs.birdSaleItemId ?? undefined),
      name: l.description,
      quantity: l.qty.toFixed(3),
      unit: l.unit,
      rate: (l.rate ?? 0).toFixed(4),
    }));
    const totals = await computeDocumentTotals(tx, lines, customer.placeOfSupplyState);
    const number = await nextDocumentNumber(tx, "invoice");
    const [inv] = await tx
      .insert(invoices)
      .values({
        number,
        customerId: customer.id,
        status: "draft",
        invoiceDate: docDate,
        dueDate: computeDueDate(docDate, customer.paymentTermsDays),
        reference: `Farm ${from.slice(0, 7)}`,
        placeOfSupplyState: customer.placeOfSupplyState,
        subTotal: totals.subTotal,
        discountTotal: totals.discountTotal,
        cgst: totals.cgst,
        sgst: totals.sgst,
        igst: totals.igst,
        roundOff: totals.roundOff,
        total: totals.total,
        balanceDue: totals.total,
        customerNotes: `Feed and pullets supplied to ${draft.owner.name}'s sheds, ${from} to ${to}.`,
        createdBy: userId,
      })
      .returning();
    const withAccounts = await applyDefaultSalesAccounts(tx, totals.lines);
    await tx.insert(invoiceLines).values(withAccounts.map((l) => ({ ...l, invoiceId: inv!.id })));

    const jeId = await postInvoiceJournal(tx, inv!, customer.displayName, userId);
    await tx
      .update(invoices)
      .set({ status: "sent", journalEntryId: jeId })
      .where(eq(invoices.id, inv!.id));
    invoiceId = inv!.id;
  }

  /* ── Owner → Amino: the eggs ──────────────────────────────────────────── */
  let billId: string | null = null;
  if (draft.billLines.length) {
    const [vendor] = await tx.select().from(contacts).where(eq(contacts.id, contactId));
    if (!vendor) throw new PostingError("No such owner");
    if (!["vendor", "both"].includes(vendor.type)) {
      throw new PostingError(
        `${vendor.displayName} is not set up as a vendor, so Amino cannot buy their eggs`,
      );
    }
    const bill = await createBill(tx, {
      vendor,
      billDate: docDate,
      reference: `Farm ${from.slice(0, 7)}`,
      notes: `Eggs bought from ${draft.owner.name}'s sheds, ${from} to ${to}.`,
      lines: draft.billLines.map((l) => ({
        itemId: prefs.eggPurchaseItemId ?? undefined,
        name: l.description,
        quantity: l.qty.toFixed(3),
        unit: l.unit,
        rate: (l.rate ?? 0).toFixed(4),
      })),
      postedBy: userId,
    });
    billId = bill.id;
  }

  // Recorded LAST, so a failure anywhere above leaves no trace of a month
  // having been billed. The unique index on (contact, period) is what actually
  // stops a second run; this row is how the screen knows.
  await tx.insert(ownerBillingRuns).values({
    contactId,
    period: from,
    invoiceId,
    billId,
    feedKg: draft.invoiceLines
      .filter((l) => l.kind === "feed")
      .reduce((s, l) => s + l.qty, 0)
      .toFixed(3),
    birds: draft.invoiceLines.filter((l) => l.kind === "birds").reduce((s, l) => s + l.qty, 0),
    eggs: draft.billLines.reduce((s, l) => s + l.qty, 0),
    createdBy: userId,
  });

  // Built LAST, from the same transaction, so it describes exactly what was
  // billed. The caller writes it to disk after committing — a file written
  // inside a transaction survives a rollback and leaves an orphan behind.
  const statement = await monthStatement(tx, contactId, period);
  return { draft, invoiceId, billId, statement };
}

/* ── The supporting statement ─────────────────────────────────────────────── */

/**
 * Every delivery, housing and day's lay behind the month's two documents.
 *
 * The invoice says "Layer Mash, 40,429 kg". This says which lorries, on which
 * days, at which rate — so a total nobody can take apart becomes one anybody
 * can check. It is a SNAPSHOT, attached to the documents when they are raised:
 * the underlying records can be corrected afterwards, and a statement that
 * silently followed them would stop explaining the invoice it is attached to.
 */
export async function monthStatement(
  tx: Conn,
  contactId: string,
  period: string,
): Promise<string> {
  const { from, to } = monthBounds(period);
  const [owner] = await tx
    .select({ name: contacts.displayName })
    .from(contacts)
    .where(eq(contacts.id, contactId));
  const theirs = await tx
    .select({ id: houses.id, code: houses.code })
    .from(houses)
    .where(eq(houses.ownerId, contactId));
  const houseIds = theirs.map((h) => h.id);
  const codeOf = new Map(theirs.map((h) => [h.id, h.code]));

  // Excel opens a CSV without being asked, which is what the office actually
  // does with this. A PDF would look better and be harder to check a total in.
  const rows: string[][] = [];
  const cell = (v: string | number | null | undefined) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const line = (...cells: Array<string | number | null | undefined>) => rows.push(cells.map(cell));

  line(`${owner?.name ?? "Owner"} — supporting statement`);
  line("Period", `${from} to ${to}`);
  line("Sheds", theirs.map((h) => h.code).join(" "));
  line();

  /* ── Everything the month touched ─────────────────────────────────────── */
  const feed = houseIds.length
    ? await tx
        .select({
          day: feedTransfers.transferDate,
          number: feedTransfers.number,
          house: feedTransfers.toHouseId,
          item: items.name,
          kg: feedTransfers.quantityKg,
          rate: feedTransfers.ratePerKg,
          value: feedTransfers.value,
        })
        .from(feedTransfers)
        .innerJoin(items, eq(items.id, feedTransfers.itemId))
        .where(
          and(
            inArray(feedTransfers.toHouseId, houseIds),
            gte(feedTransfers.transferDate, from),
            lte(feedTransfers.transferDate, to),
            ne(feedTransfers.status, "void"),
          ),
        )
        .orderBy(asc(feedTransfers.transferDate), asc(feedTransfers.number))
    : [];

  const days = houseIds.length
    ? await tx
        .select({
          day: placementDays.day,
          house: flockPlacements.houseId,
          flock: flocks.code,
          eggs: placementDays.eggsTotal,
          cracked: placementDays.eggsCracked,
        })
        .from(placementDays)
        .innerJoin(flockPlacements, eq(flockPlacements.id, placementDays.placementId))
        .innerJoin(flocks, eq(flocks.id, flockPlacements.flockId))
        .where(
          and(
            inArray(flockPlacements.houseId, houseIds),
            gte(placementDays.day, from),
            lte(placementDays.day, to),
          ),
        )
        .orderBy(asc(placementDays.day))
    : [];

  const arrivals = houseIds.length
    ? await tx
        .select({
          day: flockMovements.eventDate,
          qty: flockMovements.qty,
          house: flockPlacements.houseId,
          flock: flocks.code,
          breedId: flocks.breedId,
          hatchDate: flocks.hatchDate,
          fromOwner: sql<string | null>`(
            SELECT h.owner_id::text FROM flock_placements fp
            JOIN houses h ON h.id = fp.house_id
            WHERE fp.id = ${flockMovements.counterpartPlacementId})`,
        })
        .from(flockMovements)
        .innerJoin(flockPlacements, eq(flockPlacements.id, flockMovements.placementId))
        .innerJoin(flocks, eq(flocks.id, flockPlacements.flockId))
        .where(
          and(
            inArray(flockPlacements.houseId, houseIds),
            eq(flockMovements.kind, "transfer_in"),
            gte(flockMovements.eventDate, from),
            lte(flockMovements.eventDate, to),
          ),
        )
        .orderBy(asc(flockMovements.eventDate))
    : [];

  const rateFor = await dailyEggRate(tx, contactId, from, to);
  const ageWeekOn = (day: string, hatchDate: string) =>
    Math.floor(
      (Date.parse(`${day}T00:00:00Z`) - Date.parse(`${hatchDate}T00:00:00Z`)) / 86_400_000 / 7,
    ) + 1;

  /* ── The day-wise table ───────────────────────────────────────────────── */
  //
  // Every day of the month gets a row, quiet ones included. A statement that
  // skips a day leaves the reader unable to tell "nothing happened" from
  // "nobody wrote it down", and those are very different conversations.
  interface DayRow {
    feedKg: number;
    feedValue: number;
    eggs: number;
    eggValue: number;
    rate: number | null;
    birds: number;
    birdValue: number;
  }
  const blank = (): DayRow => ({
    feedKg: 0,
    feedValue: 0,
    eggs: 0,
    eggValue: 0,
    rate: null,
    birds: 0,
    birdValue: 0,
  });
  const byDay = new Map<string, DayRow>();
  const dayOf = (d: string) => {
    const row = byDay.get(d) ?? blank();
    byDay.set(d, row);
    return row;
  };
  const nextDay = (iso: string) =>
    new Date(Date.parse(`${iso}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  for (let d = from; d <= to; d = nextDay(d)) dayOf(d);

  for (const f of feed) {
    const r = dayOf(f.day);
    r.feedKg += n(f.kg);
    r.feedValue += n(f.value);
  }
  for (const d of days) {
    const count = d.eggs ?? 0;
    if (!count) continue;
    const r = dayOf(d.day);
    r.eggs += count;
    r.rate = rateFor(d.day);
    r.eggValue += r.rate == null ? 0 : count * r.rate;
  }
  const fromAmino = arrivals.filter((a) => a.fromOwner === null);
  for (const a of fromAmino) {
    const v = await birdRateOn(tx, a.breedId, ageWeekOn(a.day, a.hatchDate), a.day);
    const r = dayOf(a.day);
    r.birds += a.qty;
    r.birdValue += v ? a.qty * n(v.rate) : 0;
  }

  line("DAY BY DAY");
  line(
    "Date",
    "Feed kg",
    "Feed sold",
    "Pullets",
    "Pullets sold",
    "Eggs",
    "Rate/egg",
    "Eggs bought",
  );
  const totals = blank();
  for (const day of [...byDay.keys()].sort()) {
    const r = byDay.get(day)!;
    totals.feedKg += r.feedKg;
    totals.feedValue += r.feedValue;
    totals.eggs += r.eggs;
    totals.eggValue += r.eggValue;
    totals.birds += r.birds;
    totals.birdValue += r.birdValue;
    line(
      day,
      r.feedKg ? r.feedKg.toFixed(2) : "",
      r.feedValue ? r.feedValue.toFixed(2) : "",
      r.birds || "",
      r.birdValue ? r.birdValue.toFixed(2) : "",
      r.eggs || "",
      r.rate?.toFixed(4) ?? "",
      r.eggValue ? r.eggValue.toFixed(2) : "",
    );
  }
  line(
    "Total",
    totals.feedKg.toFixed(2),
    totals.feedValue.toFixed(2),
    totals.birds || "",
    totals.birdValue ? totals.birdValue.toFixed(2) : "",
    totals.eggs,
    "",
    totals.eggValue.toFixed(2),
  );
  line();

  /* ── The detail behind each column ────────────────────────────────────── */
  line("FEED DELIVERED — every transfer");
  line("Date", "Transfer", "House", "Feed", "Kg", "Rate/kg", "Value");
  for (const f of feed) {
    line(
      f.day,
      f.number,
      codeOf.get(f.house ?? "") ?? "",
      f.item,
      n(f.kg).toFixed(2),
      n(f.rate).toFixed(4),
      n(f.value).toFixed(2),
    );
  }
  line();

  if (fromAmino.length) {
    line("PULLETS HOUSED — sold to the owner");
    line("Date", "Batch", "Into", "Age (weeks)", "Birds", "Rate/bird", "Value");
    for (const a of fromAmino) {
      const week = ageWeekOn(a.day, a.hatchDate);
      const v = await birdRateOn(tx, a.breedId, week, a.day);
      const rate = v ? n(v.rate) : null;
      line(
        a.day,
        a.flock,
        codeOf.get(a.house) ?? "",
        week,
        a.qty,
        rate?.toFixed(2) ?? "—",
        rate == null ? "—" : (a.qty * rate).toFixed(2),
      );
    }
    line();
  }

  line("EGGS — by house, by day");
  line("Date", "House", "Batch", "Eggs", "Cracked", "Rate/egg", "Value");
  for (const d of days) {
    const count = d.eggs ?? 0;
    if (!count) continue;
    const rate = rateFor(d.day);
    line(
      d.day,
      codeOf.get(d.house) ?? "",
      d.flock,
      count,
      d.cracked ?? "",
      rate?.toFixed(4) ?? "—",
      rate == null ? "—" : (count * rate).toFixed(2),
    );
  }


  return rows.map((r) => r.join(",")).join("\r\n");
}
