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
  /** Yesterday's closing figure, or the silo at midnight when there is none. */
  openingKg: number | null;
  openingFrom: "saved" | "silo" | null;
  /** Mill transfers whose tankers reached the silo this day, by the mill's weight. */
  arrivedKg: number;
  /** Tankers that reached the silo this day with no mill transfer behind them. */
  unbookedKg: number;
  /** The silo at midnight, when the controller covered the day. */
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

/** The book and the silo may differ by this much before stock stops for a person. */
export const STOCK_TOLERANCE_KG = 500;

/**
 * Closing stock, judged from whatever feed-consumed figure is in the box.
 *
 * The book — yesterday's closing, plus what the mill sent that arrived, less
 * what was eaten — is the figure, because it balances with the mill's
 * transfers. The silo at midnight is the check on it.
 */
export function judgeStock(p: StockParts, consumedKg: number | null): Figure {
  if (p.openingKg == null || consumedKg == null) {
    return {
      status: "unavailable",
      value: null,
      from: null,
      note:
        p.openingKg == null
          ? "No opening stock — yesterday has no closing figure and the silo wasn't reporting."
          : "Enter feed consumed first; stock follows from it.",
      also: p.siloKg != null ? [{ label: "Silo at midnight", value: p.siloKg }] : undefined,
    };
  }
  const book = Math.round(p.openingKg + p.arrivedKg - consumedKg);
  if (p.unbookedKg > 0) {
    return {
      status: "check",
      value: null,
      from: "book",
      note: `A tanker of ${fmt(p.unbookedKg)} kg arrived with no mill transfer, so the book is short — get the mill to enter it first.`,
      also: [
        { label: "Book", value: book },
        ...(p.siloKg != null ? [{ label: "Silo at midnight", value: p.siloKg }] : []),
      ],
    };
  }
  if (p.siloKg == null) {
    return {
      status: "unavailable",
      value: null,
      from: null,
      note: "The silo wasn't reporting, so the book can't be checked.",
      also: [{ label: "Book", value: book }],
    };
  }
  const gap = p.siloKg - book;
  if (Math.abs(gap) > STOCK_TOLERANCE_KG) {
    return {
      status: "check",
      value: null,
      from: "book",
      note: `The book and the silo differ by ${fmt(Math.abs(gap))} kg.`,
      also: [
        { label: "Book", value: book },
        { label: "Silo at midnight", value: p.siloKg },
      ],
    };
  }
  return {
    status: "filled",
    value: book,
    from: "book",
    note: `Opening ${fmt(p.openingKg)} + arrived ${fmt(p.arrivedKg)} − eaten ${fmt(consumedKg)}; silo ${fmt(p.siloKg)} (${gap >= 0 ? "+" : "−"}${fmt(Math.abs(gap))}).`,
  };
}

/** A saved figure counts as the offer when it is the offer to the kilo (or 50 litres). */
export function sameFigure(field: "feedConsumedKg" | "feedClosingKg" | "waterKl", a: number, b: number): boolean {
  return Math.abs(a - b) <= (field === "waterKl" ? 0.05 : 1);
}

const fmt = (n: number) => Math.round(n).toLocaleString("en-IN");
