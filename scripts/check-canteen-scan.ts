/**
 * The canteen learns its own faces (docs/canteen-face-matching-plan.md), inside
 * a transaction that is rolled back.
 *
 *   a face-matched plate keeps its face, its scan, and no photo
 *   a hand-picked plate keeps the frame and the scan; its face teaches only
 *     when the gate's own check passes for the person picked
 *   the canteen's captures are served to the canteen and never to the gate
 *   the prune keeps exactly what the canteen roster serves
 *
 * Run: npx tsx scripts/check-canteen-scan.ts
 */
import { randomUUID } from "node:crypto";
import { inArray, sql } from "drizzle-orm";
import { canteens, canteenServings, employees, locations, users } from "@shared/schema";
import { FACE_DIM } from "@shared/face";
import { db } from "../server/db";
import { recordBrowserServing } from "../server/services/canteen";
import { canteenCaptures, pruneCanteenCaptures, taughtCaptures } from "../server/services/face-gallery";
import { addDays, istDate } from "../server/services/day-resolution";

let failures = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!cond) failures++;
};
class Rollback extends Error {}
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const axis = (i: number) => Array.from({ length: FACE_DIM }, (_, k) => (k === i ? 1 : 0));
const between = (a: number[], b: number[], cosToA: number) => {
  const rest = Math.sqrt(1 - cosToA * cosToA);
  return a.map((v, k) => cosToA * v + rest * b[k]!);
};
const PHOTO = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==";

try {
  await db.transaction(async (tx: Tx) => {
    const [user] = await tx.select({ id: users.id }).from(users).limit(1);
    if (!user) throw new Error("need a user to test with");
    // The real roster steps aside (rolled back): these faces and no others.
    await tx.update(employees).set({ isActive: false });
    let [loc] = await tx.select({ id: locations.id }).from(locations).limit(1);
    if (!loc) [loc] = await tx.insert(locations).values({ code: "ZZL", name: "ZZ Check Site" } as typeof locations.$inferInsert).returning({ id: locations.id });
    const [canteen] = await tx.insert(canteens).values({ code: "ZZS", name: "ZZ Scan Canteen", locationId: loc!.id }).returning();

    const A = axis(0), B = axis(1), C = axis(2), noise = axis(3);
    const mk = async (empCode: string, face: number[]) =>
      (await tx.insert(employees).values({ empCode, name: `ZZ Scan ${empCode}`, payType: "daily_wage", dateOfJoining: "2026-01-01", faceDescriptor: face, faceEnrolledAt: new Date() }).returning())[0]!;
    const a = await mk("ZZSCA", A);
    const b = await mk("ZZSCB", B);
    const c = await mk("ZZSCC", C);

    const today = istDate();
    const at = (day: string, time: string) => new Date(`${day}T${time}:00+05:30`);
    const plate = (employeeId: string, method: "face" | "manual", face: number[] | null, when: Date, extra: object = {}) =>
      recordBrowserServing(tx, user.id, {
        clientId: randomUUID(), canteenId: canteen!.id, employeeId, method, matchScore: method === "face" ? 0.8 : null,
        faceEmbedding: face, photoUrl: PHOTO,
        scan: { score: 0.55, closestId: employeeId, secondScore: 0.4, secondId: null, frames: 3 },
        ...extra,
      }, when).then((r) => r.serving);

    console.log("\n  what a plate keeps\n");
    const f = await plate(a.id, "face", between(A, noise, 0.9), at(today, "13:00"));
    ok("a face-matched plate keeps its face to teach", Array.isArray(f.faceEmbedding) && f.faceEmbedding.length === FACE_DIM);
    ok("and its scan: score, closest, frames", f.scanScore !== null && f.scanClosestId === a.id && f.scanFrames === 3);
    ok("but no photo — only a hand-picked plate keeps one", f.photoUrl === null);

    const good = await plate(b.id, "manual", between(B, noise, 0.6), at(today, "13:01"));
    ok("hand-picked, the face looks enough like B: it teaches", good.faceEmbedding !== null && good.state === "name_matched");
    ok("and the frame is kept for HR", good.photoUrl === PHOTO);

    const wrong = await plate(c.id, "manual", between(A, noise, 0.9), at(today, "13:02"));
    ok("hand-picked as C, but the face is clearly A's: served, teaches nothing", wrong.faceEmbedding === null && wrong.state === "name_matched");
    ok("the plate still records what the scan saw", wrong.scanScore !== null && wrong.photoUrl === PHOTO);

    const nobody = await plate(a.id, "manual", noise, at(today, "20:00"));
    ok("hand-picked, a face that looks like nobody: teaches nothing", nobody.faceEmbedding === null);

    const camOff = await plate(b.id, "manual", null, at(today, "20:01"), { scan: null, photoUrl: null });
    ok("picked with the camera off: nothing to teach, nothing to show", camOff.faceEmbedding === null && camOff.scanScore === null && camOff.photoUrl === null);

    console.log("\n  who is served what\n");
    const own = await canteenCaptures(tx, [a.id, b.id, c.id]);
    ok("the canteen's gallery has A's and B's taught faces, not C's", own.some((x) => x.employeeId === a.id) && own.some((x) => x.employeeId === b.id) && !own.some((x) => x.employeeId === c.id));
    const gate = await taughtCaptures(tx, [a.id, b.id, c.id]);
    ok("the gate's gallery is untouched by the canteen", gate.length === 0);

    console.log("\n  the prune\n");
    // Seven earlier days of A's lunches: only the newest five capture-days are served.
    for (let i = 1; i <= 7; i++) await plate(a.id, "face", between(A, noise, 0.85), at(addDays(today, -i), "13:00"));
    const beforeA = (await canteenCaptures(tx, [a.id])).length;
    ok("A is served five capture-days, one capture each", beforeA === 5, String(beforeA));
    const cleared = await pruneCanteenCaptures(tx);
    const stored = (await tx.execute(sql`SELECT count(*)::int AS n FROM canteen_servings WHERE employee_id = ${a.id}::uuid AND face_embedding IS NOT NULL`)).rows[0] as { n: number };
    ok("the prune clears what is no longer served, and keeps what is", cleared >= 3 && stored.n === 5, `cleared ${cleared}, kept ${stored.n}`);
    ok("and the plates themselves stay", ((await tx.select({ n: sql<number>`count(*)::int` }).from(canteenServings).where(inArray(canteenServings.employeeId, [a.id])))[0]!.n) === 9);

    throw new Rollback();
  });
} catch (e) {
  if (!(e instanceof Rollback)) { console.error(e); failures++; }
}
const [left] = await db.select({ n: sql<number>`count(*)::int` }).from(employees).where(inArray(employees.empCode, ["ZZSCA", "ZZSCB", "ZZSCC"]));
ok("the rollback left nothing behind", left!.n === 0);

console.log(failures ? `\n  ${failures} failed\n` : "\n  all good\n");
process.exit(failures ? 1 : 0);
