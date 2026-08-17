/**
 * Reads the vehicle photo and the weigh slip, and checks what they prove about
 * the bill.
 *
 * The pair of slips here is the point: Shanti prints Gross/Tare/Net, Prem
 * prints First Wt/Second Wt/Net Wt where "first" is the EMPTY vehicle. Any
 * extractor that reads those labels positionally inverts the load. This proves
 * the physics-based reconciliation handles both.
 *
 * Run: npx tsx scripts/check-gate-docs.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

// This script touches no database, so nothing else pulls the .env in for it.
try {
  process.loadEnvFile();
} catch {
  /* no .env file */
}

import { crossCheckGateDocs, extractGateDocs, type ExtractedBill } from "../server/services/ocr";

const DIR = join(process.cwd(), "fixtures", "bills");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const check = (name: string, actual: unknown, expected: unknown) => {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failed++;
  console.log(
    `    ${pass ? "PASS" : "FAIL"}  ${name.padEnd(18)} ` +
      (pass ? String(actual) : `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`),
  );
};

const img = (f: string) => ({
  data: readFileSync(join(DIR, f)).toString("base64"),
  mimeType: "image/jpeg",
});

const CASES = [
  {
    label: "517 — Prem Weigh Bridge (First Wt / Second Wt)",
    vehicle: "517-vehicle.jpeg",
    slip: "517-weighslip.jpeg",
    plate: "AS01EC2633",
    slipNumber: "702",
    grossKg: 31730,
    tareKg: 7350,
    netKg: 24380,
    billWeight: 24380,
  },
  {
    label: "518 — Shanti Weigh Bridge (Gross / Tare)",
    vehicle: "518-vehicle.jpeg",
    slip: "518-weighslip.jpeg",
    plate: "AS26AC1723",
    slipNumber: "4831",
    grossKg: 54350,
    tareKg: 13560,
    netKg: 40790,
    billWeight: 40790,
  },
];

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");

  for (const c of CASES) {
    console.log(`\n  ${c.label}\n`);
    const { plate, weighslip, usage } = await extractGateDocs(
      { vehicle: img(c.vehicle), weighslip: img(c.slip) },
      apiKey,
    );

    check("plate", plate.plate, c.plate);
    check("slip vehicle", weighslip.vehicleNumber, c.plate);
    check("slip number", weighslip.slipNumber, c.slipNumber);
    check("gross", weighslip.grossKg, c.grossKg);
    check("tare", weighslip.tareKg, c.tareKg);
    check("net", weighslip.netKg, c.netKg);
    check("reconciled", weighslip.reconciled, true);

    // Stand in for the bill with just the fields the cross-checks read.
    const bill = {
      vehicleNumber: c.plate,
      lines: [{ quantityKg: c.billWeight }],
    } as unknown as ExtractedBill;
    const checks = crossCheckGateDocs({ bill, slip: weighslip, plate: plate.plate });
    for (const k of checks) {
      if (!k.ok) failed++;
      console.log(`    ${k.ok ? "PASS" : "FAIL"}  ${k.name.padEnd(32)} ${k.detail}`);
    }
    console.log(`    (${usage.promptTokens} in / ${usage.outputTokens} out tokens for both photos)`);
    if (weighslip.warnings.length) weighslip.warnings.forEach((w) => console.log(`      · ${w}`));
    await sleep(4000);
  }

  console.log(failed === 0 ? "\n  All gate-document checks passed." : `\n  ${failed} FAILED.`);
  process.exit(failed ? 1 : 0);
}

void main();
