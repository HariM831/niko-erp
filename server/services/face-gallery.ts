/**
 * The faces the gate matches against.
 *
 * A worker's gallery is the gate photo they first passed through on each of
 * their last 7 days at the gate — the first scan of the day that passed the
 * check below, read by SFace on the phone and kept on its punch. Their
 * enrolment photo is used only while they have none of those: a new joiner,
 * or someone back from more than two months away. Enrolment is one photo taken
 * once in whatever light the office had; the gate's own photos are this
 * camera, this light, this season's face. (Decided 24 Oct 2026,
 * docs/face-sface-plan.md.)
 *
 * The rules that make it survive real life:
 *
 *  - The window counts DAYS THAT HAVE A TAUGHT SCAN, not calendar days. A
 *    calendar window empties itself over leave or a weekly off and leaves the
 *    worker back on their enrolment photo alone.
 *  - Nothing older than GALLERY_MAX_AGE_DAYS: a face drifts.
 *  - One scan per day, the first that passed. A scan that failed the check
 *    (a stranger scored as well, or it did not look like its owner) is kept
 *    on its punch but teaches nobody, and the day's next scan is tried.
 *
 * Every scan's vector is kept, taught or not, and nothing prunes them: they
 * are a kilobyte a punch, and the history is worth more than the space.
 */
import { FACE_DIM, LOOKALIKE_THRESHOLD, MATCH_MARGIN, MATCH_THRESHOLD, TEACH_OWN_FLOOR } from "@shared/face";
import { sql } from "drizzle-orm";
import type { Db, Tx } from "../db";

type Conn = Db | Tx;

/** Days WITH a taught scan, not calendar days — see the note above. */
export const GALLERY_DAYS = 7;

/** However few days a worker has, nothing older than this is served. */
export const GALLERY_MAX_AGE_DAYS = 60;

/**
 * 4 dp, the same rounding the device pull has always applied. Measured over
 * 7,140 real descriptor pairs it moves a similarity score by at most 0.00001,
 * and it is two and a half times fewer bytes.
 */
export function roundEmbedding(e: number[]): number[] {
  return e.map((n) => Math.round(n * 10_000) / 10_000);
}

/**
 * Only a real vector counts: FACE_DIM finite numbers. One of another length
 * (a FaceRes vector from a phone still on the old page) scores zero against
 * every real face, so it is not kept as one.
 */
export function isUsableEmbedding(v: unknown): v is number[] {
  return Array.isArray(v) && v.length === FACE_DIM && v.every((n) => typeof n === "number" && Number.isFinite(n));
}

export interface TaughtCapture {
  employeeId: string;
  embedding: number[];
}

/**
 * The first taught scan of each of a worker's newest GALLERY_DAYS days that
 * have one, nothing older than GALLERY_MAX_AGE_DAYS. Picked in SQL: these are
 * the heaviest values the roster carries.
 */
export async function taughtCaptures(conn: Conn, employeeIds?: string[]): Promise<TaughtCapture[]> {
  const rows = await conn.execute(sql`
    WITH per_day AS (
      SELECT DISTINCT ON (employee_id, punch_date)
             employee_id, punch_date, face_embedding
        FROM punches
       WHERE face_taught
         AND face_embedding IS NOT NULL
         AND punch_date >= (now() AT TIME ZONE 'Asia/Kolkata')::date - ${GALLERY_MAX_AGE_DAYS}::int
         ${
           // The codebase's idiom for a list parameter: drizzle expands a JS
           // array into a record, not a Postgres array, so `= ANY($1)` fails
           // with "cannot cast type record to uuid[]".
           employeeIds?.length
             ? sql`AND employee_id IN (${sql.join(employeeIds.map((id) => sql`${id}::uuid`), sql`, `)})`
             : sql``
         }
       -- Within a day, the first scan that passed.
       ORDER BY employee_id, punch_date, punched_at ASC
    ),
    ranked AS (
      SELECT employee_id, face_embedding,
             row_number() OVER (PARTITION BY employee_id ORDER BY punch_date DESC) AS rn
        FROM per_day
    )
    SELECT employee_id, face_embedding
      FROM ranked
     WHERE rn <= ${GALLERY_DAYS}
  `);
  return (rows.rows as Array<{ employee_id: string; face_embedding: number[] }>)
    .filter((r) => isUsableEmbedding(r.face_embedding))
    .map((r) => ({ employeeId: r.employee_id, embedding: r.face_embedding }));
}

/** Taught scans keyed by employee. */
export async function taughtCapturesByEmployee(conn: Conn, employeeIds?: string[]): Promise<Map<string, number[][]>> {
  const out = new Map<string, number[][]>();
  for (const c of await taughtCaptures(conn, employeeIds)) {
    const list = out.get(c.employeeId) ?? [];
    list.push(c.embedding);
    out.set(c.employeeId, list);
  }
  return out;
}

/**
 * What a worker is matched against: their gate photos when they have any,
 * their enrolment photo only when they have none. Every reader — the gate,
 * the canteen, the guard below — goes through this, so they all agree.
 */
export function galleryOf(enrolment: unknown, taught: number[][] | undefined): number[][] {
  if (taught?.length) return taught;
  return isUsableEmbedding(enrolment) ? [roundEmbedding(enrolment)] : [];
}

/* ── Whose face is this? ───────────────────────────────────────────────── */

const cosine = (a: number[], b: number[]): number => {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
};

export interface CaptureVerdict {
  /** Best score against the gallery of the person the capture is filed under. */
  ownScore: number;
  /** Somebody else this face clearly is, if there is one: refuse the punch. */
  lookalike: { id: string; name: string; empCode: string; score: number } | null;
  /**
   * A stranger scores as a match would against this capture — over the gate's
   * threshold and clear of the owner by its margin — without reaching
   * lookalike. Not enough to refuse a punch; enough to learn nothing from it.
   */
  contested: boolean;
  /** Whether the capture may join that person's gallery. */
  teach: boolean;
}

/**
 * Judge a captured face against everybody's gallery before it is filed under
 * one person.
 *
 * Two ways a capture is wrong for the name beside it. It can be somebody else:
 * another person scores clearly above what chance produces (LOOKALIKE_THRESHOLD)
 * and clear of the picked person by the gate's margin — that refuses the punch.
 * A stranger merely over the gate's own threshold is contested: the punch
 * stands, but nothing is learned from it. Or it can be
 * nobody: a face that resembles no one strongly passes that test untouched, and
 * learned under the picked name it starts that person's gallery drifting toward
 * a stranger. So it must also look at least somewhat like its owner.
 *
 * A gallery is what galleryOf serves — exactly what the gate matches against,
 * so this agrees with what the guard just saw.
 */
export async function judgeCapture(
  conn: Conn,
  selectedId: string,
  embedding: number[],
): Promise<CaptureVerdict> {
  const people = await conn.execute(sql`
    SELECT id, name, emp_code, face_descriptor
      FROM employees
     WHERE is_active AND (face_descriptor IS NOT NULL OR id = ${selectedId}::uuid)
  `);
  const taught = await taughtCapturesByEmployee(conn);
  let ownScore = 0;
  let best: CaptureVerdict["lookalike"] = null;
  for (const p of people.rows as Array<{ id: string; name: string; emp_code: string; face_descriptor: number[] | null }>) {
    const gallery = galleryOf(p.face_descriptor, taught.get(p.id));
    let score = 0;
    for (const g of gallery) score = Math.max(score, cosine(embedding, g));
    if (p.id === selectedId) ownScore = score;
    else if (!best || score > best.score) best = { id: p.id, name: p.name, empCode: p.emp_code, score };
  }
  const contested = !!best && best.score >= MATCH_THRESHOLD && best.score - ownScore >= MATCH_MARGIN;
  const lookalike = contested && best!.score >= LOOKALIKE_THRESHOLD ? best : null;
  return { ownScore, lookalike, contested, teach: !contested && ownScore >= TEACH_OWN_FLOOR };
}
