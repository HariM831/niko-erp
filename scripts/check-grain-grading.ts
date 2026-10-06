/**
 * Check the maize photo grading.
 *
 * Three modes, because the parts fail differently:
 *
 *   npx tsx scripts/check-grain-grading.ts
 *     The arithmetic, with no API call: percentages come from counts, a kernel
 *     the model put in two categories is warned about, an impossible count is
 *     capped, a photo of something else fills nothing in.
 *
 *   npx tsx scripts/check-grain-grading.ts --tiles fixtures/grain/maize-2026-10-06-d.jpg
 *     Writes the overview and the boxed tiles the model would be shown to
 *     ./tmp-grain-tiles/, so a person can look at exactly what it sees.
 *
 *   npx tsx scripts/check-grain-grading.ts --live
 *     Grades every fixture in fixtures/grain/ for real and compares the grain
 *     count against the hand count made on the bench. Needs ANTHROPIC_API_KEY
 *     (read from .env when not in the environment). Costs a few rupees a photo.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gradeMaizePhoto, reconcileGrading, tilePhoto, type RawGrading } from "../server/services/grain-grading";

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`  ${ok ? "ok " : "FAIL"} ${what}`);
  if (!ok) failures++;
};
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? (process.argv[i + 1] ?? "") : undefined;
};

/**
 * Counted by hand, kernel by kernel, in 20 boxed sections per plate
 * (5–6 Oct 2026). The bench's own report said 301 for both b and c — c was
 * a copied figure, which is what started this.
 */
const HAND_COUNTS: Record<string, number> = {
  "maize-2026-10-05-a.jpg": 278,
  "maize-2026-10-05-b.jpg": 302,
  "maize-2026-10-05-c.jpg": 334,
  "maize-2026-10-06-d.jpg": 311,
};

const tile = (over: Partial<RawGrading["tiles"][number]>): RawGrading["tiles"][number] => ({
  tile: 1, kernels: 0, fungus: 0, damaged_grain: 0, discoloured: 0, broken: 0, immature: 0,
  foreign_matter: [], live_insects: 0, ...over,
});

function offline() {
  console.log("\nArithmetic");
  const g = reconcileGrading(
    {
      is_maize_sample: true,
      photo_quality: "good",
      photo_issues: [],
      observations: ["Pink flaky pieces in tile 2"],
      tiles: [
        tile({ tile: 1, kernels: 100, fungus: 1, broken: 3, foreign_matter: [{ what: "chaff", size: "small" }] }),
        tile({ tile: 2, kernels: 100, fungus: 1, discoloured: 2, immature: 2, live_insects: 1 }),
        tile({ tile: 3, kernels: 50, damaged_grain: 2, foreign_matter: [{ what: "cob piece", size: "large" }] }),
        tile({ tile: 4, kernels: 50 }),
      ],
    },
    "test",
  );
  check(g.grainCount === 300, `grain count is the sum of the tiles (${g.grainCount})`);
  check(g.readings.fungus === 0.67, `fungus 2/300 = 0.67% (${g.readings.fungus})`);
  check(g.readings.broken === 1, `broken 3/300 = 1% (${g.readings.broken})`);
  check(g.readings.damaged_grain === 0.67, `damaged 2/300 (${g.readings.damaged_grain})`);
  check(g.readings.live_insects === 1, "live insects are a count, not a percentage");
  check(g.readings.foreign_matter === 1.08, `FM: small 0.25 + large 3 kernel-equivalents of 300 (${g.readings.foreign_matter})`);
  check(g.warnings.length === 0, `a clean grading carries no warnings (${g.warnings.join("; ")})`);

  const capped = reconcileGrading(
    {
      is_maize_sample: true, photo_quality: "usable", photo_issues: [], observations: [],
      tiles: [tile({ kernels: 200, fungus: 250 }), tile({ tile: 2, kernels: 10, fungus: 6, broken: 6 })],
    },
    "test",
  );
  check(capped.counts.fungus === 206, `more fungus than kernels is capped to the kernels (${capped.counts.fungus})`);
  check(capped.warnings.some((w) => w.includes("capped")), "and the cap is warned about");
  check(capped.warnings.some((w) => w.includes("two categories")), "a kernel in two categories is warned about");

  // Opus 5.5 now and then sends a list as its JSON text (seen on fixture d, 6 Oct 2026).
  const stringy = reconcileGrading(
    {
      is_maize_sample: true, photo_quality: "good",
      photo_issues: JSON.stringify(["glare"]) as unknown as string[],
      observations: [],
      tiles: JSON.stringify([tile({ kernels: 150, broken: 3 }), tile({ tile: 2, kernels: 150 })]) as unknown as RawGrading["tiles"],
    },
    "test",
  );
  check(stringy.grainCount === 300, `a tile list sent as JSON text is still counted (${stringy.grainCount})`);
  check(stringy.warnings.includes("Photo: glare"), "and so are photo issues sent as JSON text");

  const soya = reconcileGrading(
    { is_maize_sample: false, photo_quality: "good", photo_issues: [], observations: [], tiles: [tile({ kernels: 300, fungus: 3 })] },
    "test",
  );
  check(Object.values(soya.readings).every((v) => v == null), "a photo that is not maize fills nothing in");

  const thin = reconcileGrading(
    { is_maize_sample: true, photo_quality: "poor", photo_issues: ["blurred"], observations: [], tiles: [tile({ kernels: 60 })] },
    "test",
  );
  check(thin.warnings[0]!.startsWith("Poor photo"), "a poor photo leads the warnings");
  check(thin.warnings.some((w) => w.includes("Only 60 kernels")), "a thin sample is warned about");
}

async function writeTiles(file: string) {
  const out = path.resolve("tmp-grain-tiles");
  mkdirSync(out, { recursive: true });
  const { overview, tiles } = await tilePhoto(readFileSync(file));
  writeFileSync(path.join(out, "overview.jpg"), overview);
  for (const t of tiles) writeFileSync(path.join(out, `tile-${t.n}.jpg`), t.jpeg);
  console.log(`\nWrote the overview and ${tiles.length} tile(s) to ${out}`);
}

async function live() {
  if (!process.env.ANTHROPIC_API_KEY && existsSync(".env")) {
    for (const l of readFileSync(".env", "utf8").split("\n")) {
      const m = l.match(/^ANTHROPIC_API_KEY=(.+)$/);
      if (m) process.env.ANTHROPIC_API_KEY = m[1]!.trim();
    }
  }
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    console.log("\nANTHROPIC_API_KEY is not set — skipping the live run");
    return;
  }
  const dir = path.resolve("fixtures/grain");
  for (const f of readdirSync(dir).filter((x) => /\.(jpe?g|png)$/i.test(x)).sort()) {
    const started = Date.now();
    const { grading: g, usage } = await gradeMaizePhoto(readFileSync(path.join(dir, f)), key);
    const hand = HAND_COUNTS[f];
    const off = hand ? ((g.grainCount - hand) / hand) * 100 : null;
    console.log(`\n${f}  ${g.model}  ${((Date.now() - started) / 1000).toFixed(0)} s  ${usage.inputTokens} in / ${usage.outputTokens} out`);
    console.log(`  grains ${g.grainCount}${hand ? ` (hand count ${hand}, ${off! >= 0 ? "+" : ""}${off!.toFixed(1)}%)` : ""}`);
    console.log(`  ${Object.entries(g.readings).map(([k, v]) => `${k} ${v ?? "—"}`).join(" · ")}`);
    for (const fm of g.foreignMatter) console.log(`  FM: ${fm.what} (${fm.size})`);
    for (const o of g.observations) console.log(`  note: ${o}`);
    for (const w of g.warnings) console.log(`  warn: ${w}`);
    if (hand) check(Math.abs(off!) <= 5, `${f}: grain count within 5% of the hand count`);
  }
}

const tilesFile = arg("tiles");
if (tilesFile) await writeTiles(tilesFile);
else if (process.argv.includes("--live")) await live();
else offline();

console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
