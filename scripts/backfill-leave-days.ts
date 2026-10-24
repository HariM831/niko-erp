/**
 * Write the days of leaves that were approved before they began.
 *
 * Until 24 Oct 2026 the day resolver wrote no row for a future day, approved
 * leave or not. Approval recomputes the leave's range, so a leave approved in
 * advance — most of them — wrote nothing, and its days stayed blank on the
 * calendar and the team grid until somebody recomputed that month after the
 * days had passed. The payroll run recomputes, so the slip was right; the
 * screens were not (KAMAL KATTEL's CL for 23–24 and 26–29 Oct read empty).
 *
 * The resolver now writes a future day under an approved leave. This replays
 * each approved leave's range the way approval does, imports overridden and
 * HR's manual rows left alone, so the ones decided before the fix catch up.
 *
 *   npx tsx scripts/backfill-leave-days.ts                    (from 1 Sep, dry run)
 *   npx tsx scripts/backfill-leave-days.ts --from 2026-10-01
 *   npx tsx scripts/backfill-leave-days.ts --apply
 */
import { and, eq, gte } from "drizzle-orm";
import { attendanceDays, employees, leaveApplications } from "@shared/schema";
import { db, pool } from "../server/db";
import { addDays, recomputeRange } from "../server/services/day-resolution";

const APPLY = process.argv.includes("--apply");
const fromArg = process.argv[process.argv.indexOf("--from") + 1];
const FROM = process.argv.includes("--from") && /^\d{4}-\d{2}-\d{2}$/.test(fromArg ?? "") ? fromArg! : "2026-09-01";

async function main() {
  const leaves = await db
    .select({
      employeeId: leaveApplications.employeeId,
      name: employees.name,
      leaveType: leaveApplications.leaveType,
      fromDate: leaveApplications.fromDate,
      toDate: leaveApplications.toDate,
    })
    .from(leaveApplications)
    .innerJoin(employees, eq(employees.id, leaveApplications.employeeId))
    .where(and(eq(leaveApplications.status, "approved"), gte(leaveApplications.toDate, FROM)));

  let short = 0;
  for (const l of leaves) {
    const rows = await db
      .select({ day: attendanceDays.day })
      .from(attendanceDays)
      .where(and(eq(attendanceDays.employeeId, l.employeeId), gte(attendanceDays.day, l.fromDate)));
    const have = new Set(rows.map((r) => r.day));
    const missing: string[] = [];
    for (let d = l.fromDate; d <= l.toDate; d = addDays(d, 1)) if (!have.has(d)) missing.push(d);
    if (!missing.length) continue;
    short++;
    console.log(`${l.name.padEnd(28)} ${l.leaveType.padEnd(6)} ${l.fromDate} → ${l.toDate}  blank: ${missing.join(", ")}`);
    if (APPLY) await db.transaction((tx) => recomputeRange(tx, l.fromDate, l.toDate, [l.employeeId], true));
  }

  console.log(`\n${short} of ${leaves.length} approved leave(s) ending on or after ${FROM} had blank days.`);
  console.log(APPLY ? "Recomputed." : "Dry run — nothing written. Re-run with --apply.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
