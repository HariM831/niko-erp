# SFace replaces FaceRes

From 23 Oct 2026, faces are read on the server by OpenCV's SFace, not on the
phone by Human's FaceRes. Matching still happens on the device: the phone sends
the server a picture and gets back the face's vector, then scores it against
the roster gallery exactly as before.

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

- **The engine:** `server/services/face-engine.ts`.
  - YuNet finds the face and five points on it.
  - The face is turned and scaled onto SFace's 112×112 template.
  - SFace turns the crop into 128 numbers.
  - It runs on onnxruntime-node and sharp: no Python and no OpenCV binary.
  - On 300 farm photos its vectors agree with OpenCV's own at a median cosine of
    0.999 (worst 0.93).
  - The weights are pinned by revision and sha256, and fetched once into
    `.cache/face-models` (or `FACE_MODELS_DIR`).
- **The API:**
  - `POST /api/payroll/face/vector` takes `{ photo: dataURL }` and returns
    `{ embedding, faceCount, confidence }`.
  - `GET /api/payroll/face/ready` loads the models.
  - The gate, the canteen gate, enrolment and the employee form all read faces
    through it (`client/src/lib/face.ts`).
- **Vector length:** `FACE_DIM` is 128, and the cutoffs in `shared/face.ts` are on
  SFace's scale. The gallery, the wrong-person guard, face health and the prune
  are unchanged.
- **The switch-over:** migration 0138 cleared every stored FaceRes vector, because
  they cannot be compared with SFace ones.
  - At boot, and hourly, the server re-enrols every enrolled worker from their
    photo (`services/face-enrol.ts`). Nobody needs re-photographing.
  - `scripts/backfill-face-vectors.ts --apply` re-teaches the gate galleries from
    recent punch photos. It only teaches a photo where SFace agrees with the name
    on the punch.
- **Lost for now:** Human's photo-or-screen check. A guard holds the phone at the
  gate. A check of its own will come back on the server with the CCTV cameras,
  which will have no guard.
- **Android devices still send FaceRes vectors.** None is in use. Any that is will
  have its vectors ignored (wrong length), and its punches still record. A future
  app should send a photo.

## Next

1. **Re-enrolment:** 3–5 photos per worker at the gate, each checked by a person.
   Start with the workers face health flags.
2. **Fewer taps:** capture automatically when a face is steady, take the best of 3
   frames, and on a strong match punch at once with a few seconds to undo.
3. **CCTV:** a box at the gate sends the best frame of each person who walks past
   to the same engine. It needs a server-side photo/screen check first.
