/**
 * Payroll, exercised end to end — inside one transaction that is rolled back
 * at the end, so the real books are untouched however hard it goes.
 *
 * The matrix:
 *   resolver:  punch beats holiday beats leave beats weekly off beats absent;
 *              manual survives recompute; 4h is a half day; punches pair
 *              in→out with strays ignored; an open `in` on a past day is H
 *   leave:     CL/SL accrual with opening balances; comp-off earned by a
 *              punch on a holiday, expiring on schedule
 *   run:       one salaried (PF + ESI + PT + bonus + an advance whose EMI
 *              swallows the net) and one daily-wage employee; totals; a
 *              reprocess reverts the draft's side effects first
 *   confirm:   the journal is balanced with exactly the plan's lines;
 *              a confirmed run refuses deletion and reprocessing
 *   delete:    a draft run deletes clean, advance outstanding restored
 *
 * Run: npx tsx scripts/check-payroll.ts
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  accounts,
  advanceRepayments,
  advances,
  attendanceDays,
  employees,
  holidays,
  journalEntryLines,
  payInputs,
  payrollRuns,
  payrollSettings,
  punches,
  salarySlips,
  shiftAssignments,
  shifts,
  users,
  wageRoles,
} from "@shared/schema";
import { db } from "../server/db";
import { addDays, istDate, recomputeRange } from "../server/services/day-resolution";
import { applyLeave, approveLeave, leaveBalance } from "../server/services/leave";
import { advanceOutstanding, confirmRun, deleteDraftRun, processRun, runExceptions } from "../server/services/payroll";

let failures = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!cond) failures++;
};
const approx = (a: number, b: number) => Math.abs(a - b) < 0.011;

class Rollback extends Error {}

async function refuses(label: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    ok(label, false, "was allowed — it must not be");
  } catch (e) {
    ok(label, true, `"${(e as Error).message.slice(0, 70)}"`);
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

try {
  await db.transaction(async (tx: Tx) => {
    const [user] = await tx.select({ id: users.id }).from(users).limit(1);
    if (!user) throw new Error("need a user to test with");
    const uid = user.id;

    /* ── A world of exactly two people ─────────────────────────────────── */
    // Everyone real goes inactive (rolled back), the real holiday calendar
    // goes blank, and the settings become the known statutory numbers — so
    // every figure below is arithmetic, not archaeology.
    await tx.update(employees).set({ isActive: false });
    await tx.delete(holidays);
    await tx.update(payrollSettings).set({
      pfEmployeePct: 12,
      pfEmployerPct: 12,
      pfWageCeiling: "15000.00",
      esiEmployeePct: 0.75,
      esiEmployerPct: 3.25,
      esiGrossCeiling: "21000.00",
      ptSlabs: [
        { upTo: 10000, amount: 0 },
        { upTo: 15000, amount: 150 },
        { upTo: null, amount: 200 },
      ],
      fullDayHours: 8,
      halfDayHours: 4,
      clPerMonth: 1,
      clMaxConsecutive: 6,
      slPerMonth: 0.5,
      compOffValidityDays: 45,
    });
    await tx.execute(sql`DELETE FROM salary_slips WHERE payroll_run_id IN (SELECT id FROM payroll_runs WHERE year = 2026 AND month IN (6, 7))`);
    await tx.execute(sql`DELETE FROM payroll_runs WHERE year = 2026 AND month IN (6, 7)`);
    // A database seeded before the payroll chart hooks may be missing some of
    // the system keys the run posts to; give it scratch accounts (rolled back
    // with everything else) so the journal test is about the journal.
    const NEEDED: [string, string][] = [
      ["salary_expense", "expense"],
      ["wages_expense", "expense"],
      ["pf_employer_expense", "expense"],
      ["esi_employer_expense", "expense"],
      ["pf_payable", "liability"],
      ["esi_payable", "liability"],
      ["pt_payable", "liability"],
      ["salary_payable", "liability"],
    ];
    let zz = 0;
    for (const [key, type] of NEEDED) {
      const [have] = await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.systemKey, key));
      if (!have) {
        await tx.execute(sql`INSERT INTO accounts (code, name, type, system_key) VALUES (${"ZZPR" + ++zz}, ${"ZZ Check " + key}, ${type}::account_type, ${key})`);
      }
    }

    const [role] = await tx.insert(wageRoles).values({ name: "ZZ Check Loader", dailyRate: "500.00" }).returning();
    const [shift] = await tx
      .insert(shifts)
      .values({ name: "ZZ Check General", startTime: "09:00", endTime: "18:00", workingHours: 8, weeklyOffDays: [0] })
      .returning();
    const [sal] = await tx
      .insert(employees)
      .values({
        empCode: "ZZSAL1",
        name: "ZZ Check Salaried",
        payType: "salaried",
        dateOfJoining: "2026-01-01",
        basicSalary: "31000.00",
        hra: "3100.00",
        allowances: "6200.00",
        pfEnabled: true,
        esiEnabled: true,
        openingCl: 2,
      })
      .returning();
    const [wage] = await tx
      .insert(employees)
      .values({
        empCode: "ZZWAG1",
        name: "ZZ Check Wage",
        payType: "daily_wage",
        wageRoleId: role!.id,
        dateOfJoining: "2026-07-01",
        pfEnabled: false,
        esiEnabled: false,
      })
      .returning();
    await tx.insert(shiftAssignments).values({ employeeId: sal!.id, shiftId: shift!.id, effectiveFrom: "2026-01-01" });

    // Two holidays: the 14th (nobody comes) and the 15th (somebody does).
    await tx.insert(holidays).values([
      { name: "ZZ Check Holiday A", date: "2026-07-14", type: "company" },
      { name: "ZZ Check Holiday B", date: "2026-07-15", type: "company" },
    ]);

    /** A punch pair in IST, straight into July. */
    const punch = (empId: string, day: string, type: "in" | "out", time: string) =>
      tx.insert(punches).values({ employeeId: empId, type, punchDate: day, punchedAt: new Date(`${day}T${time}:00+05:30`), method: "manual", markedBy: uid });

    // Salaried: half day (5h), a short day (1h), a broken pairing day (7h),
    // a forgotten punch-out, and a full day ON the holiday.
    await punch(sal!.id, "2026-07-06", "in", "09:00");
    await punch(sal!.id, "2026-07-06", "out", "14:00");
    await punch(sal!.id, "2026-07-07", "in", "09:00");
    await punch(sal!.id, "2026-07-07", "out", "10:00");
    await punch(sal!.id, "2026-07-08", "in", "09:00");
    await punch(sal!.id, "2026-07-08", "in", "09:05"); // double tap — earliest anchor holds
    await punch(sal!.id, "2026-07-08", "out", "12:00");
    await punch(sal!.id, "2026-07-08", "out", "12:05"); // stray — ignored
    await punch(sal!.id, "2026-07-08", "in", "13:00");
    await punch(sal!.id, "2026-07-08", "out", "17:00");
    await punch(sal!.id, "2026-07-09", "in", "09:00"); // never punched out
    await punch(sal!.id, "2026-07-15", "in", "09:00");
    await punch(sal!.id, "2026-07-15", "out", "18:00");

    // Daily wage: three full days and one exactly-4-hours half day.
    for (const d of ["2026-07-01", "2026-07-02", "2026-07-03"]) {
      await punch(wage!.id, d, "in", "09:00");
      await punch(wage!.id, d, "out", "18:00");
    }
    await punch(wage!.id, "2026-07-04", "in", "09:00");
    await punch(wage!.id, "2026-07-04", "out", "13:00");

    // CL over the 12th (a Sunday) through the 15th, approved — the ladder's
    // middle rungs: leave beats weekly off, holiday beats leave, punch beats
    // holiday.
    const leaveApp = await applyLeave(tx, {
      employeeId: sal!.id,
      leaveType: "CL",
      fromDate: "2026-07-12",
      toDate: "2026-07-15",
      reason: "check script",
    });
    await approveLeave(tx, leaveApp.id, uid);

    // HR rules the 20th present by hand; recompute must not touch it.
    await tx.insert(attendanceDays).values({ employeeId: sal!.id, day: "2026-07-20", status: "P", source: "manual", note: "check", setBy: uid });

    await recomputeRange(tx, "2026-07-01", "2026-07-31");

    console.log("\n  resolver\n");
    const dayOf = async (empId: string, day: string) => {
      const [r] = await tx.select().from(attendanceDays).where(and(eq(attendanceDays.employeeId, empId), eq(attendanceDays.day, day)));
      return r ?? null;
    };
    let d = await dayOf(sal!.id, "2026-07-15");
    ok("a punch on a holiday makes the day present", d?.status === "P" && d?.source === "punch", `${d?.status}/${d?.source}`);
    d = await dayOf(sal!.id, "2026-07-14");
    ok("a holiday under approved leave stays a holiday", d?.status === "HO" && d?.source === "holiday", `${d?.status}/${d?.source}`);
    d = await dayOf(sal!.id, "2026-07-13");
    ok("approved leave marks the day L", d?.status === "L" && d?.source === "leave");
    d = await dayOf(sal!.id, "2026-07-12");
    ok("leave over a Sunday is leave, not weekly off", d?.status === "L" && d?.source === "leave");
    d = await dayOf(sal!.id, "2026-07-19");
    ok("a bare Sunday is the weekly off", d?.status === "WO" && d?.source === "weekly_off");
    d = await dayOf(sal!.id, "2026-07-21");
    ok("a bare weekday is absent", d?.status === "A" && d?.source === "absent");
    d = await dayOf(sal!.id, "2026-07-06");
    ok("five worked hours is a half day", d?.status === "H" && d?.workedHours === 5);
    d = await dayOf(wage!.id, "2026-07-04");
    ok("exactly four hours is still a half day", d?.status === "H" && d?.workedHours === 4);
    d = await dayOf(sal!.id, "2026-07-07");
    ok("one worked hour is absent", d?.status === "A" && d?.source === "punch");
    d = await dayOf(sal!.id, "2026-07-08");
    ok("punches pair in→out; strays and double taps ignored", d?.status === "H" && d?.workedHours === 7, `${d?.workedHours}h`);
    d = await dayOf(sal!.id, "2026-07-09");
    ok("a forgotten punch-out on a past day resolves H", d?.status === "H" && d?.source === "punch");
    d = await dayOf(sal!.id, "2026-07-20");
    ok("the manual override survived the recompute", d?.status === "P" && d?.source === "manual");
    d = await dayOf(wage!.id, "2026-06-30");
    ok("no row before the date of joining", d === null);

    /* ── Leave balance ─────────────────────────────────────────────────── */
    console.log("\n  leave\n");
    const today = istDate();
    // DOJ 1 Jan 2026 with day-of-month 1: months accrued this year = the
    // current month number (capped by the year's end).
    const monthsThisYear = today.slice(0, 4) === "2026" ? Number(today.slice(5, 7)) : 12;
    const bal = await leaveBalance(tx, sal!.id, 2026);
    ok(
      "CL earned = accrual + opening",
      bal.CL.earned === Math.min(12, monthsThisYear) + 2,
      `${bal.CL.earned} = min(12, ${monthsThisYear}) + 2`,
    );
    ok("CL used counts the approved application", bal.CL.used === 4 && bal.CL.balance === bal.CL.earned - 4);
    ok("SL accrues at half a day a month", bal.SL.earned === Math.min(6, monthsThisYear * 0.5), `${bal.SL.earned}`);
    ok("the worked holiday earned one comp-off", bal.CompOff.earned === 1);
    const compOffValid = addDays("2026-07-15", 45) >= today;
    ok(
      compOffValid ? "the comp-off is still inside its validity" : "the comp-off has expired on schedule",
      bal.CompOff.balance === (compOffValid ? 1 : 0),
      `balance ${bal.CompOff.balance}`,
    );
    await refuses("CL longer than the consecutive cap → refused", () =>
      applyLeave(tx, { employeeId: sal!.id, leaveType: "CL", fromDate: "2026-09-01", toDate: "2026-09-08", reason: "too long" }),
    );
    await refuses("a comp-off against a day never worked → refused", () =>
      applyLeave(tx, { employeeId: sal!.id, leaveType: "CompOff", fromDate: "2026-08-03", toDate: "2026-08-03", reason: "x", compOffWorkDate: "2026-07-16" }),
    );

    /* ── The run ───────────────────────────────────────────────────────── */
    console.log("\n  payroll run\n");
    // A ₹1,000 bonus, approved for July; a ₹50,000 advance whose ₹20,000 EMI
    // is far more than July's net can carry.
    const [bonus] = await tx
      .insert(payInputs)
      .values({ employeeId: sal!.id, kind: "bonus", month: 7, year: 2026, amount: "1000.00", status: "approved", createdBy: uid })
      .returning();
    const [adv] = await tx
      .insert(advances)
      .values({ employeeId: sal!.id, amount: "50000.00", emiAmount: "20000.00", givenOn: "2026-06-15", createdBy: uid })
      .returning();

    const run = await processRun(tx, { month: 7, year: 2026, userId: uid });
    const slips = await tx.select().from(salarySlips).where(eq(salarySlips.payrollRunId, run.id));
    ok("two slips, one per person", slips.length === 2);
    const s = slips.find((x) => x.employeeId === sal!.id)!;
    const w = slips.find((x) => x.employeeId === wage!.id)!;

    // Salaried: P2 H3 WO3 HO1 L2 → paid 9.5 of 31.
    ok("salaried paid days = P + H/2 + WO + HO + L; LOP = A", s.paidDays === 9.5 && s.lopDays === 20, `paid ${s.paidDays}, lop ${s.lopDays}`);
    ok("earned basic prorates by paid days", approx(Number(s.earnedBasic), 9500), s.earnedBasic);
    ok("earned gross = basic + HRA + allowances, prorated", approx(Number(s.earnedGross), 12350), s.earnedGross);
    ok("PF 12% each side on earned basic (under the ceiling)", approx(Number(s.pfEmployee), 1140) && approx(Number(s.pfEmployer), 1140));
    ok("ESI 0.75% / 3.25% of earned gross", approx(Number(s.esiEmployee), 92.63) && approx(Number(s.esiEmployer), 401.38), `${s.esiEmployee} / ${s.esiEmployer}`);
    ok("PT from the slab the gross lands in", approx(Number(s.professionalTax), 150));
    ok("the bonus rode in", approx(Number(s.bonus), 1000));
    // net before advance = 12350 + 1000 − 1140 − 92.63 − 150 = 11967.37; the
    // EMI wants 20000 but may only take what is there.
    ok("advance recovery capped at the remaining net", approx(Number(s.advanceRecovery), 11967.37), s.advanceRecovery);
    ok("net pay lands at zero, never below", approx(Number(s.netPay), 0), s.netPay);
    ok("outstanding fell by exactly the recovery", approx(await advanceOutstanding(tx, adv!.id), 38032.63));

    // Daily wage: 3 P + 1 H at ₹500 → 1750, nothing withheld.
    ok("daily wage earns rate × (P + H/2)", approx(Number(w.earnedGross), 1750) && approx(Number(w.earnedBasic), 1750), w.earnedGross);
    ok("no PF/ESI with the flags off", Number(w.pfEmployee) === 0 && Number(w.esiEmployee) === 0);
    ok("wage net = wage gross", approx(Number(w.netPay), 1750));

    ok(
      "run totals foot",
      approx(Number(run.totalGross), 15100) && approx(Number(run.totalNet), 1750) && approx(Number(run.totalEmployerCost), 16641.38),
      `gross ${run.totalGross}, net ${run.totalNet}, CTC ${run.totalEmployerCost}`,
    );

    const [bonusAfter] = await tx.select().from(payInputs).where(eq(payInputs.id, bonus!.id));
    ok("the bonus is marked paid by this run", bonusAfter?.status === "paid" && bonusAfter?.payrollRunId === run.id);

    const exceptions = await runExceptions(tx, run.id);
    ok("the zero-net slip surfaces as an exception", exceptions.some((e) => e.employeeId === sal!.id && e.issue.includes("Net pay")));
    ok("missing bank details surface too", exceptions.some((e) => e.issue.includes("bank")));

    /* ── Reprocess: the draft's side effects revert first ──────────────── */
    console.log("\n  reprocess\n");
    const run2 = await processRun(tx, { month: 7, year: 2026, userId: uid });
    ok("the draft row is reused, not duplicated", run2.id === run.id);
    const reps = await tx.select().from(advanceRepayments).where(eq(advanceRepayments.advanceId, adv!.id));
    ok("one repayment row, not two — the revert held", reps.length === 1, `${reps.length} row(s)`);
    ok("outstanding unchanged by the reprocess", approx(await advanceOutstanding(tx, adv!.id), 38032.63));
    const [bonusAfter2] = await tx.select().from(payInputs).where(eq(payInputs.id, bonus!.id));
    ok("the bonus is paid by the reprocessed draft", bonusAfter2?.status === "paid" && bonusAfter2?.payrollRunId === run2.id);
    ok("still exactly two slips", (await tx.select().from(salarySlips).where(eq(salarySlips.payrollRunId, run2.id))).length === 2);

    /* ── Confirm: one balanced journal, the plan's lines ───────────────── */
    console.log("\n  confirm\n");
    const confirmed = await confirmRun(tx, run.id, uid);
    ok("the run is confirmed with a journal", confirmed.run.status === "confirmed" && !!confirmed.journalEntryId);
    const lines = await tx
      .select({ systemKey: accounts.systemKey, debit: journalEntryLines.debit, credit: journalEntryLines.credit })
      .from(journalEntryLines)
      .innerJoin(accounts, eq(accounts.id, journalEntryLines.accountId))
      .where(eq(journalEntryLines.entryId, confirmed.journalEntryId));
    const line = (key: string) => lines.find((l) => l.systemKey === key);
    const expect: [string, "debit" | "credit", number][] = [
      ["salary_expense", "debit", 13350], // 12350 gross + 1000 bonus
      ["wages_expense", "debit", 1750],
      ["pf_employer_expense", "debit", 1140],
      ["esi_employer_expense", "debit", 401.38],
      ["pf_payable", "credit", 2280],
      ["esi_payable", "credit", 494.01],
      ["pt_payable", "credit", 150],
      ["salary_payable", "credit", 13717.37], // net 1750 + advance 11967.37
    ];
    for (const [key, side, amount] of expect) {
      const l = line(key);
      ok(`${side === "debit" ? "Dr" : "Cr"} ${key} ${amount}`, !!l && approx(Number(l[side]), amount), l ? `${l.debit}/${l.credit}` : "missing");
    }
    ok("no other lines slipped in", lines.length === expect.length, `${lines.length} lines`);
    const dr = lines.reduce((n, l) => n + Number(l.debit), 0);
    const cr = lines.reduce((n, l) => n + Number(l.credit), 0);
    ok("the journal balances", approx(dr, cr), `Dr ${dr.toFixed(2)} = Cr ${cr.toFixed(2)}`);

    await refuses("a confirmed month refuses reprocessing", () => processRun(tx, { month: 7, year: 2026, userId: uid }));
    await refuses("a confirmed run refuses deletion", () => deleteDraftRun(tx, run.id));
    await refuses("confirming twice refuses", () => confirmRun(tx, run.id, uid));

    /* ── Delete a draft: everything walks back ─────────────────────────── */
    console.log("\n  delete draft\n");
    // June: the salaried employee alone (the wage hand joined in July), no
    // punches, so the advance eats whatever four Sundays' proration nets.
    const june = await processRun(tx, { month: 6, year: 2026, userId: uid });
    ok("June processed as its own draft", june.id !== run.id && june.status === "draft");
    const outstandingBefore = await advanceOutstanding(tx, adv!.id);
    ok("June's draft recovered something more", outstandingBefore < 38032.63, `outstanding ${outstandingBefore.toFixed(2)}`);
    await deleteDraftRun(tx, june.id);
    const [goneRun] = await tx.select().from(payrollRuns).where(eq(payrollRuns.id, june.id));
    ok("the draft run is gone", !goneRun);
    ok("its slips went with it", (await tx.select().from(salarySlips).where(eq(salarySlips.payrollRunId, june.id))).length === 0);
    ok("the advance outstanding walked back", approx(await advanceOutstanding(tx, adv!.id), 38032.63));

    throw new Rollback();
  });
} catch (e) {
  if (!(e instanceof Rollback)) {
    console.error(e);
    failures++;
  }
}

// Prove the rollback held: none of the test artefacts survived.
const [left] = await db
  .select({ n: sql<number>`count(*)::int` })
  .from(employees)
  .where(inArray(employees.empCode, ["ZZSAL1", "ZZWAG1"]));
ok("the rollback left nothing behind", left!.n === 0);

console.log(failures ? `\n  ${failures} failed\n` : "\n  all good\n");
process.exit(failures ? 1 : 0);
