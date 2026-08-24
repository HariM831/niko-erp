/**
 * One house's page, in the shapes the farm's own shed screen expects.
 *
 * Built on top of `housesBoard` rather than beside it. The board already turns
 * placements and the movement ledger into "batches" and "daily records"; doing
 * that translation twice is how the same shed comes to show one number on the
 * overview and a different one on its own page.
 *
 * Weighings and vaccinations are keyed to the PLACEMENT in niko and grouped
 * back onto the shed here — see shared/schema/health.ts for why.
 */
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  birdWeighings,
  flockMovements,
  flockPlacements,
  houses,
  vaccinationEvents,
  vaccineStandards,
} from "@shared/schema";
import type { db as Db } from "../db";
import { housesBoard } from "./houses-board";

type Tx = Parameters<Parameters<typeof Db.transaction>[0]>[0];

const num = (v: string | number | null) => (v == null ? 0 : Number(v));

interface Stock {
  id: string;
  batchNumber?: string;
  [k: string]: unknown;
}
interface Record_ {
  placementId: string;
  batchNumber?: string;
  [k: string]: unknown;
}

export async function houseDetail(tx: Tx, houseId: string) {
  const board = await housesBoard(tx);
  const shed = board.sheds.find((s) => s.id === houseId) ?? null;
  if (!shed) return null;

  const stocks = (board.stocks[houseId] ?? []) as Stock[];
  const records = (board.records[houseId] ?? []) as Record_[];
  const placementIds = stocks.map((s) => s.id);

  // ── Weekly weights ──
  const weightRows = placementIds.length
    ? await tx
        .select({
          id: birdWeighings.id,
          placementId: birdWeighings.placementId,
          weekNumber: birdWeighings.weekNumber,
          date: birdWeighings.weighedOn,
          averageWeight: birdWeighings.avgWeightG,
          eggWeight: birdWeighings.eggWeightG,
          sampleSize: birdWeighings.sampleSize,
          note: birdWeighings.note,
        })
        .from(birdWeighings)
        .where(inArray(birdWeighings.placementId, placementIds))
        .orderBy(asc(birdWeighings.weekNumber))
    : [];
  const batchOf = new Map(stocks.map((s) => [s.id, s.batchNumber]));
  const weights = weightRows.map((w) => ({
    ...w,
    shedId: houseId,
    batchNumber: batchOf.get(w.placementId),
    averageWeight: num(w.averageWeight),
    eggWeight: w.eggWeight == null ? null : num(w.eggWeight),
  }));

  // ── Vaccination ──
  const standards = await tx
    .select()
    .from(vaccineStandards)
    .orderBy(asc(vaccineStandards.sortOrder), asc(vaccineStandards.age));

  const eventRows = placementIds.length
    ? await tx
        .select()
        .from(vaccinationEvents)
        .where(inArray(vaccinationEvents.placementId, placementIds))
        .orderBy(desc(vaccinationEvents.eventDate))
    : [];
  const vaccinationRecords = eventRows.map((v) => ({
    id: v.id,
    shedId: houseId,
    date: v.eventDate,
    vaccineName: v.vaccineName,
    batchNumber: batchOf.get(v.placementId),
    make: v.make,
    birdsVaccinated: v.birdsVaccinated,
    vaccinatorCount: v.vaccinatorCount,
    laboursCount: v.laboursCount,
    imageUrl: v.imageUrl,
    placementId: v.placementId,
  }));

  // ── Batch history — everything this shed has held, by batch ──
  //
  // The transfers list comes from the paired movements, so a batch that walked
  // in from the pullet house shows where it came from rather than appearing
  // from nowhere.
  const transferRows = placementIds.length
    ? await tx
        .select({
          id: flockMovements.id,
          placementId: flockMovements.placementId,
          kind: flockMovements.kind,
          qty: flockMovements.qty,
          transferDate: flockMovements.eventDate,
          counterpartPlacementId: flockMovements.counterpartPlacementId,
        })
        .from(flockMovements)
        .where(
          and(
            inArray(flockMovements.placementId, placementIds),
            inArray(flockMovements.kind, ["transfer_in", "transfer_out"]),
          ),
        )
        .orderBy(asc(flockMovements.eventDate))
    : [];

  // Which shed sits on the other end of each transfer.
  const counterpartIds = [
    ...new Set(transferRows.map((t) => t.counterpartPlacementId).filter((v): v is string => !!v)),
  ];
  const counterparts = counterpartIds.length
    ? await tx
        .select({ id: flockPlacements.id, houseId: flockPlacements.houseId, code: houses.code })
        .from(flockPlacements)
        .innerJoin(houses, eq(houses.id, flockPlacements.houseId))
        .where(inArray(flockPlacements.id, counterpartIds))
    : [];
  const shedOfPlacement = new Map(counterparts.map((c) => [c.id, c.houseId]));

  const byBatch = new Map<string, Stock[]>();
  for (const s of stocks) {
    const key = s.batchNumber ?? s.id;
    (byBatch.get(key) ?? byBatch.set(key, []).get(key)!).push(s);
  }

  const batches = [...byBatch.entries()].map(([batchNumber, batchStocks]) => {
    const ids = new Set(batchStocks.map((s) => s.id));
    const dailyRecords = records.filter((r) => ids.has(r.placementId));
    const transfers = transferRows
      .filter((t) => ids.has(t.placementId))
      .map((t) => ({
        id: t.id,
        batchNumber,
        fromShedId: t.kind === "transfer_out" ? houseId : (shedOfPlacement.get(t.counterpartPlacementId!) ?? ""),
        toShedId: t.kind === "transfer_out" ? (shedOfPlacement.get(t.counterpartPlacementId!) ?? "") : houseId,
        transferDate: t.transferDate,
        birdCount: t.qty,
      }));
    const arrival = transfers.find((t) => t.toShedId === houseId);
    // Closing count for the batch, straight off the daily rows the board built.
    const opening = batchStocks.reduce((n, s) => n + Number(s.openingCount ?? 0), 0);
    const currentCount = dailyRecords.reduce(
      (n, r) =>
        n +
        Number(r.birdsTransferredIn ?? 0) -
        Number(r.mortality ?? 0) -
        Number(r.birdsTransferredOut ?? 0) -
        Number(r.birdsCulled ?? 0) -
        Number(r.maleBirds ?? 0),
      opening,
    );
    return {
      batchNumber,
      originShedId: arrival?.fromShedId || undefined,
      originDate: arrival?.transferDate,
      currentCount: Math.max(0, currentCount),
      stocks: batchStocks,
      dailyRecords,
      weeklyWeights: weights.filter((w) => ids.has(w.placementId)),
      vaccinations: vaccinationRecords.filter((v) => ids.has(v.placementId)),
      transfers,
    };
  });

  return {
    shed,
    allSheds: board.sheds,
    stocks,
    records,
    weights,
    breeds: board.breeds,
    breedStandards: board.breedStandards,
    vaccineStandards: standards,
    vaccinationRecords,
    batchHistory: { shedId: houseId, batches },
    formulaTransfers: board.formulaTransfers.filter((t) => t.shedId === houseId),
  };
}
