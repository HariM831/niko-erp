/**
 * Make SFace vectors from the photos already on file, once, after migration
 * 0138 moved every FaceRes vector to its *_faceres column
 * (docs/face-sface-plan.md). Runs as a script so the web server never loads a
 * model.
 *
 *  1. Enrolment. Every worker who was enrolled and has a photo gets that
 *     photo's SFace vector. One with no photo on file is listed: they need
 *     photographing again.
 *  2. Gate punches. Every punch photo still on file gets its vector, so the
 *     history is SFace's too. A scan is marked taught only when SFace, against
 *     everyone's new enrolment vector, picks the punch's own worker and at
 *     least TEACH_OWN_FLOOR sure: the name on an old punch was chosen by
 *     FaceRes or a guard, and about 1 gate photo in 100 here wears somebody
 *     else's. The gallery is then the first taught scan of each of a worker's
 *     last 7 days with one (services/face-gallery.ts).
 *  3. Canteen plates. Every plate photo still on file gets its vector; plates
 *     teach nobody.
 *
 * Only rows without an SFace vector are read, so a second run picks up where
 * the first stopped and changes nothing it already did.
 *
 * Dry by default: it reads every photo and says what it would write.
 * `--apply` writes, in one transaction.
 *
 *   npx tsx scripts/sface-switch-over.ts
 *   npx tsx scripts/sface-switch-over.ts --apply
 */
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { FACE_DIM, TEACH_OWN_FLOOR } from "@shared/face";
import { buildMatchIndex, findBestMatchIndexed } from "@shared/face-match";
import { canteenServings, employees, punches } from "@shared/schema";
import { db, pool } from "../server/db";
import { isUsableEmbedding, roundEmbedding } from "../server/services/face-gallery";
import { faceVector } from "./lib/face-engine-node";

const APPLY = process.argv.includes("--apply");
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");
const progress = (label: string, i: number, n: number) => {
  if (i % 250 === 0 || i === n) console.log(`    ${label}: ${i} of ${n}`);
};

console.log(`\n  SFACE SWITCH-OVER${APPLY ? "" : "   (dry run — add --apply to write)"}\n`);

/* ── 1. Enrolment ─────────────────────────────────────────────────────── */

const due = await db
  .select({ id: employees.id, name: employees.name, empCode: employees.empCode })
  .from(employees)
  .where(
    and(
      isNotNull(employees.faceEnrolledAt),
      isNotNull(employees.photoUrl),
      sql`(${employees.faceDescriptor} IS NULL OR jsonb_array_length(${employees.faceDescriptor}) <> ${FACE_DIM})`,
    ),
  );
const enrol = new Map<string, number[]>();
const noFace: string[] = [];
for (const [i, d] of due.entries()) {
  // One photo at a time: these are the heaviest column in the table.
  const [row] = await db.select({ photo: employees.photoUrl }).from(employees).where(eq(employees.id, d.id));
  const f = row?.photo ? await faceVector(row.photo) : null;
  if (f) enrol.set(d.id, roundEmbedding(f.vector));
  else noFace.push(`${d.empCode} ${d.name}`);
  progress("enrolment photos", i + 1, due.length);
}
const noPhoto = await db
  .select({ name: employees.name, empCode: employees.empCode })
  .from(employees)
  .where(and(isNotNull(employees.faceEnrolledAt), isNull(employees.photoUrl), eq(employees.isActive, true)));

console.log(`
  1. Enrolment
    enrolled workers to read from their photo:  ${due.length}
      read:                                     ${enrol.size}
      no face found in the photo:               ${noFace.length}${noFace.length ? `\n        ${noFace.join("\n        ")}` : ""}
    enrolled, active, but no photo on file:     ${noPhoto.length}${noPhoto.length ? `  — photograph again\n        ${noPhoto.map((p) => `${p.empCode} ${p.name}`).join("\n        ")}` : ""}
`);

// Everyone's enrolment vector — read now, or already SFace's — is what the
// punches are judged against.
const existing = (
  await db.select({ id: employees.id, v: employees.faceDescriptor }).from(employees).where(isNotNull(employees.faceDescriptor))
).filter((r) => isUsableEmbedding(r.v));
const roster = new Map<string, number[]>([...existing.map((r) => [r.id, r.v!] as const), ...enrol]);
if (roster.size < 2) {
  console.log("  Fewer than two enrolment vectors — nothing to judge the punches against. Stopping.\n");
  await pool.end();
  process.exit(1);
}
const index = buildMatchIndex([...roster].map(([id, v]) => ({ id, descriptors: [v] })));

/* ── 2. Gate punches ──────────────────────────────────────────────────── */

const shots = await db
  .select({ id: punches.id, employeeId: punches.employeeId, method: punches.method })
  .from(punches)
  .where(and(isNotNull(punches.photoUrl), isNull(punches.faceEmbedding)))
  .orderBy(punches.punchedAt);
const punchWrites: { id: string; v: number[]; taught: boolean }[] = [];
const tally = { noFace: 0, notEnrolled: 0, taught: 0, otherPerson: 0, unsure: 0 };
const manual = { n: 0, agreed: 0 };
for (const [i, s] of shots.entries()) {
  const [row] = await db.select({ photo: punches.photoUrl }).from(punches).where(eq(punches.id, s.id));
  const f = row?.photo ? await faceVector(row.photo) : null;
  progress("gate photos", i + 1, shots.length);
  if (!f) { tally.noFace++; continue; }
  const v = roundEmbedding(f.vector);
  let taught = false;
  if (!roster.has(s.employeeId)) {
    tally.notEnrolled++;
  } else {
    const m = findBestMatchIndexed(v, index);
    if (s.method === "manual") manual.n++;
    if (m.id !== s.employeeId) tally.otherPerson++;
    else {
      if (s.method === "manual") manual.agreed++;
      if (m.score < TEACH_OWN_FLOOR) tally.unsure++;
      else { tally.taught++; taught = true; }
    }
  }
  punchWrites.push({ id: s.id, v, taught });
}
const judged = tally.taught + tally.otherPerson + tally.unsure;
console.log(`
  2. Gate punches
    punch photos with no SFace vector:         ${shots.length}
      vector made:                              ${punchWrites.length}   (no face found: ${tally.noFace})
      SFace picked the punch's own worker:     ${tally.taught + tally.unsure} of ${judged} (${pct(tally.taught + tally.unsure, judged)})
        of which sure enough to teach:          ${tally.taught}
      SFace picked somebody else (not taught): ${tally.otherPerson} (${pct(tally.otherPerson, judged)})
      worker has no enrolment vector:           ${tally.notEnrolled} (kept, not taught)
      hand-picked punches SFace agreed with:    ${manual.agreed} of ${manual.n} (${pct(manual.agreed, manual.n)})
`);

/* ── 3. Canteen plates ────────────────────────────────────────────────── */

const plates = await db
  .select({ id: canteenServings.id })
  .from(canteenServings)
  .where(and(isNotNull(canteenServings.photoUrl), isNull(canteenServings.faceEmbedding)));
const plateWrites: { id: string; v: number[] }[] = [];
for (const [i, p] of plates.entries()) {
  const [row] = await db.select({ photo: canteenServings.photoUrl }).from(canteenServings).where(eq(canteenServings.id, p.id));
  const f = row?.photo ? await faceVector(row.photo) : null;
  if (f) plateWrites.push({ id: p.id, v: roundEmbedding(f.vector) });
  progress("canteen photos", i + 1, plates.length);
}
console.log(`
  3. Canteen plates
    plate photos with no SFace vector:         ${plates.length}
      vector made:                              ${plateWrites.length}
`);

if (!APPLY) {
  console.log("  Dry run — nothing written. Re-run with --apply to write.\n");
} else {
  await db.transaction(async (tx) => {
    // updated_at drives the devices' delta pull, and every write bumps it.
    for (const [id, v] of enrol) await tx.update(employees).set({ faceDescriptor: v, updatedAt: new Date() }).where(eq(employees.id, id));
    for (const w of punchWrites) await tx.update(punches).set({ faceEmbedding: w.v, faceTaught: w.taught }).where(eq(punches.id, w.id));
    for (const w of plateWrites) await tx.update(canteenServings).set({ faceEmbedding: w.v }).where(eq(canteenServings.id, w.id));
  });
  console.log(`  Written: ${enrol.size} enrolment(s), ${punchWrites.length} punch vector(s) (${tally.taught} taught), ${plateWrites.length} plate vector(s).\n`);
}
await pool.end();
