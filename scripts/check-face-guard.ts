/**
 * Whose face is this? — the guard that stops one person's face being learned
 * under another's name, exercised on synthetic faces inside a transaction that
 * is rolled back.
 *
 * Real faces are not needed and would prove less: what is being checked is the
 * arithmetic of "clearly somebody else", "looks like its owner" and "looks like
 * nobody", and unit vectors built to sit at known angles say exactly which case
 * each one is.
 *
 *   a vector of the wrong length never teaches and never enrols
 *   A's face picked as B                 → named as A's, and would be refused
 *   A's face picked as A                 → taught
 *   a stranger's face picked as B        → not a conflict, but not taught
 *   someone with no gallery at all       → never taught by hand
 *   a taught capture counts as gallery   → B's drifted look is recognised as B
 *
 * Run: npx tsx scripts/check-face-guard.ts
 */
import { inArray, sql } from "drizzle-orm";
import { employees, punches, users } from "@shared/schema";
import { FACE_DIM, MATCH_MARGIN, MATCH_THRESHOLD, TEACH_OWN_FLOOR } from "@shared/face";
import { db } from "../server/db";
import { isUsableEmbedding, judgeCapture, roundEmbedding } from "../server/services/face-gallery";
import { istDate } from "../server/services/day-resolution";

let failures = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!cond) failures++;
};

class Rollback extends Error {}
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The i-th axis of face space: a face unlike every other axis. */
const axis = (i: number) => Array.from({ length: FACE_DIM }, (_, k) => (k === i ? 1 : 0));
/** A face at a chosen cosine to `a`, leaning toward `b` for the rest. */
const between = (a: number[], b: number[], cosToA: number) => {
  const rest = Math.sqrt(1 - cosToA * cosToA);
  return a.map((v, k) => cosToA * v + rest * b[k]!);
};

console.log("\n  vectors\n");
ok("1024 finite numbers is a face", isUsableEmbedding(axis(0)));
ok("192 numbers — the phone app's model — is not", !isUsableEmbedding(Array(192).fill(0.1)));
ok("1023 numbers is not", !isUsableEmbedding(Array(FACE_DIM - 1).fill(0.1)));
ok("a NaN in it is not", !isUsableEmbedding([...axis(0).slice(1), Number.NaN]));

try {
  await db.transaction(async (tx: Tx) => {
    const [user] = await tx.select({ id: users.id }).from(users).limit(1);
    if (!user) throw new Error("need a user to test with");
    // The real gallery steps aside (rolled back): the scores below are about
    // these faces and no others.
    await tx.update(employees).set({ isActive: false });

    const A = axis(0);
    const B = axis(1);
    const stranger = axis(2);
    const mk = async (empCode: string, face: number[] | null) => {
      const [row] = await tx
        .insert(employees)
        .values({ empCode, name: `ZZ Face ${empCode}`, payType: "salaried", faceDescriptor: face, faceEnrolledAt: face ? new Date() : null })
        .returning();
      return row!;
    };
    const a = await mk("ZZFCA", A);
    const b = await mk("ZZFCB", B);
    const bare = await mk("ZZFCN", null);

    console.log("\n  whose face\n");
    let v = await judgeCapture(tx, b.id, A);
    ok("A's face picked as B is named as A's", v.lookalike?.id === a.id && !v.teach, `looks like ${v.lookalike?.name ?? "nobody"} at ${v.lookalike?.score.toFixed(2)}`);

    v = await judgeCapture(tx, a.id, between(A, stranger, 0.9));
    ok("A's face picked as A is taught", !v.lookalike && v.teach, `own ${v.ownScore.toFixed(2)}`);

    v = await judgeCapture(tx, b.id, stranger);
    ok("a stranger's face picked as B is no conflict…", v.lookalike === null);
    ok("…but is not taught: it does not look like B either", !v.teach, `own ${v.ownScore.toFixed(2)} < ${TEACH_OWN_FLOOR}`);

    // Close call: looks like A, but B is within the margin. The gate would not
    // have auto-accepted it as A, and the guard does not call it A's either.
    v = await judgeCapture(tx, b.id, between(A, B, Math.SQRT1_2));
    ok("a face as close to B as to A is not called A's", v.lookalike === null, `A ${Math.SQRT1_2.toFixed(2)} vs own ${v.ownScore.toFixed(2)}, margin ${MATCH_MARGIN}`);

    v = await judgeCapture(tx, b.id, between(A, stranger, MATCH_THRESHOLD - 0.05));
    ok("below the match threshold nobody is named", v.lookalike === null);

    v = await judgeCapture(tx, bare.id, stranger);
    ok("someone with no face on file is never taught by hand", !v.teach && v.ownScore === 0);

    // B has changed since enrolment; the gate has taught itself his new look.
    // A capture of that look is B's, though it is far from his enrolment photo.
    const newLook = between(B, stranger, 0.3);
    await tx.insert(punches).values({
      employeeId: b.id, type: "in", punchDate: istDate(), method: "face", matchScore: 0.8,
      faceEmbedding: roundEmbedding(newLook), markedBy: user.id,
    });
    v = await judgeCapture(tx, b.id, newLook);
    ok("a taught capture counts as gallery", v.teach && v.ownScore > 0.99, `own ${v.ownScore.toFixed(2)}`);

    throw new Rollback();
  });
} catch (e) {
  if (!(e instanceof Rollback)) {
    console.error(e);
    failures++;
  }
}

const [left] = await db.select({ n: sql<number>`count(*)::int` }).from(employees).where(inArray(employees.empCode, ["ZZFCA", "ZZFCB", "ZZFCN"]));
ok("the rollback left nothing behind", left!.n === 0);

console.log(failures ? `\n  ${failures} failed\n` : "\n  all good\n");
process.exit(failures ? 1 : 0);
