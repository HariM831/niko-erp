// Shared batch helpers for the Farms module.
//
// A "batch" is one bird_stock row in a shed. A shed can hold several batches
// over time. These helpers decide which batch represents the shed's *current*
// flock and which batches should be counted at all.
//
// Rules:
//  - A batch flagged `isActive === false` is excluded from every calculation.
//  - A batch whose live bird count has dropped to 0 (fully transferred out,
//    culled, or dead) is treated as no longer current.
//  - The age-reference batch is the active batch with the largest *live* bird
//    count (so the shed's age reflects the flock currently in it, not the
//    biggest batch it ever held).

export interface BatchStockLike {
  batchNumber?: string;
  dateIn: string;
  openingCount: number;
  batchBirthDate?: string | null;
  sourceShedId?: string;
  isActive?: boolean;
}

export interface BatchRecordLike {
  batchNumber?: string | null;
  mortality?: number;
  birdsTransferredIn?: number;
  birdsTransferredOut?: number;
  birdsCulled?: number;
  maleBirds?: number;
}

/** A batch counts unless it has been explicitly marked inactive. */
export function isBatchActive(stock: BatchStockLike): boolean {
  return stock.isActive !== false;
}

/** Current live birds in a single batch (opening count net of all movements). */
export function batchLiveCount(stock: BatchStockLike, records: BatchRecordLike[]): number {
  const batchRecords = records.filter(r => r.batchNumber === stock.batchNumber);
  return batchRecords.reduce(
    (sum, r) =>
      sum +
      (r.birdsTransferredIn || 0) -
      (r.mortality || 0) -
      (r.birdsTransferredOut || 0) -
      (r.birdsCulled || 0) -
      (r.maleBirds || 0),
    stock.openingCount || 0,
  );
}

/**
 * The batch that should drive the shed's age: among active batches with birds
 * still in them, the one with the largest live count. Falls back gracefully so
 * age never silently disappears:
 *   - if no batch has live birds, the largest active batch by opening count;
 *   - if every batch is inactive, all batches are considered.
 */
export function getAgeRefStock<T extends BatchStockLike>(
  stocks: T[],
  records: BatchRecordLike[],
): T | null {
  if (!stocks || stocks.length === 0) return null;

  const active = stocks.filter(isBatchActive);
  const candidates = active.length > 0 ? active : stocks;

  const withLive = candidates.map(s => ({ s, live: batchLiveCount(s, records) }));
  const liveOnes = withLive.filter(x => x.live > 0);
  const pool = liveOnes.length > 0 ? liveOnes : withLive;

  const best = pool.reduce((acc, cur) => {
    if (cur.live !== acc!.live) return cur.live > acc!.live ? cur : acc;
    return cur.s.openingCount > acc!.s.openingCount ? cur : acc;
  }, pool[0]!);

  return best!.s;
}

/** Age reference date for a shed (batch birth date, or placement date if unset). */
export function getBatchAgeRefDate(
  stocks: BatchStockLike[],
  records: BatchRecordLike[],
): Date | null {
  const stock = getAgeRefStock(stocks, records);
  if (!stock) return null;
  return stock.batchBirthDate ? new Date(stock.batchBirthDate) : new Date(stock.dateIn);
}
