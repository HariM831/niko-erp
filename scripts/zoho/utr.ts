/**
 * A bank reference belongs to one transfer, which makes it the only hard
 * evidence that two records are one deposit.
 *
 * Zoho and the bank statement spell the same reference differently — spaces,
 * a trailing customer name, an IMPS or NEFT prefix — so the comparison is of
 * the long alphanumeric runs inside, and everything else is ignored.
 */

/**
 * A bank reference carries its bank's letters: PUNBR5..., SBIY226...,
 * HDFCR5... A bare thirteen-digit run is the payer's account number, which
 * repeats across every transfer they ever make and paired four unrelated
 * receipts the first time this was tried. A bare twelve is an IMPS id.
 */
export const utrs = (s: string | null | undefined) =>
  new Set(
    (s ?? "")
      .toUpperCase()
      .split(/[^A-Z0-9]+/)
      .filter((t) => {
        const letters = (t.match(/[A-Z]/g) ?? []).length;
        const digits = (t.match(/\d/g) ?? []).length;
        return (letters >= 3 && digits >= 8) || /^\d{12}$/.test(t);
      }),
  );

export const sharesUtr = (a: Set<string>, b: Set<string>) => [...a].some((t) => b.has(t));
