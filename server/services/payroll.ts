/**
 * The payroll run: one month, every active person, one journal.
 *
 * A run is processed as a draft — slips are snapshots of what the employee
 * row and the attendance table said at that moment — and may be processed
 * again as often as HR likes until it is confirmed. Reprocessing first undoes
 * the draft's side effects (advance repayments written, pay inputs marked
 * paid) so nothing is charged twice; Amino learned that one the hard way.
 *
 * Confirming posts ONE journal dated the last day of the month. Other
 * deductions and advance recovery stay inside salary payable: the expense is
 * the gross already, and what is held back from the person is money the
 * company keeps. The cash paid out on an advance was booked when it was
 * given; recovery just reduces what is owed on the slip.
 */
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  advanceRepayments,
  advances,
  departments,
  employees,
  journalEntries,
  payInputs,
  payrollRuns,
  payrollSettings,
  salarySlips,
  wageRoles,
} from "@shared/schema";
import type { Db, Tx } from "../db";
import { PostingError, postJournal } from "./posting";
import { nextDocumentNumber } from "../lib/numbering";
import { daysInMonth, emptyTotals, monthRange, monthTotals, recomputeRange, type MonthTotals } from "./day-resolution";

type Conn = Tx | Db;

const r2 = (n: number) => Math.round(n * 100) / 100;
const money = (n: number) => r2(n).toFixed(2);

/** Outstanding on an advance = amount − Σ repayments; never stored. */
export async function advanceOutstanding(tx: Conn, advanceId: string): Promise<number> {
  const [adv] = await tx.select({ amount: advances.amount }).from(advances).where(eq(advances.id, advanceId));
  if (!adv) return 0;
  const [rep] = await tx
    .select({ v: sql<string>`coalesce(sum(${advanceRepayments.amount}), 0)` })
    .from(advanceRepayments)
    .where(eq(advanceRepayments.advanceId, advanceId));
  return r2(Number(adv.amount) - Number(rep!.v));
}

/**
 * Undo what a draft pass wrote outside its own slips: its repayment rows and
 * the `paid` flags on pay inputs. Advances it closed are reopened, since
 * outstanding is derived and the repayment is about to vanish.
 */
export async function revertRunSideEffects(tx: Conn, runId: string): Promise<void> {
  const reps = await tx
    .select({ advanceId: advanceRepayments.advanceId })
    .from(advanceRepayments)
    .where(eq(advanceRepayments.payrollRunId, runId));
  await tx.delete(advanceRepayments).where(eq(advanceRepayments.payrollRunId, runId));
  const touched = [...new Set(reps.map((r) => r.advanceId))];
  if (touched.length) {
    await tx
      .update(advances)
      .set({ status: "active" })
      .where(and(inArray(advances.id, touched), eq(advances.status, "closed")));
  }
  await tx
    .update(payInputs)
    .set({ status: "approved", payrollRunId: null })
    .where(and(eq(payInputs.payrollRunId, runId), eq(payInputs.status, "paid")));
}

export interface ProcessInput {
  month: number;
  year: number;
  userId: string;
}

/** First PT slab whose upper bound covers the gross; a null bound is open-ended. */
export function professionalTaxFor(gross: number, slabs: { upTo: number | null; amount: number }[]): number {
  for (const s of slabs) if (s.upTo == null || gross <= s.upTo) return s.amount;
  return 0;
}

export async function processRun(tx: Tx, input: ProcessInput) {
  const { month, year, userId } = input;
  if (month < 1 || month > 12) throw new PostingError("Month must be 1–12");
  const { from, to } = monthRange(year, month);
  const totalDays = daysInMonth(year, month);

  const [existing] = await tx.select().from(payrollRuns).where(and(eq(payrollRuns.year, year), eq(payrollRuns.month, month)));
  if (existing?.status === "confirmed") {
    throw new PostingError(`Payroll for ${month}/${year} is confirmed — it cannot be processed again`);
  }
  let runId: string;
  if (existing) {
    await revertRunSideEffects(tx, existing.id);
    await tx.delete(salarySlips).where(eq(salarySlips.payrollRunId, existing.id));
    runId = existing.id;
  } else {
    const [run] = await tx.insert(payrollRuns).values({ month, year, status: "draft" }).returning({ id: payrollRuns.id });
    runId = run!.id;
  }

  const [settings] = await tx.select().from(payrollSettings);
  if (!settings) throw new PostingError("Payroll settings are missing — run migrations");

  // Attendance is recomputed first so a punch resolved five minutes ago is
  // in the slip; manual and imported rows survive as always.
  await recomputeRange(tx, from, to);

  const staff = await tx
    .select({
      id: employees.id,
      payType: employees.payType,
      basicSalary: employees.basicSalary,
      hra: employees.hra,
      allowances: employees.allowances,
      pfEnabled: employees.pfEnabled,
      esiEnabled: employees.esiEnabled,
      dailyRate: wageRoles.dailyRate,
      bankName: employees.bankName,
      bankAccountNumber: employees.bankAccountNumber,
      bankIfsc: employees.bankIfsc,
      dateOfJoining: employees.dateOfJoining,
      dateOfLeaving: employees.dateOfLeaving,
    })
    .from(employees)
    .leftJoin(wageRoles, eq(wageRoles.id, employees.wageRoleId))
    .where(and(eq(employees.isActive, true), sql`(${employees.dateOfJoining} IS NULL OR ${employees.dateOfJoining} <= ${to})`));

  const totals = await monthTotals(tx, from, to);
  const inputs = await tx
    .select()
    .from(payInputs)
    .where(and(eq(payInputs.year, year), eq(payInputs.month, month), eq(payInputs.status, "approved")));
  const inputsByEmp = new Map<string, typeof inputs>();
  for (const i of inputs) inputsByEmp.set(i.employeeId, [...(inputsByEmp.get(i.employeeId) ?? []), i]);

  // Repayments already recorded for this pay month by hand (after the revert
  // above, so the draft's own rows are gone): an EMI paid at the counter is
  // not charged again by the run.
  const manualReps = await tx
    .select({ advanceId: advanceRepayments.advanceId, amount: advanceRepayments.amount })
    .from(advanceRepayments)
    .where(and(eq(advanceRepayments.year, year), eq(advanceRepayments.month, month)));
  const repaidThisMonth = new Map<string, number>();
  for (const r of manualReps) repaidThisMonth.set(r.advanceId, (repaidThisMonth.get(r.advanceId) ?? 0) + Number(r.amount));

  let sumGross = 0;
  let sumDeductions = 0;
  let sumNet = 0;
  let sumEmployer = 0;
  let count = 0;

  for (const e of staff) {
    const t: MonthTotals = totals.get(e.id) ?? emptyTotals();
    const paidDays = t.paid;
    const ratio = paidDays / totalDays;

    let basic = 0;
    let hra = 0;
    let allowances = 0;
    let earnedBasic = 0;
    let earnedHra = 0;
    let earnedAllowances = 0;
    let dailyRate: number | null = null;
    if (e.payType === "salaried") {
      basic = Number(e.basicSalary);
      hra = Number(e.hra);
      allowances = Number(e.allowances);
      earnedBasic = r2(basic * ratio);
      earnedHra = r2(hra * ratio);
      earnedAllowances = r2(allowances * ratio);
    } else {
      // Wages are for days worked; a holiday or a weekly off earns nothing.
      dailyRate = Number(e.dailyRate ?? 0);
      earnedBasic = r2(dailyRate * (t.P + 0.5 * t.H));
    }
    const earnedGross = r2(earnedBasic + earnedHra + earnedAllowances);

    const mine = inputsByEmp.get(e.id) ?? [];
    const sumKind = (k: string) => r2(mine.filter((i) => i.kind === k).reduce((n, i) => n + Number(i.approvedAmount ?? i.amount), 0));
    const bonus = sumKind("bonus");
    const overtime = sumKind("overtime");
    const reimbursement = sumKind("reimbursement");
    const otherDeductions = sumKind("deduction");

    let pfEmployee = 0;
    let pfEmployer = 0;
    if (e.pfEnabled) {
      const ceiling = Number(settings.pfWageCeiling);
      const base = ceiling > 0 ? Math.min(earnedBasic, ceiling) : earnedBasic;
      pfEmployee = r2((base * settings.pfEmployeePct) / 100);
      pfEmployer = r2((base * settings.pfEmployerPct) / 100);
    }
    let esiEmployee = 0;
    let esiEmployer = 0;
    if (e.esiEnabled && earnedGross <= Number(settings.esiGrossCeiling)) {
      esiEmployee = r2((earnedGross * settings.esiEmployeePct) / 100);
      esiEmployer = r2((earnedGross * settings.esiEmployerPct) / 100);
    }
    const professionalTax = r2(professionalTaxFor(earnedGross, settings.ptSlabs ?? []));

    const netBeforeAdvance = r2(earnedGross + bonus + overtime + reimbursement - (pfEmployee + esiEmployee + professionalTax + otherDeductions));

    // Advances, oldest first, never past what is left of the pay.
    let budget = Math.max(0, netBeforeAdvance);
    let advanceRecovery = 0;
    const active = await tx
      .select()
      .from(advances)
      .where(and(eq(advances.employeeId, e.id), eq(advances.status, "active")))
      .orderBy(asc(advances.givenOn), asc(advances.createdAt));
    for (const adv of active) {
      const outstanding = await advanceOutstanding(tx, adv.id);
      const due = Math.max(0, Number(adv.emiAmount) - (repaidThisMonth.get(adv.id) ?? 0));
      const repay = r2(Math.min(due, outstanding, budget));
      if (repay <= 0) continue;
      await tx.insert(advanceRepayments).values({ advanceId: adv.id, amount: money(repay), month, year, payrollRunId: runId });
      budget = r2(budget - repay);
      advanceRecovery = r2(advanceRecovery + repay);
      if (r2(outstanding - repay) <= 0) await tx.update(advances).set({ status: "closed" }).where(eq(advances.id, adv.id));
    }

    const totalDeductions = r2(pfEmployee + esiEmployee + professionalTax + otherDeductions + advanceRecovery);
    const netPay = r2(netBeforeAdvance - advanceRecovery);

    await tx.insert(salarySlips).values({
      payrollRunId: runId,
      employeeId: e.id,
      payType: e.payType,
      totalDays,
      presentDays: t.P,
      halfDays: t.H,
      weeklyOffs: t.WO,
      holidays: t.HO,
      leaveDays: t.L,
      paidDays,
      lopDays: t.lop,
      dailyRate: dailyRate == null ? null : money(dailyRate),
      basicSalary: money(basic),
      hra: money(hra),
      allowances: money(allowances),
      earnedBasic: money(earnedBasic),
      earnedHra: money(earnedHra),
      earnedAllowances: money(earnedAllowances),
      earnedGross: money(earnedGross),
      bonus: money(bonus),
      overtime: money(overtime),
      reimbursement: money(reimbursement),
      pfEmployee: money(pfEmployee),
      pfEmployer: money(pfEmployer),
      esiEmployee: money(esiEmployee),
      esiEmployer: money(esiEmployer),
      professionalTax: money(professionalTax),
      otherDeductions: money(otherDeductions),
      advanceRecovery: money(advanceRecovery),
      totalDeductions: money(totalDeductions),
      netPay: money(netPay),
      bankName: e.bankName,
      bankAccountNumber: e.bankAccountNumber,
      bankIfsc: e.bankIfsc,
    });

    if (mine.length) {
      await tx
        .update(payInputs)
        .set({ status: "paid", payrollRunId: runId })
        .where(inArray(payInputs.id, mine.map((i) => i.id)));
    }

    sumGross = r2(sumGross + earnedGross + bonus + overtime + reimbursement);
    sumDeductions = r2(sumDeductions + totalDeductions);
    sumNet = r2(sumNet + netPay);
    sumEmployer = r2(sumEmployer + earnedGross + bonus + overtime + reimbursement + pfEmployer + esiEmployer);
    count++;
  }

  const [run] = await tx
    .update(payrollRuns)
    .set({
      status: "draft",
      employeeCount: count,
      totalGross: money(sumGross),
      totalDeductions: money(sumDeductions),
      totalNet: money(sumNet),
      totalEmployerCost: money(sumEmployer),
      processedBy: userId,
      processedAt: new Date(),
    })
    .where(eq(payrollRuns.id, runId))
    .returning();
  return run!;
}

/** Post the month's journal and lock the run. */
export async function confirmRun(tx: Tx, runId: string, userId: string) {
  const [run] = await tx.select().from(payrollRuns).where(eq(payrollRuns.id, runId));
  if (!run) throw new PostingError("No such payroll run");
  if (run.status === "confirmed") throw new PostingError("This run is already confirmed");
  const slips = await tx.select().from(salarySlips).where(eq(salarySlips.payrollRunId, runId));
  if (!slips.length) throw new PostingError("Nothing to confirm — process the run first");

  const sum = (pick: (s: typeof slips[number]) => number, filter: (s: typeof slips[number]) => boolean = () => true) =>
    r2(slips.filter(filter).reduce((n, s) => n + pick(s), 0));
  const earnings = (s: typeof slips[number]) => Number(s.earnedGross) + Number(s.bonus) + Number(s.overtime) + Number(s.reimbursement);

  const salary = sum(earnings, (s) => s.payType === "salaried");
  const wages = sum(earnings, (s) => s.payType === "daily_wage");
  const pfEr = sum((s) => Number(s.pfEmployer));
  const esiEr = sum((s) => Number(s.esiEmployer));
  const pfPayable = r2(sum((s) => Number(s.pfEmployee)) + pfEr);
  const esiPayable = r2(sum((s) => Number(s.esiEmployee)) + esiEr);
  const pt = sum((s) => Number(s.professionalTax));
  const salaryPayable = sum((s) => Number(s.netPay) + Number(s.otherDeductions) + Number(s.advanceRecovery));

  const { to } = monthRange(run.year, run.month);
  const reference = await nextDocumentNumber(tx, "payroll_run");
  const lines = [
    { systemKey: "salary_expense", debit: money(salary), description: "Salaries" },
    { systemKey: "wages_expense", debit: money(wages), description: "Daily wages" },
    { systemKey: "pf_employer_expense", debit: money(pfEr), description: "PF employer contribution" },
    { systemKey: "esi_employer_expense", debit: money(esiEr), description: "ESI employer contribution" },
    { systemKey: "pf_payable", credit: money(pfPayable) },
    { systemKey: "esi_payable", credit: money(esiPayable) },
    { systemKey: "pt_payable", credit: money(pt) },
    { systemKey: "salary_payable", credit: money(salaryPayable) },
  ].filter((l) => Number(l.debit ?? l.credit) > 0);

  const jeId = await postJournal(tx, {
    entryDate: to,
    narration: `Payroll ${String(run.month).padStart(2, "0")}/${run.year}`,
    reference,
    sourceType: "payroll_run",
    sourceId: run.id,
    postedBy: userId,
    lines,
  });
  const [updated] = await tx
    .update(payrollRuns)
    .set({ status: "confirmed", confirmedBy: userId, confirmedAt: new Date(), journalEntryId: jeId })
    .where(eq(payrollRuns.id, runId))
    .returning();
  return { run: updated!, journalEntryId: jeId, reference };
}

export async function deleteDraftRun(tx: Tx, runId: string) {
  const [run] = await tx.select().from(payrollRuns).where(eq(payrollRuns.id, runId));
  if (!run) throw new PostingError("No such payroll run");
  if (run.status === "confirmed") throw new PostingError("A confirmed run cannot be deleted");
  await revertRunSideEffects(tx, runId);
  await tx.delete(salarySlips).where(eq(salarySlips.payrollRunId, runId));
  await tx.delete(payrollRuns).where(eq(payrollRuns.id, runId));
}

export interface RunException {
  employeeId: string;
  name: string;
  issue: string;
}

/** What the reviewer should look at before confirming. */
export async function runExceptions(tx: Conn, runId: string): Promise<RunException[]> {
  const rows = await tx
    .select({
      employeeId: salarySlips.employeeId,
      name: employees.name,
      payType: salarySlips.payType,
      paidDays: salarySlips.paidDays,
      netPay: salarySlips.netPay,
      bankAccountNumber: salarySlips.bankAccountNumber,
      bankIfsc: salarySlips.bankIfsc,
      wageRoleId: employees.wageRoleId,
    })
    .from(salarySlips)
    .innerJoin(employees, eq(employees.id, salarySlips.employeeId))
    .where(eq(salarySlips.payrollRunId, runId));
  const out: RunException[] = [];
  for (const r of rows) {
    if (r.paidDays <= 0) out.push({ employeeId: r.employeeId, name: r.name, issue: "Zero paid days" });
    if (Number(r.netPay) <= 0) out.push({ employeeId: r.employeeId, name: r.name, issue: "Net pay is zero or negative" });
    if (!r.bankAccountNumber || !r.bankIfsc) out.push({ employeeId: r.employeeId, name: r.name, issue: "Missing bank details" });
    if (r.payType === "daily_wage" && !r.wageRoleId) out.push({ employeeId: r.employeeId, name: r.name, issue: "Daily-wage employee without a wage role" });
  }
  return out;
}

/** The slips of a run with the employee columns the screen shows. */
/**
 * A run's slips, flat: the slip's own columns with the person's name, code and
 * department beside them. Flat because every consumer — the review table, the
 * payslip, the bank file — wants one row per person, not a row wrapping a row.
 * Ordered by employee code, the sequence the office reads in.
 */
export async function runSlips(tx: Conn, runId: string) {
  const rows = await tx
    .select({
      slip: salarySlips,
      name: employees.name,
      empCode: employees.empCode,
      department: departments.name,
    })
    .from(salarySlips)
    .innerJoin(employees, eq(employees.id, salarySlips.employeeId))
    .leftJoin(departments, eq(departments.id, employees.departmentId))
    .where(eq(salarySlips.payrollRunId, runId))
    .orderBy(asc(employees.empCode));
  return rows.map((r) => ({ ...r.slip, name: r.name, empCode: r.empCode, department: r.department }));
}

export async function listRuns(tx: Conn) {
  return tx
    .select({
      id: payrollRuns.id,
      month: payrollRuns.month,
      year: payrollRuns.year,
      status: payrollRuns.status,
      employeeCount: payrollRuns.employeeCount,
      totalGross: payrollRuns.totalGross,
      totalDeductions: payrollRuns.totalDeductions,
      totalNet: payrollRuns.totalNet,
      totalEmployerCost: payrollRuns.totalEmployerCost,
      processedAt: payrollRuns.processedAt,
      confirmedAt: payrollRuns.confirmedAt,
      journalEntryNumber: journalEntries.entryNumber,
    })
    .from(payrollRuns)
    .leftJoin(journalEntries, eq(journalEntries.id, payrollRuns.journalEntryId))
    .orderBy(desc(payrollRuns.year), desc(payrollRuns.month));
}
