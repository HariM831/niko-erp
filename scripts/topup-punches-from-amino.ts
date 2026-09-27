/**
 * Bring across the Amino punches the history import never saw — punches only.
 *
 * The history import ran on 25 Sep 2026 and took every punch Amino had by
 * then. Amino's gates went on recording that afternoon and into 26 Sep, while
 * niko's own gate started on the 26th, so niko is missing those crossings:
 * people show an entry and no exit on 25 Sep, and the face captures for those
 * punches (scripts/import-face-captures-from-amino.ts) had nowhere to land.
 *
 * Re-running the whole history import would do more than add punches: it
 * overwrites canteen meal eligibility and the closed months' attendance with
 * Amino's, and would add again any leave or advance keyed into both systems
 * during parallel entry. So this reads the same export folder and takes
 * punches alone, from a date:
 *
 *   - a punch already in niko (same id — the history import kept Amino's) is
 *     left alone;
 *   - a punch within DUP_MINUTES of one niko already has for the same person
 *     is the same crossing recorded by both gates, and is not added again;
 *   - everything else is inserted as the history import would have, and the
 *     days it touched are resolved again under niko's rules (a day HR set by
 *     hand, or one imported as Amino counted it, is left exactly as it is).
 *
 * The export comes from `scripts/export-payroll-history-for-niko.ts` in the
 * Amino repo, run on Replit, handed over as its folder.
 *
 *   npx tsx scripts/topup-punches-from-amino.ts --dir payroll-export --from 2026-09-25
 *   npx tsx scripts/topup-punches-from-amino.ts --dir payroll-export --from 2026-09-25 --apply
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { and, gte, inArray } from "drizzle-orm";
import { employees, punches } from "@shared/schema";
import { db } from "../server/db";
import { recomputeEmployeeDay } from "../server/services/day-resolution";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const DIR = arg("dir") ?? "payroll-export";
const FROM = arg("from");
const APPLY = process.argv.includes("--apply");
const DUP_MINUTES = Number(arg("dup-minutes") ?? 3);
if (!FROM || !/^\d{4}-\d{2}-\d{2}$/.test(FROM)) {
  console.error("\n  --from YYYY-MM-DD is required: the first day to top up\n");
  process.exit(1);
}

type Row = Record<string, any>;
const exp = JSON.parse(await readFile(path.join(DIR, "payroll-export.json"), "utf8")) as { exportedAt: string; data: Record<string, Row[]> };
const D = exp.data;

const s = (v: unknown) => (v == null || v === "" ? null : String(v));
const num = (v: unknown) => (v == null ? null : Number(v));
/** Amino writes UTC without a zone. */
const at = (v: unknown): Date | null => {
  const t = s(v);
  if (!t) return null;
  const iso = t.includes("T") ? t : t.replace(" ", "T");
  return new Date(/[Zz]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
};
let photosMissing = 0;
const inhale = async (file: unknown): Promise<string | null> => {
  if (typeof file !== "string" || !file) return null;
  try {
    return `data:image/jpeg;base64,${(await readFile(path.join(DIR, file))).toString("base64")}`;
  } catch {
    photosMissing++;
    return null;
  }
};
const hhmm = (d: Date) => d.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false });

class DryRun extends Error {}

try {
  await db.transaction(async (tx) => {
    // Who is who — the history import's own walk: salaried by code, wage
    // workers W-0001… in the export's order.
    const niko = await tx.select({ id: employees.id, code: employees.empCode, name: employees.name }).from(employees);
    const byCode = new Map(niko.map((e) => [e.code, e.id]));
    const nameOf = new Map(niko.map((e) => [e.id, e.name]));
    const person = new Map<string, string>();
    for (const e of D.employees ?? []) {
      const id = byCode.get(String(e.emp_code));
      if (id) person.set(String(e.id), id);
    }
    (D.wage_workers ?? []).forEach((w, i) => {
      const id = byCode.get(`W-${String(i + 1).padStart(4, "0")}`);
      if (id) person.set(String(w.id), id);
    });

    const rows = [
      ...(D.attendance_punches ?? []).map((row) => ({ row, who: String(row.employee_id) })),
      ...(D.wage_punches ?? []).map((row) => ({ row, who: String(row.worker_id) })),
    ].filter((r) => String(r.row.punch_date) >= FROM);

    // What niko already holds from FROM on, per person, to spot the same
    // crossing recorded by both gates.
    const held = await tx
      .select({ id: punches.id, employeeId: punches.employeeId, punchedAt: punches.punchedAt })
      .from(punches)
      .where(gte(punches.punchDate, FROM));
    const heldIds = new Set(held.map((h) => h.id));
    const heldBy = new Map<string, number[]>();
    for (const h of held) heldBy.set(h.employeeId, [...(heldBy.get(h.employeeId) ?? []), h.punchedAt.getTime()]);

    const tally = { inExport: rows.length, unknownPerson: 0, alreadyIn: 0, sameCrossing: 0, added: 0 };
    const byDay = new Map<string, number>();
    const touched = new Set<string>();
    for (const { row, who } of rows) {
      const employeeId = person.get(who);
      if (!employeeId) { tally.unknownPerson++; continue; }
      if (heldIds.has(String(row.id))) { tally.alreadyIn++; continue; }
      const when = at(row.punched_at);
      if (!when) continue;
      const near = (heldBy.get(employeeId) ?? []).some((t) => Math.abs(t - when.getTime()) < DUP_MINUTES * 60_000);
      if (near) { tally.sameCrossing++; continue; }
      await tx.insert(punches).values({
        id: String(row.id),
        employeeId,
        type: String(row.punch_type) as "in",
        punchDate: String(row.punch_date),
        punchedAt: when,
        method: (String(row.method) === "manual" ? "manual" : "face") as "face",
        matchScore: num(row.match_score),
        latitude: num(row.latitude),
        longitude: num(row.longitude),
        accuracyM: num(row.accuracy),
        photoUrl: await inhale(row.photo_file),
        resolvedAt: at(row.resolved_at),
        resolutionNote: s(row.resolution_note),
      });
      heldBy.set(employeeId, [...(heldBy.get(employeeId) ?? []), when.getTime()]);
      tally.added++;
      byDay.set(String(row.punch_date), (byDay.get(String(row.punch_date)) ?? 0) + 1);
      touched.add(`${employeeId}|${row.punch_date}`);
    }

    // Resolve the touched days again, under niko's rules.
    for (const k of touched) {
      const [employeeId, day] = k.split("|") as [string, string];
      await recomputeEmployeeDay(tx, employeeId, day);
    }

    // Days where the two systems' punches now run the same way twice in a row:
    // worth a look, though the day's pairing already tolerates them.
    const ids = [...new Set([...touched].map((k) => k.split("|")[0]!))];
    const after = ids.length
      ? await tx
          .select({ employeeId: punches.employeeId, punchDate: punches.punchDate, type: punches.type, punchedAt: punches.punchedAt })
          .from(punches)
          .where(and(inArray(punches.employeeId, ids), gte(punches.punchDate, FROM)))
      : [];
    const days = new Map<string, typeof after>();
    for (const p of after) if (touched.has(`${p.employeeId}|${p.punchDate}`)) days.set(`${p.employeeId}|${p.punchDate}`, [...(days.get(`${p.employeeId}|${p.punchDate}`) ?? []), p]);
    const odd: string[] = [];
    for (const [k, ps] of days) {
      ps.sort((a, b) => a.punchedAt.getTime() - b.punchedAt.getTime());
      if (ps.some((p, i) => i > 0 && p.type === ps[i - 1]!.type)) {
        const [employeeId, day] = k.split("|") as [string, string];
        odd.push(`${day} ${nameOf.get(employeeId) ?? employeeId}: ${ps.map((p) => `${hhmm(p.punchedAt)} ${p.type.toUpperCase()}`).join(", ")}`);
      }
    }

    console.log(`\n  Amino export of ${exp.exportedAt}; punches from ${FROM}: ${tally.inExport}`);
    console.log(`  added               ${tally.added}  (${[...byDay].sort().map(([d, n]) => `${d}: ${n}`).join(", ") || "none"})`);
    console.log(`  already in niko     ${tally.alreadyIn}`);
    console.log(`  same crossing, both gates (within ${DUP_MINUTES} min)  ${tally.sameCrossing}`);
    if (tally.unknownPerson) console.log(`  person not in niko  ${tally.unknownPerson}`);
    if (photosMissing) console.log(`  photos not in the folder  ${photosMissing} (punches added without them)`);
    console.log(`  days resolved again ${touched.size}`);
    if (odd.length) {
      console.log(`  days with the same direction twice (${odd.length}):`);
      for (const o of odd.slice(0, 20)) console.log(`    ${o}`);
    }
    if (!APPLY) throw new DryRun();
  });
  console.log(`\n  Written.\n`);
} catch (e) {
  if (e instanceof DryRun) console.log(`\n  Dry run — nothing written. Re-run with --apply.\n`);
  else { console.error(e); process.exitCode = 1; }
}
process.exit(process.exitCode ?? 0);
