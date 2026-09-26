/**
 * The indexed matcher against the plain cosine it replaced: same person, same
 * score, same runner-up, over random rosters and probes.
 *
 * Run: npx tsx scripts/check-face-match.ts
 */
import { FACE_DIM } from "@shared/face";
import { buildMatchIndex, findBestMatchIndexed, type MatchCandidate } from "@shared/face-match";

let failures = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!cond) failures++;
};

// Deterministic, so a failure can be reproduced.
let seed = 20260917;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) - 0.5;
const vec = () => Array.from({ length: FACE_DIM }, rnd);

const cosine = (a: number[], b: number[]) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return dot / Math.sqrt(na * nb);
};
const naive = (e: number[], cs: MatchCandidate[]) => {
  let best: string | null = null, bestScore = -1, second = -1;
  for (const c of cs) {
    let s = -1;
    for (const d of c.descriptors) s = Math.max(s, cosine(e, d));
    if (s > bestScore) { second = bestScore; bestScore = s; best = c.id; } else if (s > second) second = s;
  }
  return { id: best, score: Math.max(0, bestScore), secondScore: Math.max(0, second) };
};

const roster: MatchCandidate[] = Array.from({ length: 60 }, (_, i) => ({ id: `p${i}`, descriptors: Array.from({ length: 1 + (i % 5) }, vec) }));
const index = buildMatchIndex(roster);

let agree = 0;
let worst = 0;
for (let i = 0; i < 200; i++) {
  // Half the probes are a roster face with noise, so there is a real match to find.
  const base = i % 2 ? roster[i % roster.length]!.descriptors[0]! : vec();
  const probe = base.map((x) => x + rnd() * 0.3);
  const a = naive(probe, roster);
  const b = findBestMatchIndexed(probe, index);
  worst = Math.max(worst, Math.abs(a.score - b.score), Math.abs(a.secondScore - b.secondScore));
  if (a.id === b.id) agree++;
}
console.log("");
ok("the same person over 200 probes", agree === 200, `${agree}/200`);
ok("the same score and runner-up", worst < 1e-12, `worst difference ${worst.toExponential(1)}`);

// Centred: the index takes the mean face off every vector and the probe. It
// must score exactly the cosine of the mean-subtracted vectors, which is what
// scripts/calibrate-face-matching.ts measures the centred thresholds with.
const shift = vec().map((x) => x * 3); // a shared bulk every face carries
const shifted: MatchCandidate[] = roster.map((c) => ({ id: c.id, descriptors: c.descriptors.map((d) => d.map((x, k) => x + shift[k]!)) }));
const mean = Array.from({ length: FACE_DIM }, (_, k) => {
  let s = 0, n = 0;
  for (const c of shifted) for (const d of c.descriptors) { s += d[k]!; n++; }
  return s / n;
});
const centredRoster: MatchCandidate[] = shifted.map((c) => ({ id: c.id, descriptors: c.descriptors.map((d) => d.map((x, k) => x - mean[k]!)) }));
const centred = buildMatchIndex(shifted, mean);
let cAgree = 0;
let cWorst = 0;
for (let i = 0; i < 200; i++) {
  const base = i % 2 ? shifted[i % shifted.length]!.descriptors[0]! : vec().map((x, k) => x + shift[k]!);
  const probe = base.map((x) => x + rnd() * 0.3);
  const a = naive(probe.map((x, k) => x - mean[k]!), centredRoster);
  const b = findBestMatchIndexed(probe, centred);
  cWorst = Math.max(cWorst, Math.abs(a.score - b.score), Math.abs(a.secondScore - b.secondScore));
  if (a.id === b.id) cAgree++;
}
ok("centred: the same person as cosine after subtracting the mean", cAgree === 200, `${cAgree}/200`);
ok("centred: the same score and runner-up", cWorst < 1e-12, `worst difference ${cWorst.toExponential(1)}`);
ok("centred: the index says it is centred", centred.mean === mean && index.mean === null);
ok("a mean of the wrong length builds a raw index, not a wrong one", buildMatchIndex(roster, Array(192).fill(0)).mean === null);

const broken = buildMatchIndex([{ id: "short", descriptors: [Array(192).fill(0.1)] }, ...roster]);
ok("a wrong-length descriptor at the head of the roster is skipped, alone", broken.skipped === 1 && broken.people.length === roster.length);
ok("an empty roster matches nobody", findBestMatchIndexed(vec(), buildMatchIndex([])).id === null);
ok("a wrong-length probe matches nobody", findBestMatchIndexed(Array(192).fill(0.1), index).id === null);

console.log(failures ? `\n  ${failures} failed\n` : "\n  all good\n");
process.exit(failures ? 1 : 0);
