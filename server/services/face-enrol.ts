/**
 * Enrolled faces made again from their photos, by the server's own engine.
 *
 * When the face model changes, every stored vector stops meaning anything:
 * migration 0138 cleared the FaceRes ones when SFace took over. Nobody has to
 * re-photograph anyone for that — the enrolment photo is still on the row. A
 * worker who was enrolled (`face_enrolled_at` set) but has no usable vector is
 * enrolled again from `photo_url`.
 *
 * `face_enrolled_at` is the line between "lost their vector" and "never had
 * one, or had it removed": DELETE /employees/:id/face clears both, so a face
 * taken off deliberately is not put back by this.
 *
 * Runs at boot and on the hourly face tick (face-prune.ts). After the first
 * pass it finds nothing, unless a photo has no face in it; those are tried
 * once per process, not every hour.
 */
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { FACE_DIM } from "@shared/face";
import { employees } from "@shared/schema";
import type { Db, Tx } from "../db";
import { faceVector } from "./face-engine";
import { roundEmbedding } from "./face-gallery";

type Conn = Db | Tx;

/** Photos that held no face, so the hourly pass does not read them again. */
const noFace = new Set<string>();

export async function enrolFromPhotos(conn: Conn): Promise<{ enrolled: number; noFace: number }> {
  const due = await conn
    .select({ id: employees.id, hash: employees.photoHash })
    .from(employees)
    .where(
      and(
        isNotNull(employees.faceEnrolledAt),
        isNotNull(employees.photoUrl),
        sql`(${employees.faceDescriptor} IS NULL OR jsonb_array_length(${employees.faceDescriptor}) <> ${FACE_DIM})`,
      ),
    );
  let enrolled = 0;
  let missed = 0;
  for (const d of due) {
    const key = `${d.id}:${d.hash ?? ""}`;
    if (noFace.has(key)) continue;
    // One photo at a time: these are the heaviest column in the table.
    const [row] = await conn.select({ photo: employees.photoUrl }).from(employees).where(eq(employees.id, d.id));
    const f = row?.photo ? await faceVector(row.photo) : null;
    if (!f) {
      noFace.add(key);
      missed++;
      continue;
    }
    // updated_at drives the devices' delta pull, and every write bumps it.
    await conn
      .update(employees)
      .set({ faceDescriptor: roundEmbedding(f.vector), updatedAt: new Date() })
      .where(eq(employees.id, d.id));
    enrolled++;
  }
  return { enrolled, noFace: missed };
}
