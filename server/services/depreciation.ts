import { and, desc, eq, lte, sql } from "drizzle-orm";
import { depreciationEntries, fixedAssets } from "@shared/schema";
import type { Db, Tx } from "../db";
import { PostingError, postJournal } from "./posting";

/** Reads work against a plain connection or a transaction; writes need a Tx. */
type Reader = Db | Tx;

/** All arithmetic in integer paise to avoid float drift. */
const toPaise = (s: string | number | null | undefined): number =>
  Math.round(Number(s ?? 0) * 100);
const fromPaise = (p: number): string => (p / 100).toFixed(2);

type Asset = typeof fixedAssets.$inferSelect;

/** Last day of the month containing `date`, as YYYY-MM-DD. */
export function monthEnd(date: string): string {
  const [y, m] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, m!, 0)).toISOString().slice(0, 10);
}

/** Whole months from `from` to `to`, counting the month of `to` itself. */
function monthsBetween(from: string, to: string): number {
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  return (ty! - fy!) * 12 + (tm! - fm!) + 1;
}

/**
 * Depreciation owed on an asset from its start date through `periodEnd`,
 * in paise, ignoring what has already been charged.
 *
 * Straight line spreads (cost - salvage) evenly across the useful life.
 * Written-down value applies a constant rate to the reducing balance, which is
 * derived from the life so that the asset lands on its salvage value.
 */
function cumulativeDue(asset: Asset, periodEnd: string): number {
  const costP = toPaise(asset.cost);
  const salvageP = toPaise(asset.salvageValue);
  const depreciableP = costP - salvageP;
  if (depreciableP <= 0) return 0;

  const elapsed = Math.min(
    Math.max(monthsBetween(asset.depreciationStartDate, periodEnd), 0),
    asset.usefulLifeMonths,
  );
  if (elapsed <= 0) return 0;
  if (elapsed >= asset.usefulLifeMonths) return depreciableP;

  if (asset.method === "straight_line") {
    return Math.round((depreciableP * elapsed) / asset.usefulLifeMonths);
  }

  // WDV: salvage must be positive for a rate to exist, else the balance never
  // reaches zero. Fall back to straight line rather than divide by zero.
  if (salvageP <= 0) {
    return Math.round((depreciableP * elapsed) / asset.usefulLifeMonths);
  }
  const monthlyRate = 1 - Math.pow(salvageP / costP, 1 / asset.usefulLifeMonths);
  const remaining = costP * Math.pow(1 - monthlyRate, elapsed);
  return Math.round(costP - remaining);
}

/** Depreciation already recorded against an asset, including opening balance. */
async function chargedSoFar(tx: Reader, assetId: string, openingP: number): Promise<number> {
  const [row] = await tx
    .select({ total: sql<string>`coalesce(sum(${depreciationEntries.amount}), 0)` })
    .from(depreciationEntries)
    .where(eq(depreciationEntries.assetId, assetId));
  return openingP + toPaise(row?.total);
}

export interface DepreciationLine {
  assetId: string;
  number: string;
  name: string;
  amount: string;
}

export interface DepreciationRun {
  periodEnd: string;
  journalEntryId: string | null;
  total: string;
  lines: DepreciationLine[];
}

/**
 * Charge depreciation for every active asset up to `periodEnd`, as one journal
 * entry: DR depreciation expense, CR accumulated depreciation.
 *
 * Catch-up by design — each asset is charged the difference between what it
 * owes cumulatively and what it has already been charged, so a missed month is
 * picked up by the next run rather than being lost. Running twice for the same
 * period is therefore a no-op, which is what makes this safe to retry.
 */
export async function runDepreciation(
  tx: Tx,
  args: { periodEnd: string; postedBy: string; dryRun?: boolean },
): Promise<DepreciationRun> {
  const period = monthEnd(args.periodEnd);

  const assets = await tx
    .select()
    .from(fixedAssets)
    .where(
      and(
        eq(fixedAssets.status, "active"),
        lte(fixedAssets.depreciationStartDate, period),
      ),
    );

  const lines: DepreciationLine[] = [];
  const fullyDepreciated: string[] = [];
  let totalP = 0;

  for (const asset of assets) {
    const dueP = cumulativeDue(asset, period);
    const doneP = await chargedSoFar(tx, asset.id, toPaise(asset.openingAccumulated));
    const chargeP = dueP - doneP;
    if (chargeP <= 0) continue;

    lines.push({
      assetId: asset.id,
      number: asset.number,
      name: asset.name,
      amount: fromPaise(chargeP),
    });
    totalP += chargeP;

    const depreciableP = toPaise(asset.cost) - toPaise(asset.salvageValue);
    if (doneP + chargeP >= depreciableP) fullyDepreciated.push(asset.id);
  }

  if (!lines.length) {
    return { periodEnd: period, journalEntryId: null, total: "0.00", lines: [] };
  }
  if (args.dryRun) {
    return { periodEnd: period, journalEntryId: null, total: fromPaise(totalP), lines };
  }

  const journalEntryId = await postJournal(tx, {
    entryDate: period,
    narration: `Depreciation for period ending ${period}`,
    sourceType: "depreciation",
    postedBy: args.postedBy,
    lines: [
      { systemKey: "depreciation_expense", debit: fromPaise(totalP) },
      { systemKey: "accum_depreciation", credit: fromPaise(totalP) },
    ],
  });

  await tx.insert(depreciationEntries).values(
    lines.map((l) => ({
      assetId: l.assetId,
      journalEntryId,
      periodEnd: period,
      amount: l.amount,
    })),
  );

  for (const id of fullyDepreciated) {
    await tx
      .update(fixedAssets)
      .set({ status: "fully_depreciated", updatedAt: new Date() })
      .where(eq(fixedAssets.id, id));
  }

  return { periodEnd: period, journalEntryId, total: fromPaise(totalP), lines };
}

/** Net book value of an asset: cost less everything depreciated to date. */
export async function netBookValue(tx: Reader, asset: Asset): Promise<number> {
  const doneP = await chargedSoFar(tx, asset.id, toPaise(asset.openingAccumulated));
  return toPaise(asset.cost) - doneP;
}

/**
 * Retire an asset. Removes cost and its accumulated depreciation from the
 * balance sheet, records any proceeds, and books the difference against net
 * book value as a gain or loss.
 */
export async function disposeAsset(
  tx: Tx,
  args: {
    asset: Asset;
    disposalDate: string;
    proceeds: string;
    proceedsAccountId?: string;
    postedBy: string;
  },
): Promise<string> {
  const { asset } = args;
  if (asset.status === "disposed") throw new PostingError("Asset is already disposed");

  const costP = toPaise(asset.cost);
  const accumulatedP = await chargedSoFar(
    tx,
    asset.id,
    toPaise(asset.openingAccumulated),
  );
  const proceedsP = toPaise(args.proceeds);
  const nbvP = costP - accumulatedP;
  const gainP = proceedsP - nbvP;

  const lines = [
    // Clear the asset off the books.
    { accountId: asset.assetAccountId, credit: fromPaise(costP) },
  ] as Parameters<typeof postJournal>[1]["lines"];

  if (accumulatedP > 0) {
    lines.push({ systemKey: "accum_depreciation", debit: fromPaise(accumulatedP) });
  }
  if (proceedsP > 0) {
    // No sensible default: "cash_bank" is a heading, and only the caller knows
    // which bank or cash account actually received the money.
    if (!args.proceedsAccountId) {
      throw new PostingError("Choose the account the sale proceeds were received into");
    }
    lines.push({ accountId: args.proceedsAccountId, debit: fromPaise(proceedsP) });
  }
  if (gainP > 0) {
    lines.push({ systemKey: "gain_on_disposal", credit: fromPaise(gainP) });
  } else if (gainP < 0) {
    lines.push({ systemKey: "loss_on_disposal", debit: fromPaise(-gainP) });
  }

  const journalEntryId = await postJournal(tx, {
    entryDate: args.disposalDate,
    narration: `Disposal of ${asset.number} — ${asset.name}`,
    sourceType: "depreciation",
    sourceId: asset.id,
    postedBy: args.postedBy,
    lines,
  });

  await tx
    .update(fixedAssets)
    .set({
      status: "disposed",
      disposalDate: args.disposalDate,
      disposalProceeds: fromPaise(proceedsP),
      disposalJournalEntryId: journalEntryId,
      updatedAt: new Date(),
    })
    .where(eq(fixedAssets.id, asset.id));

  return journalEntryId;
}

/** Most recent period any depreciation has been charged for. */
export async function lastRunPeriod(tx: Reader): Promise<string | null> {
  const [row] = await tx
    .select({ periodEnd: depreciationEntries.periodEnd })
    .from(depreciationEntries)
    .orderBy(desc(depreciationEntries.periodEnd))
    .limit(1);
  return row?.periodEnd ?? null;
}
