/**
 * Matching a face against the roster, with the roster's arithmetic done once.
 *
 * The gate scored a scan by taking the cosine against every descriptor of
 * every person, and a cosine recomputes both vectors' lengths each time — so
 * every scan re-measured a few hundred roster vectors that had not changed
 * since the last one. An index holds each of them already scaled to unit
 * length; a scan is then scaled once, and a score is a plain dot product.
 *
 * Plain arrays, not a packed Float32Array: reading a Float32 element widens it
 * to a double on every access, and Amino measured the typed array slower than
 * this (1.3× against 1.5× over the unindexed matcher). Scores agree with the
 * plain cosine to 1e-12.
 *
 * No DOM and no camera in here, so the Canteen Gate shares it and a script can
 * prove it agrees with the matcher it replaces.
 */
import { FACE_DIM } from "./face";

export interface MatchCandidate {
  id: string;
  /** Enrolment descriptor plus taught captures: a person scores on their BEST one. */
  descriptors: number[][];
}

export interface MatchResult {
  /** id of the best candidate, or null if none */
  id: string | null;
  /** similarity 0..1 of the best candidate */
  score: number;
  /** similarity of the runner-up PERSON — what the margin rule is judged on */
  secondScore: number;
  /** Who the runner-up was, so a refusal can name both faces it could not choose between. */
  secondId: string | null;
}

export interface MatchIndex {
  /** One entry per person with at least one usable descriptor. */
  people: { id: string; units: number[][] }[];
  /** Descriptors left out because they were not FACE_DIM finite numbers. */
  skipped: number;
}

function unit(v: number[]): number[] | null {
  // The length is fixed, never taken from the first vector seen: Amino's index
  // did that, and one malformed descriptor at the head of the roster made every
  // good one after it "the wrong size".
  if (v.length !== FACE_DIM) return null;
  let n = 0;
  for (let i = 0; i < FACE_DIM; i++) {
    const x = v[i]!;
    if (!Number.isFinite(x)) return null;
    n += x * x;
  }
  if (n === 0) return null;
  const inv = 1 / Math.sqrt(n);
  const out = new Array<number>(FACE_DIM);
  for (let i = 0; i < FACE_DIM; i++) out[i] = v[i]! * inv;
  return out;
}

export function buildMatchIndex(candidates: MatchCandidate[]): MatchIndex {
  let skipped = 0;
  const people: MatchIndex["people"] = [];
  for (const c of candidates) {
    const units: number[][] = [];
    for (const d of c.descriptors) {
      const u = unit(d);
      if (u) units.push(u);
      else skipped++;
    }
    if (units.length) people.push({ id: c.id, units });
  }
  return { people, skipped };
}

/** Best person for an embedding; `secondScore` is the best DIFFERENT person. */
export function findBestMatchIndexed(embedding: number[], index: MatchIndex): MatchResult {
  const probe = unit(embedding);
  if (!probe) return { id: null, score: 0, secondScore: 0, secondId: null };
  let best: string | null = null;
  let bestScore = -1;
  let second: string | null = null;
  let secondScore = -1;
  for (const p of index.people) {
    let s = -1;
    for (const u of p.units) {
      let dot = 0;
      for (let i = 0; i < FACE_DIM; i++) dot += probe[i]! * u[i]!;
      if (dot > s) s = dot;
    }
    if (s > bestScore) {
      secondScore = bestScore;
      second = best;
      bestScore = s;
      best = p.id;
    } else if (s > secondScore) {
      secondScore = s;
      second = p.id;
    }
  }
  return { id: best, score: Math.max(0, bestScore), secondScore: Math.max(0, secondScore), secondId: second };
}
