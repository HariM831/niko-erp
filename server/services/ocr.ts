/**
 * Reading a vendor's bill.
 *
 * The division of labour here is the whole design: **the model reads, the
 * server decides.** Gemini is asked only for what is physically printed or
 * written on the paper — the digits in each cell, verbatim, including the ones
 * it is unsure about. Every judgement that follows (which number is the weight,
 * what the rate is per, whether the line closes) is arithmetic done here, where
 * it is testable and cannot be talked out of an answer.
 *
 * That split is not academic. On bill 517 the rate reads convincingly as 2810;
 * only 2310 makes 24,380 kg come to ₹5,63,178. A confident misread of one digit
 * would overpay by ₹1,21,900 on a single truck. And in the Qnty column both
 * bills carry a bag count — 401, 666 — where a naive reader expects the weight,
 * which is wrong by a factor of sixty.
 *
 * The third trap is the unit. A quantity column holds 24380 on one bill and
 * 43.330 on the next, and only the column header says the second is tonnes.
 * Read as kilograms it implies ₹50,300/kg, closes against nothing, and the
 * truck reaches the gate showing zero kilograms billed.
 *
 * See fixtures/bills/ for the bills these rules were derived from, and
 * scripts/check-line-reconcile.ts for the arithmetic, which is checked without
 * spending an API call.
 */
import { GoogleGenerativeAI } from "@google/generative-ai";

/**
 * A floating alias, deliberately. Pinned versions rot: gemini-2.5-flash is
 * still listed by the models endpoint but returns 404 "no longer available to
 * new users" when called. The resolved name is recorded on every receipt in
 * ocr_model so a change in behaviour stays attributable.
 */
/**
 * Measured, not assumed. scripts/measure-ocr-cost.ts ran both candidates over
 * both bills: flash-lite scored 26/26, identical to flash, on the hardest
 * document we have — handwritten quintal rates with a bag count sitting in the
 * quantity column. There is no reason to pay for the larger model.
 *
 * Overridable by env so a bad reading can be answered by changing a variable
 * rather than shipping a deploy. Floating aliases on purpose: gemini-2.5-flash
 * is still listed by the models endpoint but 404s for new keys, and a pinned
 * name that dies is worse than one that moves.
 */
export const OCR_MODEL = process.env.OCR_MODEL_BILL || "gemini-flash-lite-latest";
/** Plate and weigh slip: an embossed plate and dot-matrix on white. */
export const OCR_MODEL_SIMPLE = process.env.OCR_MODEL_SIMPLE || "gemini-flash-lite-latest";

export const MAX_IMAGES = 5;
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp"] as const;

/** Feed materials sit well inside this. Outside it, a number is not a rate. */
const PLAUSIBLE_RATE_PER_KG = { min: 1, max: 500 };
/**
 * Where feed raw material actually trades. Deliberately NOT used to reject a
 * reading — only to break a tie between two inferred units, because quintal and
 * tonne readings differ by exactly 10× and the rate column corroborates both or
 * neither. A tie it cannot break is refused, not guessed.
 */
const TYPICAL_RATE_PER_KG = { min: 5, max: 150 };
/** Line closes if quantity × rate lands within this much of the printed amount. */
const RECONCILE_TOLERANCE = 0.005; // 0.5%

export type RateBasis = "kg" | "quintal" | "mt";
const BASIS_DIVISOR: Record<RateBasis, number> = { kg: 1, quintal: 100, mt: 1000 };

/**
 * A quantity cell is not always in kilograms. G K Extractions bills in metric
 * tonnes — "43.330" against ₹50,300 — and reading that as 43 kg makes the rate
 * ₹50,300/kg, which closes against nothing and lands the line at zero.
 *
 * Ordered smallest leap first: where two bases would both close, quintal is the
 * likelier reading and the ambiguity is warned about rather than guessed at.
 */
const SCALED_BASES: RateBasis[] = ["quintal", "mt"];

/** The unit written in the cell itself, when the vendor bothered: "43.330 MT". */
function statedBasis(raw: string | null): RateBasis | null {
  if (!raw) return null;
  if (/\b(m\.?\s?t\.?|tonnes?|tons?)\b/i.test(raw)) return "mt";
  if (/\b(q(?:tl|ntl|uintals?))\b/i.test(raw)) return "quintal";
  if (/\b(k\.?\s?gs?\.?|kilos?|kilograms?)\b/i.test(raw)) return "kg";
  return null;
}

export interface RawLine {
  lineNo: number;
  description: string | null;
  hsnCode: string | null;
  /** The Qnty cell verbatim, e.g. "401 Pm" — often a bag count, not a weight. */
  quantityCellRaw: string | null;
  /** The unit named in that column's header, e.g. "MT" from "Quantity (MT)". */
  quantityUnitRaw: string | null;
  /** A separate bag/package count column, when the bill has one, e.g. "760". */
  bagCountRaw: string | null;
  /** Any handwritten weight elsewhere in the row, e.g. "wt 24380". */
  handwrittenWeightRaw: string | null;
  ratePrinted: number | null;
  amount: number | null;
}

export interface RawBill {
  documentType: string | null;
  vendorName: string | null;
  vendorPan: string | null;
  vendorGstin: string | null;
  billNumber: string | null;
  billDateRaw: string | null;
  vehicleNumberRaw: string | null;
  grandTotal: number | null;
  taxTotal: number | null;
  lines: RawLine[];
}

export interface ExtractedLine {
  lineNo: number;
  description: string | null;
  materialName: string | null;
  itemId: string | null;
  hsnCode: string | null;
  quantityKg: number | null;
  bagCount: number | null;
  ratePerKg: number | null;
  rateBasis: RateBasis | null;
  amount: number | null;
  /** quantity × rate closes against the printed amount. */
  reconciled: boolean;
  /** How the quantity was decided, so a person can see the reasoning. */
  basis: string | null;
}

export interface ExtractedBill {
  documentType: "tax_invoice" | "bill_of_supply" | "delivery_challan" | "unknown";
  vendor: string | null;
  vendorPan: string | null;
  vendorGstin: string | null;
  billNumber: string | null;
  billDate: string | null;
  vehicleNumber: string | null;
  billTotal: number | null;
  billTax: number | null;
  footingOk: boolean;
  lines: ExtractedLine[];
  warnings: string[];
  model: string;
}

const buildPrompt = (today: string) => `You are reading a photograph of an Indian trade bill
for animal feed raw material. Transcribe what is on the paper. Do NOT calculate,
correct or reconcile anything — arithmetic is done elsewhere.

Today is ${today}. The bill is being read at the gate as the truck arrives, so
its date is almost always within the last few days and never years old. Use that
only to settle an ambiguous handwritten digit in the YEAR of the date — for
example a two-digit year that could be 24 or 26. Never let it override a year
that is clearly legible, and never apply it to any other field.

Return ONLY a JSON object, no markdown fence, matching exactly:

{
  "documentType": "tax_invoice" | "bill_of_supply" | "delivery_challan" | "unknown",
  "vendorName": string|null,
  "vendorPan": string|null,
  "vendorGstin": string|null,
  "billNumber": string|null,
  "billDateRaw": string|null,
  "vehicleNumberRaw": string|null,
  "grandTotal": number|null,
  "taxTotal": number|null,
  "lines": [{
    "lineNo": number,
    "description": string|null,
    "hsnCode": string|null,
    "quantityCellRaw": string|null,
    "quantityUnitRaw": string|null,
    "bagCountRaw": string|null,
    "handwrittenWeightRaw": string|null,
    "ratePrinted": number|null,
    "amount": number|null
  }]
}

Rules:
1. ONE ROW of the particulars table is ONE line. Never merge rows. Never invent
   a row for a subtotal, a tax line or freight — those belong to the header.
2. "quantityCellRaw": copy the Qnty cell EXACTLY as written, including any unit
   or suffix, e.g. "401 Pm", "666 Pkt". Do not convert it. Do not clean it up.
3. "quantityUnitRaw": the unit named in that column's HEADER, e.g. "MT" from a
   header reading "Quantity (MT)", or "Kgs", "Qtl". Null if the header names no
   unit. This matters: the same column holds 43.330 on one bill and 24380 on
   another, and only the header says which is tonnes.
4. "bagCountRaw": if the row has a SEPARATE column counting bags, packages or
   pieces (a header like "Bags", "Pkgs", "No. of Bags"), copy that cell here.
   Null if there is no such column. Never duplicate the Qnty cell into it.
5. "handwrittenWeightRaw": if a weight is handwritten anywhere in or under the
   row (often like "wt 24380" or "24380 kg"), copy it verbatim here. Otherwise
   null. This is separate from the Qnty cell and both may be present.
6. "ratePrinted": the number in the Rate cell as printed, with no unit applied.
   If a digit is genuinely ambiguous, give your single best reading — the
   arithmetic downstream will resolve it.
7. "amount" and "grandTotal": strip Indian digit grouping, so "5,63,178"
   becomes 563178.
8. "taxTotal": only if GST/CGST/SGST/IGST is actually printed. A BILL OF SUPPLY
   charges no tax — use null, not 0.
9. The buyer is NOT the vendor. A "Party Name" field names the buyer. The
   vendor is the letterhead at the top. Never return the buyer as vendorName.
10. "billDateRaw": copy verbatim, e.g. "13/8/26". Do not reformat.
11. Use null for anything absent or illegible. Never guess a value that is not
   on the paper.`;

/** "401 Pm" → 401. "1,250 bags" → 1250. Anything without digits → null. */
function firstNumber(raw: string | null): number | null {
  if (!raw) return null;
  const m = raw.replace(/,/g, "").match(/\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

/** DD/MM/YY or DD-MM-YYYY → ISO. Indian order; never MM/DD. */
export function parseIndianDate(
  raw: string | null,
  what = "Bill date",
): { date: string | null; warning?: string } {
  if (!raw) return { date: null };
  const m = raw.replace(/\s/g, "").match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (!m) return { date: null, warning: `Could not read the ${what.toLowerCase()} "${raw}"` };
  const day = Number(m[1]);
  const month = Number(m[2]);
  let year = Number(m[3]);
  if (year < 100) year += 2000;
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return { date: null, warning: `${what} "${raw}" is not a real date` };
  }
  const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  const now = Date.now();
  if (parsed.getTime() > now + 86_400_000) {
    return { date: iso, warning: `${what} ${iso} is in the future` };
  }
  if (now - parsed.getTime() > 18 * 30 * 86_400_000) {
    return { date: iso, warning: `${what} ${iso} is over 18 months old` };
  }
  return { date: iso };
}

const close = (a: number, b: number) => Math.abs(a - b) <= Math.abs(b) * RECONCILE_TOLERANCE;

/**
 * Decide what this line actually says.
 *
 * Rather than trusting the Rate cell — whose digits are the least legible thing
 * on a handwritten bill — the per-kg rate is DERIVED from quantity and amount,
 * which are the two figures a vendor is most careful about. Each candidate
 * quantity is tried; the one yielding a plausible rate that also closes against
 * the printed amount wins.
 *
 * On 517 that turns "401 Pm" and "wt 24380" into: 563178 / 24380 = ₹23.10/kg,
 * which is the printed 2310 read as per-quintal. The bag-count reading would
 * imply ₹1,404/kg, which no feed material has ever cost.
 */
export function reconcileLine(raw: RawLine): {
  quantityKg: number | null;
  bagCount: number | null;
  ratePerKg: number | null;
  rateBasis: RateBasis | null;
  reconciled: boolean;
  basis: string | null;
  warnings: string[];
} {
  const warnings: string[] = [];
  const cellNumber = firstNumber(raw.quantityCellRaw);
  const handwritten = firstNumber(raw.handwrittenWeightRaw);
  const printedBags = firstNumber(raw.bagCountRaw);
  const amount = raw.amount;

  const candidates: Array<{ qty: number; from: string; stated: RateBasis | null }> = [];
  if (handwritten != null) {
    candidates.push({
      qty: handwritten,
      from: "handwritten weight",
      stated: statedBasis(raw.handwrittenWeightRaw),
    });
  }
  if (cellNumber != null) {
    candidates.push({
      qty: cellNumber,
      from: "quantity column",
      // The cell may carry its own unit; failing that, the column header does.
      stated: statedBasis(raw.quantityCellRaw) ?? statedBasis(raw.quantityUnitRaw),
    });
  }

  /** The bag count is whichever number was NOT used as the weight. */
  const bagsBesides = (from: string) =>
    printedBags ?? (from === "handwritten weight" ? cellNumber : null);

  if (!candidates.length || amount == null || amount <= 0) {
    return {
      quantityKg: handwritten ?? cellNumber,
      bagCount: printedBags ?? (handwritten != null ? cellNumber : null),
      ratePerKg: null,
      rateBasis: null,
      reconciled: false,
      basis: null,
      warnings: ["This line could not be reconciled — enter the figures by hand"],
    };
  }

  /**
   * One way of reading the line, as kilograms. `qtyBasis` is the unit the
   * quantity was taken to be in — only "kg" leaves the printed figure alone.
   */
  interface Reading {
    qtyKg: number;
    printed: number;
    qtyBasis: RateBasis;
    from: string;
    /** True when the paper names the unit; false when it had to be inferred. */
    stated: boolean;
  }

  const readings: Reading[] = [];
  // Strongest first: the cell says what it is in.
  for (const c of candidates) {
    if (c.qty > 0 && c.stated) {
      readings.push({ qtyKg: c.qty * BASIS_DIVISOR[c.stated], printed: c.qty, qtyBasis: c.stated, from: c.from, stated: true });
    }
  }
  // Then the printed figure at face value as kilograms — the common case, and
  // the reading bill 517 depends on.
  for (const c of candidates) {
    if (c.qty > 0 && c.stated == null) {
      readings.push({ qtyKg: c.qty, printed: c.qty, qtyBasis: "kg", from: c.from, stated: false });
    }
  }
  // Weakest: the unit lives in a column header the transcription never saw, so
  // it has to be inferred. Admitted below only when the printed rate agrees.
  for (const c of candidates) {
    if (c.qty <= 0 || c.stated) continue;
    for (const b of SCALED_BASES) {
      readings.push({ qtyKg: c.qty * BASIS_DIVISOR[b], printed: c.qty, qtyBasis: b, from: c.from, stated: false });
    }
  }

  /** Which printed basis does a derived per-kg rate correspond to? */
  const basisOfPrintedRate = (perKg: number): RateBasis | null => {
    if (raw.ratePrinted == null || raw.ratePrinted <= 0) return null;
    for (const b of ["kg", "quintal", "mt"] as RateBasis[]) {
      if (close(raw.ratePrinted / BASIS_DIVISOR[b], perKg)) return b;
    }
    return null;
  };

  const closes = readings.filter((r) => {
    const perKg = amount / r.qtyKg;
    if (perKg < PLAUSIBLE_RATE_PER_KG.min || perKg > PLAUSIBLE_RATE_PER_KG.max) return false;
    // A unit taken off the paper — written in the cell, or the plain kilogram
    // reading — stands on the plausible rate alone. An INFERRED unit is a
    // guess, so the rate column has to corroborate it before it is believed.
    if (r.stated || r.qtyBasis === "kg") return true;
    return basisOfPrintedRate(perKg) != null;
  });

  const describe = (r: Reading) =>
    `${r.printed.toLocaleString("en-IN")} ${r.qtyBasis} = ${r.qtyKg.toLocaleString("en-IN")} kg ` +
    `at ₹${(amount / r.qtyKg).toFixed(2)}/kg`;

  // A unit read off the paper settles it outright. Only when every closing
  // reading was INFERRED is there a choice to make.
  let winner = closes.find((r) => r.stated || r.qtyBasis === "kg");
  let discarded: Reading | null = null;
  if (!winner) {
    const distinct = closes.filter(
      (r, i) => closes.findIndex((x) => x.qtyKg === r.qtyKg) === i,
    );
    if (distinct.length > 1) {
      const typical = distinct.filter((r) => {
        const perKg = amount / r.qtyKg;
        return perKg >= TYPICAL_RATE_PER_KG.min && perKg <= TYPICAL_RATE_PER_KG.max;
      });
      if (typical.length === 1) {
        winner = typical[0];
        discarded = distinct.find((r) => r !== winner) ?? null;
      } else {
        // Genuinely undecidable. A blank field gets typed; a wrong one gets paid.
        return {
          quantityKg: null,
          bagCount: printedBags ?? cellNumber,
          ratePerKg: null,
          rateBasis: null,
          reconciled: false,
          basis: null,
          warnings: [
            ...warnings,
            `The quantity unit is not printed and both readings close — ` +
              `${distinct.map(describe).join(" or ")}. Enter the weight by hand`,
          ],
        };
      }
    } else {
      winner = distinct[0];
    }
  }

  if (winner) {
    const impliedPerKg = amount / winner.qtyKg;
    const basisMatch = basisOfPrintedRate(impliedPerKg);
    if (raw.ratePrinted != null && raw.ratePrinted > 0 && !basisMatch) {
      warnings.push(
        `The printed rate ${raw.ratePrinted} does not match ${amount} ÷ ${winner.qtyKg} = ` +
          `${impliedPerKg.toFixed(4)}/kg — a digit may be misread; the amount was trusted`,
      );
    }
    if (discarded) {
      warnings.push(
        `The unit was inferred: read as ${describe(winner)}, not ${describe(discarded)} — confirm it`,
      );
    }
    const perKg = Number(impliedPerKg.toFixed(6));
    const converted =
      winner.qtyBasis === "kg"
        ? ""
        : `${winner.printed.toLocaleString("en-IN")} ${winner.qtyBasis} → `;
    return {
      quantityKg: winner.qtyKg,
      bagCount: bagsBesides(winner.from),
      ratePerKg: perKg,
      rateBasis: basisMatch,
      reconciled: true,
      basis:
        `${converted}${winner.qtyKg.toLocaleString("en-IN")} kg (${winner.from}) × ₹${perKg}/kg = ` +
        `₹${amount.toLocaleString("en-IN")}` +
        (basisMatch && basisMatch !== "kg" ? ` — rate printed per ${basisMatch}` : ""),
      warnings,
    };
  }

  // Nothing closed. Return the figures unconverted and low-confidence rather
  // than a plausible-looking wrong number: a blank field gets typed, a wrong
  // one gets paid.
  warnings.push(
    "No reading of this line makes quantity × rate equal the printed amount — check it by hand",
  );
  return {
    quantityKg: null,
    bagCount: printedBags ?? cellNumber,
    ratePerKg: null,
    rateBasis: null,
    reconciled: false,
    basis: null,
    warnings,
  };
}

/** Uppercase, no separators — "AS 01 EC 2633" and "as01ec2633" are one truck. */
export const normalisePlate = (s: string | null) =>
  s ? s.toUpperCase().replace(/[^A-Z0-9]/g, "") || null : null;

// ───────────────────── Weigh slip and number plate ─────────────────────

export interface ExtractedWeighslip {
  weighbridgeName: string | null;
  slipNumber: string | null;
  vehicleNumber: string | null;
  grossKg: number | null;
  tareKg: number | null;
  netKg: number | null;
  weighedAt: string | null;
  /** gross − tare equals net. */
  reconciled: boolean;
  warnings: string[];
}

export interface ExtractedPlate {
  plate: string | null;
  warnings: string[];
}

const GATE_DOCS_PROMPT = `You are reading photographs taken at a feed mill gate.
Transcribe what is visible. Do NOT calculate or reconcile — that happens elsewhere.

Return ONLY JSON:

{
  "weighslip": {
    "weighbridgeName": string|null,
    "slipNumber": string|null,
    "vehicleNumber": string|null,
    "weights": [{ "label": string, "kg": number }],
    "netLabelledKg": number|null,
    "dateRaw": string|null,
    "timeRaw": string|null
  } | null,
  "vehicle": { "plate": string|null } | null
}

Rules for the WEIGH SLIP:
1. Weighbridges do not agree on labels. Some print "Gross" and "Tare"; others
   print "First Wt" and "Second Wt"; others "Load"/"Empty". Copy EVERY weight you
   see into "weights" with its printed label verbatim and its number in kg. Do
   NOT decide which is gross and which is tare — that is worked out downstream.
2. "netLabelledKg" is only the figure explicitly labelled Net. Null if absent.
3. Ignore any weight labelled as a charge, fee or rate. Those are money.

Rules for the VEHICLE photo:
4. Read the plate from the NUMBER PLATE on the vehicle itself.
5. Many gate cameras burn a text overlay onto the photo — a date, GPS
   coordinates, a place name, a speed. NEVER take the plate, or anything else,
   from that overlay. It is not part of the vehicle.

Use null for anything absent or illegible. Never guess.`;

interface RawGateDocs {
  weighslip: {
    weighbridgeName: string | null;
    slipNumber: string | null;
    vehicleNumber: string | null;
    weights: Array<{ label: string; kg: number }>;
    netLabelledKg: number | null;
    dateRaw: string | null;
    timeRaw: string | null;
  } | null;
  vehicle: { plate: string | null } | null;
}

/**
 * Work out which weight is which.
 *
 * The labels cannot be trusted to mean what they say: Prem Weigh Bridge prints
 * "First Wt 7350" for the EMPTY vehicle and "Second Wt 31730" for the loaded
 * one, because that is simply the order the truck crossed the platform. Reading
 * those positionally as gross-then-tare inverts the load and yields a negative
 * net.
 *
 * Physics settles it instead: a loaded truck weighs more than an empty one, so
 * the larger figure is gross. The printed net then has to equal the difference,
 * which is the slip checking itself.
 */
export function reconcileWeighslip(raw: RawGateDocs["weighslip"]): ExtractedWeighslip {
  const warnings: string[] = [];
  if (!raw) {
    return {
      weighbridgeName: null, slipNumber: null, vehicleNumber: null,
      grossKg: null, tareKg: null, netKg: null, weighedAt: null,
      reconciled: false, warnings: ["No weigh slip was read"],
    };
  }

  const weights = (raw.weights ?? [])
    .map((w) => Number(w.kg))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => b - a);

  let grossKg: number | null = null;
  let tareKg: number | null = null;
  let netKg: number | null = raw.netLabelledKg ?? null;

  if (weights.length >= 2) {
    grossKg = weights[0]!;
    tareKg = weights[weights.length - 1]!;
    const derived = Number((grossKg - tareKg).toFixed(3));
    if (netKg == null) {
      netKg = derived;
    } else if (Math.abs(derived - netKg) > 1) {
      warnings.push(
        `The slip's net (${netKg} kg) is not gross minus tare (${grossKg} − ${tareKg} = ${derived} kg)`,
      );
    }
  } else if (weights.length === 1 && netKg != null) {
    warnings.push("Only one weight was readable on the slip — check gross and tare by hand");
  }

  const reconciled =
    grossKg != null && tareKg != null && netKg != null && Math.abs(grossKg - tareKg - netKg) <= 1;

  const { date } = parseIndianDate(raw.dateRaw);
  const time = raw.timeRaw?.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  const weighedAt =
    date && time
      ? `${date}T${time[1]!.padStart(2, "0")}:${time[2]}:${(time[3] ?? "00").padStart(2, "0")}`
      : date;

  return {
    weighbridgeName: raw.weighbridgeName ?? null,
    slipNumber: raw.slipNumber ?? null,
    vehicleNumber: normalisePlate(raw.vehicleNumber),
    grossKg, tareKg, netKg, weighedAt,
    reconciled, warnings,
  };
}

/**
 * Read the vehicle photo and the weigh slip in one call.
 *
 * Batched deliberately: both are trivial extractions next to the bill — an
 * embossed plate and a dot-matrix ticket — so paying twice for two round trips
 * buys nothing.
 */
export async function extractGateDocs(
  input: { vehicle?: ImageInput; weighslip?: ImageInput },
  apiKey: string,
  modelName: string = OCR_MODEL_SIMPLE,
): Promise<{ plate: ExtractedPlate; weighslip: ExtractedWeighslip; usage: OcrUsage }> {
  const parts: Array<string | { inlineData: { data: string; mimeType: string } }> = [
    GATE_DOCS_PROMPT,
  ];
  if (input.weighslip) {
    parts.push("This image is the vendor's weigh slip:");
    parts.push({ inlineData: { data: input.weighslip.data, mimeType: input.weighslip.mimeType } });
  }
  if (input.vehicle) {
    parts.push("This image is the vehicle:");
    parts.push({ inlineData: { data: input.vehicle.data, mimeType: input.vehicle.mimeType } });
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: modelName,
    generationConfig: { temperature: 0, responseMimeType: "application/json" },
  });
  const result = await model.generateContent(parts);
  const raw = JSON.parse(
    (() => {
      const t = result.response.text().trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "");
      return t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1);
    })(),
  ) as RawGateDocs;

  const meta = result.response.usageMetadata;
  return {
    plate: { plate: normalisePlate(raw.vehicle?.plate ?? null), warnings: [] },
    weighslip: reconcileWeighslip(raw.weighslip),
    usage: {
      promptTokens: meta?.promptTokenCount ?? 0,
      outputTokens: meta?.candidatesTokenCount ?? 0,
      totalTokens: meta?.totalTokenCount ?? 0,
    },
  };
}

/**
 * What the three photos say about each other.
 *
 * This is the strongest signal available at the gate. Each check turns a field
 * nobody could otherwise verify into a corroborated one — most of all the
 * handwritten weight on the bill, which is copied from the slip and is the
 * single most expensive thing to get wrong.
 */
export interface CrossCheck {
  name: string;
  ok: boolean;
  detail: string;
  /** Blocking is never right here — the guard confirms, the gate stays open. */
  severity: "confirm" | "info";
}

export function crossCheckGateDocs(input: {
  bill?: ExtractedBill | null;
  slip?: ExtractedWeighslip | null;
  plate?: string | null;
}): CrossCheck[] {
  const checks: CrossCheck[] = [];
  const { bill, slip, plate } = input;

  const plates = [
    ["number plate", plate],
    ["weigh slip", slip?.vehicleNumber],
    ["bill", bill?.vehicleNumber],
  ].filter(([, v]) => !!v) as Array<[string, string]>;

  if (plates.length >= 2) {
    const distinct = [...new Set(plates.map(([, v]) => v))];
    checks.push({
      name: "Vehicle number agrees",
      ok: distinct.length === 1,
      detail:
        distinct.length === 1
          ? `${distinct[0]} on ${plates.map(([k]) => k).join(", ")}`
          : plates.map(([k, v]) => `${k}: ${v}`).join(" · "),
      severity: "confirm",
    });
  }

  if (slip?.netKg != null && bill?.lines.length) {
    const billed = bill.lines.reduce((s, l) => s + (l.quantityKg ?? 0), 0);
    const diff = Math.abs(billed - slip.netKg);
    checks.push({
      name: "Slip net matches the billed weight",
      ok: diff <= 1,
      detail:
        diff <= 1
          ? `${slip.netKg.toLocaleString("en-IN")} kg on both`
          : `slip ${slip.netKg.toLocaleString("en-IN")} kg vs bill ${billed.toLocaleString("en-IN")} kg`,
      severity: "confirm",
    });
  }

  if (slip && slip.grossKg != null && slip.tareKg != null) {
    checks.push({
      name: "Weigh slip adds up",
      ok: slip.reconciled,
      detail: `${slip.grossKg.toLocaleString("en-IN")} − ${slip.tareKg.toLocaleString("en-IN")} = ${(slip.grossKg - slip.tareKg).toLocaleString("en-IN")} kg`,
      severity: "info",
    });
  }

  return checks;
}

/** Match a description to the item master, by name then by alias. */
export function resolveItem(
  description: string | null,
  items: Array<{ id: string; name: string; aliases: string[] }>,
): { itemId: string | null; materialName: string | null } {
  if (!description) return { itemId: null, materialName: null };
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const target = norm(description);
  if (!target) return { itemId: null, materialName: null };

  for (const it of items) {
    if (norm(it.name) === target) return { itemId: it.id, materialName: it.name };
  }
  for (const it of items) {
    if ((it.aliases ?? []).some((a) => norm(a) === target)) {
      return { itemId: it.id, materialName: it.name };
    }
  }
  // Containment, longest name first, so "Maize" does not beat "Maize Gluten".
  const sorted = [...items].sort((a, b) => norm(b.name).length - norm(a.name).length);
  for (const it of sorted) {
    const n = norm(it.name);
    if (n.length >= 4 && (target.includes(n) || n.includes(target))) {
      return { itemId: it.id, materialName: it.name };
    }
  }
  return { itemId: null, materialName: description };
}

/** Strip a ```json fence if the model added one despite being told not to. */
function parseModelJson<T = RawBill>(text: string): T {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error("The model did not return JSON");
  return JSON.parse(cleaned.slice(start, end + 1)) as T;
}

export interface ImageInput {
  data: string; // base64, no data: prefix
  mimeType: string;
}

/**
 * Read a bill. Every derived number is computed here, never taken from the
 * model — including the footing check, so two clients can never disagree about
 * whether a bill adds up.
 */
export async function extractBill(
  images: ImageInput[],
  items: Array<{ id: string; name: string; aliases: string[] }>,
  apiKey: string,
): Promise<ExtractedBill> {
  return (await extractBillWith(images, items, apiKey, OCR_MODEL)).bill;
}

/** What the call actually burned. Logged per receipt so cost is observable. */
export interface OcrUsage {
  promptTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/**
 * The same extraction, with the model named explicitly and token usage
 * returned. Exists so the cost harness can compare candidates against the
 * fixtures without duplicating any of the reconciliation logic — the thing
 * being measured has to be the thing that ships.
 */
export async function extractBillWith(
  images: ImageInput[],
  items: Array<{ id: string; name: string; aliases: string[] }>,
  apiKey: string,
  modelName: string,
): Promise<{ bill: ExtractedBill; usage: OcrUsage }> {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: modelName,
    generationConfig: { temperature: 0, responseMimeType: "application/json" },
  });

  const result = await model.generateContent([
    buildPrompt(new Date().toISOString().slice(0, 10)),
    ...images.map((i) => ({ inlineData: { data: i.data, mimeType: i.mimeType } })),
  ]);
  const rawBill = parseModelJson(result.response.text());

  const warnings: string[] = [];
  const { date: billDate, warning: dateWarning } = parseIndianDate(rawBill.billDateRaw);
  if (dateWarning) warnings.push(dateWarning);

  const lines: ExtractedLine[] = (rawBill.lines ?? []).map((raw, i) => {
    const r = reconcileLine(raw);
    warnings.push(...r.warnings.map((w) => `Line ${raw.lineNo ?? i + 1}: ${w}`));
    const { itemId, materialName } = resolveItem(raw.description, items);
    if (!itemId && raw.description) {
      warnings.push(`Line ${raw.lineNo ?? i + 1}: "${raw.description}" is not in the item list`);
    }
    return {
      lineNo: raw.lineNo ?? i + 1,
      description: raw.description ?? null,
      materialName,
      itemId,
      hsnCode: raw.hsnCode ?? null,
      quantityKg: r.quantityKg,
      bagCount: r.bagCount,
      ratePerKg: r.ratePerKg,
      rateBasis: r.rateBasis,
      amount: raw.amount ?? null,
      reconciled: r.reconciled,
      basis: r.basis,
    };
  });

  // Footing: Σ line amounts (+ printed tax) against the printed grand total.
  const lineSum = lines.reduce((s, l) => s + (l.amount ?? 0), 0);
  const tax = rawBill.taxTotal ?? 0;
  const grand = rawBill.grandTotal;
  const footingOk = grand != null && lines.length > 0 && close(lineSum + tax, grand);
  if (grand != null && !footingOk) {
    warnings.push(
      `The lines add to ₹${(lineSum + tax).toLocaleString("en-IN")} but the bill says ` +
        `₹${grand.toLocaleString("en-IN")}`,
    );
  }

  const docType = (rawBill.documentType ?? "unknown") as ExtractedBill["documentType"];
  if (docType === "bill_of_supply" && rawBill.taxTotal) {
    warnings.push("A bill of supply should not carry tax — check the document type");
  }

  const meta = result.response.usageMetadata;
  return {
    bill: {
      documentType: docType,
      vendor: rawBill.vendorName ?? null,
      vendorPan: rawBill.vendorPan ?? null,
      vendorGstin: rawBill.vendorGstin ?? null,
      billNumber: rawBill.billNumber ?? null,
      billDate,
      vehicleNumber: normalisePlate(rawBill.vehicleNumberRaw),
      billTotal: grand ?? null,
      billTax: rawBill.taxTotal ?? null,
      footingOk,
      lines,
      warnings,
      model: modelName,
    },
    usage: {
      promptTokens: meta?.promptTokenCount ?? 0,
      outputTokens: meta?.candidatesTokenCount ?? 0,
      totalTokens: meta?.totalTokenCount ?? 0,
    },
  };
}

/* ── Retrying the model ──────────────────────────────────────────────────── */

/**
 * Retry a vision call through a quota bounce.
 *
 * Free-tier quota is per minute. Two trucks arriving a minute apart should not
 * show a guard "could not read the bill" when the model was never asked — that
 * teaches people to stop trusting the camera and start typing everything.
 */
export async function withOcrRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = String((err as Error)?.message ?? "");
      if (!/429|503|500|quota|rate|overloaded|unavailable/i.test(msg) || attempt === 3) break;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  throw lastErr;
}

/* ── The egg packing room's day sheet ────────────────────────────────────── */
//
// The same division of labour as the bill: the model transcribes cells, and
// every judgement — which column is which grade, whether the sheds add up to
// the TOTAL row, which shed is which house — is made here.
//
// The sheet is two tables over one set of grade columns. A printed heading is
// sometimes struck through with another grade handwritten over it (SMALL
// became BROWN on 12 Sep 2026), so both names are asked for and the written
// one wins. A column niko has no grade for is reported by name with its
// figures, never dropped and never guessed into a neighbour.

export interface RawEggSheetColumn {
  index: number;
  printedHeader: string | null;
  writtenHeader: string | null;
  /** The printed note under the name, e.g. "210/BOX". */
  perBoxRaw: string | null;
}

export interface RawEggSheet {
  dateRaw: string | null;
  columns: RawEggSheetColumn[];
  production: Array<{ shed: string | null; cells: Array<string | null> }>;
  productionTotal: Array<string | null> | null;
  stock: {
    opening: Array<string | null> | null;
    production: Array<string | null> | null;
    sales: Array<string | null> | null;
    closing: Array<string | null> | null;
  } | null;
}

/** The grades the sheet can name. Kept in step with EGG_SIZES by the route. */
export type SheetGrade = "small" | "medium" | "large" | "xl" | "jumbo" | "brown" | "niko";
export const SHEET_GRADES: SheetGrade[] = ["small", "medium", "large", "xl", "jumbo", "brown", "niko"];

export interface ExtractedEggSheet {
  dateRaw: string | null;
  date: string | null;
  columns: Array<{ header: string; grade: SheetGrade | null; perBox: number | null }>;
  rows: Array<{
    shed: string;
    boxes: Partial<Record<SheetGrade, number>>;
    /** Figures under a heading niko has no grade for, by that heading. */
    unmapped: Record<string, number>;
  }>;
  /** Per grade: the shed rows summed, against what the paper's TOTAL row says. */
  totals: Partial<Record<SheetGrade, { sum: number; paper: number | null; ok: boolean }>>;
  /** The paper's own stock summary, for comparing with the ledger — never keyed. */
  stock: Partial<
    Record<SheetGrade, { opening: number | null; production: number | null; sales: number | null; closing: number | null }>
  > | null;
  unmappedColumns: Array<{ header: string; production: number; closing: number | null }>;
  warnings: string[];
  model: string;
}

const buildEggSheetPrompt = () => `You are reading a photograph of a handwritten egg packing-room
day sheet from an Indian layer farm. Transcribe what is on the paper. Do NOT
calculate, correct or reconcile anything — arithmetic is done elsewhere.

The sheet has a Date box at the top, a PRODUCTION REPORT table and a STOCK
SUMMARY table. Both tables share one set of columns: one per grade of egg (for
example SMALL, MEDIUM, LARGE, EXTRA LARGE, JUMBO, NIKO), each with a printed
note like "210/BOX" under the name. A printed column heading may be struck
through with another grade handwritten over or beside it — report both,
exactly as written.

The PRODUCTION REPORT has one row per shed (L2, L3, L4, L5 …) and a TOTAL row.
The STOCK SUMMARY has rows OPENING STOCK, PRODUCTION, SALES and CLOSING STOCK.

Return ONLY a JSON object, no markdown fence, matching exactly:

{
  "dateRaw": string|null,
  "columns": [{ "index": number, "printedHeader": string|null, "writtenHeader": string|null, "perBoxRaw": string|null }],
  "production": [{ "shed": string|null, "cells": [string|null] }],
  "productionTotal": [string|null] | null,
  "stock": {
    "opening": [string|null] | null,
    "production": [string|null] | null,
    "sales": [string|null] | null,
    "closing": [string|null] | null
  } | null
}

Rules:
1. "columns" lists every grade column left to right, index from 0. Leave out
   the SHED label column. "printedHeader" is the printed name; "writtenHeader"
   is any handwritten name over or beside it, else null. "perBoxRaw" is the
   printed note under the name, e.g. "210/BOX".
2. Every "cells" array has exactly one entry per column, in column order, so a
   value is never shifted into the wrong grade. Copy each cell verbatim and
   keep leading zeros: "03" stays "03". An empty cell or a dash is null.
3. ONE ROW of the table is ONE entry. The TOTAL row goes in "productionTotal",
   never in "production".
4. "dateRaw": copy the Date box verbatim, e.g. "12/09/26". Do not reformat.
5. Use null for anything absent or illegible. Never guess a value that is not
   on the paper.`;

/** "EXTRA LARGE" → xl, "Brown" → brown … or null for a heading niko has no grade for. */
export function gradeOfHeader(header: string | null): SheetGrade | null {
  const h = (header ?? "").toLowerCase().replace(/[^a-z]/g, "");
  if (!h) return null;
  if (h.includes("brown")) return "brown";
  if (h.includes("niko")) return "niko";
  if (h.includes("jumbo")) return "jumbo";
  if (h.includes("extra") || h === "xl" || h.endsWith("xl")) return "xl";
  if (h.includes("large")) return "large";
  if (h.includes("medium")) return "medium";
  if (h.includes("small")) return "small";
  return null;
}

/** "03" → 3, "1,551" → 1551, "-" or blank → null. */
function cellNumber(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const t = String(raw).replace(/,/g, "").trim();
  if (!t || /^[-–—.·nil]+$/i.test(t)) return null;
  const m = t.match(/\d+/);
  return m ? Number(m[0]) : null;
}

/**
 * Read the day sheet. The model returns cells; the grades, the footing and the
 * date are decided in `reconcileEggSheet`, which is checked without an API
 * call by scripts/check-egg-sheet-read.ts.
 */
export async function extractEggSheet(
  images: ImageInput[],
  apiKey: string,
  modelName: string = OCR_MODEL,
): Promise<ExtractedEggSheet> {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: modelName,
    generationConfig: { temperature: 0, responseMimeType: "application/json" },
  });
  const result = await model.generateContent([
    buildEggSheetPrompt(),
    ...images.map((i) => ({ inlineData: { data: i.data, mimeType: i.mimeType } })),
  ]);
  return reconcileEggSheet(parseModelJson<RawEggSheet>(result.response.text()), modelName);
}

/** Everything decided about a transcribed sheet, with the model out of the loop. */
export function reconcileEggSheet(raw: RawEggSheet, modelName: string): ExtractedEggSheet {
  const warnings: string[] = [];
  const { date, warning: dateWarning } = parseIndianDate(raw.dateRaw ?? null, "Sheet date");
  if (dateWarning) warnings.push(dateWarning);
  if (!raw.dateRaw) warnings.push("No date read from the sheet");

  const rawColumns = [...(raw.columns ?? [])].sort((a, b) => a.index - b.index);
  const columns = rawColumns.map((c) => {
    // The handwritten heading is the one in force; the printed one under a
    // strike-through is what the column used to be.
    const header = (c.writtenHeader?.trim() || c.printedHeader?.trim() || `column ${c.index + 1}`).replace(/\s+/g, " ");
    return { header, grade: gradeOfHeader(header), perBox: cellNumber(c.perBoxRaw) };
  });
  const seen = new Map<SheetGrade, string>();
  for (const c of columns) {
    if (!c.grade) continue;
    const other = seen.get(c.grade);
    if (other) {
      warnings.push(`"${c.header}" and "${other}" both read as ${c.grade}; the first is used and the second is left unmapped`);
      c.grade = null;
    } else {
      seen.set(c.grade, c.header);
    }
  }
  if (!columns.length) warnings.push("No grade columns were read");

  // The TOTAL row sometimes comes back as a production row despite the prompt.
  const productionRows: Array<{ shed: string; cells: Array<string | null> }> = [];
  let totalCells: Array<string | null> | null = raw.productionTotal ?? null;
  for (const r of raw.production ?? []) {
    const shed = (r.shed ?? "").toUpperCase().replace(/\s+/g, "");
    if (!shed) continue;
    if (/^TOTAL/.test(shed)) {
      totalCells = totalCells ?? r.cells;
      continue;
    }
    productionRows.push({ shed, cells: r.cells ?? [] });
  }

  const rows = productionRows.map((r) => {
    const boxes: Partial<Record<SheetGrade, number>> = {};
    const unmapped: Record<string, number> = {};
    columns.forEach((c, i) => {
      const n = cellNumber(r.cells[i]);
      if (n == null) return;
      if (c.grade) boxes[c.grade] = n;
      else unmapped[c.header] = n;
    });
    return { shed: r.shed, boxes, unmapped };
  });
  if (!rows.length) warnings.push("No shed rows were read");

  const totals: ExtractedEggSheet["totals"] = {};
  columns.forEach((c, i) => {
    if (!c.grade) return;
    const sum = rows.reduce((a, r) => a + (r.boxes[c.grade!] ?? 0), 0);
    const paper = totalCells ? cellNumber(totalCells[i]) : null;
    const ok = paper == null ? sum === 0 : sum === paper;
    totals[c.grade] = { sum, paper, ok };
    if (!ok) {
      warnings.push(
        paper == null
          ? `${c.header}: the sheds add to ${sum} but no total is written`
          : `${c.header}: the sheds add to ${sum}, the TOTAL row says ${paper}`,
      );
    }
  });

  const pick = (line: Array<string | null> | null | undefined, i: number) => (line ? cellNumber(line[i]) : null);
  const stock: ExtractedEggSheet["stock"] = raw.stock ? {} : null;
  const unmappedColumns: ExtractedEggSheet["unmappedColumns"] = [];
  columns.forEach((c, i) => {
    const entry = raw.stock
      ? {
          opening: pick(raw.stock.opening, i),
          production: pick(raw.stock.production, i),
          sales: pick(raw.stock.sales, i),
          closing: pick(raw.stock.closing, i),
        }
      : null;
    if (c.grade) {
      if (stock && entry) stock[c.grade] = entry;
      return;
    }
    const production = rows.reduce((a, r) => a + (r.unmapped[c.header] ?? 0), 0);
    unmappedColumns.push({ header: c.header, production, closing: entry?.closing ?? null });
    warnings.push(`"${c.header}" is not a grade niko knows — its figures were not entered`);
  });

  return { dateRaw: raw.dateRaw ?? null, date, columns, rows, totals, stock, unmappedColumns, warnings, model: modelName };
}
