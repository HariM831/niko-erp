/**
 * Proves the provenance band renders, sits below the photo, and stays inside
 * the size budget.
 *
 * Writes stamped copies to fixtures/bills/_stamped/ so the result can be looked
 * at rather than merely asserted — a watermark that covers a figure is the kind
 * of bug only an eye catches.
 *
 * Run: npx tsx scripts/check-capture-stamp.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { CAPTURE, type CaptureKind, encodeForCapture } from "../server/services/capture";
import { haversine, resolvePlace } from "../server/services/geo";
import { db } from "../server/db";

const DIR = join(process.cwd(), "fixtures", "bills");
const OUT = join(DIR, "_stamped");

let failed = 0;
const check = (name: string, pass: boolean, detail = "") => {
  if (!pass) failed++;
  console.log(`    ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `   ${detail}` : ""}`);
};

async function main() {
  mkdirSync(OUT, { recursive: true });

  // Distance sanity: Kharupetia to Nalbari is ~40 km apart.
  const d = haversine({ latitude: 26.64319, longitude: 92.61556 }, { latitude: 26.70519, longitude: 92.51252 });
  console.log("  GEO\n");
  check("haversine returns a sane distance", d > 11_000 && d < 14_000, `${Math.round(d)} m between two known sites`);

  const noFix = await resolvePlace(db, null);
  check("a missing fix never throws", noFix.verdict === "no_fix", noFix.label);

  const somewhere = await resolvePlace(db, { latitude: 26.64319, longitude: 92.61556, accuracyM: 30 });
  check("an unsurveyed fix still resolves", !!somewhere.label, `${somewhere.verdict} — ${somewhere.label}`);

  console.log("\n  STAMP\n");
  const files: Array<{ file: string; kind: CaptureKind; ref: string }> = [
    { file: "518.jpeg", kind: "bill", ref: "GR-00001" },
    { file: "518-weighslip.jpeg", kind: "weighslip", ref: "GR-00001" },
    { file: "518-vehicle.jpeg", kind: "vehicle", ref: "AS26AC1723" },
  ];

  for (const { file, kind, ref } of files) {
    const input = readFileSync(join(DIR, file));
    // .metadata() on an unexecuted pipeline reports the INPUT size, so the
    // resize has to actually run before it can be measured.
    const before = await sharp(
      await sharp(input)
        .resize({
          width: CAPTURE[kind].maxEdge,
          height: CAPTURE[kind].maxEdge,
          fit: "inside",
          withoutEnlargement: true,
        })
        .toBuffer(),
    ).metadata();

    const out = await encodeForCapture(input, kind, {
      place: "Nalbari Feed Mill · Main gate",
      capturedAt: new Date("2026-08-14T10:43:51"),
      accuracyM: 18,
      reference: ref,
    });
    const after = await sharp(out).metadata();
    writeFileSync(join(OUT, file), out);

    const cap = CAPTURE[kind].maxBytes;
    const grew = (after.height ?? 0) - (before.height ?? 0);
    check(
      `${file} band added below`,
      grew > 0 && after.width === before.width,
      `height ${before.height} → ${after.height} (+${grew}px), width unchanged`,
    );
    check(
      `${file} inside budget`,
      out.length <= cap,
      `${(out.length / 1024).toFixed(0)}KB / ${(cap / 1024).toFixed(0)}KB`,
    );
  }

  console.log(`\n  Stamped copies written to fixtures/bills/_stamped/ — open one and check nothing is covered.`);
  console.log(failed === 0 ? "\n  All checks passed." : `\n  ${failed} check(s) FAILED.`);
  process.exit(failed ? 1 : 0);
}

void main();
