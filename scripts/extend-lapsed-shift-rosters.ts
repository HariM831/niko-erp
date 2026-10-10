/**
 * Carry each person's last shift on, open-ended, where their roster has run out.
 *
 * Amino's shift assignments were dated rosters — a week, a month — and they
 * came across as they were. Nobody rostered October in niko, so by 9 Oct 2026
 * 107 of 116 salaried staff had no shift at all. The gate's night rule leans
 * on the shift: with none, an entry from 15:00 on reads as a night's, and a
 * day worker who missed the morning scan and was scanned leaving (Hemanga
 * Barman, 8 Oct, 17:52) was held as a night shift in progress.
 *
 * So: for every active employee with no assignment covering today, the
 * assignment that ended last is continued — same shift, same personal weekly
 * off — from the day after it ended, with no end date. HR then changes only
 * the people who actually move. The old rows are left as they are; the roster
 * that was is still the roster that was.
 *
 * Attendance is not recomputed. Every shift rests on Sunday, as an unassigned
 * person does, so a past day reads the same either way — except for someone
 * carrying a personal weekly off, who is listed so their days since the lapse
 * can be looked at.
 *
 * People who never had an assignment (every daily-wage worker) are listed and
 * left alone: there is no roster of theirs to continue.
 *
 *   npx tsx scripts/extend-lapsed-shift-rosters.ts            (dry run)
 *   npx tsx scripts/extend-lapsed-shift-rosters.ts --apply
 */
import { asc, eq } from "drizzle-orm";
import { employees, shiftAssignments, shifts } from "@shared/schema";
import { db, pool } from "../server/db";
import { addDays, istDate } from "../server/services/day-resolution";
import { syncNightShiftBreakfast } from "../server/services/canteen";

const APPLY = process.argv.includes("--apply");
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

async function main() {
  const today = istDate();
  const people = await db
    .select({ id: employees.id, empCode: employees.empCode, name: employees.name, payType: employees.payType, dateOfLeaving: employees.dateOfLeaving })
    .from(employees)
    .where(eq(employees.isActive, true))
    .orderBy(asc(employees.empCode));
  const shiftById = new Map((await db.select().from(shifts)).map((s) => [s.id, s]));
  const all = await db.select().from(shiftAssignments);
  const byEmp = new Map<string, typeof all>();
  for (const a of all) byEmp.set(a.employeeId, [...(byEmp.get(a.employeeId) ?? []), a]);

  const plan: Array<{ p: (typeof people)[number]; last: (typeof all)[number]; from: string }> = [];
  const never: typeof people = [];
  let covered = 0;
  let upcoming = 0;
  for (const p of people) {
    if (p.dateOfLeaving && p.dateOfLeaving < today) continue;
    const mine = byEmp.get(p.id) ?? [];
    if (!mine.length) {
      never.push(p);
      continue;
    }
    if (mine.some((a) => a.effectiveFrom <= today && (!a.effectiveTo || a.effectiveTo >= today))) {
      covered++;
      continue;
    }
    // Rostered to start later: that is HR's own answer, not a lapse to fill.
    if (mine.some((a) => a.effectiveFrom > today)) {
      upcoming++;
      continue;
    }
    // The one that ended last; of two ending together, the one that began later.
    const last = [...mine].sort((a, b) => (b.effectiveTo! < a.effectiveTo! ? -1 : b.effectiveTo! > a.effectiveTo! ? 1 : b.effectiveFrom < a.effectiveFrom ? -1 : 1))[0]!;
    plan.push({ p, last, from: addDays(last.effectiveTo!, 1) });
  }

  console.log(`${APPLY ? "APPLY" : "DRY RUN"} — as of ${today}`);
  console.log(`  ${covered} already on a shift today, ${upcoming} rostered to start later, ${plan.length} to carry on, ${never.length} never rostered\n`);
  const byShift = new Map<string, number>();
  for (const { p, last, from } of plan) {
    const sh = shiftById.get(last.shiftId);
    const name = sh ? `${sh.name} ${sh.startTime}-${sh.endTime}` : "(shift missing)";
    byShift.set(name, (byShift.get(name) ?? 0) + 1);
    const off = last.weeklyOffDays ? `  own weekly off: ${last.weeklyOffDays.map((d) => DAYS[d]).join(", ") || "none"}` : "";
    console.log(`  ${p.empCode.padEnd(14)} ${p.name.padEnd(28)} ${name.padEnd(26)} ended ${last.effectiveTo} -> open from ${from}${off}`);
  }
  console.log("\n  By shift:");
  for (const [name, n] of [...byShift].sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(3)}  ${name}`);
  const neverBy = new Map<string, number>();
  for (const p of never) neverBy.set(p.payType, (neverBy.get(p.payType) ?? 0) + 1);
  console.log(`\n  Never rostered (left alone): ${[...neverBy].map(([k, n]) => `${n} ${k}`).join(", ") || "none"}`);
  for (const p of never.filter((x) => x.payType === "salaried")) console.log(`    ${p.empCode.padEnd(14)} ${p.name}`);

  if (!APPLY) {
    console.log("\nNothing written. Re-run with --apply.");
    return;
  }
  await db.transaction(async (tx) => {
    for (const { p, last, from } of plan) {
      await tx.insert(shiftAssignments).values({
        employeeId: p.id,
        shiftId: last.shiftId,
        effectiveFrom: from,
        effectiveTo: null,
        weeklyOffDays: last.weeklyOffDays,
        notes: `Carried on from the roster that ended ${last.effectiveTo}`,
      });
    }
    // On nights again means breakfast again.
    await syncNightShiftBreakfast(tx, plan.map((x) => x.p.id));
  });
  console.log(`\nWrote ${plan.length} open assignments.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
