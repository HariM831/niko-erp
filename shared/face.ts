/**
 * The numbers the gate, the server's wrong-person guard and the face-health
 * report all have to agree on. They were written down twice — once in the
 * client, where the match is decided, and once in the report that judges it —
 * "kept in step" by a comment.
 */

/**
 * Length of a face vector: @vladmandic/human's FaceRes embedding. Anything
 * else is not a face this system can compare — a vector of another length
 * scores zero against every real one, so it can never match, but it can sit in
 * a gallery displacing a capture that would have.
 */
export const FACE_DIM = 1024;

/** Auto-accept at this cosine score… (the reasoning is in client/src/lib/face.ts) */
export const MATCH_THRESHOLD = 0.6;

/** …and only with this much daylight over the runner-up. */
export const MATCH_MARGIN = 0.05;

/**
 * A captured face must look at least this much like the person it is filed
 * under before it may teach their gallery. The wrong-person check only catches
 * a face that looks like somebody ELSE; one that resembles nobody strongly
 * sails through it, and would then be learned as the person a guard picked.
 */
export const TEACH_OWN_FLOOR = 0.5;

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
 * roster, Anupam Das like the 132nd. 70% is above what chance produces for
 * nine captures in ten: a stranger that high is a resemblance, not noise.
 *
 * Learning is judged by the old, stricter rule (services/face-gallery.ts): a
 * capture that a stranger contests at MATCH_THRESHOLD still punches, but
 * teaches nobody.
 */
export const LOOKALIKE_THRESHOLD = 0.7;
