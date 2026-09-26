/**
 * Put right the punches the gate recorded the wrong way round.
 *
 * Until 26 Sep 2026 the gate decided IN or OUT from the newest 200 punches of
 * the day. A working day runs to 380, so by mid-morning the early arrivals had
 * dropped off the end and the gate offered them IN again as they left; the
 * server took its word. On staging that day 22 people ended up with a second
 * entry and no exit — and the next scan after it was flipped too, because the
 * gate then read the wrong IN and offered OUT to someone coming back in.
 *
 * Every scan at the gate is a crossing, so a person's punches on a day
 * alternate. For each person-day holding IN on top of IN, the day's punches
 * are re-typed to alternate from its first punch, in time order, and the
 * attendance day is recomputed from them. Days without a repeat are not
 * touched.
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
    const first = ps[0]!.type;
    const changes = ps
      .map((p, i) => ({ id: p.id, at: p.punchedAt, from: p.type, to: (i % 2 === 0 ? first : first === "in" ? "out" : "in") as "in" | "out" }))
      .filter((c) => c.from !== c.to);
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
