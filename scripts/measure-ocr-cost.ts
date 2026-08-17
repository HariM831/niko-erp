/**
 * What does reading a bill actually cost, and can a cheaper model do it?
 *
 * Runs every bill fixture through each candidate model at each image size, and
 * reports two numbers side by side: how many ground-truth checks passed, and
 * how many tokens it burned. Accuracy without cost is how you end up with an
 * expensive gate; cost without accuracy is how you overpay a vendor by a lakh.
 *
 * Image size is in here because it is the bigger lever. Gemini bills images by
 * tile, so a 4000px phone photo costs several times a 1568px one — and if the
 * handwriting still reads at 1568, that saving is free.
 *
 * Costs real API calls: models x sizes x bills. Run:
 *   npx tsx scripts/measure-ocr-cost.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { and, eq } from "drizzle-orm";
import { items } from "@shared/schema";
import { db } from "../server/db";
import { extractBillWith } from "../server/services/ocr";

const DIR = join(process.cwd(), "fixtures", "bills");

const MODELS = ["gemini-flash-latest", "gemini-flash-lite-latest"];
/** null = leave the photo exactly as the phone produced it. */
const WIDTHS: Array<number | null> = [null, 1568, 1024];

interface Fixture {
  file: string;
  expected: Record<string, unknown> & { lines: Array<Record<string, unknown>> };
}

interface Run {
  model: string;
  width: number | null;
  bytes: number;
  passed: number;
  total: number;
  promptTokens: number;
  outputTokens: number;
  failures: string[];
}

async function resize(buf: Buffer, width: number | null): Promise<Buffer> {
  if (width == null) return buf;
  return sharp(buf).resize({ width, withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Free-tier quota is per minute, and firing a dozen calls back to back trips
 * it — which reads as "the model failed" when the model was never asked. Retry
 * with backoff so a quota bounce cannot be mistaken for a wrong answer.
 */
async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = String((err as Error).message ?? "");
      const retryable = /429|503|500|quota|rate|overloaded|unavailable/i.test(msg);
      if (!retryable || attempt === 4) break;
      const wait = 4000 * attempt;
      console.log(`      ${label}: retry ${attempt} in ${wait / 1000}s`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

function compare(got: Record<string, any>, fx: Fixture): { passed: number; total: number; failures: string[] } {
  const e = fx.expected;
  const failures: string[] = [];
  let passed = 0;
  let total = 0;
  const eq_ = (name: string, a: unknown, b: unknown) => {
    total++;
    if (JSON.stringify(a) === JSON.stringify(b)) passed++;
    else failures.push(`${name}: got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
  };

  eq_("documentType", got.documentType, e.documentType);
  eq_("vendorPan", got.vendorPan, e.vendorPan);
  eq_("billNumber", got.billNumber, e.billNumber);
  eq_("billDate", got.billDate, e.billDate);
  eq_("vehicleNumber", got.vehicleNumber, e.vehicleNumber);
  eq_("billTotal", got.billTotal, e.billTotal);
  eq_("footingOk", got.footingOk, e.footingOk);
  eq_("lineCount", got.lines.length, e.lines.length);
  e.lines.forEach((want, i) => {
    const line = got.lines[i];
    eq_(`L${i + 1}.quantityKg`, line?.quantityKg ?? null, want.quantityKg);
    eq_(`L${i + 1}.bagCount`, line?.bagCount ?? null, want.bagCount);
    eq_(`L${i + 1}.ratePerKg`, line?.ratePerKg ?? null, want.ratePerKg);
    eq_(`L${i + 1}.amount`, line?.amount ?? null, want.amount);
    eq_(`L${i + 1}.reconciled`, line?.reconciled ?? false, want.reconciled);
  });
  return { passed, total, failures };
}

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

  const runs: Run[] = [];

  for (const model of MODELS) {
    for (const width of WIDTHS) {
      const agg: Run = {
        model,
        width,
        bytes: 0,
        passed: 0,
        total: 0,
        promptTokens: 0,
        outputTokens: 0,
        failures: [],
      };
      for (const fx of manifest.bills) {
        const original = readFileSync(join(DIR, fx.file));
        const buf = await resize(original, width);
        agg.bytes += buf.length;
        try {
          const { bill, usage } = await withRetry(`${model}@${width ?? "orig"} ${fx.file}`, () =>
            extractBillWith(
              [{ data: buf.toString("base64"), mimeType: "image/jpeg" }],
              master,
              apiKey,
              model,
            ),
          );
          await sleep(2500); // stay under the per-minute quota
          const c = compare(bill as unknown as Record<string, any>, fx);
          agg.passed += c.passed;
          agg.total += c.total;
          agg.promptTokens += usage.promptTokens;
          agg.outputTokens += usage.outputTokens;
          agg.failures.push(...c.failures.map((f) => `${fx.file} ${f}`));
        } catch (err) {
          agg.failures.push(`${fx.file} ERROR ${String((err as Error).message).slice(0, 80)}`);
          agg.total += 13;
        }
      }
      runs.push(agg);
      const label = `${model} @ ${width ?? "original"}`;
      console.log(
        `  ${label.padEnd(42)} ${String(agg.passed + "/" + agg.total).padEnd(8)} ` +
          `${String(agg.promptTokens).padStart(7)} in  ${String(agg.outputTokens).padStart(5)} out  ` +
          `${(agg.bytes / 1024).toFixed(0).padStart(5)} KB`,
      );
    }
  }

  console.log("\n\n  MODEL                          SIZE      ACCURACY   IN TOKENS  OUT  IMAGE KB");
  console.log("  " + "─".repeat(76));
  for (const r of runs) {
    const pct = r.total ? Math.round((r.passed / r.total) * 100) : 0;
    console.log(
      `  ${r.model.padEnd(30)} ${String(r.width ?? "original").padEnd(9)} ` +
        `${(r.passed + "/" + r.total).padEnd(7)} ${String(pct + "%").padStart(4)}  ` +
        `${String(r.promptTokens).padStart(8)} ${String(r.outputTokens).padStart(5)} ` +
        `${(r.bytes / 1024).toFixed(0).padStart(8)}`,
    );
  }

  console.log("\n  Failures by run:");
  for (const r of runs) {
    if (!r.failures.length) {
      console.log(`    ${r.model} @ ${r.width ?? "original"}: none`);
      continue;
    }
    console.log(`    ${r.model} @ ${r.width ?? "original"}:`);
    r.failures.forEach((f) => console.log(`      · ${f}`));
  }

  const baseline = runs.find((r) => r.model === MODELS[0] && r.width === null);
  if (baseline) {
    console.log(
      `\n  Token cost is relative to ${MODELS[0]} @ original = ${baseline.promptTokens} input tokens.`,
    );
    for (const r of runs) {
      const ratio = baseline.promptTokens ? r.promptTokens / baseline.promptTokens : 1;
      console.log(
        `    ${(r.model + " @ " + (r.width ?? "original")).padEnd(42)} ${(ratio * 100).toFixed(0)}% of baseline input tokens`,
      );
    }
  }
  process.exit(0);
}

void main();
