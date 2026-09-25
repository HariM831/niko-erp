import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge class names, letting a passed className beat a component default. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * A date as YYYY-MM-DD in the viewer's own calendar — today when called bare.
 * Never toISOString().slice(0, 10): that reads the date in UTC, and India is
 * five and a half hours ahead, so local midnight on the 1st is still the 31st
 * and "today" is yesterday until 5:30 am.
 */
export const localYmd = (d: Date = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * The number a bill goes by on screen: the vendor's own, as Zoho shows it,
 * falling back to niko's counter when the vendor's was never entered.
 */
export function billNo(b: { number: string; vendorBillNumber?: unknown }) {
  return (typeof b.vendorBillNumber === "string" && b.vendorBillNumber.trim()) || b.number;
}

/**
 * The server's search rule (matches() in server/services/document-search.ts),
 * for lists the page already holds whole, like a bank account's register. Words
 * match from their start; a term with a digit in it is a number and matches
 * anywhere. Keep the two in step.
 */
export function matchesTerm(term: string, fields: Array<string | null | undefined>) {
  const t = term.trim().toLowerCase();
  if (!t) return true;
  if (/\d/.test(t)) return fields.some((f) => f?.toLowerCase().includes(t));
  const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}`, "iu");
  return fields.some((f) => !!f && re.test(f));
}

/**
 * A moment, read in the farm's own clock.
 *
 * Everything niko records happens in Assam, so a time on the screen means IST
 * whoever is looking — a director reading the gate from Dubai must not see a
 * shift starting at 06:30. Left to the browser these render in whatever zone
 * the viewer's laptop is set to, which is right in Nabil and wrong anywhere
 * else, and silently so. [[dates-never-toisostring]] is the same rule for the
 * other direction.
 */
const IST = "Asia/Kolkata";

export const istTime = (at: string | number | Date | null | undefined, opts: Intl.DateTimeFormatOptions = {}) =>
  at == null
    ? "—"
    : new Date(at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: IST, ...opts });

export const istDateTime = (at: string | number | Date | null | undefined, opts: Intl.DateTimeFormatOptions = {}) =>
  at == null
    ? "—"
    : new Date(at).toLocaleString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: IST,
        ...opts,
      });

export const istDateOf = (at: string | number | Date | null | undefined) =>
  at == null
    ? "—"
    : new Date(at).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: IST });
