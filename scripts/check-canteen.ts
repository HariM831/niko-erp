/**
 * The canteen's rules, inside a transaction that is rolled back.
 *
 *   the meal comes from the clock: inside a window, or the nearest one, flagged
 *   a plate at the browser gate: no device, served by the logged-in user,
 *     verified or manual, numbered, and judged — outside its hours, not at
 *     work, not on the list — by the server
 *   one plate per person per meal; the same plate sent twice is one plate
 *   a night worker is present at breakfast though he punched nothing today
 *   night-shift breakfast is granted and taken back, and HR's own flags are
 *     never touched in either direction
 *
 * Run: npx tsx scripts/check-canteen.ts
 */
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { canteenMealEligibility, canteens, employees, locations, punches, shiftAssignments, shifts, users } from "@shared/schema";
import { DEFAULT_MEAL_WINDOWS, MEALS, mealForTime } from "@shared/canteen";
import { db } from "../server/db";
import { DuplicatePlate, recordBrowserServing, syncNightShiftBreakfast } from "../server/services/canteen";
import { addDays, istDate } from "../server/services/day-resolution";

let failures = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!cond) failures++;
};
class Rollback extends Error {}

console.log("\n  which meal\n");
const windows = MEALS.map((meal) => ({ meal, ...DEFAULT_MEAL_WINDOWS[meal] }));
let m = mealForTime("07:37", windows);
ok("07:37 is breakfast, inside its hours", m.meal === "breakfast" && !m.outsideWindow);
m = mealForTime("10:45", windows);
ok("10:45 is nearer lunch, and outside its hours", m.meal === "lunch" && m.outsideWindow);
m = mealForTime("23:30", windows);
ok("23:30 is dinner, late — not tomorrow's breakfast", m.meal === "dinner" && m.outsideWindow);
m = mealForTime("03:00", windows);
ok("03:00 is nearer breakfast than last night's dinner", m.meal === "breakfast" && m.outsideWindow);

try {
  await db.transaction(async (tx) => {
    const [user] = await tx.select({ id: users.id }).from(users).limit(1);
    if (!user) throw new Error("need a user to test with");
    let [loc] = await tx.select({ id: locations.id }).from(locations).limit(1);
    if (!loc) [loc] = await tx.insert(locations).values({ code: "ZZL", name: "ZZ Check Site" } as typeof locations.$inferInsert).returning({ id: locations.id });
    const [canteen] = await tx.insert(canteens).values({ code: "ZZC", name: "ZZ Check Canteen", locationId: loc!.id }).returning();

    const today = istDate();
    const at = (time: string) => new Date(`${today}T${time}:00+05:30`);
    const mk = async (empCode: string) =>
      (await tx.insert(employees).values({ empCode, name: `ZZ Plate ${empCode}`, payType: "daily_wage", dateOfJoining: "2026-01-01" }).returning())[0]!;
    const day = await mk("ZZPLD");
    const night = await mk("ZZPLN");
    await tx.insert(punches).values({ employeeId: day.id, type: "in", punchDate: today, punchedAt: at("06:55"), method: "manual", markedBy: user.id });

    console.log("\n  a plate at the browser gate\n");
    const clientId = randomUUID();
    const first = await recordBrowserServing(tx, user.id, { clientId, canteenId: canteen!.id, employeeId: day.id, method: "face", matchScore: 0.81 }, at("07:37"));
    const p = first.serving;
    ok("the server says it is breakfast", p.meal === "breakfast" && !p.outsideWindow);
    ok("no device; served by whoever was logged in", p.deviceId === null && p.servedBy === user.id);
    ok("a scanned face is verified, with its score and a token", p.state === "verified" && p.matchScore !== null && /^WEB-[0-9A-F]{6}$/.test(p.tokenNumber), p.tokenNumber);
    ok("he punched in this morning: present", p.attendancePresent === true);
    ok("not on the breakfast list: served, and marked", p.ineligible === true);

    const again = await recordBrowserServing(tx, user.id, { clientId, canteenId: canteen!.id, employeeId: day.id, method: "face" }, at("07:38"));
    ok("the same plate sent twice is one plate", again.replay && again.serving.id === p.id);
    try {
      await recordBrowserServing(tx, user.id, { clientId: randomUUID(), canteenId: canteen!.id, employeeId: day.id, method: "manual" }, at("07:50"));
      ok("a second breakfast → refused", false, "was allowed");
    } catch (e) {
      ok("a second breakfast → refused, with the first one's token", e instanceof DuplicatePlate && e.tokenNumber === p.tokenNumber);
    }
    const lunch = await recordBrowserServing(tx, user.id, { clientId: randomUUID(), canteenId: canteen!.id, employeeId: day.id, method: "manual", matchScore: 0.9 }, at("13:00"));
    ok("lunch is another meal, and everyone's", lunch.serving.meal === "lunch" && !lunch.serving.ineligible);
    ok("a name picked by hand is manual, and carries no score", lunch.serving.state === "name_matched" && lunch.serving.matchScore === null);

    console.log("\n  the night shift\n");
    const [nights] = await tx.insert(shifts).values({ name: "ZZ Check Canteen Night", startTime: "20:00", endTime: "06:00", workingHours: 10, weeklyOffDays: [0] }).returning();
    const yesterday = addDays(today, -1);
    const [assignment] = await tx.insert(shiftAssignments).values({ employeeId: night.id, shiftId: nights!.id, effectiveFrom: "2026-01-01" }).returning();
    await tx.insert(punches).values({ employeeId: night.id, type: "in", punchDate: yesterday, punchedAt: new Date(`${yesterday}T20:00:00+05:30`), method: "manual", markedBy: user.id });

    // HR has given him dinner by hand. Whatever the system does about breakfast, that stays.
    await tx.insert(canteenMealEligibility).values({ employeeId: night.id, dinner: true, note: "stays late" });
    let r = await syncNightShiftBreakfast(tx, [night.id], today);
    let [el] = await tx.select().from(canteenMealEligibility).where(eq(canteenMealEligibility.employeeId, night.id));
    ok("on an overnight shift today: breakfast granted", r.granted === 1 && el?.breakfastAuto === true);
    ok("HR's dinner, breakfast and note untouched", el?.dinner === true && el?.breakfast === false && el?.note === "stays late");
    r = await syncNightShiftBreakfast(tx, [night.id], today);
    ok("asked again, nothing changes", r.granted === 0 && r.withdrawn === 0);

    const plate = await recordBrowserServing(tx, user.id, { clientId: randomUUID(), canteenId: canteen!.id, employeeId: night.id, method: "face", matchScore: 0.7 }, at("07:30"));
    ok("in since last night and not yet out: present at breakfast", plate.serving.attendancePresent === true);
    ok("and on the list for it", plate.serving.ineligible === false);

    await tx.delete(shiftAssignments).where(eq(shiftAssignments.id, assignment!.id));
    r = await syncNightShiftBreakfast(tx, [night.id], today);
    [el] = await tx.select().from(canteenMealEligibility).where(eq(canteenMealEligibility.employeeId, night.id));
    ok("off the night shift: the grant is taken back", r.withdrawn === 1 && el?.breakfastAuto === false);
    ok("and HR's dinner is still there", el?.dinner === true && el?.note === "stays late");

    const [dayShift] = await tx.insert(shifts).values({ name: "ZZ Check Canteen Day", startTime: "08:00", endTime: "20:00", workingHours: 12, weeklyOffDays: [0] }).returning();
    await tx.insert(shiftAssignments).values({ employeeId: day.id, shiftId: dayShift!.id, effectiveFrom: "2026-01-01" });
    r = await syncNightShiftBreakfast(tx, [day.id], today);
    ok("a day shift earns no breakfast", r.granted === 0);
    await tx.insert(shiftAssignments).values({ employeeId: day.id, shiftId: nights!.id, effectiveFrom: addDays(today, 3) });
    r = await syncNightShiftBreakfast(tx, [day.id], today);
    ok("nor does a night shift that starts in three days — until it does", r.granted === 0 && (await syncNightShiftBreakfast(tx, [day.id], addDays(today, 3))).granted === 1);

    throw new Rollback();
  });
} catch (e) {
  if (!(e instanceof Rollback)) { console.error(e); failures++; }
}
const [left] = await db.select({ n: sql<number>`count(*)::int` }).from(employees).where(inArray(employees.empCode, ["ZZPLD", "ZZPLN"]));
ok("the rollback left nothing behind", left!.n === 0);

console.log(failures ? `\n  ${failures} failed\n` : "\n  all good\n");
process.exit(failures ? 1 : 0);
