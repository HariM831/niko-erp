/**
 * What the shed's instruments say about a day, judged before it is offered.
 *
 * Decided with the farm on 9 Oct 2026, after a week of house records were
 * found to hold the controller's numbers where the register held different
 * ones — the entry form had pre-filled them and they were saved untouched:
 *
 *  - The day runs midnight to midnight. The register closes around 5pm (its
 *    water is read off the controller then, and its stock is written before
 *    the evening tanker); niko does not.
 *
 *  - Feed eaten is what the SILO lost, not the controller's feed counter. Over
 *    25 Sep–8 Oct the silo matched the register within 1% on nearly every
 *    whole day; the counter missed runs outright (L2 on 7 Oct counted 7,460 of
 *    about 10,700; L5 was short by a quarter on 5 Oct). The silo is trusted on
 *    a day only when the controller covered all of it, its own tanker weights
 *    agreed with the mill's transfers within 3% in the week before (which
 *    proves the load cells), and the figure is within 10% of the house's last
 *    seven days. L3's misaligned silo fails the tanker test on its own.
 *
 *  - Stock is the book — yesterday's closing plus what arrived less what was
 *    eaten — checked against the silo at midnight. A tanker the silo saw with
 *    no mill transfer behind it stops the stock: that is the mill's record
 *    missing, as on 8 Oct, when L4 took 21,769 kg and L5 14,282 kg the mill
 *    had not recorded.
 *
 *  - Water is the controller's climb from midnight to midnight.
 */
import { and, asc, eq, gte, lt, lte, ne, sql } from "drizzle-orm";
import { feedTransfers, flockPlacements, iotHouseSample, placementDays } from "@shared/schema";
import type { DaySources, FigureSource } from "@shared/schema";
import {
  type DayAutofill,
  type Figure,
  type TankerLine,
  judgeStock,
  sameFigure,
} from "@shared/house-day";
import { db } from "../db";
import { addDays, istDate } from "./day-resolution";
import { gradedEggsOn } from "./egg-sales";
import { countersOf } from "./iot/store";
import { type SiloMove, dayCoverage, siloMoves, siloTankers } from "./iot/silo-events";
import { PostingError } from "./posting";

/** A tanker and its transfer agree within this share of the transfer. */
const TANKER_TOLERANCE = 0.03;
/** A rise smaller than this, unmatched, is a top-up of noise, not a tanker. */
const TANKER_MIN_KG = 1_000;
/** Today's intake may stray this far from the last week's before it stops. */
const INTAKE_TOLERANCE = 0.1;
/** How many consecutive silo rises one transfer may arrive as. */
const LOADS_AT_MOST = 4;

const startOf = (day: string) => new Date(`${day}T00:00:00+05:30`);
const fmt = (n: number) => Math.round(n).toLocaleString("en-IN");

interface Transfer {
  number: string;
  transferDate: string;
  quantityKg: number;
}

export interface MatchedTanker {
  move: SiloMove;
  transfer: Transfer | null;
  /** This load's share of its transfer, by the mill's weight. */
  bookedKg: number;
}

/**
 * Pair the silo's tankers with the mill's transfers.
 *
 * A transfer may arrive as up to four consecutive loads — the silo fills
 * before the lorry is empty and the rest goes in after a feeding run (L2's
 * 16,148 kg on 6 Oct arrived as 10,049 kg at 17:51 the evening before and
 * 6,187 kg at 11:31).
 *
 * Two passes. First every transfer looks only at its own day and the evening
 * before it (from 16:00), where nearly every tanker lands — the mill enters an
 * evening tanker next morning, against that morning's date. Then those still
 * unmatched look from noon the day before to noon the day after. Taking each
 * transfer's natural loads first stops one transfer borrowing its neighbour's
 * evening load because the weights happened to add up.
 *
 * Within a pass, transfers go in date order and each takes the EARLIEST run of
 * loads that weighs within 3% — tankers arrive in the order they were sent,
 * and the closest run can be the next transfer's (L2's 7 Oct transfer would
 * have taken 13:09 + 8 Oct's 06:20 over 6 Oct 20:19 + 13:09).
 */
export function matchTankers(rises: SiloMove[], transfers: Transfer[]): {
  tankers: MatchedTanker[];
  unseen: Transfer[];
} {
  const used = new Array(rises.length).fill(false) as boolean[];
  const owner = new Array<Transfer | null>(rises.length).fill(null);
  const ordered = [...transfers].sort((a, b) =>
    a.transferDate === b.transferDate ? a.number.localeCompare(b.number) : a.transferDate.localeCompare(b.transferDate),
  );
  const hour = 3_600_000;
  const passes: Array<(t: Transfer) => [Date, Date]> = [
    (t) => [new Date(startOf(addDays(t.transferDate, -1)).getTime() + 16 * hour), startOf(addDays(t.transferDate, 1))],
    (t) => [
      new Date(startOf(addDays(t.transferDate, -1)).getTime() + 12 * hour),
      new Date(startOf(addDays(t.transferDate, 1)).getTime() + 12 * hour),
    ],
  ];
  const matched = new Set<Transfer>();
  for (const window of passes) {
    for (const t of ordered) {
      if (matched.has(t)) continue;
      const [from, to] = window(t);
      let best: { i: number; j: number; off: number } | null = null;
      for (let i = 0; i < rises.length && !best; i++) {
        if (used[i] || rises[i]!.start < from || rises[i]!.start >= to) continue;
        let sum = 0;
        for (let j = i; j < rises.length && j < i + LOADS_AT_MOST; j++) {
          if (used[j] || rises[j]!.start >= to) break;
          sum += rises[j]!.kg;
          const off = Math.abs(sum - t.quantityKg);
          if (off <= TANKER_TOLERANCE * t.quantityKg && (!best || off < best.off)) best = { i, j, off };
        }
      }
      if (!best) continue;
      matched.add(t);
      for (let k = best.i; k <= best.j; k++) {
        used[k] = true;
        owner[k] = t;
      }
    }
  }
  const tankers = rises.map((move, i) => {
    const t = owner[i];
    if (!t) return { move, transfer: null, bookedKg: 0 };
    const loads = rises.filter((_, k) => owner[k] === t);
    const total = loads.reduce((s, m) => s + m.kg, 0);
    return { move, transfer: t, bookedKg: total > 0 ? (t.quantityKg * move.kg) / total : 0 };
  });
  return { tankers, unseen: ordered.filter((t) => !matched.has(t)) };
}

/** The house's silo and water readings from `from` to `to`. */
async function readings(houseId: string, from: Date, to: Date) {
  const rows = await db
    .select({ at: iotHouseSample.at, siloKg: iotHouseSample.siloKg, waterL: iotHouseSample.waterL })
    .from(iotHouseSample)
    .where(and(eq(iotHouseSample.houseId, houseId), gte(iotHouseSample.at, from), lt(iotHouseSample.at, to)))
    .orderBy(asc(iotHouseSample.at));
  return rows;
}

async function transfersBetween(houseId: string, from: string, to: string): Promise<Transfer[]> {
  const rows = await db
    .select({ number: feedTransfers.number, transferDate: feedTransfers.transferDate, quantityKg: feedTransfers.quantityKg })
    .from(feedTransfers)
    .where(
      and(
        eq(feedTransfers.toHouseId, houseId),
        gte(feedTransfers.transferDate, from),
        lte(feedTransfers.transferDate, to),
        ne(feedTransfers.status, "void"),
      ),
    );
  return rows.map((r) => ({ ...r, quantityKg: Number(r.quantityKg) }));
}

/**
 * Every tanker the silo saw from `fromDay` to `toDay`, matched to the mill's
 * transfers, and the days in and around the window the controller did not see
 * whole — a transfer that arrived while it was offline cannot have been seen,
 * which says nothing about the silo's weights.
 */
export async function tankersFor(houseId: string, fromDay: string, toDay: string) {
  const from = startOf(fromDay);
  const to = startOf(addDays(toDay, 1));
  const rows = await readings(houseId, new Date(startOf(addDays(fromDay, -1)).getTime() - 3_600_000), to);
  const silo = rows.filter((r) => r.siloKg != null && r.siloKg >= 0).map((r) => ({ at: r.at, kg: r.siloKg! }));
  const rises = siloTankers(siloMoves(silo, from, to));
  // Transfers a day either side, so loads at the window's edges find theirs.
  const transfers = await transfersBetween(houseId, addDays(fromDay, -1), addDays(toDay, 1));
  const blind = new Set<string>();
  const today = istDate();
  for (let d = addDays(fromDay, -1); d <= toDay; d = addDays(d, 1)) {
    if (d >= today) continue;
    const c = dayCoverage(
      rows.map((r) => ({ at: r.at, waterL: r.waterL })),
      startOf(d),
      startOf(addDays(d, 1)),
    );
    if (!c.complete) blind.add(d);
  }
  return { ...matchTankers(rises, transfers), blind };
}

/** The house's controller-backed suggestions for one day. */
export async function autofillDay(houseId: string, day: string): Promise<DayAutofill> {
  const dayStart = startOf(day);
  const dayEnd = startOf(addDays(day, 1));
  const eggsProduced = await gradedEggsOn(db, houseId, day);

  const rows = await readings(houseId, new Date(dayStart.getTime() - 3_600_000), dayEnd);
  const over = day < istDate();
  const coverage = over
    ? dayCoverage(rows.map((r) => ({ at: r.at, waterL: r.waterL })), dayStart, dayEnd)
    : { complete: false, reason: "The day isn't over — its figures fill in after midnight." };

  // A week of tankers before the day, to prove the silo's weights — and the
  // day after, so a transfer whose first load came this evening finds the
  // rest of it.
  const week = await tankersFor(houseId, addDays(day, -6), addDays(day, 1));
  const today = week.tankers.filter((t) => t.move.start >= dayStart && t.move.start < dayEnd);
  // A transfer whose arrival window has not closed yet is pending, not unseen.
  const now = new Date();
  const closed = (t: Transfer) =>
    new Date(startOf(addDays(t.transferDate, 1)).getTime() + 12 * 3_600_000) <= now;
  // A transfer that could only have arrived while the controller was blind
  // cannot count against the silo.
  const seeable = (t: Transfer) =>
    ![addDays(t.transferDate, -1), t.transferDate, addDays(t.transferDate, 1)].some((d) => week.blind.has(d));
  const weekUnseen = week.unseen.filter(
    (t) => t.transferDate >= addDays(day, -6) && t.transferDate <= day && closed(t) && seeable(t),
  );
  const proven = week.tankers.some((t) => t.transfer) && weekUnseen.length === 0;

  const silo = rows.filter((r) => r.siloKg != null && r.siloKg >= 0).map((r) => ({ at: r.at, kg: r.siloKg! }));
  const moves = siloMoves(silo, dayStart, dayEnd);
  /*
   * What was eaten is a balance, not a sum of the falls: the silo at midnight,
   * plus what arrived, less the silo at the next midnight. Adding up the falls
   * also adds up the settling while a lorry unloads — L2 on 8 Oct read 10,777
   * that way against the register's 10,422; the balance, taking each tanker at
   * the mill's weight, reads 10,510. A tanker with no transfer counts at the
   * silo's weight.
   */
  const s0 = silo.filter((x) => x.at < dayStart).at(-1)?.kg ?? null;
  const s1 = silo.filter((x) => x.at < dayEnd).at(-1)?.kg ?? null;
  const arrivedAll = today.reduce((sum, t) => sum + (t.transfer ? t.bookedKg : t.move.kg), 0);
  const fed = s0 != null && s1 != null ? Math.round(s0 - s1 + arrivedAll) : 0;
  const counters = over ? await countersOf(houseId, day) : null;
  const counter = counters?.feedKg ?? null;

  // The house's own recent intake, from what was saved.
  const [placement] = await db
    .select({ id: flockPlacements.id })
    .from(flockPlacements)
    .where(
      and(
        eq(flockPlacements.houseId, houseId),
        lte(flockPlacements.fromDate, day),
        sql`(${flockPlacements.toDate} IS NULL OR ${flockPlacements.toDate} >= ${day})`,
      ),
    );
  const saved = placement
    ? await db
        .select({ day: placementDays.day, consumed: placementDays.feedConsumedKg, closing: placementDays.feedClosingKg })
        .from(placementDays)
        .where(
          and(
            eq(placementDays.placementId, placement.id),
            gte(placementDays.day, addDays(day, -7)),
            lt(placementDays.day, day),
          ),
        )
    : [];
  const recent = saved.map((s) => Number(s.consumed)).filter((v) => v > 0).sort((a, b) => a - b);
  const median = recent.length ? recent[Math.floor(recent.length / 2)]! : null;

  const counterNote = counter != null ? [{ label: "Controller counter", value: Math.round(counter) }] : [];
  let feedConsumedKg: Figure;
  if (!coverage.complete) {
    feedConsumedKg = { status: "unavailable", value: null, from: null, note: coverage.reason ?? "" };
  } else if (fed <= 0) {
    feedConsumedKg = { status: "unavailable", value: null, from: null, note: "The silo recorded no feeding runs." };
  } else if (!proven) {
    feedConsumedKg = {
      status: "check",
      value: null,
      from: "silo",
      note: weekUnseen.length
        ? `The silo's tankers didn't match the mill's transfers this week (${weekUnseen.map((t) => t.number).join(", ")}), so its weights can't be trusted — enter the register's figure.`
        : "No tanker this week matched a mill transfer, so the silo's weights are unproven — enter the register's figure.",
      also: [{ label: "Silo", value: fed }, ...counterNote],
    };
  } else if (median != null && Math.abs(fed - median) > INTAKE_TOLERANCE * median) {
    const pct = Math.round(((fed - median) / median) * 100);
    feedConsumedKg = {
      status: "check",
      value: null,
      from: "silo",
      note: `The silo says ${fmt(fed)} kg — ${Math.abs(pct)}% ${pct > 0 ? "above" : "below"} the last 7 days (${fmt(median)}).`,
      also: [{ label: "Silo", value: fed }, ...counterNote],
    };
  } else {
    const runs = moves.filter((m) => m.kg < 0).length;
    feedConsumedKg = {
      status: "filled",
      value: fed,
      from: "silo",
      note: `From the silo: ${runs} feeding run${runs === 1 ? "" : "s"}, tankers at the mill's weight; its tankers matched the mill this week.${
        counter != null ? ` Counter ${fmt(counter)}.` : ""
      }`,
    };
  }

  // Water: the controller's climb across the whole day.
  let waterKl: Figure;
  const waterL = counters?.waterL ?? null;
  if (!coverage.complete) {
    waterKl = { status: "unavailable", value: null, from: null, note: coverage.reason ?? "" };
  } else if (waterL == null || waterL <= 0) {
    waterKl = { status: "unavailable", value: null, from: null, note: "The water meter recorded nothing." };
  } else {
    waterKl = {
      status: "filled",
      value: Math.round(waterL / 10) / 100,
      from: "controller",
      note: "The controller's meter, midnight to midnight.",
    };
  }

  // Stock parts: opening, what arrived, and the silo at midnight.
  const yesterday = saved.find((s) => s.day === addDays(day, -1));
  const before = silo.filter((s) => s.at < dayStart);
  const openingSaved = yesterday?.closing != null ? Number(yesterday.closing) : null;
  const openingSilo = before.length ? before[before.length - 1]!.kg : null;
  const lastIn = silo.filter((s) => s.at < dayEnd && s.at >= dayStart);
  const stock = {
    openingKg: openingSaved ?? (coverage.complete ? openingSilo : null),
    openingFrom: openingSaved != null ? ("saved" as const) : coverage.complete && openingSilo != null ? ("silo" as const) : null,
    arrivedKg: Math.round(today.reduce((s, t) => s + t.bookedKg, 0)),
    unbookedKg: Math.round(
      today.filter((t) => !t.transfer && t.move.kg >= TANKER_MIN_KG).reduce((s, t) => s + t.move.kg, 0),
    ),
    siloKg: coverage.complete && lastIn.length ? Math.round(lastIn[lastIn.length - 1]!.kg) : null,
  };

  const tankers: TankerLine[] = today
    .filter((t) => t.transfer || t.move.kg >= TANKER_MIN_KG)
    .map((t) => ({
      at: t.move.start.toISOString(),
      kg: Math.round(t.move.kg),
      transfer: t.transfer ?? null,
    }));
  const unseenTransfers = week.unseen.filter((t) => t.transferDate === day && closed(t));

  return {
    day,
    complete: coverage.complete,
    reason: coverage.reason,
    feedConsumedKg,
    waterKl,
    stock,
    tankers,
    unseenTransfers,
    eggsProduced,
  };
}

export type Reasons = Partial<Record<"feedConsumedKg" | "feedClosingKg" | "waterKl", string | null>>;

/**
 * Where each figure being saved came from, refusing the ones that need a
 * reason and have none.
 *
 * A figure needs a reason when it overrides one the instruments proved, or
 * when it settles one the checks stopped. A figure left as it was saved before
 * keeps its old provenance — editing a day's mortality must not demand reasons
 * for feed nobody touched.
 */
export function provenance(
  auto: DayAutofill,
  values: { feedConsumedKg: number | null; feedClosingKg: number | null; waterKl: number | null },
  before: { values: Partial<Record<keyof Reasons, number | null>>; sources: DaySources | null } | null,
  reasons: Reasons,
): DaySources {
  const out: DaySources = {};
  const stock = judgeStock(auto.stock, values.feedConsumedKg);
  const figures: Record<keyof Reasons, Figure> = {
    feedConsumedKg: auto.feedConsumedKg,
    feedClosingKg: stock,
    waterKl: auto.waterKl,
  };
  const label = { feedConsumedKg: "feed consumed", feedClosingKg: "feed stock", waterKl: "water" } as const;
  for (const field of ["feedConsumedKg", "feedClosingKg", "waterKl"] as const) {
    const v = values[field];
    if (v == null) continue;
    const old = before?.values[field];
    if (old != null && sameFigure(field, old, v)) {
      const kept = before?.sources?.[field];
      if (kept) out[field] = kept;
      continue;
    }
    const f = figures[field];
    const reason = reasons[field]?.trim() || null;
    let src: FigureSource;
    if (f.status === "filled" && f.value != null && sameFigure(field, f.value, v)) {
      src = { from: f.from!, offered: f.value };
    } else if (f.status === "unavailable") {
      src = { from: "typed", offered: f.value, reason };
    } else {
      if (!reason) {
        throw new PostingError(
          f.status === "filled"
            ? `Say why ${label[field]} differs from the ${f.from === "silo" ? "silo's" : f.from === "book" ? "book's" : "controller's"} ${fmt(f.value!)}.`
            : `Say why you chose ${fmt(v)} for ${label[field]} — ${f.note}`,
        );
      }
      src = { from: "typed", offered: f.value, reason };
    }
    out[field] = src;
  }
  return out;
}
