/**
 * Leave: balances derived, never stored; approval writes the days.
 *
 * CL and SL accrue per month of service in the calendar year, capped; an
 * opening balance on the employee carries what they brought in. Comp-off is
 * earned by working a day that would otherwise have been off (a P row from
 * a punch on a holiday or weekly off) and expires after the policy's
 * validity window. Balance = earned − approved days this year.
 *
 * Approving a leave writes `attendance_days` rows (status L, source leave)
 * for the range — except where a punch or a manual row already says
 * otherwise, because a person who turned up was not on leave. Rejecting or
 * cancelling removes exactly those rows and recomputes.
 */
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { attendanceDays, employees, holidays, leaveApplications, payrollSettings } from "@shared/schema";
import type { Db, Tx } from "../db";
import { PostingError } from "./posting";
import { addDays, buildHolidayMap, istDate, isWeeklyOff, loadContext, recomputeRange, shiftForDate } from "./day-resolution";

type Conn = Tx | Db;

export interface LeaveBalance {
  CL: { earned: number; used: number; balance: number };
  SL: { earned: number; used: number; balance: number };
  CompOff: { earned: number; used: number; balance: number; expiring: { workDate: string; expiresOn: string }[] };
}

/** Calendar days inclusive between two YYYY-MM-DD strings. */
export function spanDays(from: string, to: string): number {
  return Math.round((Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8)) - Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8))) / 86_400_000) + 1;
}

/**
 * Months of service inside `year` up to `today`: from max(DOJ, 1 Jan) to
 * today, counting the month a person joins as earned once the day-of-month
 * has passed (Amino's rule).
 */
function monthsAccrued(doj: string | null, year: number, today: string): number {
  const jan1 = `${year}-01-01`;
  const start = doj && doj > jan1 ? doj : jan1;
  if (start > today) return 0;
  const [sy, sm, sd] = start.split("-").map(Number) as [number, number, number];
  const [ty, tm, td] = today.split("-").map(Number) as [number, number, number];
  return Math.max(0, (ty - sy) * 12 + (tm - sm) + (td >= sd ? 1 : 0));
}

export async function leaveBalance(tx: Conn, employeeId: string, year: number): Promise<LeaveBalance> {
  const [emp] = await tx.select().from(employees).where(eq(employees.id, employeeId));
  if (!emp) throw new PostingError("No such employee");
  const [settings] = await tx.select().from(payrollSettings);
  const s = settings ?? { clPerMonth: 1, slPerMonth: 0.5, compOffValidityDays: 30 };
  const today = istDate();
  // A past year accrued in full; a future year has accrued nothing yet.
  const asOf = today.slice(0, 4) === String(year) ? today : today > `${year}-12-31` ? `${year}-12-31` : `${year}-01-01`;
  const months = monthsAccrued(emp.dateOfJoining, year, asOf);

  const clEarned = Math.min(12, months * s.clPerMonth) + (emp.openingCl ?? 0);
  const slEarned = Math.min(6, months * s.slPerMonth) + (emp.openingSl ?? 0);

  const approved = await tx
    .select({ leaveType: leaveApplications.leaveType, days: leaveApplications.days, compOffWorkDate: leaveApplications.compOffWorkDate })
    .from(leaveApplications)
    .where(
      and(
        eq(leaveApplications.employeeId, employeeId),
        eq(leaveApplications.status, "approved"),
        gte(leaveApplications.fromDate, `${year}-01-01`),
        lte(leaveApplications.fromDate, `${year}-12-31`),
      ),
    );
  const used = (t: string) => approved.filter((a) => a.leaveType === t).reduce((n, a) => n + a.days, 0);

  // Comp-off: P rows from a punch on a day that was a holiday or weekly off.
  const earnedDays = await compOffEarnedDays(tx, emp, year);
  const consumed = new Set(approved.filter((a) => a.leaveType === "CompOff" && a.compOffWorkDate).map((a) => a.compOffWorkDate!));
  const live = earnedDays.filter((d) => !consumed.has(d));
  const valid = live.filter((d) => addDays(d, s.compOffValidityDays) >= today);
  const expiring = valid
    .map((d) => ({ workDate: d, expiresOn: addDays(d, s.compOffValidityDays) }))
    .filter((x) => spanDays(today, x.expiresOn) <= 7);

  return {
    CL: { earned: clEarned, used: used("CL"), balance: clEarned - used("CL") },
    SL: { earned: slEarned, used: used("SL"), balance: slEarned - used("SL") },
    CompOff: { earned: earnedDays.length, used: used("CompOff"), balance: valid.length, expiring },
  };
}

/** Days in `year` on which the employee punched in on a holiday or weekly off. */
async function compOffEarnedDays(tx: Conn, emp: typeof employees.$inferSelect, year: number): Promise<string[]> {
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;
  const rows = await tx
    .select({ day: attendanceDays.day })
    .from(attendanceDays)
    .where(
      and(
        eq(attendanceDays.employeeId, emp.id),
        gte(attendanceDays.day, from),
        lte(attendanceDays.day, to),
        eq(attendanceDays.source, "punch"),
        eq(attendanceDays.status, "P"),
      ),
    );
  if (!rows.length) return [];
  const holidayRows = await tx.select().from(holidays);
  const hmap = buildHolidayMap(holidayRows, from, to);
  const ctx = await loadContext(tx, from, to, [emp.id]);
  return rows
    .map((r) => r.day)
    .filter((d) => hmap.has(d) || isWeeklyOff(d, shiftForDate(d, ctx.assignmentsByEmp.get(emp.id) ?? [], ctx.shiftById)))
    .sort();
}

export interface ApplyInput {
  employeeId: string;
  leaveType: "CL" | "SL" | "CompOff";
  fromDate: string;
  toDate: string;
  reason: string;
  medicalDocUrl?: string | null;
  compOffWorkDate?: string | null;
}

/** Validate and create a pending application. Throws PostingError on a policy breach. */
export async function applyLeave(tx: Conn, input: ApplyInput) {
  if (input.toDate < input.fromDate) throw new PostingError("To-date cannot be before from-date");
  const days = spanDays(input.fromDate, input.toDate);
  const [settings] = await tx.select().from(payrollSettings);
  const year = Number(input.fromDate.slice(0, 4));
  const bal = await leaveBalance(tx, input.employeeId, year);

  if (input.leaveType === "CL") {
    if (days > (settings?.clMaxConsecutive ?? 6)) {
      throw new PostingError(`CL cannot exceed ${settings?.clMaxConsecutive ?? 6} consecutive days`);
    }
    if (days > bal.CL.balance) throw new PostingError(`CL balance is ${bal.CL.balance} day(s); asking for ${days}`);
  } else if (input.leaveType === "SL") {
    if (days > bal.SL.balance) throw new PostingError(`SL balance is ${bal.SL.balance} day(s); asking for ${days}`);
  } else {
    const work = input.compOffWorkDate;
    if (!work) throw new PostingError("A comp-off needs the date that was worked");
    const today = istDate();
    if (work >= today) throw new PostingError("The comp-off work date must be in the past");
    const validity = settings?.compOffValidityDays ?? 30;
    if (addDays(work, validity) < input.fromDate) {
      throw new PostingError(`That comp-off expired — it had to be taken within ${validity} days of ${work}`);
    }
    if (days !== 1) throw new PostingError("A comp-off is one day against one day worked");
    const earned = await compOffEarnedDays(tx, (await tx.select().from(employees).where(eq(employees.id, input.employeeId)))[0]!, Number(work.slice(0, 4)));
    if (!earned.includes(work)) throw new PostingError(`${work} was not a worked holiday or weekly off`);
    const [taken] = await tx
      .select({ id: leaveApplications.id })
      .from(leaveApplications)
      .where(
        and(
          eq(leaveApplications.employeeId, input.employeeId),
          eq(leaveApplications.leaveType, "CompOff"),
          eq(leaveApplications.compOffWorkDate, work),
          inArray(leaveApplications.status, ["pending", "approved"]),
        ),
      );
    if (taken) throw new PostingError(`A comp-off against ${work} is already applied`);
  }

  const [row] = await tx
    .insert(leaveApplications)
    .values({
      employeeId: input.employeeId,
      leaveType: input.leaveType,
      fromDate: input.fromDate,
      toDate: input.toDate,
      days,
      reason: input.reason,
      medicalDocUrl: input.medicalDocUrl ?? null,
      compOffWorkDate: input.leaveType === "CompOff" ? input.compOffWorkDate! : null,
    })
    .returning();
  return row!;
}

/**
 * Approve: write L rows for the range where nothing stronger exists. A
 * punch row means they came in; a manual row means HR already decided.
 */
export async function approveLeave(tx: Conn, id: string, userId: string, remarks?: string | null) {
  const [app] = await tx.select().from(leaveApplications).where(eq(leaveApplications.id, id));
  if (!app) throw new PostingError("No such leave application");
  if (app.status !== "pending") throw new PostingError(`Already ${app.status}`);
  await tx
    .update(leaveApplications)
    .set({ status: "approved", decidedBy: userId, decidedAt: new Date(), remarks: remarks ?? null })
    .where(eq(leaveApplications.id, id));
  // The resolver already ranks leave under punches and over weekly off; a
  // recompute of the range IS the write, and honours manual/import rows.
  await recomputeRange(tx, app.fromDate, app.toDate, [app.employeeId]);
  return { ...app, status: "approved" as const };
}

/** Reject a pending one, or cancel an approved one: the L rows go, the days re-resolve. */
export async function rejectLeave(tx: Conn, id: string, userId: string, remarks?: string | null) {
  const [app] = await tx.select().from(leaveApplications).where(eq(leaveApplications.id, id));
  if (!app) throw new PostingError("No such leave application");
  if (app.status === "rejected") throw new PostingError("Already rejected");
  const wasApproved = app.status === "approved";
  await tx
    .update(leaveApplications)
    .set({ status: "rejected", decidedBy: userId, decidedAt: new Date(), remarks: remarks ?? null })
    .where(eq(leaveApplications.id, id));
  if (wasApproved) await revertLeaveDays(tx, app);
  return { ...app, status: "rejected" as const };
}

export async function deleteLeave(tx: Conn, id: string) {
  const [app] = await tx.select().from(leaveApplications).where(eq(leaveApplications.id, id));
  if (!app) throw new PostingError("No such leave application");
  await tx.delete(leaveApplications).where(eq(leaveApplications.id, id));
  if (app.status === "approved") await revertLeaveDays(tx, app);
  return app;
}

async function revertLeaveDays(tx: Conn, app: { employeeId: string; fromDate: string; toDate: string }) {
  await tx
    .delete(attendanceDays)
    .where(
      and(
        eq(attendanceDays.employeeId, app.employeeId),
        gte(attendanceDays.day, app.fromDate),
        lte(attendanceDays.day, app.toDate),
        eq(attendanceDays.source, "leave"),
      ),
    );
  await recomputeRange(tx, app.fromDate, app.toDate, [app.employeeId]);
}

/** Leaves that touch a month, for the calendar. */
export async function leavesInRange(tx: Conn, employeeId: string, from: string, to: string) {
  return tx
    .select()
    .from(leaveApplications)
    .where(
      and(
        eq(leaveApplications.employeeId, employeeId),
        lte(leaveApplications.fromDate, to),
        gte(leaveApplications.toDate, from),
        sql`${leaveApplications.status} != 'rejected'`,
      ),
    );
}
