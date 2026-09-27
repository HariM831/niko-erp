/**
 * The gate's punch rules, on the real database inside a rolled-back
 * transaction.
 *
 *   IN on top of IN                          → refused, says the next is OUT
 *   a second scan inside the repeat window   → refused as a repeat
 *   OUT five minutes after IN                → asked: the guard must confirm
 *   …confirmed                               → recorded as OUT
 *   OUT twenty minutes after IN              → recorded, nothing asked
 *   a hand-picked name with no photo         → refused: the camera can take one
 *
 * 27 Sep 2026: Khanjan Nath and Bipul Islary were punched OUT two and five
 * minutes after coming in, by a second scan the server took for an exit.
 *
 * Run: npx tsx scripts/check-gate-punch.ts
 */
import { eq } from "drizzle-orm";
import { employees, punches, users } from "@shared/schema";
import { db, pool } from "../server/db";
import { recordGatePunch } from "../server/routes/payroll";
import { istDate } from "../server/services/day-resolution";

let failures = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!cond) failures++;
};
class Rollback extends Error {}

const refusal = async (f: () => Promise<unknown>) => {
  try {
    await f();
    return null;
  } catch (e) {
    return e as Error & { constructor: { name: string } };
  }
};

try {
  await db.transaction(async (tx) => {
    const [user] = await tx.select({ id: users.id }).from(users).limit(1);
    if (!user) throw new Error("need a user");
    const worker = async (code: string, lastIn: number | null) => {
      const [e] = await tx.insert(employees).values({ empCode: code, name: `ZZ Gate ${code}`, payType: "salaried" }).returning();
      if (lastIn != null) {
        await tx.insert(punches).values({
          employeeId: e!.id, type: "in", punchDate: istDate(), method: "face",
          punchedAt: new Date(Date.now() - lastIn * 60_000), markedBy: user.id,
        });
      }
      return e!;
    };
    const punch = (id: string, type: "in" | "out", extra: Record<string, unknown> = {}) =>
      recordGatePunch(tx, { employeeId: id, type, method: "manual", manualReason: "no_match", photoUrl: "data:image/jpeg;base64,AA==", ...extra } as never, user.id);

    console.log("");
    const a = await worker("ZZGP1", 5);
    let e = await refusal(() => punch(a.id, "in"));
    ok("IN on top of IN is refused", e?.constructor.name === "WrongDirection", e?.message ?? "recorded");

    const b = await worker("ZZGP2", 1);
    e = await refusal(() => punch(b.id, "out"));
    ok("a second scan inside the repeat window is refused", e?.constructor.name === "RepeatPunch", e?.message ?? "recorded");

    e = await refusal(() => punch(a.id, "out"));
    ok("OUT five minutes after IN is asked, not recorded", e?.constructor.name === "QuickFlip", e?.message ?? "recorded");
    const before = await tx.select().from(punches).where(eq(punches.employeeId, a.id));
    ok("…and nothing was written", before.length === 1);

    const confirmed = await punch(a.id, "out", { confirmQuickFlip: true });
    ok("confirmed, it is recorded as OUT", confirmed.type === "out");

    const d = await worker("ZZGP4", 30);
    e = await refusal(() => punch(d.id, "out", { photoUrl: null }));
    ok("a name picked after a failed scan with no photo is refused", e?.message.includes("needs the worker's photo") ?? false, e?.message ?? "recorded");

    const c = await worker("ZZGP3", 20);
    const later = await punch(c.id, "out");
    ok("OUT twenty minutes after IN needs no confirmation", later.type === "out");

    throw new Rollback();
  });
} catch (e) {
  if (!(e instanceof Rollback)) {
    console.error(e);
    failures++;
  }
} finally {
  await pool.end().catch(() => {});
}
console.log(failures ? `\n  ${failures} failed\n` : "\n  all good\n");
process.exitCode = failures ? 1 : 0;
