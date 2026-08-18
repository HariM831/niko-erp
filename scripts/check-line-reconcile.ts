/**
 * The arithmetic half of bill reading, checked without spending an API call.
 *
 * check-bill-extraction.ts proves the model transcribes the paper correctly;
 * this proves the server decides correctly given a transcription. It is the
 * cheaper gate and the one that catches the expensive class of bug: a quantity
 * off by a factor of ten, a hundred or a thousand.
 *
 * The case that prompted it: G K Extractions bills in metric tonnes. 43.330
 * against ₹21,79,499 read as kilograms implies ₹50,300/kg, which closes against
 * nothing — so the line arrived at the gate as zero kilograms and the MT figure
 * sat in the bag-count column.
 *
 * Run: npx tsx scripts/check-line-reconcile.ts
 */
import { type RawLine, reconcileLine } from "../server/services/ocr";

let failed = 0;
const check = (name: string, actual: unknown, expected: unknown) => {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failed++;
  console.log(
    `    ${pass ? "PASS" : "FAIL"}  ${name.padEnd(46)} ` +
      (pass ? String(actual) : `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`),
  );
};

const line = (over: Partial<RawLine>): RawLine => ({
  lineNo: 1,
  description: "Material",
  hsnCode: null,
  quantityCellRaw: null,
  quantityUnitRaw: null,
  bagCountRaw: null,
  handwrittenWeightRaw: null,
  ratePrinted: null,
  amount: null,
  ...over,
});

interface Case {
  name: string;
  raw: Partial<RawLine>;
  quantityKg: number | null;
  bagCount: number | null;
  ratePerKg: number | null;
  rateBasis: string | null;
  reconciled: boolean;
}

const cases: Case[] = [
  {
    // The bag-count trap: 401 is packages, the weight is handwritten, and the
    // printed 2310 is per quintal. Reading 401 as kilos implies ₹1,404/kg.
    name: "517 — bag count in the quantity column",
    raw: {
      quantityCellRaw: "401 Pm",
      handwrittenWeightRaw: "wt 24380",
      ratePrinted: 2310,
      amount: 563178,
    },
    quantityKg: 24380,
    bagCount: 401,
    ratePerKg: 23.1,
    rateBasis: "quintal",
    reconciled: true,
  },
  {
    // The bug this script was written for, with the header transcribed.
    name: "G K — tonnes, unit named in the column header",
    raw: {
      quantityCellRaw: "43.330",
      quantityUnitRaw: "MT",
      bagCountRaw: "760",
      ratePrinted: 50300,
      amount: 2179499,
    },
    quantityKg: 43330,
    bagCount: 760,
    ratePerKg: 50.3,
    rateBasis: "mt",
    reconciled: true,
  },
  {
    // Same bill, header missed. The unit has to be inferred: quintal would mean
    // ₹503/kg, outside anything a feed material has ever cost.
    name: "G K — tonnes inferred when the header is missed",
    raw: {
      quantityCellRaw: "43.330",
      bagCountRaw: "760",
      ratePrinted: 50300,
      amount: 2179499,
    },
    quantityKg: 43330,
    bagCount: 760,
    ratePerKg: 50.3,
    rateBasis: "mt",
    reconciled: true,
  },
  {
    name: "the unit written in the cell itself is believed",
    raw: { quantityCellRaw: "43.330 MT", ratePrinted: 50300, amount: 2179499 },
    quantityKg: 43330,
    bagCount: null,
    ratePerKg: 50.3,
    rateBasis: "mt",
    reconciled: true,
  },
  {
    name: "quintals, unit named — 243.80 Qtl",
    raw: { quantityCellRaw: "243.80", quantityUnitRaw: "Qtl", ratePrinted: 2310, amount: 563178 },
    quantityKg: 24380,
    bagCount: null,
    ratePerKg: 23.1,
    rateBasis: "quintal",
    reconciled: true,
  },
  {
    name: "plain kilograms are left alone",
    raw: { quantityCellRaw: "24380", quantityUnitRaw: "Kgs", ratePrinted: 23.1, amount: 563178 },
    quantityKg: 24380,
    bagCount: null,
    ratePerKg: 23.1,
    rateBasis: "kg",
    reconciled: true,
  },
  {
    // Scaling is not a licence to invent: the rate column has to agree before
    // an inferred unit is believed.
    name: "an inferred unit the rate does not corroborate is refused",
    raw: { quantityCellRaw: "401", ratePrinted: 2310, amount: 999999 },
    quantityKg: null,
    bagCount: 401,
    ratePerKg: null,
    rateBasis: null,
    reconciled: false,
  },
  {
    // Quintal and tonne readings differ by exactly 10×, so the rate column
    // corroborates both and cannot separate them. Where they trade apart —
    // ₹30/kg against ₹300/kg — the trading band decides, and says so.
    name: "a 10x tie is broken by where material trades",
    raw: { quantityCellRaw: "40", ratePrinted: 30000, amount: 1200000 },
    quantityKg: 40000,
    bagCount: null,
    ratePerKg: 30,
    rateBasis: "mt",
    reconciled: true,
  },
  {
    // ...but ₹10/kg and ₹100/kg are both real feed prices. Nothing on the paper
    // separates them, so the line is handed to a person rather than guessed.
    name: "an undecidable unit is refused, not guessed",
    raw: { quantityCellRaw: "100", ratePrinted: 10000, amount: 1000000 },
    quantityKg: null,
    bagCount: 100,
    ratePerKg: null,
    rateBasis: null,
    reconciled: false,
  },
  {
    name: "no amount means nothing can be reconciled",
    raw: { quantityCellRaw: "401 Pm", handwrittenWeightRaw: "wt 24380" },
    quantityKg: 24380,
    bagCount: 401,
    ratePerKg: null,
    rateBasis: null,
    reconciled: false,
  },
  {
    // A printed bag column outranks the guess that the leftover number is bags.
    name: "a printed bag column is used verbatim",
    raw: {
      quantityCellRaw: "999",
      bagCountRaw: "760",
      handwrittenWeightRaw: "24380",
      ratePrinted: 2310,
      amount: 563178,
    },
    quantityKg: 24380,
    bagCount: 760,
    ratePerKg: 23.1,
    rateBasis: "quintal",
    reconciled: true,
  },
];

for (const c of cases) {
  console.log(`\n  ${c.name}`);
  const r = reconcileLine(line(c.raw));
  check("quantityKg", r.quantityKg, c.quantityKg);
  check("bagCount", r.bagCount, c.bagCount);
  check("ratePerKg", r.ratePerKg, c.ratePerKg);
  check("rateBasis", r.rateBasis, c.rateBasis);
  check("reconciled", r.reconciled, c.reconciled);
  if (r.basis) console.log(`          ${r.basis}`);
  r.warnings.forEach((w) => console.log(`          · ${w}`));
}

console.log(failed === 0 ? "\n  All reconciliation checks passed.\n" : `\n  ${failed} FAILED.\n`);
process.exit(failed ? 1 : 0);
