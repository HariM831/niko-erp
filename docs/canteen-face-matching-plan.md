# Canteen face matching — the plan

1 Oct 2026. Over the fourteen days to 1 Oct the canteen needed a name picked
by hand for 46% of plates (57–68% at breakfast and dinner, 30% at noon); the
attendance gate, with the same engine, thresholds and people, for 4%.

Why: every face a worker is matched against comes from the gate camera —
their enrolment photo plus one "taught" capture a day from their gate punches
(`face-gallery.ts`: newest 5 capture-days, nothing older than 60). The
canteen never adds its own, so a face in the canteen's light is always judged
against how it looked at the gate; even successful canteen matches score lower
(0.77 v 0.80) with a thinner lead over the runner-up (0.15 v 0.20). The
canteen also scans a single frame, and a failed scan leaves nothing behind —
no photo, no score, no closest name — so it can neither be diagnosed nor
learnt from.

Three changes, agreed to be planned on 1 Oct 2026. Nothing changes at the
attendance gate.

## 1. The canteen teaches its own gallery

- `canteen_servings` gains `face_embedding` (jsonb), filled whenever the scan
  found a face — for a face-matched plate and for a name picked after a scan.
  A name picked with no face found (camera off, nobody in frame) teaches
  nothing, exactly as at the gate.
- **A guard the gate does not have.** A name picked in a meal queue can be the
  wrong person, and a wrong capture then matches that face to the wrong
  worker. A hand-picked capture teaches only when the picked person is among
  the scan's **five closest faces**; otherwise the plate is served and
  recorded, and the capture is kept for the record but not taught.
- `canteenCaptures()`: the same rule as the gate's gallery — one capture a
  day (the day's latest), the newest 5 capture-days, nothing older than 60
  days — and the same prune.
- **Served to the canteen only.** The canteen roster becomes enrolment + the
  gate's taught captures + the canteen's own. The gate keeps matching on what
  it matches on today, so a canteen mistake can never reach attendance.
- The roster grows (up to ~11 vectors a person, ~7 KB each), so the canteen
  tablet pulls it incrementally, as the gate's gallery does (`?since=`), and
  keeps it, instead of fetching the whole roster every five minutes.

## 2. Every scan leaves a record

- On each served plate, alongside what is already kept: the scan's best
  score, its closest and second-closest people, how many frames were tried,
  and — for a hand-picked plate only — a small photo (~30 KB, as the gate
  keeps), deleted after 60 days.
- A scan that failed and was then abandoned (nobody served) is not stored.
- The face report the server already writes for the gate (`face-health.ts`,
  "Gate: n scans, n needed a name by hand…") gets a canteen section: the
  hand-pick rate by meal and hour, the people who fail most (their
  enrolment photo is the likely cause), and how often a hand-pick was the
  scan's own first choice.
- Canteen › Servings shows the score and the closest name on a hand-picked
  plate, and its photo, so HR can see what the camera saw.

## 3. A short burst instead of one frame

- Scan takes up to **three frames about 300 ms apart** and stops at the first
  that passes (score ≥ 0.60 and lead ≥ 0.05 — the gate's rule, unchanged).
  If none passes, the best of the three is what the record and the closest
  name come from.
- The worst case is about 1–2 seconds on the tablet; a face that matches on
  the first frame is as quick as today.
- The spoof check stays per frame.

## Order and checking

1. The schema change (0113: the new columns on `canteen_servings`).
2. Records first (2), so the change can be measured from day one.
3. The burst (3).
4. Teaching (1), with the incremental roster.

Each step is checked on staging with its own fixtures, then deployed. Success
is the canteen's hand-pick rate, read from the new canteen section of the face
report, after a week. The goal is under 10%.
