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
 * Two things are NOT carried unless asked for (the user, 10 Oct 2026):
 *
 * - A personal weekly off that differs from the shift's. The production dry
 *   run showed September's off days no longer hold: of 35 people resting on a
 *   day other than Sunday, 16 had worked that day in October and stayed away
 *   on Sunday. Carrying the old day would have marked their Sunday absent. So
 *   they go on the shift's own off day — what niko gives them unassigned
 *   anyway — until HR's October list is loaded. `--keep-own-off` carries them,
 *   and then recomputes those people's days from the lapse or the first of
 *   this month, whichever is later, printing every day that changes.
 * - An overnight shift. A week of nights that ended in September is not
 *   evidence of nights now, and being on nights changes how the gate reads
 *   every punch and grants a breakfast. Listed, left alone; `--with-nights`.
 *
 * The dry run does all of it in a transaction and rolls it back, so what it
 * prints is what --apply will do.
 *
 * People who never had an assignment (every daily-wage worker) are listed and
 * left alone: there is no roster of theirs to continue.
 *
 *   npx tsx scripts/extend-lapsed-shift-rosters.ts            (dry run)
 *   npx tsx scripts/extend-lapsed-shift-rosters.ts --apply
 *   npx tsx scripts/extend-lapsed-shift-rosters.ts --keep-own-off --with-nights
 */
import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import { attendanceDays, employees, shiftAssignments, shifts } from "@shared/schema";
import { db, pool } from "../server/db";
import { addDays, isOvernightShift, istDate, recomputeRange } from "../server/services/day-resolution";
import { syncNightShiftBreakfast } from "../server/services/canteen";

const APPLY = process.argv.includes("--apply");
const KEEP_OWN_OFF = process.argv.includes("--keep-own-off");
const WITH_NIGHTS = process.argv.includes("--with-nights");
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

  const plan: Array<{ p: (typeof people)[number]; last: (typeof all)[number]; from: string; off: number[] | null; dropped: boolean }> = [];
  const nights: Array<{ p: (typeof people)[number]; last: (typeof all)[number] }> = [];
  const never: typeof people = [];
  const same = (a: number[], b: number[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();
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
    const sh = shiftById.get(last.shiftId);
    if (!WITH_NIGHTS && isOvernightShift(sh)) {
      nights.push({ p, last });
      continue;
    }
    const differs = !!last.weeklyOffDays && !same(last.weeklyOffDays, sh?.weeklyOffDays ?? []);
    const dropped = differs && !KEEP_OWN_OFF;
    plan.push({ p, last, from: addDays(last.effectiveTo!, 1), off: dropped ? null : last.weeklyOffDays, dropped });
  }

  console.log(`${APPLY ? "APPLY" : "DRY RUN"} — as of ${today}`);
  console.log(`  ${covered} already on a shift today, ${upcoming} rostered to start later, ${plan.length} to carry on, ${never.length} never rostered\n`);
  const byShift = new Map<string, number>();
  for (const { p, last, from, dropped } of plan) {
    const sh = shiftById.get(last.shiftId);
    const name = sh ? `${sh.name} ${sh.startTime}-${sh.endTime}` : "(shift missing)";
    byShift.set(name, (byShift.get(name) ?? 0) + 1);
    const off = last.weeklyOffDays ? `  own weekly off: ${last.weeklyOffDays.map((d) => DAYS[d]).join(", ") || "none"}${dropped ? " (NOT carried)" : ""}` : "";
    console.log(`  ${p.empCode.padEnd(14)} ${p.name.padEnd(28)} ${name.padEnd(26)} ended ${last.effectiveTo} -> open from ${from}${off}`);
  }
  console.log("\n  By shift:");
  for (const [name, n] of [...byShift].sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(3)}  ${name}`);
  console.log(`
  Own weekly off not carried: ${plan.filter((x) => x.dropped).length}`);
  console.log(`  Last on an overnight shift (left alone): ${nights.length}`);
  for (const { p, last } of nights) console.log(`    ${p.empCode.padEnd(14)} ${p.name.padEnd(28)} ${shiftById.get(last.shiftId)?.name ?? ""} ended ${last.effectiveTo}`);
  const neverBy = new Map<string, number>();
  for (const p of never) neverBy.set(p.payType, (neverBy.get(p.payType) ?? 0) + 1);
  console.log(`\n  Never rostered (left alone): ${[...neverBy].map(([k, n]) => `${n} ${k}`).join(", ") || "none"}`);
  for (const p of never.filter((x) => x.payType === "salaried")) console.log(`    ${p.empCode.padEnd(14)} ${p.name}`);

  class DryRun extends Error {}
  const monthStart = `${today.slice(0, 7)}-01`;
  // Only a carried off day that is not the shift's own can move a past day.
  const ownOff = plan.filter((x) => x.off && !same(x.off, shiftById.get(x.last.shiftId)?.weeklyOffDays ?? []));
  try {
    await db.transaction(async (tx) => {
      for (const { p, last, from, off, dropped } of plan) {
        await tx.insert(shiftAssignments).values({
          employeeId: p.id,
          shiftId: last.shiftId,
          effectiveFrom: from,
          effectiveTo: null,
          weeklyOffDays: off,
          notes:
            `Carried on from the roster that ended ${last.effectiveTo}` +
            (dropped ? `; own weekly off (${last.weeklyOffDays!.map((d) => DAYS[d]).join(", ") || "none"}) not carried, October list awaited` : ""),
        });
      }

      // The days a personal weekly off was lost for.
      if (ownOff.length) {
        const ids = ownOff.map((x) => x.p.id);
        const read = async () =>
          new Map(
            (
              await tx
                .select({ employeeId: attendanceDays.employeeId, day: attendanceDays.day, status: attendanceDays.status })
                .from(attendanceDays)
                .where(and(inArray(attendanceDays.employeeId, ids), gte(attendanceDays.day, monthStart), lte(attendanceDays.day, today)))
            ).map((r) => [`${r.employeeId}|${r.day}`, r.status]),
          );
        const before = await read();
        for (const x of ownOff) {
          const start = x.from > monthStart ? x.from : monthStart;
          if (start <= today) await recomputeRange(tx, start, today, [x.p.id]);
        }
        const after = await read();
        const nameOf = new Map(ownOff.map((x) => [x.p.id, `${x.p.empCode} ${x.p.name}`]));
        const changes = [...new Set([...before.keys(), ...after.keys()])].filter((k) => before.get(k) !== after.get(k)).sort();
        console.log(`\n  Attendance days that change (${monthStart} to ${today}): ${changes.length}`);
        const tally = new Map<string, number>();
        for (const k of changes) {
          const [id, day] = k.split("|") as [string, string];
          const move = `${before.get(k) ?? "-"} -> ${after.get(k) ?? "-"}`;
          tally.set(move, (tally.get(move) ?? 0) + 1);
          console.log(`    ${(nameOf.get(id) ?? id).padEnd(44)} ${day} ${DAYS[new Date(`${day}T00:00:00Z`).getUTCDay()]}  ${move}`);
        }
        for (const [move, n] of tally) console.log(`    ${String(n).padStart(3)} x ${move}`);
      }

      if (!APPLY) throw new DryRun();
      // On nights again means breakfast again.
      await syncNightShiftBreakfast(tx, plan.map((x) => x.p.id));
    });
    console.log(`\nWrote ${plan.length} open assignments.`);
  } catch (e) {
    if (!(e instanceof DryRun)) throw e;
    console.log("\nNothing written (rolled back). Re-run with --apply.");
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
