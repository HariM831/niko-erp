/**
 * Where to set the gate's cutoff, decided from this farm's own faces.
 *
 * Read-only. Nothing here writes, and nothing here changes what the gate does
 * — it says what each setting WOULD have done to punches already made.
 *
 * The question is not "which threshold accepts the most". A gate that accepts
 * everything is a gate that puts the wrong name on somebody's attendance, and
 * that costs a day's pay and the trust of the person it happened to. So the
 * operating point is chosen by rule: **no wrong-person accepts at all**, and
 * then as few refusals as possible.
 *
 * Two scales are compared. `raw` is cosine as the gate does it today. In
 * `centred` the population's average face is subtracted from every vector
 * first: a FaceRes embedding is dominated by what all faces share — the
 * model's notion of a face, this camera, this light — and cosine counts that
 * shared bulk as agreement, which is why two strangers here score 64%.
 *
 * The evidence is every capture the gate kept: `punches.face_embedding`, filed
 * under the person the punch was recorded against. A capture from a punch the
 * guard picked by hand is the interesting one — it is a face the gate could
 * NOT read — and those are counted separately, because a threshold that is
 * kind to them is the whole point.
 *
 *   npx tsx scripts/calibrate-face-matching.ts
 *   npx tsx scripts/calibrate-face-matching.ts --days 30
 */
import { isNotNull, sql } from "drizzle-orm";
import { FACE_DIM, MATCH_MARGIN, MATCH_THRESHOLD } from "@shared/face";
import { employees } from "@shared/schema";
import { db } from "../server/db";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const DAYS = Number(arg("days") ?? 60);

const pct = (n: number) => `${(n * 100).toFixed(0)}%`;

/* ── The roster, as the gate holds it ─────────────────────────────────── */
const rows = await db
  .select({ id: employees.id, code: employees.empCode, name: employees.name, vec: employees.faceDescriptor })
  .from(employees)
  .where(isNotNull(employees.faceDescriptor));

const people = rows
  .map((r) => ({ ...r, vec: (r.vec ?? []) as number[] }))
  .filter((r) => r.vec.length === FACE_DIM && r.vec.every(Number.isFinite));

if (people.length < 2) {
  console.log("\n  Fewer than two enrolled faces — nothing to calibrate.\n");
  process.exit(0);
}

/* ── The captures: what the gate actually saw ─────────────────────────── */
const caps = (
  await db.execute(sql`
    SELECT p.employee_id AS "employeeId",
           p.face_embedding AS vec,
           (p.method = 'manual') AS "wasManual",
           p.punch_date AS day
      FROM punches p
     WHERE p.face_embedding IS NOT NULL
       AND p.punch_date >= (now() AT TIME ZONE 'Asia/Kolkata')::date - ${DAYS}::int
  `)
).rows as Array<{ employeeId: string; vec: number[]; wasManual: boolean; day: string }>;

const probes = caps
  .map((c) => ({ ...c, vec: (c.vec ?? []) as number[] }))
  .filter((c) => c.vec.length === FACE_DIM);

console.log(`\n  CALIBRATION — ${people.length} enrolled faces, ${probes.length} captures over ${DAYS} days`);
console.log(`  the gate today: accept at ${pct(MATCH_THRESHOLD)} with ${pct(MATCH_MARGIN)} clear of the runner-up\n`);

if (!probes.length) {
  console.log("  No captures kept — let the gate run for a few days with photographs on, then come back.\n");
  process.exit(0);
}

/* ── The two scales ───────────────────────────────────────────────────── */
const mean = new Array<number>(FACE_DIM).fill(0);
for (const p of people) for (let k = 0; k < FACE_DIM; k++) mean[k]! += p.vec[k]! / people.length;

const unit = (v: number[], centred: boolean) => {
  const w = centred ? v.map((x, k) => x - mean[k]!) : v;
  const n = Math.sqrt(w.reduce((s, x) => s + x * x, 0)) || 1;
  return w.map((x) => x / n);
};

/**
 * Every capture scored against every person, once per scale. Two scores are
 * all a decision needs: the best, and the best OTHER person.
 */
interface Scored {
  ownScore: number;
  bestOther: number;
  topIsOwn: boolean;
  wasManual: boolean;
}

function scoreAll(centred: boolean): Scored[] {
  const gallery = people.map((p) => unit(p.vec, centred));
  const byId = new Map(people.map((p, i) => [p.id, i]));
  const out: Scored[] = [];
  for (const c of probes) {
    const mine = byId.get(c.employeeId);
    if (mine == null) continue;
    const probe = unit(c.vec, centred);
    let own = -1;
    let bestOther = -1;
    let topScore = -1;
    let topIdx = -1;
    for (let i = 0; i < people.length; i++) {
      let dot = 0;
      const g = gallery[i]!;
      for (let k = 0; k < FACE_DIM; k++) dot += probe[k]! * g[k]!;
      if (i === mine) own = dot;
      else if (dot > bestOther) bestOther = dot;
      if (dot > topScore) { topScore = dot; topIdx = i; }
    }
    out.push({ ownScore: own, bestOther, topIsOwn: topIdx === mine, wasManual: c.wasManual });
  }
  return out;
}

/**
 * What a setting would have done. A capture is accepted when the top score
 * clears the threshold and beats the runner-up by the margin; it is WRONG when
 * that accepted top was somebody else.
 */
function judge(scored: Scored[], threshold: number, margin: number) {
  let accepted = 0;
  let wrong = 0;
  let refusedManual = 0;
  for (const s of scored) {
    const top = Math.max(s.ownScore, s.bestOther);
    const second = Math.min(s.ownScore, s.bestOther);
    const takes = top >= threshold && top - second >= margin;
    if (!takes) {
      if (s.wasManual) refusedManual++;
      continue;
    }
    accepted++;
    if (!s.topIsOwn) wrong++;
  }
  return { accepted, wrong, refused: scored.length - accepted, refusedManual };
}

const manualCount = probes.filter((p) => p.wasManual).length;
console.log(`  Of those captures, ${manualCount} came from a punch the guard had to pick by hand — the failures.\n`);

for (const centred of [false, true]) {
  const scored = scoreAll(centred);
  const label = centred ? "CENTRED (average face removed)" : "RAW (as the gate is today)";
  const own = scored.map((s) => s.ownScore).sort((a, b) => a - b);
  const oth = scored.map((s) => s.bestOther).sort((a, b) => a - b);
  const at = (xs: number[], q: number) => xs[Math.min(xs.length - 1, Math.floor(q * xs.length))]!;
  console.log(`  ${label}`);
  console.log(`    own: p10 ${pct(at(own, 0.1))} median ${pct(at(own, 0.5))} p90 ${pct(at(own, 0.9))}   ` +
    `stranger: median ${pct(at(oth, 0.5))} p90 ${pct(at(oth, 0.9))} max ${pct(oth[oth.length - 1]!)}`);
  console.log(`    ${"cutoff".padStart(7)} ${"margin".padStart(7)} ${"accepted".padStart(9)} ${"WRONG".padStart(6)} ${"refused".padStart(8)}  of which were manual punches`);

  const lo = centred ? 0.25 : 0.55;
  const hi = centred ? 0.65 : 0.9;
  let best: { t: number; m: number; r: number; a: number } | null = null;
  for (let t = lo; t <= hi + 1e-9; t += 0.02) {
    for (const m of [0.04, 0.06, 0.08, 0.1, 0.12]) {
      const r = judge(scored, t, m);
      if (r.wrong === 0 && (!best || r.refused < best.r)) best = { t, m, r: r.refused, a: r.accepted };
    }
  }
  // Printed sparsely: the whole sweep is a wall of numbers nobody reads.
  for (let t = lo; t <= hi + 1e-9; t += 0.05) {
    for (const m of [0.05, 0.1]) {
      const r = judge(scored, t, m);
      console.log(
        `    ${pct(t).padStart(7)} ${pct(m).padStart(7)} ${String(r.accepted).padStart(9)} ${String(r.wrong).padStart(6)} ${String(r.refused).padStart(8)}  ${r.refusedManual}`,
      );
    }
  }
  if (best) {
    const r = judge(scored, best.t, best.m);
    console.log(
      `    → no wrong name at ${pct(best.t)} with ${pct(best.m)} clear: ` +
        `${r.accepted} of ${scored.length} accepted (${pct(r.accepted / scored.length)}), ${r.refused} to the guard`,
    );
  } else {
    console.log("    → no setting on this scale avoids a wrong name. The enrolments are the problem, not the cutoff.");
  }
  console.log();
}

console.log("  A capture is filed under whoever the punch says, so a punch the guard mis-picked");
console.log("  counts here as the truth. Read a handful of the wrong ones before trusting a jump.\n");
process.exit(0);
