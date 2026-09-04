/**
 * How often face recognition actually fails, out of data already stored.
 *
 * Nothing records a failed scan, so the only signal anyone has ever had is a
 * guard mentioning that the camera did not know someone. But the answer is
 * already in the punch rows: a guard picks a name off the list ONLY when the
 * face failed, so `method = 'manual'` IS the failure rate — per person, per
 * hour, per day — and it has never been read.
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

/**
 * The gate auto-accepts at this score, and only with a clear margin over the
 * runner-up. Kept in step with DEFAULT_MATCH_THRESHOLD / MIN_MATCH_MARGIN in
 * client/src/lib/face.ts, which is where the decision is actually made.
 */
export const MATCH_THRESHOLD = 0.6;
export const MATCH_MARGIN = 0.05;

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
  /** Pairs whose enrolment photos are close enough for the gate to confuse. */
  lookalikes: Array<{ a: string; b: string; similarity: number }>;
  advice: string[];
}

export async function buildFaceHealth(conn: Conn, days = 30): Promise<FaceHealth> {
  const window = sql`p.punch_date >= (now() AT TIME ZONE 'Asia/Kolkata')::date - ${days}::int`;

  /* ── The gate, day by day ───────────────────────────────────────────── */
  const byDay = (
    await conn.execute(sql`
      SELECT p.punch_date::text AS day,
             count(*)::int AS scans,
             count(*) FILTER (WHERE p.method = 'manual')::int AS failures
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
             count(*) FILTER (WHERE p.method = 'manual')::int AS failures
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
             count(*) FILTER (WHERE p.method = 'manual')::int AS failures,
             (SELECT count(DISTINCT c.punch_date)::int FROM punches c
               WHERE c.employee_id = e.id AND c.face_embedding IS NOT NULL) AS taught,
             (e.face_descriptor IS NOT NULL) AS enrolled,
             to_char(e.face_enrolled_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS "enrolledOn"
        FROM punches p
        JOIN employees e ON e.id = p.employee_id
       WHERE ${window} AND NOT ${HR_RESOLVED}
       GROUP BY e.id, e.name, e.emp_code, e.face_descriptor, e.face_enrolled_at
      HAVING count(*) FILTER (WHERE p.method = 'manual') > 0
       ORDER BY count(*) FILTER (WHERE p.method = 'manual') DESC, count(*) DESC
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
    lookalikes: await lookalikePairs(conn),
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
async function lookalikePairs(conn: Conn): Promise<Array<{ a: string; b: string; similarity: number }>> {
  const rows = (
    await conn.execute(sql`
      SELECT name, face_descriptor AS d FROM employees
       WHERE is_active AND face_descriptor IS NOT NULL
    `)
  ).rows as Array<{ name: string; d: number[] }>;

  // Normalise once, then every comparison is a dot product rather than a dot
  // and two square roots — at 180 people this is 16,000 pairs.
  const unit = rows.map((r) => {
    const n = Math.hypot(...r.d) || 1;
    return { name: r.name, v: r.d.map((x) => x / n) };
  });

  const out: Array<{ a: string; b: string; similarity: number }> = [];
  for (let i = 0; i < unit.length; i++) {
    for (let j = i + 1; j < unit.length; j++) {
      let dot = 0;
      const a = unit[i]!.v, b = unit[j]!.v;
      for (let k = 0; k < a.length; k++) dot += a[k]! * b[k]!;
      // Close enough that whichever of them is scanned, the other is within
      // the margin and the gate refuses rather than choosing.
      if (dot >= MATCH_THRESHOLD && dot >= 1 - MATCH_MARGIN * 4) {
        out.push({ a: unit[i]!.name, b: unit[j]!.name, similarity: dot });
      }
    }
  }
  return out.sort((x, y) => y.similarity - x.similarity).slice(0, 15);
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

  if (r.lookalikes.length) {
    const p = r.lookalikes[0]!;
    out.push(
      `${r.lookalikes.length} pair(s) sit close enough to be confusable, closest ${p.a} and ${p.b} at ${p.similarity.toFixed(3)}. ` +
        "The gate refuses rather than guesses between them, so both will read as failures until one is re-photographed.",
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

  if (r.lookalikes.length) {
    L.push("");
    L.push("Close enough to be confusable");
    for (const p of r.lookalikes) L.push(`  ${p.similarity.toFixed(3)}  ${p.a}  /  ${p.b}`);
  }

  const advice = r.advice.length ? r.advice : adviseOn(r);
  if (advice.length) {
    L.push("");
    L.push("What this says to do");
    for (const a of advice) L.push(`  - ${a}`);
  }
  return L.join("\n");
}
