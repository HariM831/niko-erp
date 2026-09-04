/**
 * The faces the gate matches against.
 *
 * Enrolment gives a worker one photo, taken once, usually in whatever light
 * the office had that morning. Every scan for the rest of their employment is
 * compared against it, so a bad enrolment is a bad match forever — and the
 * worker cannot fix it, because the thing that would fix it (a good capture at
 * the gate) was computed, used, and thrown away.
 *
 * So each scan's embedding is kept on its punch, and a person's gallery is
 * their enrolment descriptor plus the recent ones. A face matches on its BEST
 * descriptor, so more of them can only help — the risk is not a weaker match,
 * it is a capture filed under the wrong person, which is why every capture
 * stays traceable to the punch and the method that produced it.
 *
 * Two rules make the gallery survive real life:
 *
 *  - The window counts DAYS THAT HAVE A CAPTURE, not calendar days. A
 *    calendar window empties itself over leave, a weekly off or a quiet week
 *    at the gate, and leaves the worker back on their enrolment photo alone —
 *    which is the state they could not recover from in the first place.
 *  - One capture per day, picked in SQL. A busy morning is six near-identical
 *    vectors and there is no reason to carry six of them.
 *
 * The read and the prune are driven by the same two constants below, so what
 * is served and what is stored cannot drift apart and leave the gate matching
 * against vectors that are about to be deleted.
 */
import { isNotNull, sql } from "drizzle-orm";
import type { Db, Tx } from "../db";
import { punches } from "@shared/schema";

type Conn = Db | Tx;

/** Days WITH a capture, not calendar days — see the note above. */
export const GALLERY_DAYS = 5;

/**
 * However few captures a worker has, nothing older than this is served. A
 * face drifts, and a two-year-old vector that still matches is as likely to be
 * matching the wrong person as the right one.
 */
export const GALLERY_MAX_AGE_DAYS = 60;

/**
 * 4 dp, the same rounding the device pull has always applied. Measured over
 * 7,140 real descriptor pairs it moves a similarity score by at most 0.00001,
 * and it is two and a half times fewer bytes — which is what makes carrying
 * several descriptors per person affordable at all.
 */
export function roundEmbedding(e: number[]): number[] {
  return e.map((n) => Math.round(n * 10_000) / 10_000);
}

/** Only a real vector teaches. A short or empty one is a bug upstream. */
export function isUsableEmbedding(v: unknown): v is number[] {
  return Array.isArray(v) && v.length > 0 && v.every((n) => typeof n === "number" && Number.isFinite(n));
}

export interface TaughtCapture {
  employeeId: string;
  embedding: number[];
}

/**
 * One capture per day, for each employee's newest GALLERY_DAYS days that have
 * one, nothing older than GALLERY_MAX_AGE_DAYS.
 *
 * The per-day pick and the per-employee limit both happen in SQL. Fetching
 * every capture and thinning them in JS means reading a morning's six
 * near-identical vectors to serve one of them, and these are the heaviest rows
 * in the payload.
 */
export async function taughtCaptures(conn: Conn, employeeIds?: string[]): Promise<TaughtCapture[]> {
  const rows = await conn.execute(sql`
    WITH per_day AS (
      SELECT DISTINCT ON (employee_id, punch_date)
             employee_id, punch_date, face_embedding
        FROM punches
       WHERE face_embedding IS NOT NULL
         AND punch_date >= (now() AT TIME ZONE 'Asia/Kolkata')::date - ${GALLERY_MAX_AGE_DAYS}::int
         ${employeeIds?.length ? sql`AND employee_id = ANY(${employeeIds}::uuid[])` : sql``}
       -- Within a day, the latest scan: the gate is busiest at the start of a
       -- shift and the light only improves from there.
       ORDER BY employee_id, punch_date, punched_at DESC
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
  return (rows.rows as Array<{ employee_id: string; face_embedding: number[] }>).map((r) => ({
    employeeId: r.employee_id,
    embedding: r.face_embedding,
  }));
}

/** Captures keyed by employee, ready to append to their enrolment descriptor. */
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
 * Clear the vectors the roster no longer serves.
 *
 * Keyed on exactly what `taughtCaptures` returns, so the stored set and the
 * served set are the same set by construction. The punch rows themselves are
 * untouched: they are the attendance record, and only the vector ages out.
 */
export async function pruneTaughtCaptures(conn: Conn): Promise<number> {
  const res = await conn.execute(sql`
    WITH per_day AS (
      SELECT DISTINCT ON (employee_id, punch_date)
             id, employee_id, punch_date
        FROM punches
       WHERE face_embedding IS NOT NULL
         AND punch_date >= (now() AT TIME ZONE 'Asia/Kolkata')::date - ${GALLERY_MAX_AGE_DAYS}::int
       ORDER BY employee_id, punch_date, punched_at DESC
    ),
    keep AS (
      SELECT id FROM (
        SELECT id, row_number() OVER (PARTITION BY employee_id ORDER BY punch_date DESC) AS rn
          FROM per_day
      ) r WHERE rn <= ${GALLERY_DAYS}
    )
    UPDATE punches
       SET face_embedding = NULL
     WHERE face_embedding IS NOT NULL
       AND id NOT IN (SELECT id FROM keep)
  `);
  return res.rowCount ?? 0;
}

/** How many captures are being stored, for the prune to report against. */
export async function taughtCaptureCount(conn: Conn): Promise<number> {
  const [row] = await conn
    .select({ n: sql<number>`count(*)::int` })
    .from(punches)
    .where(isNotNull(punches.faceEmbedding));
  return row?.n ?? 0;
}
