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
