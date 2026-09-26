/**
 * The roster's mean face, for centred matching (docs/face-matching-centred-plan.md).
 *
 * A FaceRes embedding is dominated by what every face shares — the model's
 * idea of a face, this camera, this light — and cosine counts that shared
 * bulk as agreement, which is why two strangers at this gate score 64%.
 * Subtracting the population's average first leaves what differs between
 * people. The average is taken here, once, and handed to every gate: two
 * clients computing it from their own slices of the roster would score the
 * same face differently.
 *
 * Enrolment descriptors only, never taught captures: the mean is of the
 * people, not of how often each of them happens to walk past the camera.
 * Rebuilt once a day by the face job (services/face-prune.ts); the mean of
 * 190 faces barely moves for one new joiner.
 */
import { desc, eq, isNotNull, and } from "drizzle-orm";
import { employees, faceModels } from "@shared/schema";
import { FACE_DIM } from "@shared/face";
import type { Tx } from "../db";
import { db } from "../db";
import { isUsableEmbedding } from "./face-gallery";

type Conn = Tx | typeof db;

export interface FaceModel {
  id: string;
  mean: number[];
  people: number;
  builtAt: Date;
}

/** The newest build, or null before the first one. */
export async function latestFaceModel(conn: Conn): Promise<FaceModel | null> {
  const [row] = await conn
    .select({ id: faceModels.id, mean: faceModels.mean, people: faceModels.people, builtAt: faceModels.builtAt })
    .from(faceModels)
    .orderBy(desc(faceModels.builtAt))
    .limit(1);
  return row ?? null;
}

/** Take the mean of every usable enrolment and store it. Null with fewer than two faces. */
export async function buildFaceModel(conn: Conn): Promise<FaceModel | null> {
  const rows = await conn
    .select({ vec: employees.faceDescriptor })
    .from(employees)
    .where(and(eq(employees.isActive, true), isNotNull(employees.faceDescriptor)));
  const faces = rows.map((r) => r.vec).filter((v): v is number[] => isUsableEmbedding(v));
  if (faces.length < 2) return null;
  const mean = new Array<number>(FACE_DIM).fill(0);
  for (const v of faces) for (let k = 0; k < FACE_DIM; k++) mean[k]! += v[k]! / faces.length;
  const [row] = await conn
    .insert(faceModels)
    .values({ mean, dim: FACE_DIM, people: faces.length })
    .returning({ id: faceModels.id, mean: faceModels.mean, people: faceModels.people, builtAt: faceModels.builtAt });
  return row!;
}

/**
 * The model to use, building one when there is none or the newest is older
 * than a day. A restart inside the day reuses the build it already has, so
 * deploying six times does not write six means.
 */
export async function ensureFaceModel(conn: Conn, maxAgeHours = 20): Promise<{ model: FaceModel | null; built: boolean }> {
  const latest = await latestFaceModel(conn);
  if (latest && Date.now() - latest.builtAt.getTime() < maxAgeHours * 3_600_000) return { model: latest, built: false };
  const model = await buildFaceModel(conn);
  return { model: model ?? latest, built: !!model };
}

/**
 * What a gate recorded centred matching made of a face, checked before it is
 * stored: an id that names no model or no employee would fail the insert and
 * take the punch down with it, and a punch is never refused for a diagnostic.
 */
export async function acceptCentred(
  conn: Conn,
  c: { modelId: string; matchId: string | null; score: number; secondScore: number } | null | undefined,
): Promise<{ faceModelId: string | null; centredMatchId: string | null; matchScoreCentred: number | null; centredSecondScore: number | null }> {
  const none = { faceModelId: null, centredMatchId: null, matchScoreCentred: null, centredSecondScore: null };
  if (!c) return none;
  const [model] = await conn.select({ id: faceModels.id }).from(faceModels).where(eq(faceModels.id, c.modelId));
  if (!model) return none;
  const [emp] = c.matchId
    ? await conn.select({ id: employees.id }).from(employees).where(eq(employees.id, c.matchId))
    : [undefined];
  return { faceModelId: model.id, centredMatchId: emp?.id ?? null, matchScoreCentred: c.score, centredSecondScore: c.secondScore };
}
