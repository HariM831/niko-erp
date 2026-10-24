/**
 * The numbers the gate, the server's wrong-person guard and the face-health
 * report all have to agree on. They were written down twice — once in the
 * client, where the match is decided, and once in the report that judges it —
 * "kept in step" by a comment.
 */

/**
 * Length of a face vector: OpenCV's SFace, made on the server
 * (server/services/face-engine.ts). Before 23 Oct 2026 it was 1024, Human's
 * FaceRes; those vectors were cleared, not converted. Anything
 * else is not a face this system can compare — a vector of another length
 * scores zero against every real one, so it can never match, but it can sit in
 * a gallery displacing a capture that would have.
 */
export const FACE_DIM = 128;

/**
 * Auto-accept at this cosine score…
 *
 * SFace on this farm's gate photos (23 Oct 2026, local copy of staging, 2,000
 * recent scans against one enrolment photo each — docs/face-sface-plan.md): a
 * worker scores 0.73 against their own photo at the median and 0.44 at the
 * worst 1 in 100; the closest stranger on the roster 0.41 at the median, 0.50
 * at 1 in 20. At 0.46 with the margin below, 98 scans in 100 were accepted
 * with at most one wrong name in a thousand. FaceRes needed 0.60 on its own,
 * more crowded scale.
 */
export const MATCH_THRESHOLD = 0.46;

/** …and only with this much daylight over the runner-up. */
export const MATCH_MARGIN = 0.05;

/**
 * A captured face must look at least this much like the person it is filed
 * under before it may teach their gallery. The wrong-person check only catches
 * a face that looks like somebody ELSE; one that resembles nobody strongly
 * sails through it, and would then be learned as the person a guard picked.
 */
export const TEACH_OWN_FLOOR = 0.45;
// SFace: a worker's own photo scored under 0.44 for only 1 scan in 100 (see
// MATCH_THRESHOLD), so 0.45 asks a capture to look like its owner as much as
// all but their worst scans do. FaceRes used 0.5 on its scale.

/**
 * A capture filed under a hand-picked name is refused as somebody ELSE's only
 * when that somebody scores at least this.
 *
 * Not MATCH_THRESHOLD. Against a roster of 194, the closest stranger to any
 * capture scores 64% at the median and 68% at the 90th percentile (staging,
 * 26 Sep 2026, 123 gate captures — docs/face-matching-centred-plan.md). A
 * hand-picked name only happens after the scan failed, so its capture is a
 * weak one, well under its owner's usual 73%; at a 60% bar some stranger
 * nearly always cleared it, and the guard refused the right man in the
 * wrong man's name — Debajit Bora "looked like" the 34th-closest face on the
 * roster, Anupam Das like the 132nd. 70% was above what chance produced for
 * nine captures in ten: a stranger that high is a resemblance, not noise.
 *
 * Those were FaceRes figures. On SFace (23 Oct 2026, 2,000 gate scans) the
 * closest stranger scores 0.41 at the median, 0.48 at 9 in 10, 0.50 at 19 in
 * 20 and 0.60 at 99 in 100. 0.55 sits above all but a few in a hundred.
 *
 * Learning is judged by the old, stricter rule (services/face-gallery.ts): a
 * capture that a stranger contests at MATCH_THRESHOLD still punches, but
 * teaches nobody.
 */
export const LOOKALIKE_THRESHOLD = 0.55;
