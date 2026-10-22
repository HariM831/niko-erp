/**
 * Optional holidays (the user, 22 Oct 2026), inside a transaction that is
 * rolled back:
 *
 *   OH is salaried staff only, one day, and only on an optional-holiday date
 *   the year's allowance holds, counting pending applications
 *   a date that is already everyone's holiday cannot be taken as OH
 *   an approved OH makes that day leave (L) for the person who took it
 *   for everyone else an optional holiday is an ordinary working day
 *   the balance shows OH for the salaried and nothing for wage workers
 *
 * Run: npx tsx scripts/check-optional-holiday.ts
 */
import { eq, inArray, sql, and } from "drizzle-orm";
import { attendanceDays, employees, holidays, payrollSettings, users } from "@shared/schema";
import { db } from "../server/db";
import { applyLeave, approveLeave, leaveBalance } from "../server/services/leave";
import { recomputeEmployeeDay } from "../server/services/day-resolution";
import { PostingError } from "../server/services/posting";

let failures = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!cond) failures++;
};
class Rollback extends Error {}
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const CODES = ["ZZOHS", "ZZOHT", "ZZOHW"];
// Past dates (leave is only written for days that have come), clear of the
// recurring national holidays, so the fixtures stand alone.
const Y = 2025;
const OPT = [`${Y}-02-11`, `${Y}-03-12`, `${Y}-04-15`];
const FULL = `${Y}-05-14`;
const PLAIN = `${Y}-06-11`;

try {
  await db.transaction(async (tx: Tx) => {
    const [user] = await tx.select({ id: users.id }).from(users).limit(1);
    if (!user) throw new Error("need a user to test with");
    const [s] = await tx.select().from(payrollSettings);
    if (s) await tx.update(payrollSettings).set({ optionalHolidaysPerYear: 2 });

    for (const [i, d] of OPT.entries()) await tx.insert(holidays).values({ name: `ZZ Optional ${i + 1}`, date: d, type: "optional" });
    await tx.insert(holidays).values({ name: "ZZ Full", date: FULL, type: "company" });
    await tx.insert(holidays).values({ name: "ZZ Both", date: OPT[2]!.replace("-04-15", "-07-16"), type: "optional" });
    await tx.insert(holidays).values({ name: "ZZ Both full", date: `${Y}-07-16`, type: "national" });

    const mk = async (empCode: string, payType: "salaried" | "daily_wage") =>
      (await tx.insert(employees).values({ empCode, name: `ZZ OH ${empCode}`, payType, dateOfJoining: "2020-01-01" }).returning())[0]!;
    const sal = await mk("ZZOHS", "salaried");
    const other = await mk("ZZOHT", "salaried");
    const wage = await mk("ZZOHW", "daily_wage");

    const apply = (employeeId: string, from: string, to = from) =>
      applyLeave(tx, { employeeId, leaveType: "OH", fromDate: from, toDate: to, reason: "festival" });
    const refused = async (label: string, f: () => Promise<unknown>, says: RegExp) => {
      try {
        await f();
        ok(label, false, "was accepted");
      } catch (e) {
        ok(label, e instanceof PostingError && says.test(e.message), e instanceof Error ? e.message : String(e));
      }
    };

    console.log("\n  who and when\n");
    await refused("a wage worker cannot take one", () => apply(wage.id, OPT[0]!), /salaried/);
    await refused("a date not on the list is refused", () => apply(sal.id, PLAIN), /not on the optional-holiday list/);
    await refused("two days in one application are refused", () => apply(sal.id, OPT[0]!, OPT[1]!), /one day/);
    await refused("a date that is already everyone's holiday is refused", () => apply(sal.id, `${Y}-07-16`), /already a holiday/);

    console.log("\n  the allowance\n");
    const first = await apply(sal.id, OPT[0]!);
    ok("the first optional holiday is accepted", first.leaveType === "OH" && first.days === 1);
    await apply(sal.id, OPT[1]!);
    ok("the second, still pending, is accepted", true);
    await refused("a third is refused while the second is only pending", () => apply(sal.id, OPT[2]!), /limit is 2/);

    console.log("\n  the day itself\n");
    await approveLeave(tx, first.id, user.id);
    const [mine] = await tx.select().from(attendanceDays).where(and(eq(attendanceDays.employeeId, sal.id), eq(attendanceDays.day, OPT[0]!)));
    ok("an approved OH is leave on that day", mine?.status === "L" && mine?.source === "leave", `${mine?.status}/${mine?.source}`);
        const theirs = await recomputeEmployeeDay(tx, other.id, OPT[0]!);
    ok("for someone who did not take it, the day is not a holiday", theirs === null || (theirs.status !== "HO" && theirs.source !== "holiday"), theirs ? `${theirs.status}/${theirs.source}` : "future day, unresolved");

    console.log("\n  the balance\n");
    const b = await leaveBalance(tx, sal.id, Y);
    ok("salaried: 2 allowed, 1 used (approved), 1 left", b.OH.earned === 2 && b.OH.used === 1 && b.OH.balance === 1, JSON.stringify(b.OH));
    const w = await leaveBalance(tx, wage.id, Y);
    ok("wage worker: none allowed", w.OH.earned === 0, JSON.stringify(w.OH));

    throw new Rollback();
  });
} catch (e) {
  if (!(e instanceof Rollback)) { console.error(e); failures++; }
}
const [left] = await db.select({ n: sql<number>`count(*)::int` }).from(employees).where(inArray(employees.empCode, CODES));
ok("the rollback left nothing behind", left!.n === 0);

console.log(failures ? `\n  ${failures} failed\n` : "\n  all good\n");
process.exit(failures ? 1 : 0);
