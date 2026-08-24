/**
 * Houses — ported from the farm's own app, screen for screen.
 *
 * The layout, the tiles, the modals and every calculation below are carried
 * over unchanged: smart date, closing stock, age from the batch reference date,
 * egg percent against breed standard with its green/amber/red banding, feed per
 * bird and per egg, feed stock as delivered-minus-consumed, water per bird and
 * the water:feed ratio, mortality against standard and the seven-day average.
 * The people reading this every morning know it, and the data coming across was
 * recorded through it.
 *
 * What changed is only where the numbers come from. EGGSY keeps flocks,
 * placements and a movement ledger rather than sheds with counts on them, so
 * one endpoint adapts its tables into the five collections this page expects —
 * see server/services/houses-board.ts. Nothing is adapted in here, because
 * every edit in this file is a chance to change a number on screen.
 *
 * Not carried over: "Add Shed". Houses are created in Settings → Farms →
 * Houses, where they get their site, owner and feed store together.
 */
import { useState, useEffect, useMemo } from "react";
import { useLocation } from "wouter";
import {
  X,
  Egg,
  Bird,
  Wheat,
  Droplets,
  Skull,
  ChevronRight,
  Calendar,
  type LucideIcon,
} from "lucide-react";
import { api } from "../api";
import {
  getBatchAgeRefDate,
  getAgeRefStock,
  isBatchActive,
} from "../lib/bird-batches";

interface Breed {
  id: string;
  name: string;
}

interface Shed {
  id: string;
  name: string;
  type: "pullet" | "layer";
  displayOrder: number;
  dateOfBirth?: string;
  breedId?: string;
}

/** What the Houses tables can be ordered by. */
type SortKey = "shed" | "age";

/**
 * The number inside a shed code, for ordering.
 *
 * "L10" must come after "L9", which string comparison gets backwards, and the
 * farm will have L6 through L10 at Panbari before long.
 */
function shedNumber(code: string): number {
  const m = code.match(/(\d+)/);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

interface BirdStock {
  id: string;
  shedId: string;
  dateIn: string;
  openingCount: number;
  batchNumber?: string;
  /** Not in the original shape — the row needs somewhere to link to. */
  flockId?: string;
  /** The FLOCK's placed count — see the note in houses-board.ts. */
  flockPlacedCount?: number;
  batchBirthDate?: string;
  sourceShedId?: string;
  breedId?: string;
  isActive?: boolean;
}

interface DailyRecord {
  id: string;
  shedId: string;
  date: string;
  mortality: number;
  maleBirds: number;
  birdsTransferredIn: number;
  birdsTransferredOut: number;
  birdsCulled: number;
  waterUpperKl: number;
  waterLowerKl: number;
  feedIntakeKg: number;
  eggsProduced: number;
}

interface BreedStandard {
  id: string;
  breedId: string;
  weekNumber: number;
  feedGramsPerBird: number;
  waterMlPerBird: number;
  eggPercentage: number;
  mortalityPercent: number;
  bodyWeightGrams: number;
}

interface FormulaTransfer {
  id: string;
  formulaId: string;
  formulaName: string;
  costPerKg: number | null;
  quantityKg: number;
  shedId: string;
  shedName: string;
  date: string;
}

/** What the sheds' own instruments say, as of the last poll. */
interface IotRow {
  houseId: string;
  code: string;
  purpose: string;
  device: string | null;
  fetchedAt: string | null;
  tempC: number | null;
  targetTempC: number | null;
  humidityPct: number | null;
  co2Ppm: number | null;
  pressurePa: number | null;
  siloKg: number | null;
  waterL: number | null;
  feedKg: number | null;
  birdCount: number | null;
}

interface IotBoard {
  board: IotRow[];
  poll: { at: string; ok: boolean; houses: number; readings: number; error: string | null } | null;
  tokenExpires: string | null;
}

interface BoardData {
  sheds: Shed[];
  stocks: Record<string, BirdStock[]>;
  records: Record<string, DailyRecord[]>;
  breeds: Breed[];
  breedStandards: Record<string, BreedStandard[]>;
  formulaTransfers: FormulaTransfer[];
}

type ModalType = "eggs" | "feed" | "water" | "birds" | null;

/**
 * Whole days between two dates, the same calendar-day count date-fns gives.
 * Inlined rather than pulling in the library for one function — and India keeps
 * no daylight saving, so the UTC arithmetic and the local arithmetic agree.
 */
function differenceInDays(later: Date, earlier: Date): number {
  const day = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.trunc((day(later) - day(earlier)) / 86_400_000);
}

function getSmartDate(): string {
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(now.getTime() + istOffset);
  const istHour = istNow.getUTCHours();
  const istYear = istNow.getUTCFullYear();
  const istMonth = String(istNow.getUTCMonth() + 1).padStart(2, "0");
  const istDay = String(istNow.getUTCDate()).padStart(2, "0");
  const istToday = `${istYear}-${istMonth}-${istDay}`;
  if (istHour >= 17) return istToday;
  const yesterday = new Date(istNow.getTime() - 24 * 60 * 60 * 1000);
  return `${yesterday.getUTCFullYear()}-${String(yesterday.getUTCMonth() + 1).padStart(2, "0")}-${String(yesterday.getUTCDate()).padStart(2, "0")}`;
}

function getEffectiveBreedId(
  shed: Shed,
  shedStocks: BirdStock[],
  allRecords: DailyRecord[] = [],
): string | undefined {
  // Breed should come from the same batch that drives the shed's age (the
  // current flock), so age standards line up with the right breed.
  const ageRef = getAgeRefStock(shedStocks, allRecords as never);
  if (ageRef?.breedId) return ageRef.breedId;
  const activeWithBreed = shedStocks.find((s) => isBatchActive(s) && s.breedId);
  if (activeWithBreed?.breedId) return activeWithBreed.breedId;
  return shed.breedId;
}

function calculateClosingStock(
  shedStocks: BirdStock[],
  allRecords: DailyRecord[],
  upToDate: string,
): number {
  // Inactive batches are excluded from every total.
  const inactiveBatches = new Set(
    shedStocks.filter((s) => !isBatchActive(s)).map((s) => s.batchNumber),
  );
  const totalOpening = shedStocks
    .filter(
      (s) =>
        isBatchActive(s) &&
        new Date(s.dateIn) <= new Date(upToDate + "T23:59:59"),
    )
    .reduce((sum, s) => sum + s.openingCount, 0);
  const totalChanges = allRecords
    .filter((r) => r.date.substring(0, 10) <= upToDate)
    .filter((r) => {
      const b = (r as unknown as { batchNumber?: string }).batchNumber;
      return !b || !inactiveBatches.has(b);
    })
    .reduce(
      (sum, r) =>
        sum +
        (r.birdsTransferredIn || 0) -
        (r.mortality || 0) -
        (r.birdsTransferredOut || 0) -
        (r.birdsCulled || 0) -
        (r.maleBirds || 0),
      0,
    );
  return Math.max(0, totalOpening + totalChanges);
}

function fmtNum(n: number, decimals = 0): string {
  return n.toLocaleString("en-IN", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/**
 * Everything the screen shows for one shed on one day.
 *
 * Lifted out of the component only so its return type can be named for
 * `ShedRow`; the arithmetic is exactly as it was.
 */
function buildShedMetrics(
  shed: Shed,
  shedStocks: BirdStock[],
  allRecords: DailyRecord[],
  breedStandards: Record<string, BreedStandard[]>,
  formulaTransfers: FormulaTransfer[],
  displayDate: string,
) {
  const closingStock = calculateClosingStock(
    shedStocks,
    allRecords,
    displayDate,
  );
  const dateRecord = allRecords.find(
    (r) => r.date.substring(0, 10) === displayDate,
  );

  const ageRef = getBatchAgeRefDate(shedStocks, allRecords as never);
  const ageWeeks =
    ageRef && closingStock > 0
      ? Math.max(
          0,
          Math.floor(differenceInDays(new Date(displayDate), ageRef) / 7),
        )
      : null;
  const ageDays =
    ageRef && closingStock > 0
      ? Math.max(0, differenceInDays(new Date(displayDate), ageRef) % 7)
      : null;

  const breedId = getEffectiveBreedId(shed, shedStocks, allRecords);
  const standards = breedId ? breedStandards[breedId] || [] : [];
  const weekStandard =
    ageWeeks !== null ? standards.find((s) => s.weekNumber === ageWeeks) : null;

  const eggs = dateRecord?.eggsProduced || 0;
  const actualEggPct = closingStock > 0 ? (eggs / closingStock) * 100 : 0;
  const stdEggPct = weekStandard?.eggPercentage || 0;
  const eggDelta = actualEggPct - stdEggPct;

  let eggColor: "green" | "yellow" | "red" = "green";
  if (stdEggPct > 0) {
    if (actualEggPct >= stdEggPct) eggColor = "green";
    else if (actualEggPct >= stdEggPct - 1) eggColor = "yellow";
    else eggColor = "red";
  } else if (eggs === 0 && shed.type === "layer" && closingStock > 0) {
    eggColor = "red";
  }

  const feedKg = dateRecord?.feedIntakeKg || 0;
  const feedPerEgg = eggs > 0 ? (feedKg * 1000) / eggs : 0;
  const feedPerBirdG = closingStock > 0 ? (feedKg * 1000) / closingStock : 0;
  const stdFeedPerBirdG = weekStandard?.feedGramsPerBird || 0;

  const shedTransfers = formulaTransfers.filter(
    (t) => t.shedId === shed.id && t.date.substring(0, 10) <= displayDate,
  );
  const totalDeliveredKg = shedTransfers.reduce(
    (sum, t) => sum + t.quantityKg,
    0,
  );
  const dateConsumedKg = dateRecord?.feedIntakeKg || 0;
  const allTimeConsumedKg = allRecords
    .filter((r) => r.date.substring(0, 10) <= displayDate)
    .reduce((sum, r) => sum + (r.feedIntakeKg || 0), 0);
  const feedStockKg = Math.max(0, totalDeliveredKg - allTimeConsumedKg);

  const waterUpper = dateRecord?.waterUpperKl || 0;
  const waterLower = dateRecord?.waterLowerKl || 0;
  const totalWaterL = (waterUpper + waterLower) * 1000;
  const waterPerBirdMl =
    closingStock > 0 ? (totalWaterL / closingStock) * 1000 : 0;
  const stdWaterMlPerBird = weekStandard?.waterMlPerBird || 0;
  const waterFeedRatio = feedKg > 0 ? totalWaterL / feedKg : 0;

  const prevDateObj = new Date(displayDate + "T00:00:00");
  prevDateObj.setDate(prevDateObj.getDate() - 1);
  const prevDate = `${prevDateObj.getFullYear()}-${String(prevDateObj.getMonth() + 1).padStart(2, "0")}-${String(prevDateObj.getDate()).padStart(2, "0")}`;
  const prevDateRecord = allRecords.find(
    (r) => r.date.substring(0, 10) === prevDate,
  );
  const prevClosingStock = calculateClosingStock(
    shedStocks,
    allRecords,
    prevDate,
  );
  const prevEggs = prevDateRecord?.eggsProduced || 0;
  const prevEggPct =
    prevClosingStock > 0 ? (prevEggs / prevClosingStock) * 100 : 0;
  const eggPctChange = prevDateRecord ? actualEggPct - prevEggPct : null;

  const mortality = dateRecord?.mortality || 0;
  const prevWeekStandard =
    ageWeeks !== null && ageWeeks > 0
      ? standards.find((s) => s.weekNumber === ageWeeks - 1)
      : null;
  const cumulativeMortThis = weekStandard?.mortalityPercent || 0;
  const cumulativeMortPrev = prevWeekStandard?.mortalityPercent || 0;
  const stdMortalityPct = Math.max(0, cumulativeMortThis - cumulativeMortPrev);
  const actualMortalityPct =
    closingStock > 0 ? (mortality / (closingStock + mortality)) * 100 : 0;

  const last7Records = allRecords
    .filter((r) => {
      const d = r.date.substring(0, 10);
      return d <= displayDate;
    })
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 7);
  const weekTotalMort = last7Records.reduce(
    (sum, r) => sum + (r.mortality || 0),
    0,
  );
  const weekAvgBirds = closingStock > 0 ? closingStock : 0;
  const weekAvgMortPct =
    weekAvgBirds > 0
      ? (weekTotalMort / (weekAvgBirds * last7Records.length)) * 100
      : 0;

  return {
    shed,
    closingStock,
    ageWeeks,
    ageDays,
    eggs,
    actualEggPct,
    stdEggPct,
    eggDelta,
    eggColor,
    eggPctChange,
    feedKg,
    feedPerEgg,
    feedPerBirdG,
    stdFeedPerBirdG,
    totalDeliveredKg,
    dateConsumedKg,
    feedStockKg,
    totalWaterL,
    waterPerBirdMl,
    stdWaterMlPerBird,
    waterFeedRatio,
    mortality,
    stdMortalityPct,
    /** The guide's CUMULATIVE loss to this age — what liveability is judged on. */
    stdCumMortalityPct: cumulativeMortThis,
    actualMortalityPct,
    weekAvgMortPct,
    hasRecord: !!dateRecord,
  };
}

export function FarmsHousesPage() {
  const [, setLocation] = useLocation();
  const [sheds, setSheds] = useState<Shed[]>([]);
  const [stocks, setStocks] = useState<Record<string, BirdStock[]>>({});
  const [records, setRecords] = useState<Record<string, DailyRecord[]>>({});
  const [breedStandards, setBreedStandards] = useState<
    Record<string, BreedStandard[]>
  >({});
  const [formulaTransfers, setFormulaTransfers] = useState<FormulaTransfer[]>(
    [],
  );
  const [isLoading, setIsLoading] = useState(true);
  const [sortBy, setSortBy] = useState<SortKey>("shed");
  const [iot, setIot] = useState<IotBoard | null>(null);
  const [modalShed, setModalShed] = useState<Shed | null>(null);
  const [modalType, setModalType] = useState<ModalType>(null);
  const [displayDate, setDisplayDate] = useState<string>(() => getSmartDate());

  useEffect(() => {
    fetchAllData();
  }, []);

  const fetchAllData = async () => {
    try {
      // One request. EGGSY's tables are adapted into these five collections on
      // the server, so nothing below has to know how they are really stored.
      const data = await api<BoardData>("/api/farms/houses-board");
      setSheds(data.sheds);
      setStocks(data.stocks);
      setRecords(data.records);
      setBreedStandards(data.breedStandards);
      setFormulaTransfers(data.formulaTransfers);

      // The instruments, fetched separately: they answer in milliseconds from a
      // small table, and a farm with no controllers should still get its board.
      api<IotBoard>("/api/farms/iot/board")
        .then(setIot)
        .catch(() => setIot(null));
    } catch (error) {
      console.error("Failed to fetch data:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const shedMetrics = useMemo(
    () =>
      sheds.map((shed) =>
        buildShedMetrics(
          shed,
          stocks[shed.id] || [],
          records[shed.id] || [],
          breedStandards,
          formulaTransfers,
          displayDate,
        ),
      ),
    [sheds, stocks, records, breedStandards, formulaTransfers, displayDate],
  );

  const summaryData = useMemo(() => {
    let totalEggs = 0;
    let totalBirds = 0;
    let totalFeedKg = 0;
    let totalMortality = 0;

    shedMetrics.forEach((m) => {
      totalEggs += m.eggs;
      totalBirds += m.closingStock;
      totalFeedKg += m.feedKg;
      totalMortality += m.mortality;
    });

    return { totalEggs, totalBirds, totalFeedKg, totalMortality };
  }, [shedMetrics]);

  /**
   * The four performance tiles.
   *
   * Every one is derived from `shedMetrics` — the same numbers the table below
   * is built from — so a tile and the Total row can never disagree. Reading
   * them from anywhere else would put two answers to the same question on one
   * screen, which is the bug this whole module was rebuilt to end.
   *
   * Bird-weighted throughout: averaging six sheds' percentages gives a shed of
   * 400 birds the same say as one of 12,000.
   *
   * No cost figure here, deliberately. The people who work these sheds enter
   * the daily records; the money lives in Reports, behind `reports.view`.
   */
  const performance = useMemo(() => {
    const layers = shedMetrics.filter((m) => m.shed.type === "layer");

    // Lay % and feed per egg are laying-house questions. A pullet shed dragged
    // into the average would report the farm as catastrophically off-lay.
    const layBirds = layers.reduce((s, m) => s + m.closingStock, 0);
    const layEggs = layers.reduce((s, m) => s + m.eggs, 0);
    const layFeedKg = layers.reduce((s, m) => s + m.feedKg, 0);
    const layPct = layBirds > 0 ? (layEggs / layBirds) * 100 : null;
    // The guide, weighted by the birds standing under it — the sheds are at
    // different ages, so there is no single published number to quote.
    const guideWeight = layers.reduce(
      (s, m) => s + (m.stdEggPct > 0 ? m.closingStock : 0),
      0,
    );
    const stdLayPct =
      guideWeight > 0
        ? layers.reduce((s, m) => s + m.stdEggPct * (m.stdEggPct > 0 ? m.closingStock : 0), 0) /
          guideWeight
        : null;

    const feedPerEgg = layEggs > 0 ? (layFeedKg * 1000) / layEggs : null;
    // What the guide implies: a bird eating its ration at its lay rate.
    const stdFeedPerEgg =
      guideWeight > 0
        ? layers.reduce(
            (s, m) =>
              s +
              (m.stdEggPct > 0 && m.stdFeedPerBirdG > 0
                ? (m.stdFeedPerBirdG / (m.stdEggPct / 100)) * m.closingStock
                : 0),
            0,
          ) / guideWeight
        : null;

    // Liveability spans the whole farm, pullets included — a chick lost in
    // rearing is a hen that never lays.
    const live = shedMetrics.filter((m) => m.closingStock > 0);
    const alive = live.reduce((s, m) => s + m.closingStock, 0);
    // Deduped by FLOCK: a batch split across two layer houses was placed once,
    // and counting its chicks twice would halve the loss.
    const placedByFlock = new Map<string, number>();
    for (const m of live) {
      for (const s of stocks[m.shed.id] ?? []) {
        if (s.flockId && s.flockPlacedCount) placedByFlock.set(s.flockId, s.flockPlacedCount);
      }
    }
    const placed = [...placedByFlock.values()].reduce((s, n) => s + n, 0);
    const liveability = placed > 0 ? (alive / placed) * 100 : null;
    // The guide's cumulative loss to each shed's age, turned the same way up.
    const mortGuideWeight = live.reduce(
      (s, m) => s + (m.stdCumMortalityPct > 0 ? m.closingStock : 0),
      0,
    );
    const stdLiveability =
      mortGuideWeight > 0
        ? 100 -
          live.reduce(
            (s, m) => s + (m.stdCumMortalityPct > 0 ? m.stdCumMortalityPct * m.closingStock : 0),
            0,
          ) /
            mortGuideWeight
        : null;

    // Water is the earliest warning there is: birds go off water a day or two
    // before they go off feed, and well before anything shows in the mortality.
    const waterBirds = shedMetrics.reduce(
      (s, m) => s + (m.totalWaterL > 0 ? m.closingStock : 0),
      0,
    );
    const waterL = shedMetrics.reduce((s, m) => s + m.totalWaterL, 0);
    const waterPerBird = waterBirds > 0 ? (waterL / waterBirds) * 1000 : null;
    const waterGuideWeight = shedMetrics.reduce(
      (s, m) => s + (m.stdWaterMlPerBird > 0 && m.totalWaterL > 0 ? m.closingStock : 0),
      0,
    );
    const stdWaterPerBird =
      waterGuideWeight > 0
        ? shedMetrics.reduce(
            (s, m) =>
              s +
              (m.stdWaterMlPerBird > 0 && m.totalWaterL > 0
                ? m.stdWaterMlPerBird * m.closingStock
                : 0),
            0,
          ) / waterGuideWeight
        : null;

    return {
      layPct,
      stdLayPct,
      feedPerEgg,
      stdFeedPerEgg,
      liveability,
      stdLiveability,
      waterPerBird,
      stdWaterPerBird,
    };
  }, [shedMetrics, stocks]);

  const openModal = (shed: Shed, type: ModalType) => {
    setModalShed(shed);
    setModalType(type);
  };

  const closeModal = () => {
    setModalShed(null);
    setModalType(null);
  };

  /** A row opens the house, which exists whether or not it holds birds. */
  const openShed = (shedId: string) => setLocation(`/farms/houses/${shedId}`);

  const currentMetrics = modalShed
    ? shedMetrics.find((m) => m.shed.id === modalShed.id)
    : null;

  if (isLoading) {
    return (
      <div className="min-h-full space-y-4 bg-soil-50 p-4" data-testid="page-skeleton">
        <div className="h-8 w-48 animate-pulse rounded bg-primary/10" />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="animate-pulse space-y-3 rounded-lg border p-4"
            >
              <div className="h-5 w-2/3 rounded bg-primary/10" />
              <div className="h-4 w-1/2 rounded bg-primary/10" />
              <div className="flex gap-2">
                <div className="h-8 w-20 rounded bg-primary/10" />
                <div className="h-8 w-20 rounded bg-primary/10" />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  const eggColorClass = (color: "green" | "yellow" | "red") => {
    switch (color) {
      case "green":
        return "bg-success/10 text-success border-success/40";
      case "yellow":
        return "bg-warning/10 text-warning border-warning/40";
      case "red":
        return "bg-destructive/10 text-destructive border-destructive/40";
    }
  };

  /**
   * Shed order, always, unless the reader asks otherwise.
   *
   * A farm walks its houses in order and reads them in order, so L2 comes
   * before L10 — which means comparing the NUMBER in the code rather than the
   * string, or the list runs L10, L2, L3. Clicking Age sorts by age instead,
   * oldest first, since the question that makes somebody re-sort is usually
   * "which batch is closest to the end of lay".
   */
  const inOrder = (rows: typeof shedMetrics) =>
    [...rows].sort((a, b) => {
      if (sortBy === "age") {
        // Total age, not `ageDays` — that column holds the days WITHIN the week
        // (it is a % 7), so sorting on it alone orders sheds by remainder.
        const age = (m: (typeof rows)[number]) =>
          m.ageWeeks == null ? -1 : m.ageWeeks * 7 + (m.ageDays ?? 0);
        return age(b) - age(a) || shedNumber(a.shed.name) - shedNumber(b.shed.name);
      }
      return shedNumber(a.shed.name) - shedNumber(b.shed.name) || a.shed.name.localeCompare(b.shed.name);
    });

  const layerSheds = inOrder(shedMetrics.filter((m) => m.shed.type === "layer"));
  const pulletSheds = inOrder(shedMetrics.filter((m) => m.shed.type === "pullet"));

  const computeAggregate = (group: typeof shedMetrics) => {
    const totalBirds = group.reduce((s, m) => s + m.closingStock, 0);
    const totalEggs = group.reduce((s, m) => s + m.eggs, 0);
    const totalFeedKg = group.reduce((s, m) => s + m.feedKg, 0);
    const totalMortality = group.reduce((s, m) => s + m.mortality, 0);
    const totalWaterL = group.reduce((s, m) => s + m.totalWaterL, 0);
    const avgEggPct = totalBirds > 0 ? (totalEggs / totalBirds) * 100 : 0;
    const avgFeedPerBirdG =
      totalBirds > 0 ? (totalFeedKg * 1000) / totalBirds : 0;
    const avgWaterPerBirdMl =
      totalBirds > 0 ? (totalWaterL / totalBirds) * 1000 : 0;
    return {
      totalBirds,
      totalEggs,
      avgEggPct,
      avgFeedPerBirdG,
      avgWaterPerBirdMl,
      totalMortality,
    };
  };

  const layerAgg = computeAggregate(layerSheds);
  const pulletAgg = computeAggregate(pulletSheds);

  return (
    <div className="min-h-full bg-soil-50 mx-auto max-w-4xl p-4" data-testid="bird-dashboard">
      <div className="mb-4 flex items-center gap-2.5">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-yolk-400 to-yolk-600 text-white shadow-sm">
          <Bird className="h-4 w-4" />
        </span>
        <div>
          <h1 className="text-xl font-extrabold tracking-tight text-soil-900">Houses</h1>
          <p className="text-[13px] text-soil-400">Bird sheds overview</p>
        </div>
      </div>

      {/* Date Selector */}
      <div className="mb-3 flex items-center gap-2">
        <Calendar className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
        <input
          type="date"
          value={displayDate}
          onChange={(e) => setDisplayDate(e.target.value)}
          className="flex-1 rounded-md border border-input bg-card px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          data-testid="input-display-date"
        />
        <button
          onClick={() => setDisplayDate(getSmartDate())}
          className="whitespace-nowrap rounded-md px-2 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/8"
          data-testid="button-reset-date"
        >
          Reset
        </button>
      </div>

      {/* Summary Tiles */}
      <div
        className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4"
        data-testid="summary-tiles"
      >
        <KpiCard
          label="Eggs"
          value={fmtNum(summaryData.totalEggs)}
          icon={Egg}
          accent="bg-yolk-500"
        />
        <KpiCard
          label="Birds"
          value={fmtNum(summaryData.totalBirds)}
          icon={Bird}
          accent="bg-soil-600"
        />
        <KpiCard
          label="Feed (T)"
          value={fmtNum(summaryData.totalFeedKg / 1000, 1)}
          icon={Wheat}
          accent="bg-yolk-600"
        />
        <KpiCard
          label="Mortality"
          value={fmtNum(summaryData.totalMortality)}
          icon={Skull}
          accent="bg-destructive"
        />
      </div>

      {/* Against the guide — the four that say whether the day was any good.
          The row above counts things; this one judges them. */}
      <div
        className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4"
        data-testid="performance-tiles"
      >
        <GuideCard
          label="Lay %"
          value={performance.layPct}
          guide={performance.stdLayPct}
          suffix="%"
          good="high"
        />
        <GuideCard
          label="Feed / egg"
          value={performance.feedPerEgg}
          guide={performance.stdFeedPerEgg}
          suffix="g"
          dp={0}
          good="low"
        />
        <GuideCard
          label="Liveability"
          value={performance.liveability}
          guide={performance.stdLiveability}
          suffix="%"
          dp={2}
          good="high"
        />
        <GuideCard
          label="Water / bird"
          value={performance.waterPerBird}
          guide={performance.stdWaterPerBird}
          suffix="mL"
          dp={0}
        />
      </div>

      {/* ===== DESKTOP TABLE VIEW (hidden on mobile) ===== */}
      <div className="hidden md:block">
        {layerSheds.length > 0 && (
          <div className="mb-4">
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Layers
            </div>
            <div className="table-surface">
              <table className="w-full text-sm">
                <thead className="table-head">
                  <tr className="border-b border-primary/20">
                    <Th align="left" sort="shed" active={sortBy} onSort={setSortBy}>
                      Shed
                    </Th>
                    <Th>Birds</Th>
                    <Th sort="age" active={sortBy} onSort={setSortBy}>
                      Age
                    </Th>
                    <Th>Eggs %</Th>
                    <Th>Feed (g/b)</Th>
                    <Th>Water (ml/b)</Th>
                    <Th>Mort</Th>
                  </tr>
                </thead>
                <tbody>
                  {layerSheds.map((m) => (
                    <tr
                      key={m.shed.id}
                      className="cursor-pointer border-b border-border/60 last:border-0 hover:bg-muted/30"
                      onClick={() => openShed(m.shed.id)}
                      data-testid={`row-shed-${m.shed.id}`}
                    >
                      <td className="px-3 py-2 font-medium text-foreground">
                        {m.shed.name}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                        {fmtNum(m.closingStock)}
                      </td>
                      <td className="px-3 py-2 text-right text-muted-foreground">
                        {m.ageWeeks !== null ? `${m.ageWeeks}w` : "—"}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {m.closingStock > 0 ? (
                          <span
                            className={`inline-block rounded px-1.5 py-0.5 text-xs font-semibold ${eggColorClass(m.eggColor)}`}
                          >
                            {m.actualEggPct.toFixed(1)}%
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                        {m.feedPerBirdG > 0 ? fmtNum(m.feedPerBirdG, 0) : "—"}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                        {m.waterPerBirdMl > 0
                          ? fmtNum(m.waterPerBirdMl, 0)
                          : "—"}
                      </td>
                      <td
                        className={`px-3 py-2 text-right font-medium ${m.mortality > 0 ? "text-destructive" : "text-muted-foreground"}`}
                      >
                        {m.mortality}
                      </td>
                    </tr>
                  ))}
                  <tr className="border-t border-border bg-muted/40 text-xs font-semibold text-foreground">
                    <td className="px-3 py-2">Total</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {fmtNum(layerAgg.totalBirds)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">—</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {layerAgg.avgEggPct.toFixed(1)}%
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {layerAgg.avgFeedPerBirdG > 0
                        ? fmtNum(layerAgg.avgFeedPerBirdG, 0)
                        : "—"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {layerAgg.avgWaterPerBirdMl > 0
                        ? fmtNum(layerAgg.avgWaterPerBirdMl, 0)
                        : "—"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-destructive">
                      {fmtNum(layerAgg.totalMortality)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        )}

        {pulletSheds.length > 0 && (
          <div className="mb-4">
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Pullets
            </div>
            <div className="table-surface">
              <table className="w-full text-sm">
                <thead className="table-head">
                  <tr className="border-b border-primary/20">
                    <Th align="left" sort="shed" active={sortBy} onSort={setSortBy}>
                      Shed
                    </Th>
                    <Th>Birds</Th>
                    <Th sort="age" active={sortBy} onSort={setSortBy}>
                      Age
                    </Th>
                    <Th>Feed (g/b)</Th>
                    <Th>Water (ml/b)</Th>
                    <Th>Mort</Th>
                  </tr>
                </thead>
                <tbody>
                  {pulletSheds.map((m) => (
                    <tr
                      key={m.shed.id}
                      className="cursor-pointer border-b border-border/60 last:border-0 hover:bg-muted/30"
                      onClick={() => openShed(m.shed.id)}
                      data-testid={`row-shed-${m.shed.id}`}
                    >
                      <td className="px-3 py-2 font-medium text-foreground">
                        {m.shed.name}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                        {fmtNum(m.closingStock)}
                      </td>
                      <td className="px-3 py-2 text-right text-muted-foreground">
                        {m.ageWeeks !== null ? `${m.ageWeeks}w` : "—"}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                        {m.feedPerBirdG > 0 ? fmtNum(m.feedPerBirdG, 0) : "—"}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                        {m.waterPerBirdMl > 0
                          ? fmtNum(m.waterPerBirdMl, 0)
                          : "—"}
                      </td>
                      <td
                        className={`px-3 py-2 text-right font-medium ${m.mortality > 0 ? "text-destructive" : "text-muted-foreground"}`}
                      >
                        {m.mortality}
                      </td>
                    </tr>
                  ))}
                  <tr className="border-t border-border bg-muted/40 text-xs font-semibold text-foreground">
                    <td className="px-3 py-2">Total</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {fmtNum(pulletAgg.totalBirds)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">—</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {pulletAgg.avgFeedPerBirdG > 0
                        ? fmtNum(pulletAgg.avgFeedPerBirdG, 0)
                        : "—"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {pulletAgg.avgWaterPerBirdMl > 0
                        ? fmtNum(pulletAgg.avgWaterPerBirdMl, 0)
                        : "—"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-destructive">
                      {fmtNum(pulletAgg.totalMortality)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* ===== WHAT THE INSTRUMENTS SAY ===== */}
      {/* Kept as its own section rather than columns on the tables above: what a
          person wrote on the sheet and what a sensor measured are two different
          claims, and mixing them in one row invites the reader to treat them as
          one. */}
      {iot && iot.board.some((r) => r.tempC != null) && (
        <div className="mt-6">
          <div className="mb-1 flex items-baseline justify-between">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Shed conditions
            </div>
            <div className="text-[11px] text-muted-foreground">
              {iot.poll?.at
                ? `read ${new Date(iot.poll.at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}`
                : "never read"}
              {iot.poll && !iot.poll.ok && <span className="ml-1 text-destructive">· last poll failed</span>}
            </div>
          </div>
          <div className="table-surface overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="table-head">
                <tr>
                  <Th align="left">Shed</Th>
                  <Th>Temp</Th>
                  <Th>Target</Th>
                  <Th>Humidity</Th>
                  <Th>CO₂</Th>
                  <Th>Pressure</Th>
                  <Th>Silo</Th>
                  <Th>Water today</Th>
                  <Th>Feed today</Th>
                </tr>
              </thead>
              <tbody>
                {[...iot.board]
                  .sort(
                    (a, b) =>
                      a.purpose.localeCompare(b.purpose) || shedNumber(a.code) - shedNumber(b.code),
                  )
                  .map((r) => {
                    // Off-target by more than a degree is worth seeing without
                    // reading the number; the controller is chasing a setpoint.
                    const off =
                      r.tempC != null && r.targetTempC != null
                        ? Math.abs(r.tempC - r.targetTempC)
                        : null;
                    return (
                      <tr
                        key={r.houseId}
                        onClick={() => setLocation(`/farms/conditions/${r.houseId}`)}
                        className="cursor-pointer border-b border-border/60 last:border-0 hover:bg-muted/50"
                      >
                        <td className="px-3 py-2 font-medium text-primary">{r.code}</td>
                        <td
                          className={`px-3 py-2 text-right tabular-nums ${
                            off != null && off > 1 ? "font-semibold text-warning" : ""
                          }`}
                        >
                          {r.tempC == null ? "—" : `${r.tempC.toFixed(1)}°`}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                          {r.targetTempC == null ? "—" : `${r.targetTempC.toFixed(1)}°`}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {r.humidityPct == null ? "—" : `${r.humidityPct.toFixed(0)}%`}
                        </td>
                        <td
                          className={`px-3 py-2 text-right tabular-nums ${
                            (r.co2Ppm ?? 0) > 3000 ? "font-semibold text-destructive" : ""
                          }`}
                        >
                          {r.co2Ppm == null ? "—" : fmtNum(r.co2Ppm)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                          {r.pressurePa == null ? "—" : fmtNum(r.pressurePa)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {r.siloKg == null ? "—" : `${fmtNum(r.siloKg)} kg`}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {r.waterL == null ? "—" : `${fmtNum(r.waterL)} L`}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {r.feedKg == null ? "—" : `${fmtNum(r.feedKg)} kg`}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Straight from the controllers, not from the daily sheet. Water and feed are
            the controller's own running totals for today. Click a shed for its charts.
            {iot.tokenExpires && ` Access expires ${iot.tokenExpires}.`}
          </p>
        </div>
      )}

      {/* ===== MOBILE CARD VIEW (hidden on desktop) ===== */}
      <div className="md:hidden">
        {layerSheds.length > 0 && (
          <div className="mb-3">
            <div className="mb-1 px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Layers
            </div>
            <div className="space-y-1.5">
              {layerSheds.map((m) => (
                <ShedRow
                  key={m.shed.id}
                  metrics={m}
                  onTileClick={(type) => openModal(m.shed, type)}
                  onShedClick={() => openShed(m.shed.id)}
                />
              ))}
              <div className="rounded-lg border border-gray-200 bg-gray-100 p-2.5">
                <div className="mb-1.5 text-[10px] font-semibold uppercase text-muted-foreground">
                  Layer Totals
                </div>
                <div className="grid grid-cols-4 gap-1.5">
                  <AggTile
                    tone="warning"
                    label="Eggs"
                    value={`${layerAgg.avgEggPct.toFixed(0)}%`}
                  />
                  <AggTile
                    tone="success"
                    label="Feed"
                    value={
                      layerAgg.avgFeedPerBirdG > 0
                        ? `${fmtNum(layerAgg.avgFeedPerBirdG, 0)}g`
                        : "—"
                    }
                  />
                  <AggTile
                    tone="info"
                    label="Water"
                    value={
                      layerAgg.avgWaterPerBirdMl > 0
                        ? fmtNum(layerAgg.avgWaterPerBirdMl, 0)
                        : "—"
                    }
                  />
                  <AggTile
                    tone="destructive"
                    label="Mort"
                    value={fmtNum(layerAgg.totalMortality)}
                  />
                </div>
              </div>
            </div>
          </div>
        )}

        {pulletSheds.length > 0 && (
          <div className="mb-3">
            <div className="mb-1 px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Pullets
            </div>
            <div className="space-y-1.5">
              {pulletSheds.map((m) => (
                <ShedRow
                  key={m.shed.id}
                  metrics={m}
                  onTileClick={(type) => openModal(m.shed, type)}
                  onShedClick={() => openShed(m.shed.id)}
                />
              ))}
              <div className="rounded-lg border border-gray-200 bg-gray-100 p-2.5">
                <div className="mb-1.5 text-[10px] font-semibold uppercase text-muted-foreground">
                  Pullet Totals
                </div>
                <div className="grid grid-cols-3 gap-1.5">
                  <AggTile
                    tone="success"
                    label="Feed"
                    value={
                      pulletAgg.avgFeedPerBirdG > 0
                        ? `${fmtNum(pulletAgg.avgFeedPerBirdG, 0)}g`
                        : "—"
                    }
                  />
                  <AggTile
                    tone="info"
                    label="Water"
                    value={
                      pulletAgg.avgWaterPerBirdMl > 0
                        ? fmtNum(pulletAgg.avgWaterPerBirdMl, 0)
                        : "—"
                    }
                  />
                  <AggTile
                    tone="destructive"
                    label="Mort"
                    value={fmtNum(pulletAgg.totalMortality)}
                  />
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {sheds.length === 0 && (
        <div className="rounded-lg border border-dashed bg-white py-12 text-center text-muted-foreground">
          No houses configured yet. Add them under Settings → Farms → Houses.
        </div>
      )}

      {/* Detail Modal */}
      {modalShed && modalType && currentMetrics && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center sm:items-center"
          onClick={closeModal}
        >
          <div className="fixed inset-0 bg-black/40" />
          <div
            className="relative max-h-[70vh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-white p-5 shadow-2xl sm:rounded-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={closeModal}
              className="absolute right-3 top-3 p-1 text-muted-foreground hover:text-gray-600"
              data-testid="button-close-modal"
            >
              <X className="h-5 w-5" />
            </button>
            <div className="mb-4 flex items-center gap-2">
              <span
                className={`rounded px-2 py-0.5 text-xs font-medium ${modalShed.type === "layer" ? "bg-primary text-white" : "bg-secondary text-foreground"}`}
              >
                {modalShed.type}
              </span>
              <h3 className="text-lg font-bold text-foreground">
                {modalShed.name}
              </h3>
              {currentMetrics.ageWeeks !== null && (
                <span className="ml-auto text-xs text-muted-foreground">
                  Age: {currentMetrics.ageWeeks}w {currentMetrics.ageDays}d
                </span>
              )}
            </div>

            {modalType === "eggs" && (
              <div className="space-y-3" data-testid="modal-eggs">
                <h4 className="flex items-center gap-1.5 text-sm font-semibold text-gray-600">
                  <Egg className="h-4 w-4 text-warning" />
                  Egg Production
                </h4>
                <div className="grid grid-cols-2 gap-3">
                  <MetricCard
                    label="Total Produced"
                    value={fmtNum(currentMetrics.eggs)}
                  />
                  <MetricCard
                    label="Actual %"
                    value={`${currentMetrics.actualEggPct.toFixed(1)}%`}
                    highlight={currentMetrics.eggColor}
                  />
                  <MetricCard
                    label="Breed Std %"
                    value={
                      currentMetrics.stdEggPct > 0
                        ? `${currentMetrics.stdEggPct.toFixed(1)}%`
                        : "—"
                    }
                  />
                  <MetricCard
                    label="vs Std"
                    value={
                      currentMetrics.stdEggPct > 0
                        ? `${currentMetrics.eggDelta >= 0 ? "+" : ""}${currentMetrics.eggDelta.toFixed(1)}%`
                        : "—"
                    }
                    highlight={currentMetrics.eggDelta >= 0 ? "green" : "red"}
                  />
                  <MetricCard
                    label="vs Previous Day"
                    value={
                      currentMetrics.eggPctChange !== null
                        ? `${currentMetrics.eggPctChange >= 0 ? "+" : ""}${currentMetrics.eggPctChange.toFixed(1)}%`
                        : "—"
                    }
                    highlight={
                      currentMetrics.eggPctChange !== null
                        ? currentMetrics.eggPctChange >= 0
                          ? "green"
                          : "red"
                        : undefined
                    }
                  />
                </div>
              </div>
            )}

            {modalType === "feed" && (
              <div className="space-y-3" data-testid="modal-feed">
                <h4 className="flex items-center gap-1.5 text-sm font-semibold text-gray-600">
                  <Wheat className="h-4 w-4 text-success" />
                  Feed Details
                </h4>
                <div className="grid grid-cols-2 gap-3">
                  <MetricCard
                    label="Delivered (kg)"
                    value={fmtNum(currentMetrics.totalDeliveredKg, 1)}
                  />
                  <MetricCard
                    label="Consumed (kg)"
                    value={fmtNum(currentMetrics.dateConsumedKg, 1)}
                  />
                  <MetricCard
                    label="Stock (kg)"
                    value={fmtNum(currentMetrics.feedStockKg, 1)}
                  />
                  <MetricCard
                    label="Per Bird (g)"
                    value={fmtNum(currentMetrics.feedPerBirdG, 1)}
                    sub={
                      currentMetrics.stdFeedPerBirdG > 0
                        ? `Std: ${fmtNum(currentMetrics.stdFeedPerBirdG, 0)}g`
                        : undefined
                    }
                  />
                  {modalShed?.type === "layer" && (
                    <MetricCard
                      label="Per Egg (g)"
                      value={
                        currentMetrics.feedPerEgg > 0
                          ? fmtNum(currentMetrics.feedPerEgg, 0)
                          : "—"
                      }
                    />
                  )}
                </div>
              </div>
            )}

            {modalType === "water" && (
              <div className="space-y-3" data-testid="modal-water">
                <h4 className="flex items-center gap-1.5 text-sm font-semibold text-gray-600">
                  <Droplets className="h-4 w-4 text-info" />
                  Water Details
                </h4>
                <div className="grid grid-cols-2 gap-3">
                  <MetricCard
                    label="Total (L)"
                    value={fmtNum(currentMetrics.totalWaterL, 1)}
                  />
                  <MetricCard
                    label="Per Bird (ml)"
                    value={fmtNum(currentMetrics.waterPerBirdMl, 0)}
                    sub={
                      currentMetrics.stdWaterMlPerBird > 0
                        ? `Std: ${fmtNum(currentMetrics.stdWaterMlPerBird, 0)} ml`
                        : undefined
                    }
                  />
                  <MetricCard
                    label="Water:Feed"
                    value={
                      currentMetrics.waterFeedRatio > 0
                        ? `${currentMetrics.waterFeedRatio.toFixed(2)}:1`
                        : "—"
                    }
                  />
                </div>
              </div>
            )}

            {modalType === "birds" && (
              <div className="space-y-3" data-testid="modal-birds">
                <h4 className="flex items-center gap-1.5 text-sm font-semibold text-gray-600">
                  <Skull className="h-4 w-4 text-destructive" />
                  Bird Details
                </h4>
                <div className="grid grid-cols-2 gap-3">
                  <MetricCard
                    label="Total Birds"
                    value={fmtNum(currentMetrics.closingStock)}
                  />
                  <MetricCard
                    label="Today's Mortality"
                    value={fmtNum(currentMetrics.mortality)}
                  />
                  <MetricCard
                    label="Week Avg Mort %"
                    value={`${currentMetrics.weekAvgMortPct.toFixed(2)}%`}
                  />
                  <MetricCard
                    label="Std Mort %"
                    value={
                      currentMetrics.stdMortalityPct > 0
                        ? `${currentMetrics.stdMortalityPct.toFixed(2)}%`
                        : "—"
                    }
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Th({
  children,
  align,
  sort,
  active,
  onSort,
}: {
  children: React.ReactNode;
  align?: "left";
  /** Naming a key makes the header a button that sorts by it. */
  sort?: SortKey;
  active?: SortKey;
  onSort?: (k: SortKey) => void;
}) {
  // `.table-th` and nothing else — the colour and weight live in index.css so
  // this header changes when every other header in the app changes.
  const cls = `table-th ${align === "left" ? "text-left" : "text-right"}`;
  if (!sort || !onSort) return <th className={cls}>{children}</th>;
  const on = active === sort;
  return (
    <th className={cls}>
      <button
        onClick={() => onSort(sort)}
        className={`inline-flex items-center gap-1 ${on ? "text-foreground" : "hover:text-foreground"}`}
      >
        {children}
        {/* The arrow only shows on the column doing the sorting — a row of
            them invites the reader to work out which one is live. */}
        <span className={on ? "opacity-70" : "opacity-0"}>▾</span>
      </button>
    </th>
  );
}

/** The summary tile at the top, in the compact form the farm's app uses. */
function KpiCard({
  label,
  value,
  icon: Icon,
  accent,
}: {
  label: string;
  value: string;
  icon: LucideIcon;
  accent: string;
}) {
  return (
    <div className="relative overflow-hidden rounded-2xl bg-white shadow-[0_1px_2px_rgba(36,26,16,0.06),0_1px_10px_-4px_rgba(36,26,16,0.08)] transition-shadow hover:shadow-md">
      <div className="p-3.5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {label}
            </p>
            <p
              className="whitespace-nowrap text-lg font-bold leading-tight text-foreground"
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {value}
            </p>
          </div>
          <div
            className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg ${accent}`}
          >
            <Icon className="h-4 w-4 text-white" />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * A tile that answers "is this good", not just "what is it".
 *
 * The guide sits under the figure and the figure takes its colour from the
 * comparison — at-or-better green, worse red, with no tolerance band, matching
 * the Weekly Management Summary so the two never disagree about what "good"
 * means. A tile with no guide to compare against stays black rather than
 * picking a colour it cannot justify.
 */
function GuideCard({
  label,
  value,
  guide,
  suffix,
  dp = 1,
  good,
}: {
  label: string;
  value: number | null;
  guide?: number | null;
  suffix?: string;
  dp?: number;
  /** Which way is better. Feed per egg is better low; lay % is better high. */
  good?: "high" | "low";
}) {
  const fmt = (v: number) =>
    v.toLocaleString("en-IN", { minimumFractionDigits: dp, maximumFractionDigits: dp });
  const tone =
    value == null || guide == null || !good
      ? "text-foreground"
      : (good === "high" ? value >= guide : value <= guide)
        ? "text-success"
        : "text-destructive";

  return (
    <div className="rounded-2xl bg-white p-3.5 shadow-[0_1px_2px_rgba(36,26,16,0.06),0_1px_10px_-4px_rgba(36,26,16,0.08)] transition-shadow hover:shadow-md">
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p
        className={`whitespace-nowrap text-lg font-bold leading-tight ${tone}`}
        style={{ fontVariantNumeric: "tabular-nums" }}
      >
        {value == null ? "—" : fmt(value)}
        {value != null && suffix && (
          <span className="ml-0.5 text-[11px] font-medium">{suffix}</span>
        )}
      </p>
      <p className="mt-0.5 text-[11px] text-muted-foreground">
        {guide == null ? "no guide" : `guide ${fmt(guide)}${suffix ?? ""}`}
      </p>
    </div>
  );
}

/**
 * Spelled out rather than interpolated: Tailwind extracts class names from the
 * source text, so `bg-${tone}/10` would compile to nothing at all.
 */
const AGG_TONE = {
  warning: "bg-warning/10 border-warning/40 text-warning",
  success: "bg-success/10 border-success/40 text-success",
  info: "bg-info/10 border-info/40 text-info",
  destructive: "bg-destructive/10 border-destructive/40 text-destructive",
} as const;

function AggTile({
  tone,
  label,
  value,
}: {
  tone: keyof typeof AGG_TONE;
  label: string;
  value: string;
}) {
  return (
    <div className={`rounded border px-1 py-1.5 text-center ${AGG_TONE[tone]}`}>
      <div className="text-[9px] font-medium leading-tight opacity-70">
        {label}
      </div>
      <div className="text-sm font-bold leading-tight">{value}</div>
    </div>
  );
}

function MetricCard({
  label,
  value,
  highlight,
  sub,
}: {
  label: string;
  value: string;
  highlight?: "green" | "yellow" | "red";
  sub?: string;
}) {
  const bgClass =
    highlight === "green"
      ? "bg-success/10 border-success/40"
      : highlight === "yellow"
        ? "bg-warning/10 border-warning/40"
        : highlight === "red"
          ? "bg-destructive/10 border-destructive/40"
          : "bg-gray-50 border-gray-200";
  return (
    <div className={`rounded-lg border p-3 ${bgClass}`}>
      <div className="mb-0.5 text-[11px] text-muted-foreground">{label}</div>
      <div className="text-lg font-bold text-foreground">{value}</div>
      {sub && (
        <div className="mt-0.5 text-[10px] text-muted-foreground">{sub}</div>
      )}
    </div>
  );
}

type ShedMetrics = ReturnType<typeof buildShedMetrics>;

interface ShedRowProps {
  metrics: ShedMetrics;
  onTileClick: (type: ModalType) => void;
  onShedClick: () => void;
}

function ShedRow({ metrics, onTileClick, onShedClick }: ShedRowProps) {
  const m = metrics;
  const eggBg =
    m.eggColor === "green"
      ? "bg-success/10 text-success border-success/40"
      : m.eggColor === "yellow"
        ? "bg-warning/10 text-warning border-warning/40"
        : "bg-destructive/10 text-destructive border-destructive/40";

  return (
    <div
      className="rounded-2xl bg-white p-2.5 shadow-[0_1px_2px_rgba(36,26,16,0.06),0_1px_10px_-4px_rgba(36,26,16,0.08)]"
      data-testid={`row-shed-${m.shed.id}`}
    >
      <button
        className="group mb-2 flex w-full items-center gap-1 text-left"
        onClick={onShedClick}
        data-testid={`link-shed-${m.shed.id}`}
      >
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-foreground transition-colors group-hover:text-primary">
            {m.shed.name}
          </div>
          <div className="text-[10px] leading-tight text-muted-foreground">
            {m.closingStock > 0 ? `${fmtNum(m.closingStock)} birds` : "Empty"}
            {m.ageWeeks !== null && ` · ${m.ageWeeks}w`}
          </div>
        </div>
        <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-gray-300 group-hover:text-primary" />
      </button>

      <div
        className={`grid gap-1.5 ${m.shed.type === "layer" ? "grid-cols-4" : "grid-cols-3"}`}
      >
        {m.shed.type === "layer" && (
          <button
            className={`rounded border px-1 py-1.5 text-center transition-transform active:scale-95 ${m.closingStock > 0 ? eggBg : "border-gray-200 bg-gray-50 text-muted-foreground"}`}
            onClick={(e) => {
              e.stopPropagation();
              onTileClick("eggs");
            }}
            data-testid={`tile-eggs-${m.shed.id}`}
          >
            <div className="text-[9px] font-medium leading-tight opacity-70">
              Eggs
            </div>
            <div className="text-sm font-bold leading-tight">
              {m.closingStock > 0 ? `${m.actualEggPct.toFixed(0)}%` : "—"}
            </div>
          </button>
        )}

        <button
          className="rounded border border-success/40 bg-success/10 px-1 py-1.5 text-center text-success transition-transform active:scale-95"
          onClick={(e) => {
            e.stopPropagation();
            onTileClick("feed");
          }}
          data-testid={`tile-feed-${m.shed.id}`}
        >
          <div className="text-[9px] font-medium leading-tight opacity-70">
            Feed
          </div>
          <div className="text-sm font-bold leading-tight">
            {m.feedPerBirdG > 0 ? `${fmtNum(m.feedPerBirdG, 0)}g` : "—"}
          </div>
        </button>

        <button
          className="rounded border border-info/40 bg-info/10 px-1 py-1.5 text-center text-info transition-transform active:scale-95"
          onClick={(e) => {
            e.stopPropagation();
            onTileClick("water");
          }}
          data-testid={`tile-water-${m.shed.id}`}
        >
          <div className="text-[9px] font-medium leading-tight opacity-70">
            Water
          </div>
          <div className="text-sm font-bold leading-tight">
            {m.waterPerBirdMl > 0 ? `${fmtNum(m.waterPerBirdMl, 0)}ml` : "—"}
          </div>
        </button>

        <button
          className={`rounded border px-1 py-1.5 text-center transition-transform active:scale-95 ${m.mortality > 0 ? "border-destructive/40 bg-destructive/10 text-destructive" : "border-gray-200 bg-gray-50 text-muted-foreground"}`}
          onClick={(e) => {
            e.stopPropagation();
            onTileClick("birds");
          }}
          data-testid={`tile-mortality-${m.shed.id}`}
        >
          <div className="text-[9px] font-medium leading-tight opacity-70">
            Mort
          </div>
          <div className="text-sm font-bold leading-tight">
            {m.mortality > 0 ? m.mortality : "0"}
          </div>
        </button>
      </div>
    </div>
  );
}
