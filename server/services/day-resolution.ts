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
}

export interface ShiftLike {
  id: string;
  name: string;
  weeklyOffDays: number[];
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
  assignmentsByEmp: Map<string, { shiftId: string; effectiveFrom: string; effectiveTo: string | null }[]>;
  shiftById: Map<string, ShiftLike>;
  /** IST today — a day after this with no punches is not written at all. */
  today: string;
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

/* ── Resolution ────────────────────────────────────────────────────────── */

export function shiftForDate(
  day: string,
  assignments: { shiftId: string; effectiveFrom: string; effectiveTo: string | null }[],
  shiftById: Map<string, ShiftLike>,
): ShiftLike | undefined {
  const a = assignments.find((a) => a.effectiveFrom <= day && (!a.effectiveTo || a.effectiveTo >= day));
  return a ? shiftById.get(a.shiftId) : undefined;
}

/** Weekly off from the shift; an unassigned employee still gets Sunday. */
export function isWeeklyOff(day: string, shift: ShiftLike | undefined): boolean {
  const wd = weekdayOf(day);
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
  const shift = shiftForDate(day, assignments, ctx.shiftById);
  const holiday = ctx.holidaysByDate.has(day);
  const leave = (ctx.leavesByEmp.get(employee.id) ?? []).some((l) => l.fromDate <= day && l.toDate >= day);
  const wo = isWeeklyOff(day, shift);
  const offDay = holiday || leave || wo;

  if (list.length) {
    const s = summarizeDay(list);
    // A forgotten punch-out on a past day: the person was here, so a half day
    // is the fair default until HR resolves it. Today's open `in` is just
    // someone still inside — present-so-far, nothing to decide yet.
    if (s.openIn && s.hours < ctx.halfDayHours) {
      const status: AttendanceStatus = day < ctx.today ? "H" : "P";
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
    .select({ id: punches.id, employeeId: punches.employeeId, type: punches.type, punchedAt: punches.punchedAt, punchDate: punches.punchDate })
    .from(punches)
    .where(and(gte(punches.punchDate, from), lte(punches.punchDate, to), empFilter));
  const punchesByEmpDay = new Map<string, PunchLike[]>();
  for (const p of punchRows) {
    const key = `${p.employeeId}|${p.punchDate}`;
    const list = punchesByEmpDay.get(key) ?? [];
    list.push({ id: p.id, type: p.type, punchedAt: p.punchedAt });
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
    .select({ employeeId: shiftAssignments.employeeId, shiftId: shiftAssignments.shiftId, effectiveFrom: shiftAssignments.effectiveFrom, effectiveTo: shiftAssignments.effectiveTo })
    .from(shiftAssignments)
    .where(
      and(
        lte(shiftAssignments.effectiveFrom, to),
        or(isNull(shiftAssignments.effectiveTo), gte(shiftAssignments.effectiveTo, from)),
        employeeIds?.length ? inArray(shiftAssignments.employeeId, employeeIds) : undefined,
      ),
    );
  const assignmentsByEmp = new Map<string, { shiftId: string; effectiveFrom: string; effectiveTo: string | null }[]>();
  for (const a of assignmentRows) {
    const list = assignmentsByEmp.get(a.employeeId) ?? [];
    list.push(a);
    assignmentsByEmp.set(a.employeeId, list);
  }

  const shiftRows = await tx.select({ id: shifts.id, name: shifts.name, weeklyOffDays: shifts.weeklyOffDays }).from(shifts);

  return {
    fullDayHours: settings?.fullDayHours ?? 8,
    halfDayHours: settings?.halfDayHours ?? 4,
    punchesByEmpDay,
    holidaysByDate,
    leavesByEmp,
    assignmentsByEmp,
    shiftById: new Map(shiftRows.map((s) => [s.id, s])),
    today: istDate(),
  };
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
 * Recompute every active employee (or the given ones) over [from, to].
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
    .where(employeeIds?.length ? inArray(employees.id, employeeIds) : eq(employees.isActive, true));
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
