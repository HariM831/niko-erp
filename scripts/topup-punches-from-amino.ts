/**
 * Bring across the Amino punches the history import never saw — punches, and
 * the canteen plates served beside them.
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
 * The canteen had the same gap: its plates came across up to 25 Sep 12:56 and
 * niko's own canteen gate served its first at 12:21 on the 26th, so 25 Sep's
 * afternoon lunch, its dinner and 26 Sep's breakfast were on Amino alone.
 * Plates follow the same rules:
 *
 *   - a plate already in niko (Amino's id, or client id `amino:<id>`) is left
 *     alone;
 *   - a plate for a person niko already served that meal that day is the same
 *     plate twice, unless Amino marked it an extra plate;
 *   - everything else is inserted as the history import did.
 *
 * A wage worker is matched by the W-code the history import gave him, and
 * only if the names agree too: a worker Amino added after that import sits
 * at a position in the export another code may now hold.
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
import { canteenServings, canteens, employees, punches } from "@shared/schema";
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
    const sameName = (a: unknown, b: unknown) => String(a ?? "").trim().toUpperCase() === String(b ?? "").trim().toUpperCase();
    const misplaced: string[] = [];
    (D.wage_workers ?? []).forEach((w, i) => {
      const code = `W-${String(i + 1).padStart(4, "0")}`;
      const id = byCode.get(code);
      if (!id) return;
      if (sameName(nameOf.get(id), w.name)) person.set(String(w.id), id);
      else misplaced.push(`${w.name} → ${code} is ${nameOf.get(id)}`);
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

    /* ── Canteen plates ─────────────────────────────────────────────────── */

    // Amino's canteen is niko's by id (the history import kept it), else by code.
    const nikoCanteens = await tx.select({ id: canteens.id, code: canteens.code }).from(canteens);
    const canteenId = new Map<string, string>();
    for (const c of D.canteens ?? []) {
      const hit = nikoCanteens.find((n) => n.id === String(c.id)) ?? nikoCanteens.find((n) => n.code === String(c.code));
      if (hit) canteenId.set(String(c.id), hit.id);
    }

    const plates = (D.canteen_servings ?? []).filter((v) => String(v.meal_date) >= FROM);
    const served = await tx
      .select({ id: canteenServings.id, clientId: canteenServings.clientId, canteenId: canteenServings.canteenId, mealDate: canteenServings.mealDate, meal: canteenServings.meal, employeeId: canteenServings.employeeId })
      .from(canteenServings)
      .where(gte(canteenServings.mealDate, FROM));
    const servedIds = new Set(served.flatMap((v) => [v.id, v.clientId]));
    const plateKey = (canteen: string, day: string, meal: string, employeeId: string) => `${canteen}|${day}|${meal}|${employeeId}`;
    const servedTo = new Set(served.filter((v) => v.employeeId).map((v) => plateKey(v.canteenId, v.mealDate, v.meal, v.employeeId!)));

    const plateTally = { inExport: plates.length, unknownCanteen: 0, unknownPerson: 0, alreadyIn: 0, samePlate: 0, added: 0, guests: 0 };
    const platesByMeal = new Map<string, number>();
    for (const v of plates) {
      const canteen = canteenId.get(String(v.canteen_id));
      if (!canteen) { plateTally.unknownCanteen++; continue; }
      if (servedIds.has(String(v.id)) || servedIds.has(`amino:${v.id}`)) { plateTally.alreadyIn++; continue; }
      const guest = String(v.person_type) === "guest";
      const employeeId = v.person_id ? (person.get(String(v.person_id)) ?? null) : null;
      if (!employeeId && !guest) { plateTally.unknownPerson++; continue; }
      const key = employeeId ? plateKey(canteen, String(v.meal_date), String(v.meal), employeeId) : null;
      if (key && servedTo.has(key) && !v.extra_plate_kind) { plateTally.samePlate++; continue; }
      await tx.insert(canteenServings).values({
        id: String(v.id),
        clientId: `amino:${v.id}`,
        canteenId: canteen,
        mealDate: String(v.meal_date),
        meal: String(v.meal) as "breakfast",
        employeeId,
        personName: s(v.person_name) ?? "—",
        state: (["verified", "name_matched", "unverified_attendance", "override", "guest"].includes(String(v.state))
          ? v.state
          : "override") as "verified",
        matchScore: num(v.match_score),
        servedAt: at(v.served_at) ?? new Date(),
        tokenNumber: String(v.token_number ?? `AMINO-${String(v.id).slice(0, 8)}`),
        outsideWindow: !!v.outside_window,
        guestParty: s(v.guest_party) ?? (guest ? s(v.person_name) : null),
        reasonText: s(v.reason_text) ?? s(v.reason),
        attendancePresent: v.attendance_present == null ? null : !!v.attendance_present,
        syncedAt: at(v.synced_at) ?? undefined,
      });
      if (key) servedTo.add(key);
      if (guest) plateTally.guests++;
      plateTally.added++;
      const m = `${v.meal_date} ${v.meal}`;
      platesByMeal.set(m, (platesByMeal.get(m) ?? 0) + 1);
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
    if (misplaced.length) {
      console.log(`  wage workers left out — the W-code at their place is someone else (${misplaced.length}):`);
      for (const m of misplaced) console.log(`    ${m}`);
    }

    console.log(`\n  Canteen plates from ${FROM}: ${plateTally.inExport}`);
    console.log(`  added               ${plateTally.added}${plateTally.guests ? ` (${plateTally.guests} guests)` : ""}  (${[...platesByMeal].sort().map(([m, n]) => `${m}: ${n}`).join(", ") || "none"})`);
    console.log(`  already in niko     ${plateTally.alreadyIn}`);
    console.log(`  same plate, both gates  ${plateTally.samePlate}`);
    if (plateTally.unknownPerson) console.log(`  person not in niko  ${plateTally.unknownPerson}`);
    if (plateTally.unknownCanteen) console.log(`  canteen not in niko ${plateTally.unknownCanteen}`);
    if (!APPLY) throw new DryRun();
  });
  console.log(`\n  Written.\n`);
} catch (e) {
  if (e instanceof DryRun) console.log(`\n  Dry run — nothing written. Re-run with --apply.\n`);
  else { console.error(e); process.exitCode = 1; }
}
process.exit(process.exitCode ?? 0);
