import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge class names, letting a passed className beat a component default. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
