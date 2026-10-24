/**
 * The server's face engine (services/face-engine.ts), checked in two parts.
 *
 * Arithmetic, on made-up points and pictures — no face needed, and exact:
 *
 *   points already where SFace wants them  → the identity transform
 *   points turned, scaled and shifted      → the transform that undoes it
 *   a picture whose points are the template → the crop is the picture itself
 *   a grey picture, junk bytes, a non-photo → "no face", not an error
 *
 * Real faces, when a database with enrolment photos is to hand (it runs the
 * models, so they are fetched on first use):
 *
 *   nearly every enrolment photo yields a face
 *   a vector is FACE_DIM numbers of unit length, the same every time
 *   the same photo at half the size is still clearly the same face
 *
 * Run: npx tsx scripts/check-face-engine.ts
 */
import { isNotNull } from "drizzle-orm";
import sharp from "sharp";
import { FACE_DIM } from "@shared/face";
import { employees } from "@shared/schema";
import { alignCrop, faceVector, similarity, TEMPLATE } from "../server/services/face-engine";

let failures = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!cond) failures++;
};
const close = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) <= tol;

console.log("\nArithmetic");
{
  const [a, b, tx, ty] = similarity(TEMPLATE.map(([x, y]) => [x, y]));
  ok("points on the template → identity", close(a, 1) && close(b, 0) && close(tx, 0) && close(ty, 0), `${[a, b, tx, ty].map((v) => v.toFixed(6))}`);
}
{
  // A face 2.5× the template's size, turned 20°, at (300, 140): the transform
  // back must be 1/2.5, turned −20°, and carry every point home.
  const th = (20 * Math.PI) / 180, k = 2.5;
  const src = TEMPLATE.map(([x, y]) => [k * (Math.cos(th) * x - Math.sin(th) * y) + 300, k * (Math.sin(th) * x + Math.cos(th) * y) + 140] as [number, number]);
  const [a, b, tx, ty] = similarity(src);
  const err = Math.max(...src.map(([x, y], i) => Math.hypot(a * x - b * y + tx - TEMPLATE[i]![0], b * x + a * y + ty - TEMPLATE[i]![1])));
  ok("turned, scaled, shifted points → carried back onto the template", err < 1e-9, `worst ${err.toExponential(1)} px`);
  ok("…by the inverse scale", close(Math.hypot(a, b), 1 / k, 1e-12));
}
{
  const data = Buffer.alloc(112 * 112 * 3);
  for (let i = 0; i < data.length; i++) data[i] = (i * 7919) % 251;
  const crop = alignCrop({ data, width: 112, height: 112 }, TEMPLATE.map(([x, y]) => [x, y]));
  ok("a picture whose points are the template → crop is the picture", crop.equals(data));
}
{
  const grey = await sharp({ create: { width: 320, height: 240, channels: 3, background: { r: 128, g: 128, b: 128 } } }).jpeg().toBuffer();
  ok("a grey picture → no face", (await faceVector(grey)) === null);
  ok("bytes that are not a picture → no face", (await faceVector(Buffer.from("not a jpeg"))) === null);
  ok("a string that is not a data URL → no face", (await faceVector("https://example.com/a.jpg")) === null);
}

if (!process.env.DATABASE_URL) {
  console.log("\nReal faces — skipped (no DATABASE_URL)");
} else {
  const { db, pool } = await import("../server/db");
  const rows = await db.select({ photo: employees.photoUrl }).from(employees).where(isNotNull(employees.photoUrl)).limit(40);
  console.log(`\nReal faces (${rows.length} enrolment photos)`);
  if (!rows.length) {
    console.log("  — none in this database");
  } else {
    let found = 0, unitLen = true, same = true, halfWorst = 1;
    for (const r of rows) {
      const f = await faceVector(r.photo!);
      if (!f) continue;
      found++;
      const n = Math.hypot(...f.vector);
      if (f.vector.length !== FACE_DIM || !close(n, 1, 1e-5)) unitLen = false;
      const again = await faceVector(r.photo!);
      if (!again || again.vector.some((v, i) => v !== f.vector[i])) same = false;
      const bytes = Buffer.from(r.photo!.split(",", 2)[1]!, "base64");
      const meta = await sharp(bytes).metadata();
      const half = await faceVector(await sharp(bytes).rotate().resize(Math.round((meta.width ?? 400) / 2)).jpeg({ quality: 90 }).toBuffer());
      if (half) halfWorst = Math.min(halfWorst, half.vector.reduce((s, v, i) => s + v * f.vector[i]!, 0));
    }
    ok("nearly every enrolment photo yields a face", found >= rows.length * 0.9, `${found} of ${rows.length}`);
    ok(`vectors are ${FACE_DIM} numbers of unit length`, unitLen);
    ok("the same photo gives the same vector", same);
    // SFace's same-person cutoff is 0.363; half the pixels must stay far above it.
    ok("the same photo at half size is still clearly the same face", halfWorst > 0.7, `worst ${halfWorst.toFixed(3)}`);
  }
  await pool.end();
}

console.log(failures ? `\n${failures} check(s) failed.\n` : "\nAll checks passed.\n");
process.exit(failures ? 1 : 0);
