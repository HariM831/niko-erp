/**
 * Teach the gate galleries again from the gate photos the app already keeps,
 * after a change of face model (SFace replaced FaceRes, docs/face-sface-plan.md).
 *
 * Enrolments come back on their own: the server re-enrols anyone who lost
 * their vector from their photo at boot (services/face-enrol.ts). What does not
 * come back by itself is what the gate had taught itself — a few recent scans
 * per worker, which is what carries a face the enrolment photo does not suit.
 * This rebuilds that from punch photos:
 *
 *   a punch photo inside GALLERY_MAX_AGE_DAYS → `punches.face_embedding`,
 *
 * but only when SFace itself picks the punch's worker, at least TEACH_OWN_FLOOR
 * sure. The name on an old punch was chosen by FaceRes or a guard, and about 1
 * gate photo in 100 here wears somebody else's; a capture SFace does not agree
 * with is left out rather than taught to the wrong person. Only what the
 * gallery will serve is read at all: photos are walked newest first, and a
 * worker is done once they have one agreed scan on each of GALLERY_DAYS days —
 * the hourly prune would clear anything more. That is a few photos per worker,
 * not every photo of the last two months.
 *
 * Dry by default: it says what it would write and how often SFace agreed with
 * the names on the punches. `--apply` writes, in one transaction. Run it once
 * the server has re-enrolled everyone.
 *
 *   npx tsx scripts/backfill-face-vectors.ts
 *   npx tsx scripts/backfill-face-vectors.ts --apply
 */
import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { TEACH_OWN_FLOOR } from "@shared/face";
import { buildMatchIndex, findBestMatchIndexed } from "@shared/face-match";
import { employees, punches } from "@shared/schema";
import { db, pool } from "../server/db";
import { faceVector } from "../server/services/face-engine";
import { GALLERY_DAYS, GALLERY_MAX_AGE_DAYS, isUsableEmbedding, roundEmbedding } from "../server/services/face-gallery";

const APPLY = process.argv.includes("--apply");
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");

const roster = (
  await db.select({ id: employees.id, v: employees.faceDescriptor }).from(employees).where(isNotNull(employees.faceDescriptor))
).filter((r) => isUsableEmbedding(r.v));
if (roster.length < 2) {
  console.log("\n  Fewer than two enrolled faces — start the server once so it re-enrols everyone from their photo, then run this.\n");
  process.exit(0);
}
const index = buildMatchIndex(roster.map((r) => ({ id: r.id, descriptors: [r.v!] })));
const enrolled = new Set(roster.map((r) => r.id));

const shots = await db
  .select({ id: punches.id, employeeId: punches.employeeId, day: punches.punchDate, at: punches.punchedAt, method: punches.method })
  .from(punches)
  .where(
    and(
      isNotNull(punches.photoUrl),
      isNull(punches.faceEmbedding),
      sql`${punches.punchDate} >= (now() AT TIME ZONE 'Asia/Kolkata')::date - ${GALLERY_MAX_AGE_DAYS}::int`,
    ),
  )
  .orderBy(desc(punches.punchedAt));

const tally = { noFace: 0, notEnrolled: 0, agreed: 0, otherPerson: 0, unsure: 0 };
const manual = { n: 0, agreed: 0 };
/** Per worker, per day: the latest scan SFace agreed with (newest first, so the first found). */
const best = new Map<string, Map<string, { id: string; v: number[] }>>();
let read = 0;
for (const s of shots) {
  if (!enrolled.has(s.employeeId)) { tally.notEnrolled++; continue; }
  const days = best.get(s.employeeId) ?? new Map<string, { id: string; v: number[] }>();
  if (days.has(s.day) || days.size >= GALLERY_DAYS) continue;
  const [row] = await db.select({ photo: punches.photoUrl }).from(punches).where(eq(punches.id, s.id));
  read++;
  if (read % 200 === 0) console.log(`  read ${read} gate photos`);
  const f = await faceVector(row?.photo ?? "");
  if (!f) { tally.noFace++; continue; }
  const m = findBestMatchIndexed(f.vector, index);
  if (s.method === "manual") manual.n++;
  if (m.id !== s.employeeId) { tally.otherPerson++; continue; }
  if (s.method === "manual") manual.agreed++;
  if (m.score < TEACH_OWN_FLOOR) { tally.unsure++; continue; }
  tally.agreed++;
  days.set(s.day, { id: s.id, v: roundEmbedding(f.vector) });
  best.set(s.employeeId, days);
}
const teach = [...best.values()].flatMap((days) => [...days.values()]);

const judged = tally.agreed + tally.otherPerson + tally.unsure;
console.log(`
  Gate photos inside ${GALLERY_MAX_AGE_DAYS} days with no vector: ${shots.length}, of which read: ${read}
    SFace picked the punch's own worker:  ${tally.agreed + tally.unsure} of ${judged} (${pct(tally.agreed + tally.unsure, judged)})
      of which sure enough to teach:      ${tally.agreed}
    SFace picked somebody else:           ${tally.otherPerson} (${pct(tally.otherPerson, judged)}) — left out
    hand-picked punches it agreed with:   ${manual.agreed} of ${manual.n} (${pct(manual.agreed, manual.n)})
    no face found / worker not enrolled:  ${tally.noFace} / ${tally.notEnrolled}
  Captures to write (one a day, newest ${GALLERY_DAYS} days per worker): ${teach.length} for ${best.size} workers
`);

if (!APPLY) {
  console.log("  Dry run — nothing written. Re-run with --apply to write.\n");
} else {
  await db.transaction(async (tx) => {
    for (const c of teach) await tx.update(punches).set({ faceEmbedding: c.v }).where(eq(punches.id, c.id));
  });
  console.log(`  Written: ${teach.length} capture(s).\n`);
}
await pool.end();
