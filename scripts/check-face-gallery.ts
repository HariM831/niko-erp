/**
 * The gallery rule (services/face-gallery.ts, decided 24 Oct 2026), on
 * synthetic faces inside a transaction that is rolled back:
 *
 *   a worker is matched against the first taught gate scan of each of their
 *     last 7 days that have one — not later scans, not untaught ones
 *   the 7 are days WITH a taught scan, so a week away does not empty it
 *   nothing older than 60 days is served
 *   the enrolment photo is used only while there is no taught scan
 *   a gate punch keeps its scan's vector whether it teaches or not
 *
 * Run: npx tsx scripts/check-face-gallery.ts
 */
import { eq, inArray, sql } from "drizzle-orm";
import { employees, punches, users } from "@shared/schema";
import { FACE_DIM } from "@shared/face";
import { db } from "../server/db";
import { recordGatePunch } from "../server/routes/payroll";
import { GALLERY_DAYS, GALLERY_MAX_AGE_DAYS, galleryOf, taughtCaptures } from "../server/services/face-gallery";
import { addDays, istDate } from "../server/services/day-resolution";

let failures = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!cond) failures++;
};
class Rollback extends Error {}
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const axis = (i: number) => Array.from({ length: FACE_DIM }, (_, k) => (k === i ? 1 : 0));
/** The axis a stored vector points along, which is how these fixtures name it. */
const which = (v: number[]) => v.findIndex((x) => x === 1);

try {
  await db.transaction(async (tx: Tx) => {
    const [user] = await tx.select({ id: users.id }).from(users).limit(1);
    if (!user) throw new Error("need a user to test with");
    // The real roster steps aside (rolled back): these faces and no others.
    await tx.update(employees).set({ isActive: false });
    const mk = async (empCode: string, face: number[] | null) =>
      (await tx.insert(employees).values({ empCode, name: `ZZ Gallery ${empCode}`, payType: "salaried", faceDescriptor: face, faceEnrolledAt: face ? new Date() : null }).returning())[0]!;
    const today = istDate();
    const at = (day: string, time: string) => new Date(`${day}T${time}:00+05:30`);
    const scan = (employeeId: string, day: string, time: string, face: number[], taught: boolean) =>
      tx.insert(punches).values({
        employeeId, type: "in", punchDate: day, punchedAt: at(day, time), method: "face", matchScore: 0.8,
        faceEmbedding: face, faceTaught: taught, markedBy: user.id,
      });

    console.log("\n  which scans are served\n");
    const w = await mk("ZZGLW", axis(0));
    // Yesterday: an untaught scan first, then two taught ones.
    const y = addDays(today, -1);
    await scan(w.id, y, "07:00", axis(10), false);
    await scan(w.id, y, "08:00", axis(11), true);
    await scan(w.id, y, "17:00", axis(12), true);
    let served = await taughtCaptures(tx, [w.id]);
    ok("the day's first taught scan is served", served.length === 1 && which(served[0]!.embedding) === 11, served.map((c) => which(c.embedding)).join(","));
    ok("not the untaught one before it, nor the later one", !served.some((c) => [10, 12].includes(which(c.embedding))));

    // Eight more days with a taught scan, spread over three weeks with gaps.
    const days = [3, 5, 6, 9, 12, 15, 18, 21];
    for (const [i, d] of days.entries()) await scan(w.id, addDays(today, -d), "08:30", axis(20 + i), true);
    served = await taughtCaptures(tx, [w.id]);
    ok(`${GALLERY_DAYS} days are served, the newest that have a taught scan`, served.length === GALLERY_DAYS, String(served.length));
    const servedAxes = new Set(served.map((c) => which(c.embedding)));
    ok("…reaching back past a week of calendar days", servedAxes.has(20 + days.indexOf(15)) && !servedAxes.has(20 + days.indexOf(18)), [...servedAxes].join(","));

    console.log("\n  the enrolment photo\n");
    ok("with taught scans, the enrolment photo is not served", !galleryOf(w.faceDescriptor, served.map((c) => c.embedding)).some((v) => which(v) === 0));
    const n = await mk("ZZGLN", axis(1));
    ok("a new joiner is served their enrolment photo", galleryOf(n.faceDescriptor, undefined).length === 1 && which(galleryOf(n.faceDescriptor, undefined)[0]!) === 1);
    const old = await mk("ZZGLO", axis(2));
    await scan(old.id, addDays(today, -(GALLERY_MAX_AGE_DAYS + 1)), "08:00", axis(30), true);
    const oldServed = await taughtCaptures(tx, [old.id]);
    ok(`a scan older than ${GALLERY_MAX_AGE_DAYS} days is not served`, oldServed.length === 0);
    ok("…so that worker is back on their enrolment photo", which(galleryOf(old.faceDescriptor, undefined)[0]!) === 2);
    ok("no enrolment and no taught scan: nothing to match", galleryOf(null, undefined).length === 0);

    console.log("\n  what a gate punch keeps\n");
    // A hand-pick of a face that looks like nobody: punched, not taught, kept.
    const h = await mk("ZZGLH", axis(3));
    const p = await recordGatePunch(
      tx,
      { employeeId: h.id, type: "in", method: "manual", manualReason: "no_match", photoUrl: "data:image/jpeg;base64,AA==", faceEmbedding: axis(40) } as never,
      user.id,
    );
    const [row] = await tx.select().from(punches).where(eq(punches.id, p.id));
    ok("an untaught scan is punched", !!row);
    ok("…and its vector is kept", Array.isArray(row?.faceEmbedding) && which(row!.faceEmbedding) === 40);
    ok("…marked untaught", row?.faceTaught === false && p.taught === false);
    // A face match of the worker's own face: taught.
    const t = await mk("ZZGLT", axis(4));
    const q = await recordGatePunch(tx, { employeeId: t.id, type: "in", method: "face", matchScore: 0.9, faceEmbedding: axis(4) } as never, user.id);
    const [qRow] = await tx.select().from(punches).where(eq(punches.id, q.id));
    ok("a face match of the worker's own face is taught", qRow?.faceTaught === true && Array.isArray(qRow.faceEmbedding));

    throw new Rollback();
  });
} catch (e) {
  if (!(e instanceof Rollback)) {
    console.error(e);
    failures++;
  }
}

const [left] = await db
  .select({ n: sql<number>`count(*)::int` })
  .from(employees)
  .where(inArray(employees.empCode, ["ZZGLW", "ZZGLN", "ZZGLO", "ZZGLH", "ZZGLT"]));
ok("the rollback left nothing behind", left!.n === 0);

console.log(failures ? `\n  ${failures} failed\n` : "\n  all good\n");
process.exit(failures ? 1 : 0);
