/**
 * Proves the capture settings the gate camera will use.
 *
 * Two things have to be true at once: every stored photo lands under the size
 * budget, and the bill is still read correctly after being squeezed. Guessing a
 * JPEG quality and hoping the handwriting survives is how a receipt ends up
 * wrong by a factor of sixty, so the compression is verified against the same
 * ground truth the extractor is.
 *
 * Run: npx tsx scripts/check-capture-spec.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { and, eq } from "drizzle-orm";
import { items } from "@shared/schema";
import { db } from "../server/db";
import { CAPTURE, encodeForCapture, type CaptureKind } from "../server/services/capture";
import { extractBillWith } from "../server/services/ocr";

const DIR = join(process.cwd(), "fixtures", "bills");
const MODEL = "gemini-flash-lite-latest";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const FILES: Array<{ file: string; kind: CaptureKind }> = [
  { file: "517.jpeg", kind: "bill" },
  { file: "518.jpeg", kind: "bill" },
  { file: "517-weighslip.jpeg", kind: "weighslip" },
  { file: "518-weighslip.jpeg", kind: "weighslip" },
  { file: "517-vehicle.jpeg", kind: "vehicle" },
  { file: "518-vehicle.jpeg", kind: "vehicle" },
];

const EXPECTED: Record<string, { qty: number; bags: number; rate: number; total: number }> = {
  "517.jpeg": { qty: 24380, bags: 401, rate: 23.1, total: 563178 },
  "518.jpeg": { qty: 40790, bags: 666, rate: 23.1, total: 942249 },
};

let failed = 0;

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");

  console.log("  SIZE BUDGET — every stored photo must land under its cap\n");
  console.log("    file                      kind        original    stored   cap");
  const encoded = new Map<string, Buffer>();
  for (const { file, kind } of FILES) {
    const original = readFileSync(join(DIR, file));
    const out = await encodeForCapture(original, kind);
    encoded.set(file, out);
    const cap = CAPTURE[kind].maxBytes;
    const ok = out.length <= cap;
    if (!ok) failed++;
    console.log(
      `    ${ok ? "PASS" : "FAIL"}  ${file.padEnd(22)} ${kind.padEnd(11)} ` +
        `${(original.length / 1024).toFixed(0).padStart(6)}KB ${(out.length / 1024).toFixed(0).padStart(7)}KB ` +
        `${(cap / 1024).toFixed(0).padStart(5)}KB`,
    );
  }

  console.log("\n  STILL READABLE — the bill must survive its own compression\n");
  const master = await db
    .select({ id: items.id, name: items.name, aliases: items.aliases })
    .from(items)
    .where(and(eq(items.isActive, true), eq(items.isPurchased, true)));

  for (const [file, want] of Object.entries(EXPECTED)) {
    const buf = encoded.get(file)!;
    const { bill, usage } = await extractBillWith(
      [{ data: buf.toString("base64"), mimeType: "image/jpeg" }],
      master,
      apiKey,
      MODEL,
    );
    const line = bill.lines[0];
    const ok =
      line?.quantityKg === want.qty &&
      line?.bagCount === want.bags &&
      line?.ratePerKg === want.rate &&
      bill.billTotal === want.total &&
      line?.reconciled === true;
    if (!ok) failed++;
    console.log(
      `    ${ok ? "PASS" : "FAIL"}  ${file.padEnd(12)} qty=${line?.quantityKg} bags=${line?.bagCount} ` +
        `rate=${line?.ratePerKg} total=${bill.billTotal}  ` +
        `(${(buf.length / 1024).toFixed(0)}KB, ${usage.promptTokens} tokens)`,
    );
    await sleep(3000);
  }

  console.log(failed === 0 ? "\n  All capture checks passed." : `\n  ${failed} check(s) FAILED.`);
  process.exit(failed ? 1 : 0);
}

void main();
