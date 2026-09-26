/**
 * Put right the punches the gate recorded the wrong way round.
 *
 * Until 26 Sep 2026 the gate decided IN or OUT from the newest 200 punches of
 * the day. A working day runs to 380, so by mid-morning the early arrivals had
 * dropped off the end and the gate offered them IN again as they left; the
 * server took its word. On staging that day it happened to 27 people, all
 * leaving between 16:53 and 17:24.
 *
 * Two shapes, and one repair covers both. Some were scanned once — an entry
 * that should have been the exit, and nothing after it, so the day reads as
 * still inside. Most were scanned again a few minutes later, and that retry
 * was recorded as OUT because the gate by then could see the wrong IN: the
 * retry is not a second crossing, it is the guard redoing the first.
 *
 * So only the repeated IN is re-typed, to OUT. Nothing else changes. Where a
 * retry follows, it becomes an OUT with nothing open, which the day's pairing
 * ignores (services/day-resolution.ts summarizeDay) — the exit counts at the
 * first scan, when the person actually left. The attendance day is then
 * recomputed. Re-typing every punch to alternate instead would have turned
 * each retry into a fresh entry and left 20 people inside overnight.
 *
 * It matters on the day: an open IN after 15:00 reads as a night shift, and
 * the person's first punch next morning would be filed as last night's exit.
 *
 *   npx tsx scripts/fix-double-punch-in.ts                  (last 7 days, dry run)
 *   npx tsx scripts/fix-double-punch-in.ts --from 2026-09-20
 *   npx tsx scripts/fix-double-punch-in.ts --apply
 */
import { and, asc, eq, gte, inArray } from "drizzle-orm";
import { employees, punches } from "@shared/schema";
import { db, pool } from "../server/db";
import { istDate, istDaysAgo, recomputeEmployeeDay } from "../server/services/day-resolution";

const APPLY = process.argv.includes("--apply");
const fromArg = process.argv[process.argv.indexOf("--from") + 1];
const FROM = process.argv.includes("--from") && /^\d{4}-\d{2}-\d{2}$/.test(fromArg ?? "") ? fromArg! : istDaysAgo(7);

const hhmm = (d: Date) =>
  d.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false });

async function main() {
  const rows = await db
    .select({
      id: punches.id,
      employeeId: punches.employeeId,
      punchDate: punches.punchDate,
      type: punches.type,
      punchedAt: punches.punchedAt,
    })
    .from(punches)
    .where(gte(punches.punchDate, FROM))
    .orderBy(asc(punches.employeeId), asc(punches.punchDate), asc(punches.punchedAt));

  const days = new Map<string, typeof rows>();
  for (const r of rows) {
    const k = `${r.employeeId}|${r.punchDate}`;
    days.set(k, [...(days.get(k) ?? []), r]);
  }

  const fixes: Array<{ employeeId: string; day: string; changes: Array<{ id: string; at: Date; from: string; to: string }> }> = [];
  for (const [k, ps] of days) {
    const repeat = ps.some((p, i) => i > 0 && p.type === "in" && ps[i - 1]!.type === "in");
    if (!repeat) continue;
    const changes = ps
      .filter((p, i) => i > 0 && p.type === "in" && ps[i - 1]!.type === "in")
      .map((p) => ({ id: p.id, at: p.punchedAt, from: p.type, to: "out" as const }));
    const [employeeId, day] = k.split("|") as [string, string];
    if (changes.length) fixes.push({ employeeId, day, changes });
  }

  const names = fixes.length
    ? new Map(
        (
          await db
            .select({ id: employees.id, name: employees.name, empCode: employees.empCode })
            .from(employees)
            .where(inArray(employees.id, [...new Set(fixes.map((f) => f.employeeId))]))
        ).map((e) => [e.id, `${e.name} (${e.empCode})`]),
      )
    : new Map<string, string>();

  console.log(`\n  Punches from ${FROM} to ${istDate()}: ${rows.length}. Person-days with IN on top of IN: ${fixes.length}.\n`);
  for (const f of fixes) {
    console.log(
      `  ${f.day}  ${(names.get(f.employeeId) ?? f.employeeId).padEnd(34)} ` +
        f.changes.map((c) => `${hhmm(c.at)} ${c.from.toUpperCase()}→${c.to.toUpperCase()}`).join(", "),
    );
  }
  const total = fixes.reduce((s, f) => s + f.changes.length, 0);

  if (!APPLY) {
    console.log(`\n  ${total} punch(es) to re-type on ${fixes.length} person-day(s). Dry run — nothing written. Re-run with --apply.\n`);
    await pool.end();
    return;
  }

  await db.transaction(async (tx) => {
    for (const f of fixes) {
      for (const c of f.changes) {
        await tx
          .update(punches)
          .set({ type: c.to })
          .where(and(eq(punches.id, c.id), eq(punches.type, c.from as "in" | "out")));
      }
      await recomputeEmployeeDay(tx, f.employeeId, f.day);
    }
  });
  console.log(`\n  Written: ${total} punch(es) re-typed, ${fixes.length} attendance day(s) recomputed.\n`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(`\n  ${e instanceof Error ? e.message : e}\n`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
