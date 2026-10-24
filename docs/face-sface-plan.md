# SFace replaces FaceRes

From 24 Oct 2026, faces are read on the phone by OpenCV's SFace, not by Human's
FaceRes. The gate, canteen and enrolment pages download the engine once (~53 MB:
the two models and the runtime, all from our own server) and keep it in the
phone's cache, then read and match every face on the phone. Only the punch
goes to the server, as before.

## Why

Tested on 23 Oct 2026 against the farm's own photos: a local copy of staging,
with 206 enrolment photos, about 9,000 gate photos and 190 workers. Every model
saw the same straightened face crop and one enrolment photo per worker.

| Model | Wrong name, per 100 scans | Dark hours | Licence |
|---|---|---|---|
| Human FaceRes (before) | 16.5 | 28 | yes |
| **SFace** | **1.3** | **0 of 275** | **Apache-2.0** |
| ArcFace R100 (ONNX zoo) | 1.1 | 0 | trained on non-commercial data |
| InsightFace buffalo_l | 0.9 | 0 | non-commercial unless bought |

- **The alternatives:** ArcFace and InsightFace are a little better, but 17–40×
  slower, and neither may be used here without a licence question. SFace is free,
  small (39 MB) and fast: about 8 ms a face on a desktop CPU.
- **Enrolment matters nearly as much as the model.** Four extra gate photos per
  worker, from different days, cut SFace's mistakes by about 40%.
- **Why FaceRes looks worse here than at the gate:** its live gate also matched
  against taught captures, while this test used the enrolment photo alone. The
  comparison between models is still fair.

## What changed

Decided with the owner on 24 Oct 2026, reworking the first version of this
change (which read faces on the server).

- **The engine runs on the phone.**
  - The arithmetic is in `shared/face-engine.ts`: YuNet finds the face and five
    points on it, the face is turned and scaled onto SFace's 112×112 template,
    SFace turns the crop into 128 numbers. Even the shrinking to YuNet's 640 px
    is done there, as cv2.resize does it, not by a canvas: the canvas alone moved
    a vector as far as 0.91 from the script's.
  - The phone runs it with onnxruntime-web (`client/src/lib/face-engine.ts`,
    one WebAssembly thread). Scripts on the server run the same code with
    onnxruntime-node (`scripts/lib/face-engine-node.ts`). On 30 farm gate photos
    the two gave the same vector (worst cosine 1.0000).
  - The models are pinned by revision and sha256. The server fetches them once
    into `.cache/face-models` (or `FACE_MODELS_DIR`) and serves them, with the
    runtime, from `/api/face-engine` (`server/routes/face-engine.ts`). The
    running server never loads a model, so its memory is unchanged.
  - On a laptop's browser a scan takes about 0.3 s, and the engine starts in
    under a second once cached. A phone will be slower; it has not been timed
    on the gate phone yet.
- **Nothing is thrown away.** Migration 0138 moves every FaceRes vector into
  `employees.face_descriptor_faceres`, `punches.face_embedding_faceres` and
  `canteen_servings.face_embedding_faceres`, as they were. They are never
  matched against again. From now on every scan's vector is kept on its punch
  or plate, and the hourly prune of vectors is gone (about 1 KB a scan).
- **What a worker is matched against** (`server/services/face-gallery.ts`):
  - the first gate scan of each of their last 7 days that have one, that passed
    the check (SFace agrees it is them, and no one else looks more like it). If
    a day's first scan failed the check, that day's next one is used;
  - the 7 are days with such a scan, not calendar days, and none older than
    60 days;
  - their enrolment photo only while they have none of those.
  `punches.face_taught` marks the scans that passed. The canteen matches against
  the same gallery; its own plates teach nobody.
- **Vector length:** `FACE_DIM` is 128, and the cutoffs in `shared/face.ts` are on
  SFace's scale.
- **The switch-over:** `scripts/sface-switch-over.ts`, once, after the migration.
  - Reads every enrolled worker's photo into an SFace enrolment vector, and
    lists anyone enrolled with no photo on file (they need photographing).
  - Reads every punch photo still on file. A scan is marked taught only when
    SFace, against everyone's enrolment vector, picks the punch's own worker
    and at least TEACH_OWN_FLOOR sure.
  - Reads every canteen plate photo still on file.
  - Dry run by default; `--apply` writes in one transaction. A second run
    changes nothing it already did.
- **Lost for now:** Human's photo-or-screen check. A guard holds the phone at
  the gate.
- **Android devices still send FaceRes vectors.** None is in use. Any that is will
  have its vectors ignored (wrong length), and its punches still record.

## Deploy

1. Staging's systemd unit needs `.cache` in `ReadWritePaths` (in
   `deploy/niko-staging.service`); production's already has it.
2. Deploy as usual; the migration runs.
3. Once: `npx tsx scripts/sface-switch-over.ts`, read its report, then
   `npx tsx scripts/sface-switch-over.ts --apply`.
4. Reload every gate and canteen phone. The first open downloads the engine.

## Next

1. **Time a scan on the gate phone**, and on the canteen tablet.
2. **Fewer taps:** capture automatically when a face is steady, take the best of 3
   frames, and on a strong match punch at once with a few seconds to undo.
3. **CCTV:** a box at the gate reads faces with the same engine. It needs a
   photo/screen check first.
