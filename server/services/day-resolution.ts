/**
 * Day resolution: what happened on one employee-day.
 *
 * The one place the precedence lives — punch > holiday > approved leave >
 * weekly off > absent — because Amino had three copies of it (the gate
 * calendar, the monthly table, payroll processing) and they disagreed.
 * Everything downstream reads `attendance_days`, which this module writes;
 * nothing else derives a day's status.
 *
 * A punch always wins: someone who actually worked a holiday is present (and
 * comp-off eligible), not on holiday. A `manual` row is an HR decision and an
 * `import` row is history somebody typed in — recompute never touches either.
 *
 * Dates are IST business dates as YYYY-MM-DD strings; the server may run in
 * UTC and the farm does not.
 *
 * A punch's `punch_date` is the day its SHIFT belongs to, not the calendar date
 * it happened on. For a day worker the two are the same. For a night worker who
 * came in at 20:00 and left at 06:00, both punches belong to the first date —
 * which is what lets every reader here pair them by the stored date and never
 * think about midnight. The gate and the HR resolve route both file an exit
 * under its entry's day; see `punchDayFor`.
 */
import { and, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  attendanceDays,
  employees,
  holidays,
  leaveApplications,
  payrollSettings,
  punches,
  shiftAssignments,
  shifts,
} from "@shared/schema";
import type { Db, Tx } from "../db";

type Conn = Tx | Db;

/* ── IST ───────────────────────────────────────────────────────────────── */

/** IST calendar date (YYYY-MM-DD) for an instant, or now. */
export function istDate(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(d);
}

/** IST date N days before today. */
export function istDaysAgo(days: number): string {
  return istDate(new Date(Date.now() - days * 86_400_000));
}

/** Add days to a YYYY-MM-DD string without ever touching a local timezone. */
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday, for a YYYY-MM-DD string. */
export function weekdayOf(day: string): number {
  return new Date(`${day}T00:00:00Z`).getUTCDay();
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function monthRange(year: number, month: number): { from: string; to: string } {
  const mm = String(month).padStart(2, "0");
  return { from: `${year}-${mm}-01`, to: `${year}-${mm}-${String(daysInMonth(year, month)).padStart(2, "0")}` };
}

/* ── Types ─────────────────────────────────────────────────────────────── */

export type AttendanceStatus = "P" | "H" | "A" | "WO" | "HO" | "L";
export type AttendanceSource = "punch" | "holiday" | "leave" | "weekly_off" | "absent" | "manual" | "import";

export interface PunchLike {
  id: string;
  type: "in" | "out";
  punchedAt: Date;
  /** Set once HR has ruled on a dangling entry; such an entry is never carried. */
  resolvedAt?: Date | null;
}

export interface ShiftLike {
  id: string;
  name: string;
  weeklyOffDays: number[];
  /** "HH:MM". A shift that ends at or before it starts runs past midnight. */
  startTime?: string;
  endTime?: string;
}

/** One shift assignment; `weeklyOffDays` null means "the shift's own". */
export interface AssignmentLike {
  shiftId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  weeklyOffDays: number[] | null;
}

export interface EmployeeLike {
  id: string;
  dateOfJoining: string | null;
  dateOfLeaving: string | null;
}

export interface ResolveContext {
  fullDayHours: number;
  halfDayHours: number;
  /** `${employeeId}|${day}` → punches, any order. */
  punchesByEmpDay: Map<string, PunchLike[]>;
  /** day → holiday name; recurring holidays already expanded onto the year(s) in range. */
  holidaysByDate: Map<string, string>;
  /** employeeId → approved leaves. */
  leavesByEmp: Map<string, { fromDate: string; toDate: string; leaveType: string }[]>;
  /** employeeId → assignments, any order. */
  assignmentsByEmp: Map<string, AssignmentLike[]>;
  shiftById: Map<string, ShiftLike>;
  /** IST today — a day after this with no punches is not written at all. */
  today: string;
  /** The instant of resolving; decides whether a night shift may still be open. */
  now: Date;
}

export interface DayResolution {
  status: AttendanceStatus;
  source: Exclude<AttendanceSource, "manual" | "import">;
  workedHours: number;
  /** The day ended on an unmatched `in` — listed as an exception for HR. */
  openIn: boolean;
  /** Worked on a day that would otherwise have been off — comp-off candidate. */
  compOffEligible: boolean;
  shift?: ShiftLike;
}

/* ── Punches → hours ───────────────────────────────────────────────────── */

export interface DaySummary {
  hours: number;
  firstIn: Date | null;
  lastOut: Date | null;
  openIn: boolean;
  openInPunch: PunchLike | null;
  punchCount: number;
}

/**
 * Pair punches chronologically in→out. A stray `out` with nothing open is
 * ignored; consecutive `in`s keep the earliest so a double tap at the gate
 * never shortens the interval.
 */
export function summarizeDay(list: PunchLike[]): DaySummary {
  const sorted = [...list].sort((a, b) => a.punchedAt.getTime() - b.punchedAt.getTime());
  let ms = 0;
  let anchor: PunchLike | null = null;
  let firstIn: Date | null = null;
  let lastOut: Date | null = null;
  for (const p of sorted) {
    if (p.type === "in") {
      if (!anchor) anchor = p;
      if (!firstIn) firstIn = p.punchedAt;
    } else if (anchor) {
      ms += p.punchedAt.getTime() - anchor.punchedAt.getTime();
      anchor = null;
      lastOut = p.punchedAt;
    }
  }
  return { hours: ms / 3_600_000, firstIn, lastOut, openIn: anchor !== null, openInPunch: anchor, punchCount: sorted.length };
}

export function statusForHours(hours: number, ctx: Pick<ResolveContext, "fullDayHours" | "halfDayHours">): "P" | "H" | "A" {
  if (hours >= ctx.fullDayHours) return "P";
  if (hours >= ctx.halfDayHours) return "H";
  return "A";
}

/* ── Night shifts ──────────────────────────────────────────────────────── */

/** Longer than this and an open entry is a forgotten exit, not a shift in progress. */
export const NIGHT_SHIFT_MAX_HOURS = 16;
/** With no shift assigned, an entry from this IST hour on is taken to be a night's. */
const NIGHT_ENTRY_FROM_HOUR = 15;

export function isOvernightShift(shift: { startTime?: string; endTime?: string } | undefined): boolean {
  return !!shift?.startTime && !!shift.endTime && shift.endTime <= shift.startTime;
}

/** IST hour of day, 0–23, for an instant. */
export function istHour(d: Date): number {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", hour12: false }).format(d)) % 24;
}

/**
 * May this open entry still be closed by an exit after midnight?
 *
 * Amino's rule was the age alone: any open entry under sixteen hours old. That
 * takes a day worker who forgot to punch out at 17:00 and turns his 08:00
 * return into the end of a fifteen-hour shift, losing the morning's entry with
 * it. So the person has to have been on a night: on an overnight shift that
 * day, or, with no shift assigned, in from mid-afternoon on. Daily-wage workers
 * are people like any other here.
 */
export function nightShiftStillOpen(entry: PunchLike, shift: ShiftLike | undefined, now: Date): boolean {
  if (entry.type !== "in" || entry.resolvedAt) return false;
  const ageH = (now.getTime() - entry.punchedAt.getTime()) / 3_600_000;
  if (ageH < 0 || ageH > NIGHT_SHIFT_MAX_HOURS) return false;
  return shift ? isOvernightShift(shift) : istHour(entry.punchedAt) >= NIGHT_ENTRY_FROM_HOUR;
}

/* ── Resolution ────────────────────────────────────────────────────────── */

export function assignmentForDate<T extends { effectiveFrom: string; effectiveTo: string | null }>(
  day: string,
  assignments: T[],
): T | undefined {
  return assignments.find((a) => a.effectiveFrom <= day && (!a.effectiveTo || a.effectiveTo >= day));
}

export function shiftForDate(
  day: string,
  assignments: { shiftId: string; effectiveFrom: string; effectiveTo: string | null }[],
  shiftById: Map<string, ShiftLike>,
): ShiftLike | undefined {
  const a = assignmentForDate(day, assignments);
  return a ? shiftById.get(a.shiftId) : undefined;
}

/**
 * Weekly off from the shift; an unassigned employee still gets Sunday.
 *
 * `override` is the person's own off days on this assignment — one man on the
 * day shift rests on Wednesday. Null defers to the shift; an empty list is a
 * real answer and means no weekly off at all.
 */
export function isWeeklyOff(day: string, shift: ShiftLike | undefined, override?: number[] | null): boolean {
  const wd = weekdayOf(day);
  if (override) return override.includes(wd);
  return shift ? (shift.weeklyOffDays ?? []).includes(wd) : wd === 0;
}

/** Holiday lookup keyed by date, recurring ones re-dated onto every year in [from, to]. */
export function buildHolidayMap(
  rows: { name: string; date: string; isRecurring: boolean }[],
  from: string,
  to: string,
): Map<string, string> {
  const map = new Map<string, string>();
  const y0 = Number(from.slice(0, 4));
  const y1 = Number(to.slice(0, 4));
  for (const h of rows) {
    if (!h.isRecurring) {
      map.set(h.date, h.name);
      continue;
    }
    for (let y = y0; y <= y1; y++) map.set(`${y}-${h.date.slice(5)}`, h.name);
  }
  return map;
}

/**
 * Resolve one employee-day. Returns null for days outside the employee's
 * service (before joining, after leaving) and for future days with no punch —
 * those get no row.
 */
export function resolveDay(employee: EmployeeLike, day: string, ctx: ResolveContext): DayResolution | null {
  if (employee.dateOfJoining && day < employee.dateOfJoining) return null;
  if (employee.dateOfLeaving && day > employee.dateOfLeaving) return null;

  const list = ctx.punchesByEmpDay.get(`${employee.id}|${day}`) ?? [];
  const assignments = ctx.assignmentsByEmp.get(employee.id) ?? [];
  const assignment = assignmentForDate(day, assignments);
  const shift = assignment ? ctx.shiftById.get(assignment.shiftId) : undefined;
  const holiday = ctx.holidaysByDate.has(day);
  const leave = (ctx.leavesByEmp.get(employee.id) ?? []).some((l) => l.fromDate <= day && l.toDate >= day);
  const wo = isWeeklyOff(day, shift, assignment?.weeklyOffDays);
  const offDay = holiday || leave || wo;

  if (list.length) {
    const s = summarizeDay(list);
    // A forgotten punch-out on a past day: the person was here, so a half day
    // is the fair default until HR resolves it. Today's open `in` is just
    // someone still inside — present-so-far, nothing to decide yet.
    if (s.openIn && s.hours < ctx.halfDayHours) {
      // Yesterday's entry on a night still in progress is someone inside, the
      // same as today's open entry — not a half day to be argued about at 01:00.
      const inside = day >= ctx.today || (s.openInPunch !== null && nightShiftStillOpen(s.openInPunch, shift, ctx.now));
      const status: AttendanceStatus = inside ? "P" : "H";
      return { status, source: "punch", workedHours: round2(s.hours), openIn: true, compOffEligible: offDay, shift };
    }
    const status = statusForHours(s.hours, ctx);
    return {
      status,
      source: "punch",
      workedHours: round2(s.hours),
      openIn: s.openIn,
      compOffEligible: offDay && status !== "A",
      shift,
    };
  }

  if (day > ctx.today) return null;
  if (holiday) return { status: "HO", source: "holiday", workedHours: 0, openIn: false, compOffEligible: false, shift };
  if (leave) return { status: "L", source: "leave", workedHours: 0, openIn: false, compOffEligible: false, shift };
  if (wo) return { status: "WO", source: "weekly_off", workedHours: 0, openIn: false, compOffEligible: false, shift };
  return { status: "A", source: "absent", workedHours: 0, openIn: false, compOffEligible: false, shift };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/* ── Context loading ───────────────────────────────────────────────────── */

/** Everything resolveDay needs for [from, to], loaded in a handful of queries. */
export async function loadContext(tx: Conn, from: string, to: string, employeeIds?: string[]): Promise<ResolveContext> {
  const [settings] = await tx.select().from(payrollSettings);
  const empFilter = employeeIds?.length ? inArray(punches.employeeId, employeeIds) : undefined;

  const punchRows = await tx
    .select({ id: punches.id, employeeId: punches.employeeId, type: punches.type, punchedAt: punches.punchedAt, punchDate: punches.punchDate, resolvedAt: punches.resolvedAt })
    .from(punches)
    .where(and(gte(punches.punchDate, from), lte(punches.punchDate, to), empFilter));
  const punchesByEmpDay = new Map<string, PunchLike[]>();
  for (const p of punchRows) {
    const key = `${p.employeeId}|${p.punchDate}`;
    const list = punchesByEmpDay.get(key) ?? [];
    list.push({ id: p.id, type: p.type, punchedAt: p.punchedAt, resolvedAt: p.resolvedAt });
    punchesByEmpDay.set(key, list);
  }

  const holidayRows = await tx.select().from(holidays);
  const holidaysByDate = buildHolidayMap(holidayRows, from, to);

  const leaveRows = await tx
    .select({ employeeId: leaveApplications.employeeId, fromDate: leaveApplications.fromDate, toDate: leaveApplications.toDate, leaveType: leaveApplications.leaveType })
    .from(leaveApplications)
    .where(
      and(
        eq(leaveApplications.status, "approved"),
        lte(leaveApplications.fromDate, to),
        gte(leaveApplications.toDate, from),
        employeeIds?.length ? inArray(leaveApplications.employeeId, employeeIds) : undefined,
      ),
    );
  const leavesByEmp = new Map<string, { fromDate: string; toDate: string; leaveType: string }[]>();
  for (const l of leaveRows) {
    const list = leavesByEmp.get(l.employeeId) ?? [];
    list.push(l);
    leavesByEmp.set(l.employeeId, list);
  }

  const assignmentRows = await tx
    .select({ employeeId: shiftAssignments.employeeId, shiftId: shiftAssignments.shiftId, effectiveFrom: shiftAssignments.effectiveFrom, effectiveTo: shiftAssignments.effectiveTo, weeklyOffDays: shiftAssignments.weeklyOffDays })
    .from(shiftAssignments)
    .where(
      and(
        lte(shiftAssignments.effectiveFrom, to),
        or(isNull(shiftAssignments.effectiveTo), gte(shiftAssignments.effectiveTo, from)),
        employeeIds?.length ? inArray(shiftAssignments.employeeId, employeeIds) : undefined,
      ),
    );
  const assignmentsByEmp = new Map<string, AssignmentLike[]>();
  for (const a of assignmentRows) {
    const list = assignmentsByEmp.get(a.employeeId) ?? [];
    list.push(a);
    assignmentsByEmp.set(a.employeeId, list);
  }

  const shiftRows = await tx.select({ id: shifts.id, name: shifts.name, weeklyOffDays: shifts.weeklyOffDays, startTime: shifts.startTime, endTime: shifts.endTime }).from(shifts);

  return {
    fullDayHours: settings?.fullDayHours ?? 8,
    halfDayHours: settings?.halfDayHours ?? 4,
    punchesByEmpDay,
    holidaysByDate,
    leavesByEmp,
    assignmentsByEmp,
    shiftById: new Map(shiftRows.map((s) => [s.id, s])),
    today: istDate(),
    now: new Date(),
  };
}

/* ── Which day a punch belongs to ──────────────────────────────────────── */

export interface CarriedEntry {
  /** The day the shift started: where the exit is filed. */
  day: string;
  inPunch: PunchLike;
}

/**
 * Yesterday's entry that a punch at `at` would close, if there is one: the
 * person has not punched at all today, yesterday ended on an open entry HR has
 * not ruled on, and it is still a night in progress (`nightShiftStillOpen`).
 */
export async function carryOverIn(tx: Conn, employeeId: string, at: Date = new Date()): Promise<CarriedEntry | null> {
  const today = istDate(at);
  const yesterday = addDays(today, -1);
  const rows = await tx
    .select({ id: punches.id, type: punches.type, punchedAt: punches.punchedAt, punchDate: punches.punchDate, resolvedAt: punches.resolvedAt })
    .from(punches)
    .where(and(eq(punches.employeeId, employeeId), gte(punches.punchDate, yesterday), lte(punches.punchDate, today)));
  if (rows.some((p) => p.punchDate === today)) return null;
  const open = summarizeDay(rows).openInPunch;
  if (!open) return null;

  const assignments = await tx
    .select({ shiftId: shiftAssignments.shiftId, effectiveFrom: shiftAssignments.effectiveFrom, effectiveTo: shiftAssignments.effectiveTo })
    .from(shiftAssignments)
    .where(eq(shiftAssignments.employeeId, employeeId));
  const a = assignmentForDate(yesterday, assignments);
  let shift: ShiftLike | undefined;
  if (a) {
    const [row] = await tx
      .select({ id: shifts.id, name: shifts.name, weeklyOffDays: shifts.weeklyOffDays, startTime: shifts.startTime, endTime: shifts.endTime })
      .from(shifts)
      .where(eq(shifts.id, a.shiftId));
    shift = row;
  }
  return nightShiftStillOpen(open, shift, at) ? { day: yesterday, inPunch: open } : null;
}

/**
 * Every night still in progress at `at`, for the screens that ask "who is
 * inside" — the gate's list and today's attendance.
 */
export async function carriedEntries(tx: Conn, at: Date = new Date()): Promise<(CarriedEntry & { employeeId: string })[]> {
  const yesterday = addDays(istDate(at), -1);
  const ids = await tx.selectDistinct({ employeeId: punches.employeeId }).from(punches).where(eq(punches.punchDate, yesterday));
  const out: (CarriedEntry & { employeeId: string })[] = [];
  for (const { employeeId } of ids) {
    const c = await carryOverIn(tx, employeeId, at);
    if (c) out.push({ ...c, employeeId });
  }
  return out;
}

/**
 * A leading exit with nothing before it, the morning after a day that ended on
 * an open entry: file it under that entry's day.
 *
 * For punches recorded before the gate knew about nights, and for any that
 * arrive out of order. Only an exit that precedes every entry of its own day,
 * within a night's length of the entry it closes, and only for someone who was
 * on a night — the same test the gate applies as it happens. Idempotent: once
 * moved, the morning no longer starts with a stray exit.
 */
export async function rehomeStrayOuts(tx: Conn, from: string, to: string, employeeIds?: string[]): Promise<number> {
  const ctx = await loadContext(tx, addDays(from, -1), to, employeeIds);
  let moved = 0;
  for (const [key, list] of ctx.punchesByEmpDay) {
    const [employeeId, day] = key.split("|") as [string, string];
    if (day < from || day > to) continue;
    const sorted = [...list].sort((a, b) => a.punchedAt.getTime() - b.punchedAt.getTime());
    const first = sorted[0]!;
    if (first.type !== "out") continue;
    const prev = addDays(day, -1);
    const open = summarizeDay(ctx.punchesByEmpDay.get(`${employeeId}|${prev}`) ?? []).openInPunch;
    if (!open) continue;
    const a = assignmentForDate(prev, ctx.assignmentsByEmp.get(employeeId) ?? []);
    const shift = a ? ctx.shiftById.get(a.shiftId) : undefined;
    // Judged as of the exit itself: was that night still open when he left?
    if (!nightShiftStillOpen(open, shift, first.punchedAt)) continue;
    await tx.update(punches).set({ punchDate: prev }).where(eq(punches.id, first.id));
    moved++;
  }
  return moved;
}

/* ── Writing attendance_days ───────────────────────────────────────────── */

/**
 * Upsert the resolved rows for a set of employees over [from, to]. Rows whose
 * source is `manual` or `import` are left exactly as they are; a day the
 * resolver now says has no row (future, outside service) is deleted unless
 * it is one of those.
 *
 * `overrideImported` drops `import` from that protection. Deciding a leave is
 * a decision about specific days, and it must land even where a bulk import
 * had already written those days as absent — otherwise the approval is
 * invisible and the month still pays LOP. An HR `manual` row still wins:
 * somebody looked at that day and said what it was.
 */
async function writeRange(
  tx: Conn,
  emps: EmployeeLike[],
  from: string,
  to: string,
  ctx: ResolveContext,
  overrideImported = false,
): Promise<number> {
  if (!emps.length) return 0;
  const ids = emps.map((e) => e.id);
  const locked = await tx
    .select({ employeeId: attendanceDays.employeeId, day: attendanceDays.day })
    .from(attendanceDays)
    .where(
      and(
        inArray(attendanceDays.employeeId, ids),
        gte(attendanceDays.day, from),
        lte(attendanceDays.day, to),
        overrideImported ? eq(attendanceDays.source, "manual") : inArray(attendanceDays.source, ["manual", "import"]),
      ),
    );
  const lockedSet = new Set(locked.map((r) => `${r.employeeId}|${r.day}`));

  const upserts: { employeeId: string; day: string; status: AttendanceStatus; source: AttendanceSource; workedHours: number }[] = [];
  const deletes: { employeeId: string; day: string }[] = [];
  for (const e of emps) {
    for (let day = from; day <= to; day = addDays(day, 1)) {
      if (lockedSet.has(`${e.id}|${day}`)) continue;
      const r = resolveDay(e, day, ctx);
      if (!r) deletes.push({ employeeId: e.id, day });
      else upserts.push({ employeeId: e.id, day, status: r.status, source: r.source, workedHours: r.workedHours });
    }
  }

  // Chunked: a month across a few hundred people is thousands of rows.
  for (let i = 0; i < upserts.length; i += 500) {
    await tx
      .insert(attendanceDays)
      .values(upserts.slice(i, i + 500))
      .onConflictDoUpdate({
        target: [attendanceDays.employeeId, attendanceDays.day],
        set: {
          status: sql`excluded.status`,
          source: sql`excluded.source`,
          workedHours: sql`excluded.worked_hours`,
          note: null,
          setBy: null,
          updatedAt: new Date(),
        },
      });
  }
  for (const d of deletes) {
    await tx
      .delete(attendanceDays)
      .where(
        and(
          eq(attendanceDays.employeeId, d.employeeId),
          eq(attendanceDays.day, d.day),
          overrideImported ? sql`${attendanceDays.source} <> 'manual'` : sql`${attendanceDays.source} NOT IN ('manual','import')`,
        ),
      );
  }
  return upserts.length;
}

const employeeLite = { id: employees.id, dateOfJoining: employees.dateOfJoining, dateOfLeaving: employees.dateOfLeaving };

export async function recomputeEmployeeDay(tx: Conn, employeeId: string, day: string): Promise<DayResolution | null> {
  const [emp] = await tx.select(employeeLite).from(employees).where(eq(employees.id, employeeId));
  if (!emp) return null;
  const ctx = await loadContext(tx, day, day, [employeeId]);
  await writeRange(tx, [emp], day, day, ctx);
  return resolveDay(emp, day, ctx);
}

/**
 * Who was on the rolls for any part of [from, to].
 *
 * `isActive` alone is the wrong question for a month: HR switches a leaver off
 * after his last day, and the ten days he worked went with him — no slip, no
 * exception, nothing. So someone inactive still counts when his leaving date
 * falls inside the range. The other half matters as much: a person who left in
 * an earlier month and was never switched off is not on this month's rolls.
 *
 * The run and the recompute both ask this, so they cannot disagree about who
 * the month is for.
 */
export function onRollsDuring(from: string, to: string) {
  return sql`(${employees.dateOfJoining} IS NULL OR ${employees.dateOfJoining} <= ${to})
    AND (${employees.dateOfLeaving} IS NULL OR ${employees.dateOfLeaving} >= ${from})
    AND (${employees.isActive} OR (${employees.dateOfLeaving} IS NOT NULL AND ${employees.dateOfLeaving} <= ${to}))`;
}

/**
 * An attendance row that falls inside its employee's service.
 *
 * The resolver writes nothing outside joining-to-leaving, but `manual` and
 * `import` rows are never the resolver's to touch, so an imported weekly off
 * dated after a man left stays in the table — and was paid. It is ignored when
 * days are counted rather than deleted: a mistyped leaving date, once
 * corrected, brings HR's own entries back, and a delete would not.
 */
export const withinService = sql`NOT EXISTS (
  SELECT 1 FROM employees svc
   WHERE svc.id = ${attendanceDays.employeeId}
     AND ((svc.date_of_joining IS NOT NULL AND ${attendanceDays.day} < svc.date_of_joining)
       OR (svc.date_of_leaving IS NOT NULL AND ${attendanceDays.day} > svc.date_of_leaving)))`;

/**
 * Recompute everyone on the rolls (or the given ones) over [from, to].
 * `overrideImported` is for leave decisions — see writeRange.
 */
export async function recomputeRange(
  tx: Conn,
  from: string,
  to: string,
  employeeIds?: string[],
  overrideImported = false,
): Promise<{ rows: number; employees: number }> {
  const emps = await tx
    .select(employeeLite)
    .from(employees)
    .where(employeeIds?.length ? inArray(employees.id, employeeIds) : onRollsDuring(from, to));
  const ctx = await loadContext(tx, from, to, employeeIds);
  const rows = await writeRange(tx, emps, from, to, ctx, overrideImported);
  return { rows, employees: emps.length };
}

/* ── Totals ────────────────────────────────────────────────────────────── */

export interface MonthTotals {
  P: number;
  H: number;
  A: number;
  WO: number;
  HO: number;
  L: number;
  paid: number;
  lop: number;
}

export function emptyTotals(): MonthTotals {
  return { P: 0, H: 0, A: 0, WO: 0, HO: 0, L: 0, paid: 0, lop: 0 };
}

/** Paid days = P + 0.5·H + WO + HO + L; LOP = A. The only place the weights live. */
export function addToTotals(t: MonthTotals, status: AttendanceStatus): MonthTotals {
  t[status] += 1;
  if (status === "H") t.paid += 0.5;
  else if (status !== "A") t.paid += 1;
  else t.lop += 1;
  return t;
}

/**
 * Paid day-weights per employee PER ROLE over [from, to].
 *
 * A wage worker's month is no longer one number: twenty days of egg picking
 * and five of vaccination helping are paid at two different rates. Buckets
 * key on the day's own wage_role_id; the empty-string bucket is days with no
 * role set, which price at the worker's usual role. Only P and H appear —
 * for wages, a holiday or a weekly off earns nothing.
 */
export async function wageDayTotals(
  tx: Conn,
  from: string,
  to: string,
  employeeIds?: string[],
): Promise<Map<string, Map<string, { P: number; H: number }>>> {
  const rows = await tx
    .select({
      employeeId: attendanceDays.employeeId,
      roleId: attendanceDays.wageRoleId,
      status: attendanceDays.status,
      n: sql<number>`count(*)::int`,
    })
    .from(attendanceDays)
    .where(
      and(
        gte(attendanceDays.day, from),
        lte(attendanceDays.day, to),
        inArray(attendanceDays.status, ["P", "H"]),
        withinService,
        employeeIds?.length ? inArray(attendanceDays.employeeId, employeeIds) : undefined,
      ),
    )
    .groupBy(attendanceDays.employeeId, attendanceDays.wageRoleId, attendanceDays.status);
  const out = new Map<string, Map<string, { P: number; H: number }>>();
  for (const r of rows) {
    const buckets = out.get(r.employeeId) ?? new Map<string, { P: number; H: number }>();
    const b = buckets.get(r.roleId ?? "") ?? { P: 0, H: 0 };
    if (r.status === "P") b.P += r.n;
    else b.H += r.n;
    buckets.set(r.roleId ?? "", b);
    out.set(r.employeeId, buckets);
  }
  return out;
}

/** Totals per employee over [from, to], straight from attendance_days. */
export async function monthTotals(tx: Conn, from: string, to: string, employeeIds?: string[]): Promise<Map<string, MonthTotals>> {
  const rows = await tx
    .select({ employeeId: attendanceDays.employeeId, status: attendanceDays.status, n: sql<number>`count(*)::int` })
    .from(attendanceDays)
    .where(
      and(
        gte(attendanceDays.day, from),
        lte(attendanceDays.day, to),
        withinService,
        employeeIds?.length ? inArray(attendanceDays.employeeId, employeeIds) : undefined,
      ),
    )
    .groupBy(attendanceDays.employeeId, attendanceDays.status);
  const out = new Map<string, MonthTotals>();
  for (const r of rows) {
    const t = out.get(r.employeeId) ?? emptyTotals();
    for (let i = 0; i < r.n; i++) addToTotals(t, r.status);
    out.set(r.employeeId, t);
  }
  return out;
}
