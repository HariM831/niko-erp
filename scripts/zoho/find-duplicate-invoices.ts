/**
 * Find the same sale written twice, once in each book.
 *
 *   npx tsx scripts/zoho/find-duplicate-invoices.ts
 *   npx tsx scripts/zoho/find-duplicate-invoices.ts --days 1
 *
 * Zoho holds two invoices for Puya: A-INV-EG-27-0913 of 2 October and
 * A-INV-EG-27-0948 of 7 October, both under PUYA MARKETING. niko holds four —
 * those two, renumbered, and two more for the same days and the same amounts
 * under a second contact called M/s Puya, raised here while both books were
 * being kept at once.
 *
 * The catch-up never paired them because it required the customer to agree,
 * and PUYA MARKETING is not M/s Puya by any spelling. So each was taken for a
 * sale the other book did not have, and both were given a slot in the series.
 *
 * The signature is one copy carrying a Zoho link and the other carrying none:
 * one sale, written once in each book, under a customer record each. Two loads
 * of the same value to the same customer on one day do happen, so this reports
 * and does not delete; a pair with its own receipt on each side, in the same
 * bank, is the proof to look for, and the receipts are printed under each.
 */
import { sql } from "drizzle-orm";
import { db, pool } from "../../server/db";

/** The same question of what we bought. Complaints of duplicates, 22 Oct 2026. */
const BILLS = process.argv.includes("--bills");
const SIDE = BILLS
  ? { doc: "bills", party: "vendor_id", name: "Vendor Name", word: "bill", dispatch: false }
  : { doc: "invoices", party: "customer_id", name: "Customer Name", word: "invoice", dispatch: true };

const daysAt = process.argv.indexOf("--days");
/** The same sale may be dated a day apart between the books. */
const DAYS = daysAt > -1 ? Number(process.argv[daysAt + 1]) : 0;

const money = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 0 });

interface Inv {
  id: string; number: string; date: string; cust: string; cust_id: string;
  total: number; status: string; zoho: string | null; created: string;
  dispatches: number; receipts: string | null;
}

/**
 * Two names are the same party when they share a word that names somebody.
 * Half this trade is called Traders, Store, Egg Point or Enterprise, and NB
 * Traders is not Kamakhya Traders: on the first run that one word alone
 * paired eighty sales that were nothing of the sort.
 */
const GENERIC = new Set([
  "the", "and", "mrs", "shri", "sri", "ltd", "llp", "pvt", "private", "limited",
  "traders", "trader", "trading", "store", "stores", "shop", "egg", "eggs",
  "point", "center", "centre", "enterprise", "enterprises", "marketing",
  "agency", "agencies", "bakery", "farm", "farms", "food", "foods", "poultry",
  "sons", "brothers", "company", "distributors", "suppliers", "general",
]);
const words = (s: string) =>
  new Set(
    s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/)
      .filter((w) => w.length > 2 && !GENERIC.has(w)),
  );
const related = (a: string, b: string) => {
  const [x, y] = [words(a), words(b)];
  return [...x].some((w) => y.has(w));
};

async function main() {
  console.log(`\n  Invoices written twice — same amount, ${DAYS ? `within ${DAYS} day(s)` : "same day"}\n`);

  const rows = (
    await db.execute(sql`
      SELECT i.id::text, i.number,
             ${BILLS ? sql`i.bill_date` : sql`i.invoice_date`}::text AS date,
             c.display_name AS cust,
             i.${BILLS ? sql`vendor_id` : sql`customer_id`}::text AS cust_id,
             i.total::float8 AS total, i.status::text,
             i.created_at::text AS created,
             (SELECT z.zoho_id FROM zoho_id_map z
               WHERE z.entity = ${BILLS ? "bill" : "invoice"} AND z.eggsy_id = i.id) AS zoho,
             -- Which copy to keep is decided by this: the eggs left the farm
             -- once, and the invoice carrying the dispatch is the one that
             -- moved them. The other is paper. A bill has its own version of
             -- that question — the goods receipt — which is read separately.
             ${BILLS ? sql`0` : sql`(SELECT count(*)::int FROM egg_dispatches d WHERE d.invoice_id = i.id)`} AS dispatches,
             ${
               BILLS
                 ? sql`(SELECT string_agg(p.number || ' ' || to_char(p.payment_date, 'DD Mon') || ' ' ||
                                round(pa.amount_applied::numeric)::text, ', ' ORDER BY p.payment_date)
                FROM vendor_payment_applications pa JOIN vendor_payments p ON p.id = pa.payment_id
               WHERE pa.bill_id = i.id)`
                 : sql`(SELECT string_agg(p.number || ' ' || to_char(p.payment_date, 'DD Mon') || ' ' ||
                                round(pa.amount_applied::numeric)::text, ', ' ORDER BY p.payment_date)
                FROM payment_applications pa JOIN customer_payments p ON p.id = pa.payment_id
               WHERE pa.invoice_id = i.id)`
             } AS receipts,
             -- A bill the vendor numbered himself. Two of ours carrying one
             -- of his is the only proof of a duplicate that does not depend
             -- on a judgement about dates and amounts.
             ${BILLS ? sql`i.vendor_bill_number` : sql`NULL`} AS their_number
        FROM ${BILLS ? sql`bills` : sql`invoices`} i
        JOIN contacts c ON c.id = i.${BILLS ? sql`vendor_id` : sql`customer_id`}
       WHERE i.status NOT IN ('void', 'draft')
       ORDER BY 3, i.number
    `)
  ).rows as Inv[];

  const pairs: Array<{ a: Inv; b: Inv; why: string; both: boolean }> = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const [a, b] = [rows[i]!, rows[j]!];
      const apart = Math.abs((Date.parse(a.date) - Date.parse(b.date)) / 86_400_000);
      if (apart > DAYS) break;                       // rows are in date order
      if (Math.abs(a.total - b.total) > 1) continue;
      const sameParty = a.cust_id === b.cust_id;
      const books = !a.zoho !== !b.zoho;
      if (!sameParty && !related(a.cust, b.cust)) continue;
      pairs.push({
        a, b,
        /**
         * One copy carrying a Zoho link and the other carrying none is the
         * two-books signature. Two copies from one book are a different
         * question — a customer can take two loads of the same value in a day,
         * and several did — so those are listed apart, and nothing here says
         * they are wrong.
         */
        both: books,
        why: [
          a.their_number && a.their_number === b.their_number
            ? `BOTH CARRY THE VENDOR'S BILL ${a.their_number}`
            : "",
          sameParty ? "same customer" : `two records for one party — ${a.cust} / ${b.cust}`,
          books ? "one from Zoho, one raised here" : a.zoho ? "both from Zoho" : "both raised here",
          apart ? `${apart} day apart` : "same day",
        ].filter(Boolean).join("; "),
      });
    }
  }

  for (const [label, set] of [
    ["ONE IN EACH BOOK", pairs.filter((p) => p.both)],
    ["BOTH IN ONE BOOK — a customer may take two loads of a value in a day", pairs.filter((p) => !p.both)],
  ] as const) {
    const value = set.reduce((s, p) => s + Math.min(p.a.total, p.b.total), 0);
    console.log(`  ${label}: ${set.length} pair(s), Rs ${money(value)} counted twice if they are\n`);
    for (const p of set) {
      console.log(`    ${p.why}`);
      for (const r of [p.a, p.b]) {
        console.log(
          `      ${r.number.padEnd(20)}${r.date}  ${r.cust.slice(0, 22).padEnd(23)}${money(r.total).padStart(12)}` +
            `  ${r.status.padEnd(15)}${(r.zoho ? "from Zoho" : "raised here").padEnd(13)}` +
            `${BILLS ? (r.their_number ?? "no vendor number") : r.dispatches ? `${r.dispatches} dispatch` : "no dispatch"}`,
        );
        console.log(`        ${r.receipts ?? "(nothing applied)"}`);
      }
      console.log();
    }
  }
  await pool.end();
}

main().catch(async (e) => {
  console.error(`\n  ${e.message}\n`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
