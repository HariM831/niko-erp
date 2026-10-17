/**
 * The house-day entry form's suggestions, and the rules for trusting them.
 *
 * Shared because the form and the save must agree: the form shows a figure as
 * proven, and the save refuses an unexplained change to a proven figure, so
 * both have to judge it the same way. The data is gathered on the server — see
 * server/services/house-day-autofill.ts, which carries the reasoning.
 */

/**
 *  - filled: the instruments agree; the box opens with it. Typing over it
 *    needs a reason.
 *  - check: there is a figure, but a check failed; the box opens empty, the
 *    figures are shown, and whatever is saved needs a reason.
 *  - unavailable: nothing trustworthy to offer (controller offline, day not
 *    over). Typed freely.
 */
export type FigureStatus = "filled" | "check" | "unavailable";

export interface Figure {
  status: FigureStatus;
  value: number | null;
  from: "silo" | "controller" | "book" | null;
  /** One line for under the box. */
  note: string;
  /** Other readings worth seeing beside it. */
  also?: Array<{ label: string; value: number }>;
}

export interface TankerLine {
  /** ISO instant the silo started rising. */
  at: string;
  /** What the silo gained. */
  kg: number;
  /** The mill transfer it was matched to, if any. */
  transfer?: { number: string; quantityKg: number; transferDate: string } | null;
}

export interface StockParts {
  /** Yesterday's closing figure, or the silo at 18:00 the day before when there is none. */
  openingKg: number | null;
  openingFrom: "saved" | "silo" | null;
  /** The mill's transfers into the house dated this day — feed in (17 Oct 2026). */
  arrivedKg: number;
  /** Tankers that reached the silo this day with no mill transfer behind them. */
  unbookedKg: number;
  /** The silo at 18:00, when the controller covered the silo's day. */
  siloKg: number | null;
}

export interface DayAutofill {
  day: string;
  complete: boolean;
  /** Why the controller's day can't be used, when it can't. */
  reason: string | null;
  feedConsumedKg: Figure;
  waterKl: Figure;
  stock: StockParts;
  tankers: TankerLine[];
  /** Transfers dated around this day that no tanker has matched. */
  unseenTransfers: Array<{ number: string; quantityKg: number; transferDate: string }>;
  eggsProduced: number | null;
}

/**
 * Closing stock: the silo at 18:00 (decided 17 Oct 2026).
 *
 * Until then it was the book — yesterday's closing, plus what the mill sent,
 * less what was eaten — checked against the silo. With the silos reading
 * under the mill (L2, L3), the mill's transfers stand as feed in and the silo
 * as stock, and the book is shown beside it for the difference to be seen.
 * `consumedKg` only feeds that book.
 */
export function judgeStock(p: StockParts, consumedKg: number | null): Figure {
  const book =
    p.openingKg != null && consumedKg != null ? Math.round(p.openingKg + p.arrivedKg - consumedKg) : null;
  const bookLine = book != null ? [{ label: "Book", value: book }] : [];
  if (p.siloKg == null) {
    return {
      status: "unavailable",
      value: null,
      from: null,
      note: "The silo wasn't reporting through 18:00.",
      also: bookLine.length ? bookLine : undefined,
    };
  }
  return {
    status: "filled",
    value: p.siloKg,
    from: "silo",
    note:
      book != null
        ? `The silo at 18:00. The book (opening ${fmt(p.openingKg!)} + transfers ${fmt(p.arrivedKg)} − eaten ${fmt(consumedKg!)}) says ${fmt(book)} (${p.siloKg - book >= 0 ? "+" : "−"}${fmt(Math.abs(p.siloKg - book))}).`
        : "The silo at 18:00.",
  };
}

/** A saved figure counts as the offer when it is the offer to the kilo (or 50 litres). */
export function sameFigure(field: "feedConsumedKg" | "feedClosingKg" | "waterKl", a: number, b: number): boolean {
  return Math.abs(a - b) <= (field === "waterKl" ? 0.05 : 1);
}

const fmt = (n: number) => Math.round(n).toLocaleString("en-IN");
