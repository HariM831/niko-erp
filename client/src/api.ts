export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public issues?: Array<{ path: string; message: string }>,
    /** The full error body, for responses that carry more than a message. */
    public data?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(path, {
    method: options.method ?? "GET",
    headers: options.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    credentials: "same-origin",
  });
  if (!res.ok) {
    let message = res.statusText;
    let issues;
    let data;
    try {
      data = await res.json();
      message = data.error ?? message;
      issues = data.issues;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, message, issues, data);
  }
  return res.json() as Promise<T>;
}

export const formatMoney = (v: string | number | null | undefined) =>
  `₹${Number(v ?? 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const formatDate = (d: string | null | undefined) =>
  d ? new Date(`${d}T00:00:00`).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "—";

const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function threeDigitsToWords(n: number): string {
  let s = "";
  if (n >= 100) {
    s += `${ONES[Math.floor(n / 100)]} Hundred `;
    n %= 100;
  }
  if (n >= 20) {
    s += `${TENS[Math.floor(n / 10)]} `;
    n %= 10;
  }
  if (n > 0) s += `${ONES[n]} `;
  return s.trim();
}

/** Indian numbering (Lakh/Crore) amount-in-words, matching Zoho's invoice footer. */
export function amountInWords(amount: string | number): string {
  const rupees = Math.floor(Number(amount));
  const paise = Math.round((Number(amount) - rupees) * 100);
  if (rupees === 0 && paise === 0) return "Indian Rupee Zero Only";

  let n = rupees;
  const parts: string[] = [];
  const crore = Math.floor(n / 10000000);
  n %= 10000000;
  const lakh = Math.floor(n / 100000);
  n %= 100000;
  const thousand = Math.floor(n / 1000);
  n %= 1000;
  const hundred = n;

  if (crore) parts.push(`${threeDigitsToWords(crore)} Crore`);
  if (lakh) parts.push(`${threeDigitsToWords(lakh)} Lakh`);
  if (thousand) parts.push(`${threeDigitsToWords(thousand)} Thousand`);
  if (hundred) parts.push(threeDigitsToWords(hundred));

  let words = `Indian Rupee ${parts.join(" ")}`;
  if (paise > 0) words += ` and ${threeDigitsToWords(paise)} Paise`;
  return `${words} Only`;
}
