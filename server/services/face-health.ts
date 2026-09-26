/**
 * How often face recognition actually fails, out of data already stored.
 *
 * Nothing records a failed scan, so the only signal anyone has ever had is a
 * guard mentioning that the camera did not know someone. But the answer is
 * already in the punch rows: a guard picks a name off the list ONLY when the
 * face failed, so `method = 'manual'` IS the failure rate — per person, per
 * hour, per day — and it has never been read.
 *
 * Since Sep 2026 that "ONLY" has two exceptions, and the gate says which: a
 * name may also be picked because the camera was refused or the face engine
 * never loaded, or because the person has no enrolled face at all. None of
 * those is recognition failing, so they are left out — `manual_reason` null or
 * 'no_match' is what counts.
 *
 * Read-only. No schema change, no new table, nothing written.
 *
 * One correction matters more than the rest. HR closing a forgotten punch-out
 * writes a punch with method 'manual' and no device, which is indistinguishable
 * from a guard failing to be recognised; a day where HR clears twenty dangling
 * INs would otherwise show up as twenty face failures and put those twenty
 * people on the re-photograph list. Those rows carry a resolution note, and are
 * excluded — but only the manufactured OUT. The same action stamps the note
 * onto the original IN as well, and that one is a genuine gate scan, usually a
 * successful match. Excluding both shrinks the denominator and inflates the
 * rate. The discriminator is `resolved_at`: set on the original, null on the
 * row HR created.
 */
import { sql } from "drizzle-orm";
import type { Db, Tx } from "../db";

type Conn = Db | Tx;

// The gate auto-accepts at this score, and only with a clear margin over the
// runner-up. One definition, shared with the client that makes the decision.
export { MATCH_MARGIN, MATCH_THRESHOLD } from "@shared/face";
import { FACE_DIM, MATCH_MARGIN, MATCH_THRESHOLD, TEACH_OWN_FLOOR } from "@shared/face";

/** HR's desk work, which is not a face failing. See the note above. */
const HR_RESOLVED = sql`(p.resolution_note IS NOT NULL AND p.resolved_at IS NULL)`;

export interface FaceHealth {
  days: number;
  from: string;
  to: string;
  gate: {
    scans: number;
    failures: number;
    rate: number | null;
    hrResolved: number;
    byDay: Array<{ day: string; scans: number; failures: number }>;
    byHour: Array<{ hour: number; scans: number; failures: number }>;
  };
  canteen: { plates: number; nameMatched: number; rate: number | null };
  /** Who the gate keeps failing to recognise, worst first. */
  strugglers: Array<{
    name: string;
    empCode: string;
    scans: number;
    failures: number;
    rate: number;
    descriptors: number;
    enrolledOn: string | null;
  }>;
  /** How much room a successful match had. A pile at the cutoff is fragile. */
  margins: { scored: number; bands: Array<{ label: string; n: number }> };
  gallery: { active: number; noFace: number; enrolmentOnly: number; taught: number; captures: number };
  /**
   * How far apart the enrolled faces are from one another. Without this the
   * look-alike list below cannot be read: a pair at 0.94 means nothing until
   * you know whether the typical pair sits at 0.4 or at 0.9.
   */
  separation: {
    pairs: number; median: number; p90: number; p99: number; max: number; overThreshold: number;
    /**
     * The same pairs with the population's average face subtracted first. If
     * everyone resembles everyone, this says whether identity is still in there
     * under a shared offset (it drops well below the raw median) or the vectors
     * are genuinely alike (it does not).
     */
    centredMedian: number;
    centredP99: number;
    /** Typical similarity within and across pay types; a gap means two enrolment routes of different quality. */
    byPayType: { salaried: number | null; dailyWage: number | null; across: number | null };
    /** Enrolment vectors left out for not being FACE_DIM finite numbers. */
    skippedVectors: number;
  };
  /**
   * Captures the gate learned that do not look like the person they are filed
   * under — each one is pulling that person's gallery toward somebody else.
   */
  misfiled: { total: number; shown: Array<{ filedUnder: string; looksLike: string | null; ownScore: number; otherScore: number; method: string; day: string }> };
  /**
   * How much of the face model actually fired on each enrolment photo.
   *
   * The descriptor is mostly zeros where the model found nothing to say, so
   * the count of non-zero dimensions is a plain measure of how much the photo
   * gave it. A weak one is not merely a poorer match — sparse vectors that
   * share their few live dimensions score high against EACH OTHER, so weak
   * enrolments become mutually confusable as a group.
   *
   * This is the useful half of the report, because it is knowable the day the
   * photo is taken rather than after somebody has failed at the gate a dozen
   * times.
   */
  enrolment: {
    people: number;
    medianActiveDims: number;
    weakBelow: number;
    weak: Array<{ name: string; activeDims: number; confusableWith: number }>;
  };
  /**
   * Groups of enrolments too close to tell apart, not pairs: they come in
   * cliques, and "78 pairs" hides that it is thirteen people.
   */
  clusters: Array<{ members: string[]; tightest: number }>;
  /** The tightest few pairs, to put a number on how close "too close" is. */
  lookalikes: { total: number; shown: Array<{ a: string; b: string; similarity: number }> };
  /**
   * Centred matching, scored beside the raw decision and not yet deciding
   * anything (docs/face-matching-centred-plan.md, rollout step 3). The number
   * that matters is `byHand`: those are the faces the raw matcher could not
   * read, and a centred matcher that puts the right person first on them is
   * the case for switching.
   */
  centred: {
    recorded: number;
    /** Recognised by the raw matcher: did centred pick the same person? */
    scanned: CentredBand;
    /** Picked by hand after the scan failed: was the picked person centred's first choice? */
    byHand: CentredBand;
  };
  advice: string[];
}

interface CentredBand {
  n: number;
  /** Centred's first choice was the person the punch or plate was recorded against. */
  agree: number;
  medianScore: number | null;
  /** Median lead of centred's first choice over its runner-up. */
  medianGap: number | null;
}

async function centredComparison(conn: Conn, days: number): Promise<FaceHealth["centred"]> {
  const rows = (
    await conn.execute(sql`
      SELECT p.method::text AS method, (p.centred_match_id = p.employee_id) AS agree,
             p.match_score_centred AS score, p.match_score_centred - p.centred_second_score AS gap
        FROM punches p
       WHERE p.face_model_id IS NOT NULL
         AND p.punch_date >= (now() AT TIME ZONE 'Asia/Kolkata')::date - ${days}::int
      UNION ALL
      SELECT 'face', (s.centred_match_id = s.employee_id),
             s.match_score_centred, s.match_score_centred - s.centred_second_score
        FROM canteen_servings s
       WHERE s.face_model_id IS NOT NULL
         AND s.meal_date >= (now() AT TIME ZONE 'Asia/Kolkata')::date - ${days}::int
    `)
  ).rows as Array<{ method: string; agree: boolean | null; score: number | null; gap: number | null }>;
  const median = (xs: number[]) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)]!;
  };
  const band = (list: typeof rows): CentredBand => ({
    n: list.length,
    agree: list.filter((r) => r.agree).length,
    medianScore: median(list.flatMap((r) => (r.score == null ? [] : [Number(r.score)]))),
    medianGap: median(list.flatMap((r) => (r.gap == null ? [] : [Number(r.gap)]))),
  });
  return {
    recorded: rows.length,
    scanned: band(rows.filter((r) => r.method === "face")),
    byHand: band(rows.filter((r) => r.method === "manual")),
  };
}

/**
 * Whose face needs taking again — the same arithmetic as `strugglers`, but
 * per person, over both places a face is read, and reduced to a verdict the
 * enrolment screen can show as a badge.
 *
 * The two places fail for different reasons and must be judged apart. The gate
 * is a person standing still in daylight, so a face that fails THERE is a bad
 * enrolment. The canteen is a queue at 8pm with a plate in each hand, and a
 * face that reads well at the gate and badly over the counter is telling you
 * about the lamp above the counter, not about the photograph. So a poor
 * canteen record alone says "watch", never "take a new photograph".
 *
 * Thin evidence says nothing at all: a person with four scans who failed twice
 * is not a pattern, and putting them on a list wastes somebody's morning.
 */
export type FaceVerdict = "no_face" | "reenrol" | "watch" | "ok" | "thin";

export interface FaceStanding {
  employeeId: string;
  empCode: string;
  name: string;
  gateScans: number;
  gateFailures: number;
  gateRate: number | null;
  gateScore: number | null;
  canteenPlates: number;
  canteenByHand: number;
  canteenRate: number | null;
  verdict: FaceVerdict;
  /** One line saying why, for the badge's tooltip. */
  why: string;
}

/** Enough scans for a rate to mean anything. */
const ENOUGH = 10;
/** Above this share of hand-picked names at the gate, the enrolment is the problem. */
const REENROL_AT = 0.3;
const WATCH_AT = 0.15;

export async function faceStandings(conn: Conn, days = 60): Promise<FaceStanding[]> {
  const rows = (
    await conn.execute(sql`
      WITH gate AS (
        SELECT p.employee_id,
               count(*)::int AS scans,
               count(*) FILTER (WHERE p.method = 'manual' AND coalesce(p.manual_reason, 'no_match') = 'no_match')::int AS failures,
               avg(p.match_score) AS score
          FROM punches p
         WHERE p.punch_date >= (now() AT TIME ZONE 'Asia/Kolkata')::date - ${days}::int
           AND NOT ${HR_RESOLVED}
         GROUP BY p.employee_id
      ),
      cant AS (
        SELECT s.employee_id,
               count(*)::int AS plates,
               count(*) FILTER (WHERE s.state = 'name_matched')::int AS by_hand
          FROM canteen_servings s
         WHERE s.employee_id IS NOT NULL
           AND s.meal_date >= (now() AT TIME ZONE 'Asia/Kolkata')::date - ${days}::int
         GROUP BY s.employee_id
      )
      SELECT e.id AS "employeeId", e.emp_code AS "empCode", e.name,
             (e.face_descriptor IS NOT NULL) AS enrolled,
             coalesce(g.scans, 0)::int AS "gateScans",
             coalesce(g.failures, 0)::int AS "gateFailures",
             g.score::float8 AS "gateScore",
             coalesce(c.plates, 0)::int AS "canteenPlates",
             coalesce(c.by_hand, 0)::int AS "canteenByHand"
        FROM employees e
        LEFT JOIN gate g ON g.employee_id = e.id
        LEFT JOIN cant c ON c.employee_id = e.id
       WHERE e.is_active
    `)
  ).rows as Array<{
    employeeId: string; empCode: string; name: string; enrolled: boolean;
    gateScans: number; gateFailures: number; gateScore: number | null;
    canteenPlates: number; canteenByHand: number;
  }>;

  return rows.map((r) => {
    const gateRate = r.gateScans ? r.gateFailures / r.gateScans : null;
    const canteenRate = r.canteenPlates ? r.canteenByHand / r.canteenPlates : null;
    let verdict: FaceVerdict;
    let why: string;
    if (!r.enrolled) {
      verdict = "no_face";
      why = "No face on file — every punch is a name picked by hand.";
    } else if (r.gateScans < ENOUGH) {
      // The canteen can still speak up, but only loudly and only to say "watch".
      if (r.canteenPlates >= ENOUGH && (canteenRate ?? 0) >= 0.5) {
        verdict = "watch";
        why = `${pct(canteenRate!)} of plates went out on a tapped name, and the gate has too few scans to judge.`;
      } else {
        verdict = "thin";
        why = "Too few scans to say anything yet.";
      }
    } else if (gateRate! >= REENROL_AT) {
      verdict = "reenrol";
      why = `The gate failed to recognise them on ${pct(gateRate!)} of ${r.gateScans} scans — that is the photograph, not the light.`;
    } else if (gateRate! >= WATCH_AT || (canteenRate != null && r.canteenPlates >= ENOUGH && canteenRate >= 0.5)) {
      verdict = "watch";
      why =
        gateRate! >= WATCH_AT
          ? `${pct(gateRate!)} of gate scans needed a name picked by hand.`
          : `The gate is fine (${pct(gateRate!)}) but ${pct(canteenRate!)} of plates went out on a tapped name — look at the light over the counter first.`;
    } else {
      verdict = "ok";
      why = `${pct(gateRate!)} of gate scans needed a hand.`;
    }
    return {
      employeeId: r.employeeId,
      empCode: r.empCode,
      name: r.name,
      gateScans: r.gateScans,
      gateFailures: r.gateFailures,
      gateRate,
      gateScore: r.gateScore,
      canteenPlates: r.canteenPlates,
      canteenByHand: r.canteenByHand,
      canteenRate,
      verdict,
      why,
    };
  });
}

export async function buildFaceHealth(conn: Conn, days = 30): Promise<FaceHealth> {
  const window = sql`p.punch_date >= (now() AT TIME ZONE 'Asia/Kolkata')::date - ${days}::int`;

  /* ── The gate, day by day ───────────────────────────────────────────── */
  const byDay = (
    await conn.execute(sql`
      SELECT p.punch_date::text AS day,
             count(*)::int AS scans,
             count(*) FILTER (WHERE (p.method = 'manual' AND coalesce(p.manual_reason, 'no_match') = 'no_match'))::int AS failures
        FROM punches p
       WHERE ${window} AND NOT ${HR_RESOLVED}
       GROUP BY p.punch_date
       ORDER BY p.punch_date
    `)
  ).rows as Array<{ day: string; scans: number; failures: number }>;

  const byHour = (
    await conn.execute(sql`
      SELECT EXTRACT(HOUR FROM p.punched_at AT TIME ZONE 'Asia/Kolkata')::int AS hour,
             count(*)::int AS scans,
             count(*) FILTER (WHERE (p.method = 'manual' AND coalesce(p.manual_reason, 'no_match') = 'no_match'))::int AS failures
        FROM punches p
       WHERE ${window} AND NOT ${HR_RESOLVED}
       GROUP BY 1 ORDER BY 1
    `)
  ).rows as Array<{ hour: number; scans: number; failures: number }>;

  const [hr] = (
    await conn.execute(sql`
      SELECT count(*)::int AS n FROM punches p WHERE ${window} AND ${HR_RESOLVED}
    `)
  ).rows as Array<{ n: number }>;

  const scans = byDay.reduce((n, d) => n + d.scans, 0);
  const failures = byDay.reduce((n, d) => n + d.failures, 0);

  /* ── Who it keeps failing ───────────────────────────────────────────── */
  const strugglers = (
    await conn.execute(sql`
      SELECT e.name, e.emp_code AS "empCode",
             count(*)::int AS scans,
             count(*) FILTER (WHERE (p.method = 'manual' AND coalesce(p.manual_reason, 'no_match') = 'no_match'))::int AS failures,
             (SELECT count(DISTINCT c.punch_date)::int FROM punches c
               WHERE c.employee_id = e.id AND c.face_embedding IS NOT NULL) AS taught,
             (e.face_descriptor IS NOT NULL) AS enrolled,
             to_char(e.face_enrolled_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS "enrolledOn"
        FROM punches p
        JOIN employees e ON e.id = p.employee_id
       WHERE ${window} AND NOT ${HR_RESOLVED}
       GROUP BY e.id, e.name, e.emp_code, e.face_descriptor, e.face_enrolled_at
      HAVING count(*) FILTER (WHERE (p.method = 'manual' AND coalesce(p.manual_reason, 'no_match') = 'no_match')) > 0
       ORDER BY count(*) FILTER (WHERE (p.method = 'manual' AND coalesce(p.manual_reason, 'no_match') = 'no_match')) DESC, count(*) DESC
       LIMIT 25
    `)
  ).rows as Array<{
    name: string; empCode: string; scans: number; failures: number;
    taught: number; enrolled: boolean; enrolledOn: string | null;
  }>;

  /* ── How close the successes ran ────────────────────────────────────── */
  const [m] = (
    await conn.execute(sql`
      SELECT count(*) FILTER (WHERE p.match_score IS NOT NULL)::int AS scored,
             count(*) FILTER (WHERE p.match_score >= 0.9)::int AS band90,
             count(*) FILTER (WHERE p.match_score >= 0.8 AND p.match_score < 0.9)::int AS band80,
             count(*) FILTER (WHERE p.match_score >= 0.7 AND p.match_score < 0.8)::int AS band70,
             count(*) FILTER (WHERE p.match_score >= ${MATCH_THRESHOLD}::real
                                AND p.match_score < 0.7)::int AS bandEdge
        FROM punches p
       WHERE ${window} AND NOT ${HR_RESOLVED} AND p.method <> 'manual'
    `)
  ).rows as Array<{ scored: number; band90: number; band80: number; band70: number; bandedge: number }>;

  /* ── The canteen ────────────────────────────────────────────────────── */
  const [c] = (
    await conn.execute(sql`
      SELECT count(*)::int AS plates,
             count(*) FILTER (WHERE state = 'name_matched')::int AS "nameMatched"
        FROM canteen_servings
       WHERE employee_id IS NOT NULL
         AND meal_date >= (now() AT TIME ZONE 'Asia/Kolkata')::date - ${days}::int
    `)
  ).rows as Array<{ plates: number; nameMatched: number }>;

  /* ── What the galleries look like ───────────────────────────────────── */
  const [g] = (
    await conn.execute(sql`
      SELECT count(*)::int AS active,
             count(*) FILTER (WHERE e.face_descriptor IS NULL)::int AS "noFace",
             count(*) FILTER (WHERE e.face_descriptor IS NOT NULL AND t.n IS NULL)::int AS "enrolmentOnly",
             count(*) FILTER (WHERE t.n IS NOT NULL)::int AS taught,
             COALESCE(sum(t.n), 0)::int AS captures
        FROM employees e
        LEFT JOIN (SELECT employee_id, count(*)::int AS n FROM punches
                    WHERE face_embedding IS NOT NULL GROUP BY employee_id) t
               ON t.employee_id = e.id
       WHERE e.is_active
    `)
  ).rows as Array<{ active: number; noFace: number; enrolmentOnly: number; taught: number; captures: number }>;

  return {
    days,
    from: byDay[0]?.day ?? "",
    to: byDay[byDay.length - 1]?.day ?? "",
    centred: await centredComparison(conn, days),
    gate: { scans, failures, rate: scans ? failures / scans : null, hrResolved: hr?.n ?? 0, byDay, byHour },
    canteen: {
      plates: c?.plates ?? 0,
      nameMatched: c?.nameMatched ?? 0,
      rate: c?.plates ? c.nameMatched / c.plates : null,
    },
    strugglers: strugglers.map((s) => ({
      name: s.name,
      empCode: s.empCode,
      scans: s.scans,
      failures: s.failures,
      rate: s.failures / s.scans,
      descriptors: (s.enrolled ? 1 : 0) + s.taught,
      enrolledOn: s.enrolledOn,
    })),
    margins: {
      scored: m?.scored ?? 0,
      bands: [
        { label: "0.90 and up", n: m?.band90 ?? 0 },
        { label: "0.80 – 0.90", n: m?.band80 ?? 0 },
        { label: "0.70 – 0.80", n: m?.band70 ?? 0 },
        { label: `${MATCH_THRESHOLD.toFixed(2)} – 0.70 (thin)`, n: m?.bandedge ?? 0 },
      ],
    },
    gallery: g ?? { active: 0, noFace: 0, enrolmentOnly: 0, taught: 0, captures: 0 },
    ...(await faceSeparation(conn)),
    advice: [],
  };
}

/**
 * Pairs the gate could mistake for one another.
 *
 * The auto-accept rule needs both a score over the threshold AND a clear
 * margin over the runner-up, so two people whose enrolment photos sit within
 * that margin of each other do not produce a wrong match — they produce a
 * refused one, for both of them, every time. That is worth knowing before
 * either of them ends up on the re-photograph list for reasons of their own.
 */
async function faceSeparation(conn: Conn): Promise<Pick<FaceHealth, "separation" | "lookalikes" | "enrolment" | "clusters" | "misfiled">> {
  const fetched = (
    await conn.execute(sql`
      SELECT id, name, pay_type, face_descriptor AS d FROM employees
       WHERE is_active AND face_descriptor IS NOT NULL
    `)
  ).rows as Array<{ id: string; name: string; pay_type: string; d: number[] }>;
  // One vector of another length turns every dot product it touches into NaN,
  // and the medians with it. Left out, and counted.
  const rows = fetched.filter((r) => Array.isArray(r.d) && r.d.length === FACE_DIM && r.d.every((x) => Number.isFinite(x)));
  const skippedVectors = fetched.length - rows.length;

  // Normalise once, then every comparison is a dot product rather than a dot
  // and two square roots — at 180 people this is 16,000 pairs.
  const unit = rows.map((r) => {
    let sq = 0;
    let live = 0;
    for (const x of r.d) {
      sq += x * x;
      if (x !== 0) live++;
    }
    const n = Math.sqrt(sq) || 1;
    return { id: r.id, name: r.name, payType: r.pay_type, v: r.d.map((x) => x / n), live };
  });

  const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : null);
  const dotOf = (a: number[], b: number[]) => {
    let d = 0;
    for (let k = 0; k < a.length; k++) d += a[k]! * b[k]!;
    return d;
  };

  // The average face, taken away from each, and what is left re-measured.
  const mean = new Array<number>(FACE_DIM).fill(0);
  for (const u of unit) for (let k = 0; k < FACE_DIM; k++) mean[k]! += u.v[k]! / (unit.length || 1);
  const centred = unit.map((u) => {
    const c = u.v.map((x, k) => x - mean[k]!);
    const n = Math.sqrt(dotOf(c, c)) || 1;
    return c.map((x) => x / n);
  });
  const centredAll: number[] = [];
  const within: Record<string, number[]> = { salaried: [], daily_wage: [], across: [] };

  /** Above this, two enrolment photos are close enough to be worth a look. */
  const CONFUSABLE = 0.8;
  const all: number[] = [];
  const close: Array<{ a: string; b: string; similarity: number }> = [];
  for (let i = 0; i < unit.length; i++) {
    for (let j = i + 1; j < unit.length; j++) {
      let dot = 0;
      const a = unit[i]!.v, b = unit[j]!.v;
      for (let k = 0; k < a.length; k++) dot += a[k]! * b[k]!;
      all.push(dot);
      centredAll.push(dotOf(centred[i]!, centred[j]!));
      (within[unit[i]!.payType === unit[j]!.payType ? unit[i]!.payType : "across"] ??= []).push(dot);
      if (dot >= CONFUSABLE) close.push({ a: unit[i]!.name, b: unit[j]!.name, similarity: dot });
    }
  }
  all.sort((x, y) => x - y);
  const q = (f: number) => (all.length ? all[Math.floor(f * (all.length - 1))]! : 0);
  close.sort((x, y) => y.similarity - x.similarity);

  // How many others each face is confusable with, and the groups they form.
  const degree = new Map<string, number>();
  for (const c of close) {
    degree.set(c.a, (degree.get(c.a) ?? 0) + 1);
    degree.set(c.b, (degree.get(c.b) ?? 0) + 1);
  }
  const clusters = componentsOf(close);
  centredAll.sort((x, y) => x - y);

  // What the gate has learned, held against the enrolment it was learned for.
  const byId = new Map(unit.map((u) => [u.id, u]));
  const learned = (
    await conn.execute(sql`
      SELECT employee_id, method, punch_date::text AS day, face_embedding AS e
        FROM punches
       WHERE face_embedding IS NOT NULL
         AND punch_date >= (now() AT TIME ZONE 'Asia/Kolkata')::date - 60
    `)
  ).rows as Array<{ employee_id: string; method: string; day: string; e: number[] }>;
  const misfiledAll: FaceHealth["misfiled"]["shown"] = [];
  for (const p of learned) {
    const owner = byId.get(p.employee_id);
    if (!owner || !Array.isArray(p.e) || p.e.length !== FACE_DIM) continue;
    const n = Math.sqrt(dotOf(p.e, p.e)) || 1;
    const v = p.e.map((x) => x / n);
    const ownScore = dotOf(v, owner.v);
    if (ownScore >= TEACH_OWN_FLOOR) continue;
    let other: (typeof unit)[number] | null = null;
    let otherScore = 0;
    for (const u of unit) {
      if (u.id === owner.id) continue;
      const sc = dotOf(v, u.v);
      if (sc > otherScore) { otherScore = sc; other = u; }
    }
    misfiledAll.push({ filedUnder: owner.name, looksLike: other && otherScore >= MATCH_THRESHOLD ? other.name : null, ownScore, otherScore, method: p.method, day: p.day });
  }
  misfiledAll.sort((a, b) => a.ownScore - b.ownScore);

  const dims = unit.map((u) => u.live).sort((x, y) => x - y);
  const medianDims = dims.length ? dims[Math.floor(dims.length / 2)]! : 0;
  /*
   * A rule of thumb, not a constant of nature: three quarters of the typical
   * enrolment. On the imported roster it separates the confusable group from
   * everyone else cleanly — none of them reaches 500 live dimensions and
   * nobody outside falls below 506 — but the `confusableWith` column beside
   * it is what confirms the reading, so a wrong cut shows up rather than
   * quietly mislabelling somebody.
   */
  const weakBelow = Math.round(medianDims * 0.75);

  return {
    enrolment: {
      people: unit.length,
      medianActiveDims: medianDims,
      weakBelow,
      weak: unit
        .filter((u) => u.live < weakBelow)
        .map((u) => ({ name: u.name, activeDims: u.live, confusableWith: degree.get(u.name) ?? 0 }))
        .sort((x, y) => x.activeDims - y.activeDims),
    },
    clusters,
    misfiled: { total: misfiledAll.length, shown: misfiledAll.slice(0, 20) },
    separation: {
      centredMedian: centredAll.length ? centredAll[Math.floor(centredAll.length / 2)]! : 0,
      centredP99: centredAll.length ? centredAll[Math.floor(0.99 * (centredAll.length - 1))]! : 0,
      byPayType: { salaried: median(within.salaried ?? []), dailyWage: median(within.daily_wage ?? []), across: median(within.across ?? []) },
      skippedVectors,
      pairs: all.length,
      median: q(0.5),
      p90: q(0.9),
      p99: q(0.99),
      max: q(1),
      overThreshold: all.length ? all.filter((x) => x >= MATCH_THRESHOLD).length / all.length : 0,
    },
    // Capped, and the total said out loud: a truncated list with no count
    // reads as the whole answer.
    lookalikes: { total: close.length, shown: close.slice(0, 8) },
  };
}

/** Connected groups over the confusable pairs — plain union-find. */
function componentsOf(
  pairs: Array<{ a: string; b: string; similarity: number }>,
): Array<{ members: string[]; tightest: number }> {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    if (!parent.has(x)) parent.set(x, x);
    if (parent.get(x) === x) return x;
    const root = find(parent.get(x)!);
    parent.set(x, root);
    return root;
  };
  for (const p of pairs) parent.set(find(p.a), find(p.b));

  const groups = new Map<string, { members: Set<string>; tightest: number }>();
  for (const p of pairs) {
    const key = find(p.a);
    const g = groups.get(key) ?? { members: new Set<string>(), tightest: 0 };
    g.members.add(p.a);
    g.members.add(p.b);
    g.tightest = Math.max(g.tightest, p.similarity);
    groups.set(key, g);
  }
  return [...groups.values()]
    .map((g) => ({ members: [...g.members].sort(), tightest: g.tightest }))
    .sort((x, y) => y.members.length - x.members.length);
}

/** What this run's own numbers say to do next. Not a fixed checklist. */
export function adviseOn(r: FaceHealth): string[] {
  const out: string[] = [];
  if (r.gate.scans === 0) {
    out.push("No gate scans in this window — nothing to measure yet.");
    return out;
  }
  const rate = r.gate.rate ?? 0;
  if (rate >= 0.2) {
    out.push(`${pct(rate)} of scans needed a name picked by hand. That is the headline number and it is high.`);
  } else if (rate >= 0.05) {
    out.push(`${pct(rate)} of scans needed a name picked by hand.`);
  } else {
    out.push(`${pct(rate)} of scans needed a name picked by hand — recognition is doing its job.`);
  }

  const repeat = r.strugglers.filter((s) => s.failures >= 3 && s.rate >= 0.5);
  if (repeat.length) {
    out.push(
      `Re-photograph ${repeat.length} ${repeat.length === 1 ? "person" : "people"}: ` +
        repeat.slice(0, 8).map((s) => `${s.name} (${s.failures}/${s.scans})`).join(", ") +
        ". They fail more often than they succeed, so their enrolment photo is the problem, not the light.",
    );
  }

  const stuck = r.strugglers.filter((s) => s.descriptors <= 1 && s.failures >= 3);
  if (stuck.length) {
    out.push(
      `${stuck.length} of those still carry only their enrolment photo. A hand-picked name teaches the gallery, ` +
        "so they should start improving on their own now — if they do not, the enrolment photo is unusable.",
    );
  }

  if (r.gallery.noFace > 0) {
    out.push(`${r.gallery.noFace} active ${r.gallery.noFace === 1 ? "worker has" : "workers have"} no enrolled face at all, so every one of their punches is by hand.`);
  }

  const worstHour = [...r.gate.byHour].filter((h) => h.scans >= 10).sort((a, b) => b.failures / b.scans - a.failures / a.scans)[0];
  if (worstHour && worstHour.failures / worstHour.scans >= rate * 1.5 && worstHour.failures >= 3) {
    out.push(
      `Failures cluster at ${String(worstHour.hour).padStart(2, "0")}:00 (${pct(worstHour.failures / worstHour.scans)} against ${pct(rate)} overall) — ` +
        "an hour that stands out this far is usually the light at the camera, not the faces in front of it.",
    );
  }

  const thin = r.margins.bands.find((b) => b.label.includes("thin"))?.n ?? 0;
  if (r.margins.scored > 0 && thin / r.margins.scored >= 0.25) {
    out.push(
      `${pct(thin / r.margins.scored)} of successful matches scraped in just above the ${MATCH_THRESHOLD.toFixed(2)} cutoff. ` +
        "Those are the ones that will start failing first if anything changes.",
    );
  }

  const big = r.clusters[0];
  if (big && big.members.length >= 3) {
    out.push(
      `${big.members.length} enrolments are mutually indistinguishable — each within 0.80 of the others, against a typical ` +
        `pair of ${r.separation.median.toFixed(3)}. A group that size is not resemblance. Every one of them will be refused at the ` +
        "gate whichever of them steps up to it, because the runner-up is always another member of the group.",
    );
    out.push(`Re-photograph all of them: ${big.members.join(", ")}.`);
  } else if (r.lookalikes.total) {
    const p = r.lookalikes.shown[0]!;
    out.push(
      `${r.lookalikes.total} pair(s) sit above 0.80 against a typical pair of ${r.separation.median.toFixed(3)}, closest ${p.a} ` +
        `and ${p.b} at ${p.similarity.toFixed(3)}. The gate refuses rather than guesses between them, so both read as failures ` +
        "until one is re-photographed.",
    );
  }

  const weak = r.enrolment.weak;
  if (weak.length) {
    const alsoConfusable = weak.filter((w) => w.confusableWith > 0).length;
    out.push(
      `${weak.length} enrolment photo(s) gave the model very little to work with — under ${r.enrolment.weakBelow} of 1024 ` +
        `dimensions against a typical ${r.enrolment.medianActiveDims}` +
        (alsoConfusable ? `, and ${alsoConfusable} of them are in the confusable group above` : "") +
        ". A sparse descriptor is not just a weaker match: sparse vectors resemble each OTHER, which is how they end up " +
        "grouped. This is visible the day the photo is taken, so it is worth checking at enrolment rather than after a " +
        "month of punching by hand.",
    );
  }

  if (r.canteen.plates > 0 && (r.canteen.rate ?? 0) >= 0.2) {
    out.push(`Canteen: ${pct(r.canteen.rate!)} of plates went out on a name tapped by hand.`);
  }
  return out;
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

/** The report as text, for the console and the nightly log. */
export function formatFaceHealth(r: FaceHealth): string {
  const L: string[] = [];
  const bar = (n: number, of: number, w = 24) => "█".repeat(Math.round((of ? n / of : 0) * w)).padEnd(w, "·");

  L.push(`Face recognition — last ${r.days} days${r.from ? ` (${r.from} to ${r.to})` : ""}`);
  L.push("=".repeat(72));

  if (r.gate.scans === 0) {
    L.push("No gate scans in this window.");
  } else {
    L.push(`Gate:    ${r.gate.scans} scans, ${r.gate.failures} needed a name by hand = ${pct(r.gate.rate!)} failure rate`);
    if (r.gate.hrResolved) L.push(`         (${r.gate.hrResolved} HR punch-out fixes excluded — not a face failing)`);
    if (r.canteen.plates) L.push(`Canteen: ${r.canteen.plates} plates, ${r.canteen.nameMatched} by name = ${pct(r.canteen.rate!)}`);
    if (r.centred?.recorded) {
      const line = (label: string, b: CentredBand) =>
        b.n
          ? `  ${label}: centred's first choice was the recorded person in ${b.agree} of ${b.n} (${pct(b.agree / b.n)}); median score ${b.medianScore?.toFixed(2) ?? "—"}, lead ${b.medianGap?.toFixed(2) ?? "—"}`
          : `  ${label}: none yet`;
      L.push("");
      L.push(`Centred matching — recording only, not deciding: ${r.centred.recorded} face(s) scored both ways`);
      L.push(line("Recognised by the gate or canteen", r.centred.scanned));
      L.push(line("Picked by hand after the scan failed", r.centred.byHand));
    }

    L.push("");
    L.push("By day");
    for (const d of r.gate.byDay) {
      L.push(`  ${d.day}  ${String(d.scans).padStart(4)} scans  ${bar(d.failures, d.scans)} ${String(d.failures).padStart(3)} by hand`);
    }

    const hours = r.gate.byHour.filter((h) => h.scans > 0);
    if (hours.length) {
      L.push("");
      L.push("By hour");
      for (const h of hours) {
        L.push(`  ${String(h.hour).padStart(2, "0")}:00  ${String(h.scans).padStart(4)} scans  ${bar(h.failures, h.scans)} ${String(h.failures).padStart(3)} by hand`);
      }
    }
  }

  if (r.strugglers.length) {
    L.push("");
    L.push("Who the camera does not know");
    L.push(`  ${"name".padEnd(28)}${"by hand".padStart(9)}${"scans".padStart(7)}${"rate".padStart(8)}${"faces".padStart(7)}  enrolled`);
    for (const s of r.strugglers) {
      L.push(
        `  ${s.name.slice(0, 27).padEnd(28)}${String(s.failures).padStart(9)}${String(s.scans).padStart(7)}` +
          `${pct(s.rate).padStart(8)}${String(s.descriptors).padStart(7)}  ${s.enrolledOn ?? "—"}`,
      );
    }
  }

  if (r.margins.scored) {
    L.push("");
    L.push(`How much room the ${r.margins.scored} successful matches had`);
    for (const b of r.margins.bands) {
      L.push(`  ${b.label.padEnd(22)} ${bar(b.n, r.margins.scored)} ${String(b.n).padStart(5)}`);
    }
  }

  L.push("");
  L.push("Galleries");
  L.push(`  ${r.gallery.active} active workers: ${r.gallery.noFace} with no face, ${r.gallery.enrolmentOnly} on their enrolment photo alone, ${r.gallery.taught} with taught captures (${r.gallery.captures} stored)`);

  if (r.separation.pairs) {
    L.push("");
    L.push("How far apart the enrolled faces are");
    L.push(
      `  ${r.separation.pairs} pairs: typical ${r.separation.median.toFixed(3)}, ` +
        `9 in 10 below ${r.separation.p90.toFixed(3)}, 99 in 100 below ${r.separation.p99.toFixed(3)}, closest ${r.separation.max.toFixed(3)}`,
    );
    L.push(`  with the average face taken away: typical ${r.separation.centredMedian.toFixed(3)}, 99 in 100 below ${r.separation.centredP99.toFixed(3)}`);
    const t = r.separation.byPayType;
    const f3 = (n: number | null) => (n == null ? "—" : n.toFixed(3));
    L.push(`  typical pair — salaried ${f3(t.salaried)}, daily wage ${f3(t.dailyWage)}, one of each ${f3(t.across)}`);
    if (t.salaried != null && t.dailyWage != null && Math.abs(t.salaried - t.dailyWage) >= 0.15) {
      L.push("    the two groups differ by 0.15 or more: they were enrolled by routes of different quality");
    }
    if (r.separation.skippedVectors) L.push(`  ${r.separation.skippedVectors} enrolment vector(s) left out: not ${FACE_DIM} finite numbers`);
    L.push(`  ${pct(r.separation.overThreshold)} of pairs sit above the ${MATCH_THRESHOLD.toFixed(2)} cutoff, so the margin rule is what keeps them apart, not the cutoff`);
  }

  if (r.enrolment.people) {
    L.push("");
    L.push("How much the model found in each enrolment photo");
    L.push(`  typical photo lights up ${r.enrolment.medianActiveDims} of 1024 dimensions; anything under ${r.enrolment.weakBelow} is thin`);
    if (r.enrolment.weak.length) {
      L.push(`  ${r.enrolment.weak.length} below that line:`);
      L.push(`    ${"name".padEnd(28)}${"dims".padStart(6)}${"confusable with".padStart(17)}`);
      for (const w of r.enrolment.weak) {
        L.push(`    ${w.name.slice(0, 27).padEnd(28)}${String(w.activeDims).padStart(6)}${String(w.confusableWith).padStart(17)}`);
      }
    } else {
      L.push("  none below that line");
    }
  }

  if (r.clusters.length) {
    L.push("");
    L.push(`Too close to tell apart — ${r.clusters.length} group(s), ${r.lookalikes.total} pair(s) in all`);
    for (const c of r.clusters) {
      L.push(`  ${c.members.length} people, closest pair ${c.tightest.toFixed(3)}:`);
      L.push(`    ${c.members.join(", ")}`);
    }
  }

  if (r.misfiled.total) {
    L.push("");
    L.push(`Learned under the wrong name — ${r.misfiled.total} capture(s) in 60 days scoring under ${TEACH_OWN_FLOOR.toFixed(2)} against their owner's enrolment`);
    L.push(`    ${"filed under".padEnd(26)}${"own".padStart(6)}  ${"looks like".padEnd(26)}${"score".padStart(6)}  how      day`);
    for (const m of r.misfiled.shown) {
      L.push(`    ${m.filedUnder.slice(0, 25).padEnd(26)}${m.ownScore.toFixed(2).padStart(6)}  ${(m.looksLike ?? "nobody in particular").slice(0, 25).padEnd(26)}${m.otherScore.toFixed(2).padStart(6)}  ${m.method.padEnd(8)} ${m.day}`);
    }
    L.push("  Each one drags that person's gallery toward someone else. They age out in 60 days; clear them sooner by setting face_embedding to NULL on those punches.");
  }

  const advice = r.advice.length ? r.advice : adviseOn(r);
  if (advice.length) {
    L.push("");
    L.push("What this says to do");
    for (const a of advice) L.push(`  - ${a}`);
  }
  return L.join("\n");
}
