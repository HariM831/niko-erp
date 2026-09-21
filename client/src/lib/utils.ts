import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge class names, letting a passed className beat a component default. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * The number a bill goes by on screen: the vendor's own, as Zoho shows it,
 * falling back to niko's counter when the vendor's was never entered.
 */
export function billNo(b: { number: string; vendorBillNumber?: unknown }) {
  return (typeof b.vendorBillNumber === "string" && b.vendorBillNumber.trim()) || b.number;
}
