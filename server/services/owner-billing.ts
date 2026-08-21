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
  items,
  ownerAgreements,
  ownerBillingRuns,
  placementDays,
} from "@shared/schema";
import type { db as Db } from "../db";
import { PostingError } from "./posting";

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
  /** Positive when the owner owes Amino. */
  net: number;
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
  const eggs = await tx
    .select({
      houseId: flockPlacements.houseId,
      total: sql<string>`sum(coalesce(${placementDays.eggsTotal}, 0))`,
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
    .groupBy(flockPlacements.houseId);

  const benchmark = await eggBenchmarkOn(tx, to);
  const spread = agreement ? n(agreement.eggSpreadPerEgg) : null;
  const eggRate = benchmark && spread != null ? n(benchmark.ratePerEgg) + spread : null;
  if (!benchmark) problems.push(`No egg benchmark price is set on or before ${to}`);
  if (!agreement) problems.push(`${owner.name} has no agreement, so the egg spread is unknown`);

  for (const e of eggs) {
    const count = n(e.total);
    if (count <= 0) continue;
    billLines.push({
      kind: "eggs",
      description: `Eggs from ${codeOf.get(e.houseId)}`,
      qty: count,
      unit: "eggs",
      rate: eggRate,
      amount: eggRate == null ? null : count * eggRate,
      problem: eggRate == null ? "Not priceable until the benchmark and spread are set" : undefined,
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
    net: invoiceTotal - billTotal,
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


