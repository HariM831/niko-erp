/**
 * Check the egg day-sheet reader.
 *
 * Two modes, because the two halves fail differently:
 *
 *   npx tsx scripts/check-egg-sheet-read.ts
 *     Runs the reconciliation over a transcription of the 12 Sep 2026 sheet
 *     — the first sheet this was built from — without an API call, and asserts
 *     what it must decide: BROWN written over SMALL wins, EXTRA LARGE is xl,
 *     NIKO is a grade, every column foots against the TOTAL row, and the
 *     stock summary comes across for comparison.
 *
 *   npx tsx scripts/check-egg-sheet-read.ts --file photo.jpg
 *     Sends a real photograph to the model and prints what came back, so a
 *     reading can be eyeballed against the paper before anyone trusts it.
 *     Needs GEMINI_API_KEY (read from .env when not in the environment).
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import {
  extractEggSheet,
  gradeOfHeader,
  reconcileEggSheet,
  type RawEggSheet,
  type ExtractedEggSheet,
} from "../server/services/ocr";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`  ${ok ? "ok " : "FAIL"} ${what}`);
  if (!ok) failures++;
};

function print(x: ExtractedEggSheet) {
  console.log(`\n  date ${x.dateRaw ?? "—"} → ${x.date ?? "—"}   model ${x.model}`);
  console.log(`  columns: ${x.columns.map((c) => `${c.header}→${c.grade ?? "?"}${c.perBox ? `(${c.perBox})` : ""}`).join("  ")}`);
  for (const r of x.rows) {
    const boxes = Object.entries(r.boxes).map(([k, v]) => `${k} ${v}`).join(", ");
    const un = Object.entries(r.unmapped).map(([k, v]) => `${k} ${v}`).join(", ");
    console.log(`  ${r.shed.padEnd(4)} ${boxes}${un ? `   [unmapped: ${un}]` : ""}`);
  }
  for (const [g, t] of Object.entries(x.totals)) {
    console.log(`  total ${g.padEnd(7)} sheds ${t.sum}  paper ${t.paper ?? "—"}  ${t.ok ? "ok" : "MISMATCH"}`);
  }
  if (x.stock) {
    for (const [g, st] of Object.entries(x.stock)) {
      console.log(`  stock ${g.padEnd(7)} open ${st.opening ?? "—"}  prod ${st.production ?? "—"}  sales ${st.sales ?? "—"}  close ${st.closing ?? "—"}`);
    }
  }
  for (const w of x.warnings) console.log(`  · ${w}`);
}

/* ── The 12 Sep 2026 sheet, as the model is asked to transcribe it ────────── */
const SHEET_12_SEP: RawEggSheet = {
  dateRaw: "12/09/26",
  columns: [
    { index: 0, printedHeader: "SMALL", writtenHeader: "BROWN", perBoxRaw: "210/BOX" },
    { index: 1, printedHeader: "MEDIUM", writtenHeader: null, perBoxRaw: "210/BOX" },
    { index: 2, printedHeader: "LARGE", writtenHeader: null, perBoxRaw: "210/BOX" },
    { index: 3, printedHeader: "EXTRALARGE", writtenHeader: null, perBoxRaw: "210/BOX" },
    { index: 4, printedHeader: "JUMBO", writtenHeader: null, perBoxRaw: "180/BOX" },
    { index: 5, printedHeader: "NIKO", writtenHeader: null, perBoxRaw: "360/BOX" },
  ],
  production: [
    { shed: "L2", cells: [null, null, "521", null, "03", null] },
    { shed: "L3", cells: [null, "03", "538", null, "01", null] },
    { shed: "L4", cells: [null, "02", "492", null, "01", null] },
    { shed: "L5", cells: ["21", "230", null, null, "04", null] },
  ],
  productionTotal: ["21", "235", "1551", null, "09", null],
  stock: {
    opening: ["61", "202", "1447", "1091", "31", "34"],
    production: ["21", "235", "1551", null, "09", null],
    sales: [null, null, "1082", null, null, null],
    closing: ["82", "437", "1916", "1091", "40", "34"],
  },
};

async function main() {
  const file = arg("file");
  if (file) {
    let apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey && existsSync(".env")) {
      apiKey = readFileSync(".env", "utf8").match(/^GEMINI_API_KEY=(.*)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "");
    }
    if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
    const buf = readFileSync(file);
    const ext = path.extname(file).toLowerCase();
    const mimeType = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
    console.log(`\n  READING ${file} (${(buf.length / 1024).toFixed(0)} KB)`);
    const out = await extractEggSheet([{ data: buf.toString("base64"), mimeType }], apiKey);
    print(out);
    console.log("");
    return;
  }

  console.log("\n  THE 12 SEP 2026 SHEET, RECONCILED\n");
  const x = reconcileEggSheet(SHEET_12_SEP, "fixture");
  print(x);
  console.log("");

  check(x.date === "2026-09-12", "the date reads 12 Sep 2026");
  check(x.columns[0]?.grade === "brown", "BROWN written over SMALL wins the column");
  check(x.columns[3]?.grade === "xl", "EXTRALARGE is xl");
  check(x.columns[5]?.grade === "niko", "NIKO is a grade");
  check(x.columns[4]?.perBox === 180 && x.columns[5]?.perBox === 360, "per-box notes are read");
  const l5 = x.rows.find((r) => r.shed === "L5");
  check(l5?.boxes.brown === 21 && l5?.boxes.medium === 230 && l5?.boxes.jumbo === 4, "L5: 21 brown, 230 medium, 4 jumbo");
  const l3 = x.rows.find((r) => r.shed === "L3");
  check(l3?.boxes.medium === 3 && l3?.boxes.large === 538 && l3?.boxes.jumbo === 1, "L3: leading zeros read as 3 and 1");
  check(Object.values(x.totals).every((t) => t.ok), "every column foots against the TOTAL row");
  check(x.totals.large?.sum === 1551 && x.totals.large?.paper === 1551, "large: 521 + 538 + 492 = 1551");
  check(x.stock?.large?.sales === 1082 && x.stock?.large?.closing === 1916, "stock summary: 1082 large sold, 1916 closing");
  check(x.stock?.niko?.closing === 34 && x.stock?.xl?.closing === 1091, "niko and xl stock come across with no production");
  check(x.unmappedColumns.length === 0, "nothing on this sheet is unmapped");
  check(x.warnings.length === 0, "no warnings on a clean sheet");

  console.log("\n  headings:");
  for (const [h, g] of [
    ["Extra Large", "xl"], ["XL", "xl"], ["Large", "large"], ["Brown", "brown"], ["Niko", "niko"],
    ["JUMBO", "jumbo"], ["Medium", "medium"], ["Small", "small"], ["Dirty", null], ["", null],
  ] as const) {
    check(gradeOfHeader(h) === g, `"${h}" → ${g ?? "unmapped"}`);
  }

  // A TOTAL row that slipped into the production rows, and a shed that adds up wrong.
  const messy: RawEggSheet = {
    ...SHEET_12_SEP,
    production: [...SHEET_12_SEP.production, { shed: "TOTAL", cells: ["21", "235", "1551", null, "09", null] }],
    productionTotal: ["21", "235", "1561", null, "09", null],
  };
  const y = reconcileEggSheet(messy, "fixture");
  check(y.rows.length === 4, "a TOTAL row among the sheds is not a shed");
  check(y.totals.large?.ok === false && y.warnings.some((w) => /1551.*1561/.test(w)), "a total that does not foot is named");

  console.log(failures ? `\n  ${failures} check(s) failed\n` : "\n  all checks pass\n");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
