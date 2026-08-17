/**
 * Runs every bill in fixtures/bills/ through the extractor and diffs the result
 * against the recorded ground truth.
 *
 * This is the gate on the extraction layer. Both bills must pass before it goes
 * anywhere near a truck: between them they carry the bag-count-in-the-quantity-
 * column trap and the ambiguous rate digit, which are the two ways a bill gets
 * read wrong by a factor of sixty and by ₹1.2 lakh respectively.
 *
 * Costs a real API call per image. Run: npx tsx scripts/check-bill-extraction.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { items } from "@shared/schema";
import { db } from "../server/db";
import { extractBill } from "../server/services/ocr";

const DIR = join(process.cwd(), "fixtures", "bills");

interface Fixture {
  file: string;
  note?: string;
  expected: Record<string, unknown> & {
    lines: Array<Record<string, unknown>>;
  };
}

let failed = 0;
const check = (name: string, actual: unknown, expected: unknown) => {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failed++;
  const detail = pass ? String(actual ?? "null") : `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`;
  console.log(`    ${pass ? "PASS" : "FAIL"}  ${name.padEnd(16)} ${detail}`);
};

const mimeOf = (f: string) =>
  f.endsWith(".png") ? "image/png" : f.endsWith(".webp") ? "image/webp" : "image/jpeg";

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");

  const manifest = JSON.parse(readFileSync(join(DIR, "expected.json"), "utf8")) as {
    bills: Fixture[];
  };
  const master = await db
    .select({ id: items.id, name: items.name, aliases: items.aliases })
    .from(items)
    .where(and(eq(items.isActive, true), eq(items.isPurchased, true)));

  for (const fx of manifest.bills) {
    console.log(`\n  ${fx.file}`);
    let data: string;
    try {
      data = readFileSync(join(DIR, fx.file)).toString("base64");
    } catch {
      console.log(`    SKIP  image not found — add it to fixtures/bills/`);
      failed++;
      continue;
    }

    const got = await extractBill([{ data, mimeType: mimeOf(fx.file) }], master, apiKey);
    const e = fx.expected;

    check("documentType", got.documentType, e.documentType);
    check("vendorPan", got.vendorPan, e.vendorPan);
    check("vendorGstin", got.vendorGstin, e.vendorGstin);
    check("billNumber", got.billNumber, e.billNumber);
    check("billDate", got.billDate, e.billDate);
    check("vehicleNumber", got.vehicleNumber, e.vehicleNumber);
    check("billTotal", got.billTotal, e.billTotal);
    check("footingOk", got.footingOk, e.footingOk);
    check("lineCount", got.lines.length, e.lines.length);

    e.lines.forEach((want, i) => {
      const line = got.lines[i];
      if (!line) {
        console.log(`    FAIL  line ${i + 1} missing`);
        failed++;
        return;
      }
      check(`L${i + 1} quantityKg`, line.quantityKg, want.quantityKg);
      check(`L${i + 1} bagCount`, line.bagCount, want.bagCount);
      check(`L${i + 1} ratePerKg`, line.ratePerKg, want.ratePerKg);
      check(`L${i + 1} rateBasis`, line.rateBasis, want.rateBasis);
      check(`L${i + 1} amount`, line.amount, want.amount);
      check(`L${i + 1} reconciled`, line.reconciled, want.reconciled);
      check(`L${i + 1} itemMatched`, line.itemId !== null, true);
      if (line.basis) console.log(`          ${line.basis}`);
    });

    // The vendor name is read, not matched, so it only has to contain the
    // letterhead — and must never be the buyer.
    const vendorOk =
      !!got.vendor && /shayan/i.test(got.vendor) && !/amino/i.test(got.vendor);
    check("vendorNotBuyer", vendorOk, true);

    if (got.warnings.length) {
      console.log("    warnings:");
      got.warnings.forEach((w) => console.log(`      · ${w}`));
    }
  }

  console.log(failed === 0 ? "\nAll fixtures passed." : `\n${failed} check(s) FAILED.`);
  process.exit(failed ? 1 : 0);
}

void main();
