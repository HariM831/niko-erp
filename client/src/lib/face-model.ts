/**
 * Centred matching, run beside the raw matcher and never deciding anything
 * (docs/face-matching-centred-plan.md, rollout step 2).
 *
 * Both browser gates fetch the roster's mean face, build a second index with
 * it taken off every vector, and score each face both ways. The raw score
 * still decides who is punched or served; what centred matching made of the
 * same face is sent along and stored, so the centred thresholds can be set
 * from this farm's own faces — failures included — before the switch exists.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { buildMatchIndex, findBestMatchIndexed, type MatchCandidate, type MatchIndex } from "@shared/face-match";
import { api } from "../api";

interface FaceModelPayload {
  id: string;
  mean: number[];
  people: number;
  builtAt: string;
}

export interface CentredIndex {
  modelId: string;
  index: MatchIndex;
}

/** What centred matching made of one face, in the shape the punch and plate routes store. */
export interface CentredResult {
  modelId: string;
  matchId: string | null;
  score: number;
  secondScore: number;
}

/**
 * A centred index over `candidates`, or null before the first mean face is
 * built — or when this user may not read it. `candidates` must be memoised by
 * the caller: a new array each render would rebuild the index each render.
 */
export function useCentredIndex(candidates: MatchCandidate[]): CentredIndex | null {
  const q = useQuery({
    queryKey: ["face-model"],
    queryFn: () => api<FaceModelPayload | null>("/api/payroll/face-model"),
    staleTime: 60 * 60_000,
    retry: false,
  });
  const model = q.data ?? null;
  return useMemo(() => {
    if (!model) return null;
    const index = buildMatchIndex(candidates, model.mean);
    // A mean the index would not take builds a raw index; recording raw scores
    // as centred ones would poison exactly the data this exists to collect.
    return index.mean ? { modelId: model.id, index } : null;
  }, [model, candidates]);
}

const r4 = (v: number) => Math.round(v * 10_000) / 10_000;

export function centredOf(embedding: number[] | null | undefined, c: CentredIndex | null): CentredResult | null {
  if (!embedding || !c) return null;
  const m = findBestMatchIndexed(embedding, c.index);
  if (!m.id) return null;
  return { modelId: c.modelId, matchId: m.id, score: r4(m.score), secondScore: r4(m.secondScore) };
}
