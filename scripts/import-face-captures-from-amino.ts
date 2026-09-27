/**
 * Bring Amino's learned face captures across, onto the punches they came from.
 *
 * The history import kept Amino's punch ids as niko's but dropped every
 * punch's face_embedding, and niko's gate only started learning on 26 Sep
 * 2026 — a day and a half of captures where Amino held up to seven
 * capture-days per person. Sandip De and Sudarsan Barik, whom the enrolment
 * photo never suited, were among those it cost.
 *
 * The file comes from `scripts/export-face-captures-for-niko.ts` in the Amino
 * repo, run on Replit. Each capture names its punch; it is attached to that
 * punch in niko, and the roster serves it from there like any capture niko
 * learned itself (services/face-gallery.ts: one per day, the newest
 * GALLERY_DAYS days, nothing older than GALLERY_MAX_AGE_DAYS).
 *
 * A capture is attached only when niko would have learned it:
 *
 *   - the punch is in niko, was a face match, and has no capture of its own;
 *   - it is inside GALLERY_MAX_AGE_DAYS (older would be pruned tonight);
 *   - it is a usable 1024-float vector from the same model (the file's stamp
 *     is checked, and the whole file refused on any other);
 *   - it looks enough like its owner's enrolment (TEACH_OWN_FLOOR) and no one
 *     else contests it — the same rule the gate applies before it learns
 *     (judgeCapture), scored here against the enrolments, so a capture Amino
 *     filed under the wrong person is not carried across to go on misleading.
 *
 * Dry by default. `--apply` writes, in one transaction.
 *
 *   npx tsx scripts/import-face-captures-from-amino.ts --file face-captures-for-niko.json
 *   npx tsx scripts/import-face-captures-from-amino.ts --file face-captures-for-niko.json --apply
 */
import { readFile } from "node:fs/promises";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { employees, punches } from "@shared/schema";
import { FACE_DIM, MATCH_MARGIN, MATCH_THRESHOLD, TEACH_OWN_FLOOR } from "@shared/face";
import { db, pool } from "../server/db";
import { GALLERY_MAX_AGE_DAYS, isUsableEmbedding, roundEmbedding } from "../server/services/face-gallery";
import { istDaysAgo } from "../server/services/day-resolution";

const KNOWN_MODEL = "@vladmandic/human@3.3.5 faceres";
const APPLY = process.argv.includes("--apply");
const fileArg = process.argv[process.argv.indexOf("--file") + 1];
if (!process.argv.includes("--file") || !fileArg) {
  console.error("\n  --file <face-captures-for-niko.json> is required\n");
  process.exit(1);
}

interface Capture { punchId: string; table: string; person: string; punchDate: string; punchedAt: string; embedding: number[] }
const exp = JSON.parse(await readFile(fileArg, "utf8")) as { exportedAt: string; faceModel: string; captures: Capture[] };
if (exp.faceModel !== KNOWN_MODEL) {
  console.error(`\n  REFUSING: the file's faces are "${exp.faceModel}", not "${KNOWN_MODEL}" — they would match nothing.\n`);
  process.exit(1);
}

const unit = (v: number[]) => {
  let n = 0;
  for (let i = 0; i < FACE_DIM; i++) n += v[i]! * v[i]!;
  const s = 1 / Math.sqrt(n);
  return v.map((x) => x * s);
};
const dot = (a: number[], b: number[]) => {
  let d = 0;
  for (let i = 0; i < FACE_DIM; i++) d += a[i]! * b[i]!;
  return d;
};

class DryRun extends Error {}
const tally = { inFile: exp.captures.length, notVector: 0, tooOld: 0, noPunch: 0, notFace: 0, alreadyHas: 0, noEnrolment: 0, notOwner: 0, contested: 0, attached: 0 };
const rejectedExamples: string[] = [];
const cutoff = istDaysAgo(GALLERY_MAX_AGE_DAYS);

try {
  await db.transaction(async (tx) => {
    // Everyone's enrolment, as unit vectors: the rule below scores against them.
    const enrolled = (
      await tx
        .select({ id: employees.id, name: employees.name, vec: employees.faceDescriptor })
        .from(employees)
        .where(and(eq(employees.isActive, true), isNotNull(employees.faceDescriptor)))
    )
      .filter((r) => isUsableEmbedding(r.vec))
      .map((r) => ({ id: r.id, name: r.name, u: unit(r.vec!) }));
    const byId = new Map(enrolled.map((e) => [e.id, e]));

    const ids = exp.captures.map((c) => c.punchId);
    const found = new Map<string, { employeeId: string; method: string; has: boolean; punchDate: string }>();
    for (let i = 0; i < ids.length; i += 500) {
      const rows = await tx
        .select({ id: punches.id, employeeId: punches.employeeId, method: punches.method, emb: punches.faceEmbedding, punchDate: punches.punchDate })
        .from(punches)
        .where(inArray(punches.id, ids.slice(i, i + 500)));
      for (const r of rows) found.set(r.id, { employeeId: r.employeeId, method: r.method, has: r.emb != null, punchDate: r.punchDate });
    }

    const perPerson = new Map<string, number>();
    for (const c of exp.captures) {
      if (!isUsableEmbedding(c.embedding)) { tally.notVector++; continue; }
      const p = found.get(c.punchId);
      if (!p) { tally.noPunch++; continue; }
      if (p.punchDate < cutoff) { tally.tooOld++; continue; }
      if (p.method !== "face") { tally.notFace++; continue; }
      if (p.has) { tally.alreadyHas++; continue; }
      const owner = byId.get(p.employeeId);
      if (!owner) { tally.noEnrolment++; continue; }

      const u = unit(c.embedding);
      const own = dot(u, owner.u);
      let best = { s: -1, name: "" };
      for (const e of enrolled) if (e.id !== owner.id) { const s = dot(u, e.u); if (s > best.s) best = { s, name: e.name }; }
      if (own < TEACH_OWN_FLOOR) {
        tally.notOwner++;
        if (rejectedExamples.length < 10) rejectedExamples.push(`${owner.name} ${c.punchDate}: only ${(own * 100).toFixed(0)}% like their enrolment`);
        continue;
      }
      if (best.s >= MATCH_THRESHOLD && best.s - own >= MATCH_MARGIN) {
        tally.contested++;
        if (rejectedExamples.length < 10) rejectedExamples.push(`${owner.name} ${c.punchDate}: ${(own * 100).toFixed(0)}% own, ${best.name} ${(best.s * 100).toFixed(0)}%`);
        continue;
      }
      await tx.update(punches).set({ faceEmbedding: roundEmbedding(c.embedding) }).where(eq(punches.id, c.punchId));
      tally.attached++;
      perPerson.set(owner.id, (perPerson.get(owner.id) ?? 0) + 1);
    }

    console.log(`\n  Amino captures exported ${exp.exportedAt}: ${tally.inFile}`);
    console.log(`  attached            ${tally.attached} to ${perPerson.size} people`);
    console.log(`  punch not in niko   ${tally.noPunch}`);
    console.log(`  older than ${GALLERY_MAX_AGE_DAYS} days   ${tally.tooOld}`);
    console.log(`  punch was by hand   ${tally.notFace}`);
    console.log(`  punch has its own   ${tally.alreadyHas}`);
    console.log(`  owner not enrolled  ${tally.noEnrolment}`);
    console.log(`  unlike its owner    ${tally.notOwner}`);
    console.log(`  contested by another ${tally.contested}`);
    if (tally.notVector) console.log(`  not a usable vector ${tally.notVector}`);
    for (const r of rejectedExamples) console.log(`    left out: ${r}`);
    for (const name of ["SANDIP DE", "SUDARSAN BARIK"]) {
      const e = enrolled.find((x) => x.name === name);
      if (e) console.log(`  ${name}: ${perPerson.get(e.id) ?? 0} capture(s) attached`);
    }
    if (!APPLY) throw new DryRun();
  });
  console.log(`\n  Written. The gates pick them up on their next roster refresh.\n`);
} catch (e) {
  if (e instanceof DryRun) console.log(`\n  Dry run — nothing written. Re-run with --apply.\n`);
  else { console.error(e); process.exitCode = 1; }
} finally {
  await pool.end();
}
