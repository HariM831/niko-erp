# Centred face matching — the plan

The gate cannot reliably tell two workers apart. This is the plan to fix it,
written to be argued with before any of it is built. Nothing here is built yet.

## What is actually wrong

Measured on staging, 26 Sep 2026: 123 captures taken at the gate in the last
fortnight, scored against all 189 enrolled faces
(`scripts/diagnose-face-pairs.ts`).

| | own enrolment | closest stranger |
|---|---|---|
| p10 | 67% | 59% |
| median | **73%** | **64%** |
| p90 | 79% | 68% |
| extreme | 59% (worst own) | 74% (best stranger) |

The distributions overlap. The accept cutoff is 0.60 — **below the median
stranger** — so the gate is held together entirely by the margin rule (top must
beat runner-up by 0.05). That rule produces the two failures seen this week:

- **A wrong name.** Jiban Nath's enrolment scores 63–68% against five other
  people. Any of them can win on the day. He was punched in as Dhurba Nath.
- **A refusal with a good score.** Sandip De scored 73% — and Khanjan Nath,
  whose enrolment is 77% similar to his, scored within 5 points. Refused.
  Thandi Newar, 76%, the same story.

Across the roster, **1,935 enrolment pairs sit within a margin of each other**.

The cause is not the threshold. It is that a FaceRes embedding is dominated by
what all faces have in common — the model's notion of a face, this camera, this
light — and cosine counts that shared bulk as agreement.

## The proposal

Subtract the population's average face from every vector before comparing.
What is left is what differs between people. On the same 123 captures:

| | own | stranger | gap |
|---|---|---|---|
| now | 73% | 64% | 9 points |
| centred | 49% | 34% | **16 points** |

The best stranger falls from 74% to 50%; the right person wins 119 of 123.

This is a change of scale as well as of method, so **the thresholds must be
recalibrated with it** — 0.60 means nothing on the centred scale. It cannot be
shipped as a one-line change, because five things read those numbers.

## Who has to agree

| Reader | Where | What it does |
|---|---|---|
| The gate | `client/src/pages/payroll/gate.tsx` | matches a live face, decides the punch |
| The canteen gate | `client/src/pages/payroll/canteen-gate.tsx` | the same, for plates |
| The wrong-person guard | `server/services/face-gallery.ts` | refuses a capture filed under the wrong name, and decides what may teach |
| The health report | `server/services/face-health.ts` | judges separation, look-alikes, misfiled captures |
| Paired devices | `server/routes/device.ts` config | told the thresholds so they upload the right photos |

All five share `shared/face.ts` and `shared/face-match.ts` today, which is the
one thing that makes this tractable.

## The work, in order

### 1. The mean face, as data (server)

- A nightly job computes the mean of every enrolled descriptor and stores it
  with a version: `face_models (id, mean float8[], dim, built_at, people)`.
  One row per build, newest wins.
- Rebuilt when the roster changes materially (a nightly job is enough — the
  mean of 190 faces barely moves for one new joiner).
- Shipped in the gallery payload and in the device config, with its version.
  A client matches with the mean it was given; the server guard scores with the
  version the punch names, so a client on yesterday's mean is still judged by
  yesterday's numbers.

Why not compute it on each client: two clients holding different slices of the
gallery would compute different means and score the same face differently.

### 2. Centred matching, behind a switch (shared)

- `shared/face-match.ts` gains an optional mean: `buildMatchIndex(people, mean)`
  subtracts it from every descriptor and re-normalises; `findBestMatchIndexed`
  subtracts it from the probe. With no mean it behaves exactly as now.
- `shared/face.ts` grows a second pair of constants for the centred scale,
  and a `MATCH_MODE` the server decides and ships: `raw` or `centred`.
  The switch exists so the gate can be put back in one setting change, without
  a deploy, if the farm sees something the data did not.

### 3. Calibration, from the farm's own captures (script)

`scripts/calibrate-face-matching.ts`, read-only:

- Replays every stored capture against every enrolment, raw and centred.
- Sweeps threshold × margin and reports, for each point: auto-accepts,
  **wrong-person accepts**, refusals, and which people account for them.
- The operating point is chosen by rule, not by taste: **zero wrong-person
  accepts** on the recorded set, then the fewest refusals. That number goes
  into `shared/face.ts` with the date and sample size in the comment.

The honest limit: 123 captures is thin, and they are the ones that already
matched. The sweep must therefore also be run against the *manual* punches'
photographs once a fortnight of "keep every photo" has accumulated — those are
the failures, and they are the set that matters. **This is why the change waits
a fortnight rather than shipping on Monday.**

### 4. Rollout

1. Ship centred matching switched **off**. Nothing changes at the gate.
2. The gate computes both scores for a week and posts both with the punch
   (`match_score`, `match_score_centred`). One migration, one nullable column.
3. Compare in the health report: same decision, better decision, worse
   decision, per person and per hour.
4. Switch it on at the canteen first — a wrong plate costs a plate. Then the
   gate.
5. Keep the raw score recorded for a month afterwards, so the comparison
   survives the switch.

### 5. What this does not fix

Centring widens the gap; it does not invent identity that the enrolment
photograph never had. The 21 people the enrolment screen flags still need a new
photograph taken **on the gate's own camera**, and that remains the single
biggest win available. Two of them — W-0062 Niranjan Nath, whose face has never
matched in 73 tries, and AFPL-26-0144 Rajan Sahani, who has no face at all —
cannot be helped by any threshold.

## Cost and risk

- Roughly a day's work for steps 1–3, a fortnight of waiting for real failure
  data, then half a day for step 4.
- The risk of getting it wrong is a wrong name on somebody's attendance, which
  is why the rule is zero wrong-person accepts on the recorded set and why the
  canteen goes first.
- The migration is one nullable column and one small table. Nothing existing is
  rewritten; raw scores already recorded stay meaningful, on their own scale.

## Decisions wanted

1. **Wait a fortnight for failure data, or calibrate now on the 123 captures?**
   Recommended: wait. Calibrating on successes alone is how a gate gets tuned
   to be confidently wrong.
2. **Canteen first, or both at once?** Recommended: canteen first.
3. **Should a wrong-person accept ever be traded for fewer refusals?**
   Recommended: no. A refusal costs fifteen seconds; a wrong name costs a day's
   pay and the trust of the person it happened to.
