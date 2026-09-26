/**
 * Why the gate confuses two people, or refuses to name anyone at all.
 *
 * The gate matches a live face against every enrolled one and accepts the top
 * score only when it clears the threshold AND stands clear of the runner-up.
 * Both failures at the gate look the same to the guard — "no confident match",
 * or somebody else's name — and both have the same cause underneath: two
 * enrolled faces sitting too close together.
 *
 * This says, for whoever is named, which other enrolments theirs resembles and
 * by how much. A pair above the margin is a pair the gate cannot separate, and
 * the fix is a better photograph of one of them — not a lower threshold.
 *
 *   npx tsx scripts/diagnose-face-pairs.ts                 the worst pairs on the roster
 *   npx tsx scripts/diagnose-face-pairs.ts W-0017 SANDIP   plus these people in detail
 */
import { isNotNull, sql } from "drizzle-orm";
import { FACE_DIM, MATCH_MARGIN, MATCH_THRESHOLD } from "@shared/face";
import { employees } from "@shared/schema";
import { db } from "../server/db";

const who = process.argv.slice(2).filter((a) => !a.startsWith("--"));

const rows = await db
  .select({
    id: employees.id,
    code: employees.empCode,
    name: employees.name,
    enrolledAt: employees.faceEnrolledAt,
    vec: employees.faceDescriptor,
  })
  .from(employees)
  .where(isNotNull(employees.faceDescriptor));

/** A vector of the wrong length scores zero against everything — it cannot match, ever. */
const people = rows
  .map((r) => ({ ...r, vec: (r.vec ?? []) as number[] }))
  .filter((r) => {
    if (r.vec.length === FACE_DIM && r.vec.every(Number.isFinite)) return true;
    console.log(`  ! ${r.code} ${r.name}: enrolment vector is ${r.vec.length} numbers, not ${FACE_DIM} — it can never match`);
    return false;
  });

const norm = people.map((p) => Math.sqrt(p.vec.reduce((s, x) => s + x * x, 0)));
const cosine = (i: number, j: number) => {
  let dot = 0;
  const a = people[i]!.vec;
  const b = people[j]!.vec;
  for (let k = 0; k < FACE_DIM; k++) dot += a[k]! * b[k]!;
  return dot / (norm[i]! * norm[j]!);
};

const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
console.log(`\n  FACE PAIRS — ${people.length} enrolled, accept at ${pct(MATCH_THRESHOLD)} with ${pct(MATCH_MARGIN)} clear of the runner-up\n`);

/* ── Every pair the gate would struggle with ──────────────────────────── */
const pairs: Array<{ a: number; b: number; s: number }> = [];
for (let i = 0; i < people.length; i++) {
  for (let j = i + 1; j < people.length; j++) {
    const s = cosine(i, j);
    if (s >= MATCH_THRESHOLD - MATCH_MARGIN) pairs.push({ a: i, b: j, s });
  }
}
pairs.sort((x, y) => y.s - x.s);

console.log(`  ${pairs.length} pair(s) of enrolments closer than the gate can safely separate:\n`);
for (const p of pairs.slice(0, 25)) {
  const A = people[p.a]!;
  const B = people[p.b]!;
  console.log(`    ${pct(p.s)}  ${A.code.padEnd(13)} ${A.name.slice(0, 22).padEnd(23)} ↔  ${B.code.padEnd(13)} ${B.name}`);
}
if (pairs.length > 25) console.log(`    …and ${pairs.length - 25} more`);

/* ── The people asked about, in detail ────────────────────────────────── */
for (const term of who) {
  const idx = people.findIndex(
    (p) => p.code.toUpperCase() === term.toUpperCase() || p.name.toUpperCase().includes(term.toUpperCase()),
  );
  if (idx < 0) {
    console.log(`\n  ${term}: nobody enrolled by that name or code`);
    continue;
  }
  const me = people[idx]!;
  const others = people
    .map((p, j) => ({ p, j, s: j === idx ? -1 : cosine(idx, j) }))
    .filter((x) => x.j !== idx)
    .sort((x, y) => y.s - x.s)
    .slice(0, 5);
  console.log(`\n  ${me.code} ${me.name} — enrolled ${me.enrolledAt ? me.enrolledAt.toISOString().slice(0, 10) : "never"}`);
  for (const o of others) {
    const flag = o.s >= MATCH_THRESHOLD ? "  ← the gate can read this as them" : o.s >= MATCH_THRESHOLD - MATCH_MARGIN ? "  ← too close to call" : "";
    console.log(`     ${pct(o.s)}  ${o.p.code.padEnd(13)} ${o.p.name}${flag}`);
  }
}

/* ── How the live gate actually scores ────────────────────────────────────
 * The pairs above are enrolment against enrolment. What decides a punch is a
 * LIVE face against those enrolments, so the honest measure is: how well does
 * a face captured at the gate score against its own enrolment (genuine), and
 * how close does the best stranger come (impostor)? The gap between those two
 * distributions is the whole system. Read off the captures the gate has kept.
 */
const caps = (
  await db.execute(sql`
    SELECT p.employee_id AS "employeeId", p.face_embedding AS vec
      FROM punches p
     WHERE p.face_embedding IS NOT NULL
       AND p.punch_date >= (now() AT TIME ZONE 'Asia/Kolkata')::date - 14
     LIMIT 4000
  `)
).rows as Array<{ employeeId: string; vec: number[] }>;

if (!caps.length) {
  console.log("
  No captures kept in the last fortnight — nothing to measure the live gate with.
");
} else {
  const byId = new Map(people.map((p, i) => [p.id, i]));
  const genuine: number[] = [];
  const impostor: number[] = [];
  let separated = 0;
  for (const c of caps) {
    const v = (c.vec ?? []) as number[];
    if (v.length !== FACE_DIM) continue;
    const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    const score = (i: number) => {
      let dot = 0;
      const b = people[i]!.vec;
      for (let k = 0; k < FACE_DIM; k++) dot += v[k]! * b[k]!;
      return dot / (n * norm[i]!);
    };
    const mine = byId.get(c.employeeId);
    if (mine == null) continue;
    let best = -1;
    let bestScore = -1;
    for (let i = 0; i < people.length; i++) {
      if (i === mine) continue;
      const s2 = score(i);
      if (s2 > bestScore) { bestScore = s2; best = i; }
    }
    const own = score(mine);
    genuine.push(own);
    impostor.push(bestScore);
    if (own >= MATCH_THRESHOLD && own - bestScore >= MATCH_MARGIN) separated++;
    void best;
  }
  const stat = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
    return `min ${pct(s[0]!)}  p10 ${pct(at(0.1))}  median ${pct(at(0.5))}  p90 ${pct(at(0.9))}  max ${pct(s[s.length - 1]!)}`;
  };
  console.log(`
  LIVE GATE, ${genuine.length} captures in the last fortnight`);
  console.log(`    against their own enrolment:  ${stat(genuine)}`);
  console.log(`    against the closest stranger: ${stat(impostor)}`);
  console.log(`    would auto-accept: ${separated} of ${genuine.length} (${pct(separated / genuine.length)})`);
}

console.log();
process.exit(0);
