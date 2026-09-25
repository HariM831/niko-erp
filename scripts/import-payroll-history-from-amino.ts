/**
 * Bring Amino's payroll history across: the attendance it resolved, the
 * punches behind it, leave, advances, the runs and slips people were paid
 * from, overtime, and the canteen.
 *
 * The people come first — `import-people-from-amino.ts` — because everything
 * here hangs off them. A person this file cannot place is reported and their
 * rows are skipped, never guessed at.
 *
 * Dry by default: it resolves everything, says what it would write, and rolls
 * back. `--apply` commits, in ONE transaction, so a failure half-way leaves
 * nothing behind rather than a payroll that is half here.
 *
 * Decisions taken here, because they are not obvious from the data:
 *
 *  - Amino's ids are kept as niko's. A re-run of the same export is then an
 *    upsert rather than a second copy, which is what makes a top-up safe.
 *  - Attendance days arrive as `source: "import"` — Amino's own resolver
 *    counted them, under Amino's rules (a half day paid in full), and niko's
 *    resolver never touches a day it did not resolve. Where Amino's word for
 *    the day is finer than niko's letter ("CompOff", "CL", "SL"), it is kept
 *    in the note, so the history says how it was counted.
 *  - Only July and August are resolved: they are the closed months. September
 *    arrives as punches alone, and niko resolves it with its own rules.
 *  - The two runs were still `draft` in Amino, but their slips are what people
 *    were paid. They land CONFIRMED, so niko will not recompute a month that
 *    is already in somebody's bank account, and with NO journal entry: the
 *    salary journals come across from Zoho, and posting again would double the
 *    expense. [[gst-is-an-irrecoverable-expense]] is unrelated; this is simply
 *    one expense, recorded once.
 *  - Amino's user ids (who marked a punch, who approved leave) mean nothing in
 *    niko, so they are dropped rather than pointed at a stranger. What HR
 *    typed survives in the notes.
 *  - Daily-wage workers have no resolved days in Amino at all; their punches
 *    come across and niko's wage sheet reads those.
 *
 * Timestamps in the export are UTC without a zone, so every instant is read
 * as UTC and stored as an instant. Dates (a day, a month) are left as they are
 * — they are calendar days in IST and mean the same thing on both sides.
 * [[dates-never-toisostring]]
 *
 *   npx tsx scripts/import-payroll-history-from-amino.ts --dir payroll-export
 *   npx tsx scripts/import-payroll-history-from-amino.ts --dir payroll-export --apply
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import {
  advanceRepayments,
  advances,
  attendanceDays,
  canteenMealEligibility,
  canteenMealWindows,
  canteenServings,
  canteens,
  employees,
  holidays,
  leaveApplications,
  locations,
  payInputs,
  payrollRuns,
  punches,
  salarySlips,
  shiftAssignments,
  shifts,
} from "@shared/schema";
import { db } from "../server/db";
import { istDate, recomputeRange } from "../server/services/day-resolution";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const DIR = arg("dir") ?? "payroll-export";
const APPLY = process.argv.includes("--apply");

type Row = Record<string, any>;
const exp = JSON.parse(await readFile(path.join(DIR, "payroll-export.json"), "utf8")) as {
  exportedAt: string;
  lastClosedMonth: string;
  data: Record<string, Row[]>;
};
const D = exp.data;

const say = (s = "") => console.log(s);
let problems = 0;
const problem = (s: string) => {
  problems++;
  console.log(`   ! ${s}`);
};

const s = (v: unknown) => (v == null || v === "" ? null : String(v));
const num = (v: unknown) => (v == null ? null : Number(v));
const money = (v: unknown) => (Number(v ?? 0) || 0).toFixed(2);
/** Amino writes UTC without a zone; say so rather than let the server guess. */
const at = (v: unknown): Date | null => {
  const t = s(v);
  if (!t) return null;
  const iso = t.includes("T") ? t : t.replace(" ", "T");
  return new Date(/[Zz]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
};

/**
 * A photograph travels as a file beside the JSON and is stored as niko stores
 * its own — a data URL on the row. The export writes the path from the folder
 * root ("photos/punch/x.jpg"), so it is joined as given.
 */
let photosMissing = 0;
const inhale = async (file: unknown): Promise<string | null> => {
  if (typeof file !== "string" || !file) return null;
  try {
    const buf = await readFile(path.join(DIR, file));
    return `data:image/jpeg;base64,${buf.toString("base64")}`;
  } catch {
    photosMissing++;
    return null;
  }
};

say("\n  IMPORT PAYROLL HISTORY FROM AMINO");
say(`  export of ${exp.exportedAt} — months to ${exp.lastClosedMonth} resolved in full`);
say();

/** Thrown by the dry run's deliberate rollback, and by nothing else. */
class DryRun extends Error {}

try {
await db.transaction(async (tx) => {
  /* ── Who is who ─────────────────────────────────────────────────────────
   * Salaried people match on their code. Daily-wage workers have none in
   * Amino; the people import gave them W-0001… in enrolment order, and this
   * export lists them in that same order, so the same walk rebuilds the map.
   */
  const niko = await tx.select({ id: employees.id, code: employees.empCode }).from(employees);
  const byCode = new Map(niko.map((e) => [e.code, e.id]));
  const person = new Map<string, string>();
  for (const e of D.employees ?? []) {
    const id = byCode.get(String(e.emp_code));
    if (id) person.set(String(e.id), id);
    else problem(`${e.emp_code} ${e.name} is not in niko — their history is skipped`);
  }
  (D.wage_workers ?? []).forEach((w, i) => {
    const id = byCode.get(`W-${String(i + 1).padStart(4, "0")}`);
    if (id) person.set(String(w.id), id);
    else problem(`wage worker ${w.name} (W-${String(i + 1).padStart(4, "0")}) is not in niko — skipped`);
  });
  say(`  people              ${person.size} of ${(D.employees?.length ?? 0) + (D.wage_workers?.length ?? 0)} matched`);

  /* ── Holidays, shifts, rosters ──────────────────────────────────────── */
  let holidayCount = 0;
  const seenHoliday = new Set<string>();
  for (const h of D.holidays ?? []) {
    const key = `${h.date}|${h.name}`;
    if (seenHoliday.has(key)) continue; // Amino's seed re-inserted them on boot
    seenHoliday.add(key);
    const existing = await tx
      .select({ id: holidays.id })
      .from(holidays)
      .where(and(eq(holidays.date, String(h.date)), eq(holidays.name, String(h.name))));
    if (existing.length) continue;
    await tx.insert(holidays).values({
      id: String(h.id),
      name: String(h.name),
      date: String(h.date),
      type: (["national", "regional", "company"].includes(String(h.type)) ? h.type : "company") as "national",
      isRecurring: !!h.is_recurring,
    });
    holidayCount++;
  }

  const shiftId = new Map<string, string>();
  let shiftCount = 0;
  for (const sh of D.shifts ?? []) {
    const [existing] = await tx.select({ id: shifts.id }).from(shifts).where(eq(shifts.name, String(sh.name)));
    if (existing) {
      shiftId.set(String(sh.id), existing.id);
      continue;
    }
    const [made] = await tx
      .insert(shifts)
      .values({
        id: String(sh.id),
        name: String(sh.name),
        startTime: String(sh.start_time),
        endTime: String(sh.end_time),
        workingHours: Number(sh.working_hours ?? 8),
        weeklyOffDays: (sh.weekly_off_days ?? []) as number[],
        color: s(sh.color) ?? undefined,
        isActive: sh.is_active !== false,
      })
      .returning({ id: shifts.id });
    shiftId.set(String(sh.id), made!.id);
    shiftCount++;
  }

  let rosterCount = 0;
  for (const a of D.shift_assignments ?? []) {
    const employeeId = person.get(String(a.employee_id));
    const shift = shiftId.get(String(a.shift_id));
    if (!employeeId || !shift) continue;
    const done = await tx
      .insert(shiftAssignments)
      .values({
        id: String(a.id),
        employeeId,
        shiftId: shift,
        effectiveFrom: String(a.effective_from),
        effectiveTo: s(a.effective_to),
        notes: s(a.notes),
        weeklyOffDays: (a.weekly_off_override ?? null) as number[] | null,
      })
      .onConflictDoNothing()
      .returning({ id: shiftAssignments.id });
    rosterCount += done.length;
  }
  say(`  reference data      ${holidayCount} holidays, ${shiftCount} shifts, ${rosterCount} roster rows`);

  /* ── Attendance, as Amino counted it ────────────────────────────────────
   * niko's letters and Amino's agree (P, H, A, WO, HO, L). Where Amino's own
   * word says more than the letter — a comp-off, which leave it was — it is
   * kept in the note, because "L" alone cannot answer "which leave was that".
   */
  let dayCount = 0;
  for (const r of D.resolved_days ?? []) {
    const employeeId = person.get(String(r.employee_id));
    if (!employeeId) continue;
    const amino = s(r.amino_status);
    const note =
      amino && amino !== String(r.status)
        ? `Amino: ${amino}${r.hr_override ? " (HR)" : ""}`
        : r.hr_override
          ? "Amino: set by HR"
          : null;
    await tx
      .insert(attendanceDays)
      .values({
        employeeId,
        day: String(r.day),
        status: String(r.status) as "P",
        source: "import",
        note,
      })
      .onConflictDoUpdate({
        target: [attendanceDays.employeeId, attendanceDays.day],
        set: { status: String(r.status) as "P", source: "import", note, updatedAt: new Date() },
      });
    dayCount++;
  }
  say(`  attendance days     ${dayCount} imported (Amino's own resolution)`);

  /* ── Punches: the evidence, including the open month ──────────────────── */
  let punchCount = 0;
  let photoCount = 0;
  const punchRows: Array<{ row: Row; worker: boolean }> = [
    ...(D.attendance_punches ?? []).map((row) => ({ row, worker: false })),
    ...(D.wage_punches ?? []).map((row) => ({ row, worker: true })),
  ];
  for (const { row, worker } of punchRows) {
    const employeeId = person.get(String(worker ? row.worker_id : row.employee_id));
    if (!employeeId) continue;
    const photoUrl = await inhale(row.photo_file);
    if (photoUrl) photoCount++;
    // ONLY what HR actually wrote. The note is not a free field: a note with
    // no `resolvedAt` is how niko says "HR closed this day by hand", and the
    // face-health reading throws those rows out — so stamping "Amino browser"
    // on all 16,835 punches made every one of them invisible to it. Where the
    // punch came from is already said by the day's own source, `import`.
    const note = s(row.resolution_note);
    const done = await tx
      .insert(punches)
      .values({
        id: String(row.id),
        employeeId,
        type: String(row.punch_type) as "in",
        punchDate: String(row.punch_date),
        punchedAt: at(row.punched_at) ?? new Date(),
        method: (String(row.method) === "manual" ? "manual" : "face") as "face",
        matchScore: num(row.match_score),
        latitude: num(row.latitude),
        longitude: num(row.longitude),
        accuracyM: num(row.accuracy),
        photoUrl,
        resolvedAt: at(row.resolved_at),
        resolutionNote: note,
      })
      .onConflictDoNothing()
      .returning({ id: punches.id });
    punchCount += done.length;
  }
  say(`  punches             ${punchCount} imported, ${photoCount} with a photograph`);

  /* ── Leave ──────────────────────────────────────────────────────────────
   * Amino's approver is a name, not a niko user, so it goes in the remarks
   * rather than into decidedBy pointing at nobody.
   */
  let leaveCount = 0;
  for (const l of D.leave_applications ?? []) {
    const employeeId = person.get(String(l.employee_id));
    if (!employeeId) continue;
    const type = ["CL", "SL", "CompOff"].includes(String(l.leave_type)) ? String(l.leave_type) : "CL";
    if (type !== String(l.leave_type)) problem(`leave ${l.id}: type "${l.leave_type}" read as CL`);
    const approver = s(l.approver_name) ?? s(l.approved_by);
    const remarks = [s(l.remarks), approver ? `Approved in Amino by ${approver}` : null]
      .filter(Boolean)
      .join(" · ");
    const done = await tx
      .insert(leaveApplications)
      .values({
        id: String(l.id),
        employeeId,
        leaveType: type as "CL",
        fromDate: String(l.from_date),
        toDate: String(l.to_date),
        days: Number(l.days ?? 0),
        reason: s(l.reason) ?? "—",
        status: (["pending", "approved", "rejected"].includes(String(l.status)) ? l.status : "approved") as "approved",
        compOffWorkDate: s(l.comp_off_work_date),
        remarks: remarks || null,
        appliedAt: at(l.applied_at) ?? new Date(),
      })
      .onConflictDoNothing()
      .returning({ id: leaveApplications.id });
    leaveCount += done.length;
  }
  say(`  leave               ${leaveCount} applications`);

  /* ── Advances and what has been recovered ───────────────────────────────
   * niko derives what is outstanding from the repayments, so Amino's own
   * `outstanding` is checked rather than stored: a mismatch means one of the
   * two is wrong, and it is better said out loud than quietly imported.
   */
  let advCount = 0;
  let repCount = 0;
  for (const a of D.employee_advances ?? []) {
    const employeeId = person.get(String(a.employee_id));
    if (!employeeId) continue;
    const repaid = (D.advance_repayments ?? [])
      .filter((r) => String(r.advance_id) === String(a.id))
      .reduce((sum, r) => sum + Number(r.amount ?? 0), 0);
    const derived = Number(a.amount ?? 0) - repaid;
    if (Math.abs(derived - Number(a.outstanding ?? 0)) > 0.5) {
      problem(
        `advance ${a.emp_code ?? a.employee_name}: Amino says ${a.outstanding} outstanding, its repayments leave ${derived}`,
      );
    }
    const done = await tx
      .insert(advances)
      .values({
        id: String(a.id),
        employeeId,
        type: (String(a.type) === "loan" ? "loan" : "salary_advance") as "salary_advance",
        amount: money(a.amount),
        emiAmount: money(a.emi_amount),
        givenOn: String(a.given_date),
        reason: [s(a.reason), s(a.notes)].filter(Boolean).join(" · ") || null,
        status: (["active", "closed", "cancelled"].includes(String(a.status)) ? a.status : "active") as "active",
        createdAt: at(a.created_at) ?? new Date(),
      })
      .onConflictDoNothing()
      .returning({ id: advances.id });
    advCount += done.length;
  }
  for (const r of D.advance_repayments ?? []) {
    const done = await tx
      .insert(advanceRepayments)
      .values({
        id: String(r.id),
        advanceId: String(r.advance_id),
        amount: money(r.amount),
        month: Number(r.month),
        year: Number(r.year),
        notes: [s(r.notes), "recovered in Amino"].filter(Boolean).join(" · "),
        createdAt: at(r.created_at) ?? new Date(),
      })
      .onConflictDoNothing()
      .returning({ id: advanceRepayments.id });
    repCount += done.length;
  }
  say(`  advances            ${advCount} advances, ${repCount} repayments`);

  /* ── The runs people were paid from ─────────────────────────────────────
   * Confirmed, so niko never recomputes a month already paid, and with no
   * journal: Zoho carries the salary entries for these months.
   */
  const summary = new Map<string, Row>();
  for (const m of D.month_summaries ?? []) summary.set(`${m.employee_id}|${m.year}-${m.month}`, m);

  let runCount = 0;
  for (const r of D.payroll_runs ?? []) {
    const done = await tx
      .insert(payrollRuns)
      .values({
        id: String(r.id),
        month: Number(r.month),
        year: Number(r.year),
        status: "confirmed",
        employeeCount: Number(r.employee_count ?? 0),
        totalGross: money(r.total_gross),
        totalDeductions: money(r.total_deductions),
        totalNet: money(r.total_net),
        processedAt: at(r.processed_at),
        confirmedAt: at(r.processed_at),
        createdAt: at(r.created_at) ?? new Date(),
      })
      .onConflictDoNothing()
      .returning({ id: payrollRuns.id });
    runCount += done.length;
  }

  let slipCount = 0;
  for (const sl of D.salary_slips ?? []) {
    const employeeId = person.get(String(sl.employee_id));
    if (!employeeId) continue;
    const m = summary.get(`${sl.employee_id}|${sl.year}-${sl.month}`);
    const done = await tx
      .insert(salarySlips)
      .values({
        id: String(sl.id),
        payrollRunId: String(sl.payroll_run_id),
        employeeId,
        payType: "salaried",
        totalDays: Number(sl.total_days ?? 0),
        presentDays: Number(m?.presentDays ?? 0),
        halfDays: Number(m?.halfDays ?? 0),
        weeklyOffs: Number(m?.weeklyOffs ?? 0),
        holidays: Number(m?.holidayDays ?? 0),
        leaveDays: Number(m?.leaveDays ?? 0),
        paidDays: Number(sl.paid_days ?? 0),
        lopDays: Number(sl.lop_days ?? 0),
        basicSalary: money(sl.basic_salary),
        hra: money(sl.hra),
        allowances: money(sl.allowances),
        earnedBasic: money(sl.earned_basic),
        earnedHra: money(sl.earned_hra),
        earnedAllowances: money(sl.earned_allowances),
        earnedGross: money(sl.earned_gross),
        bonus: money(sl.bonus_amount),
        overtime: money(sl.overtime_amount),
        reimbursement: money(sl.expense_reimbursement),
        arrears: money(sl.arrears_amount),
        pfEmployee: money(sl.pf_employee),
        pfEmployer: money(sl.pf_employer),
        esiEmployee: money(sl.esi_employee),
        esiEmployer: money(sl.esi_employer),
        advanceRecovery: money(sl.advance_deduction),
        totalDeductions: money(sl.total_deductions),
        netPay: money(sl.net_salary),
        bankName: s(sl.bank_name),
        bankAccountNumber: s(sl.bank_account_number),
        bankIfsc: s(sl.bank_ifsc),
      })
      .onConflictDoNothing()
      .returning({ id: salarySlips.id });
    slipCount += done.length;
  }
  say(`  payroll             ${runCount} runs (confirmed, no journal), ${slipCount} slips`);

  /* ── Overtime: a pay input in niko ──────────────────────────────────── */
  let otCount = 0;
  for (const o of D.employee_overtime ?? []) {
    const employeeId = person.get(String(o.employee_id));
    if (!employeeId) continue;
    const done = await tx
      .insert(payInputs)
      .values({
        id: String(o.id),
        employeeId,
        kind: "overtime",
        month: Number(o.month),
        year: Number(o.year),
        amount: money(o.amount),
        hours: num(o.hours),
        ratePerHour: o.rate_per_hour == null ? null : money(o.rate_per_hour),
        description: s(o.description),
        status: (String(o.status) === "paid" ? "paid" : "approved") as "paid",
        payrollRunId: s(o.payroll_run_id),
        createdAt: at(o.created_at) ?? new Date(),
      })
      .onConflictDoNothing()
      .returning({ id: payInputs.id });
    otCount += done.length;
  }
  say(`  pay inputs          ${otCount} overtime rows`);

  /* ── Canteen ────────────────────────────────────────────────────────────
   * One canteen, one site: niko keeps canteens under a location, and there is
   * only one for it to belong to. More than one and this would have to ask.
   */
  const sites = await tx.select({ id: locations.id, name: locations.name }).from(locations);
  const canteenId = new Map<string, string>();
  let canteenCount = 0;
  for (const c of D.canteens ?? []) {
    const [existing] = await tx.select({ id: canteens.id }).from(canteens).where(eq(canteens.code, String(c.code)));
    if (existing) {
      canteenId.set(String(c.id), existing.id);
      continue;
    }
    if (!sites.length) {
      problem(`canteen ${c.name}: niko has no location to put it in — skipped`);
      continue;
    }
    if (sites.length > 1) problem(`canteen ${c.name}: put at ${sites[0]!.name}, the first of ${sites.length} sites`);
    const [made] = await tx
      .insert(canteens)
      .values({
        id: String(c.id),
        code: String(c.code),
        name: String(c.name),
        locationId: sites[0]!.id,
        isActive: c.is_active !== false,
      })
      .returning({ id: canteens.id });
    canteenId.set(String(c.id), made!.id);
    canteenCount++;
  }

  let windowCount = 0;
  for (const w of D.canteen_meal_windows ?? []) {
    const done = await tx
      .insert(canteenMealWindows)
      .values({
        id: String(w.id),
        canteenId: w.canteen_id ? (canteenId.get(String(w.canteen_id)) ?? null) : null,
        meal: String(w.meal) as "breakfast",
        startTime: String(w.start_time),
        endTime: String(w.end_time),
        isActive: w.is_active !== false,
      })
      .onConflictDoNothing()
      .returning({ id: canteenMealWindows.id });
    windowCount += done.length;
  }

  let eligibleCount = 0;
  for (const e of D.canteen_meal_eligibility ?? []) {
    const employeeId = person.get(String(e.person_id));
    if (!employeeId) continue;
    await tx
      .insert(canteenMealEligibility)
      .values({
        employeeId,
        breakfast: !!e.breakfast,
        dinner: !!e.dinner,
        note: s(e.note),
        updatedAt: at(e.updated_at) ?? new Date(),
      })
      .onConflictDoUpdate({
        target: canteenMealEligibility.employeeId,
        set: { breakfast: !!e.breakfast, dinner: !!e.dinner, note: s(e.note) },
      });
    eligibleCount++;
  }

  let servingCount = 0;
  let guestCount = 0;
  for (const v of D.canteen_servings ?? []) {
    const canteen = canteenId.get(String(v.canteen_id));
    if (!canteen) continue;
    const employeeId = v.person_id ? (person.get(String(v.person_id)) ?? null) : null;
    if (!employeeId && String(v.person_type) !== "guest") continue;
    if (!employeeId) guestCount++;
    const done = await tx
      .insert(canteenServings)
      .values({
        id: String(v.id),
        // The client id is what stops a device's retry serving twice; Amino's
        // own row id is as unique and travels with it.
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
        guestParty: s(v.guest_party) ?? (String(v.person_type) === "guest" ? s(v.person_name) : null),
        reasonText: s(v.reason_text) ?? s(v.reason),
        attendancePresent: v.attendance_present == null ? null : !!v.attendance_present,
        syncedAt: at(v.synced_at),
      })
      .onConflictDoNothing()
      .returning({ id: canteenServings.id });
    servingCount += done.length;
  }
  say(
    `  canteen             ${canteenCount} canteen, ${windowCount} windows, ${eligibleCount} eligibility, ${servingCount} servings (${guestCount} guests)`,
  );

  /* ── The open month ─────────────────────────────────────────────────────
   * Amino closed July and August; September it never resolved, so those days
   * arrive as punches and nothing else. niko resolves a day when a punch
   * comes through its own gate — these did not — so the month is resolved
   * here, once, with niko's own rules. Imported and HR-set days are left
   * exactly as they are, so this cannot touch what Amino counted.
   */
  const [y, m] = exp.lastClosedMonth.split("-").map(Number);
  const firstOpen = m === 12 ? `${y! + 1}-01-01` : `${y}-${String(m! + 1).padStart(2, "0")}-01`;
  const today = istDate();
  const resolved =
    firstOpen <= today ? await recomputeRange(tx, firstOpen, today, [...person.values()]) : { rows: 0, employees: 0 };
  say(`  open month          ${resolved.rows} days resolved by niko, ${firstOpen} to ${today}`);

  if (photosMissing) problem(`${photosMissing} punch photograph(s) not in the folder — rows imported without them`);
  say();
  if (!APPLY) {
    say(`  dry run rolled back — nothing written${problems ? ` (${problems} problems above)` : ""}`);
    throw new DryRun();
  }
  say(`  applied${problems ? ` with ${problems} problems noted above` : ""}`);
});
} catch (err) {
  if (!(err instanceof DryRun)) throw err;
}

process.exit(0);
