import { buildXlsx, type Cell } from "../lib/xlsx";
import type { runSlips } from "./payroll";

/**
 * A confirmed month's files, as Amino's Payroll Reports gave them: the salary
 * register, the bank NEFT list, the PF and ESI challans, and the cost by
 * department — each as CSV or Excel (5 Oct 2026). Same columns as Amino's,
 * plus professional tax and other deductions in the register, which Amino had
 * no column for and without which its total deductions do not add up.
 *
 * UAN and ESI numbers come from the employee record; Amino left them blank.
 * EDLI stays 0 as it did there.
 */
export const PAYROLL_REPORTS = ["register", "neft", "pf", "esi", "dept"] as const;
export type PayrollReport = (typeof PAYROLL_REPORTS)[number];

type Slip = Awaited<ReturnType<typeof runSlips>>[number];
interface Table {
  title: string;
  headers: string[];
  /** Per column: text keeps leading zeros (accounts, UAN), money and number stay numeric. */
  kinds: ("text" | "number" | "money")[];
  rows: (string | number)[][];
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const n = (v: unknown) => Math.round(Number(v ?? 0) * 100) / 100;

function table(report: PayrollReport, slips: Slip[], pfWageCeiling: number): Table {
  switch (report) {
    case "register":
      return {
        title: "Salary Register",
        headers: [
          "Department", "Emp Code", "Name", "Designation", "Total Days", "Paid Days", "LOP Days",
          "Basic", "HRA", "Allowances", "Gross", "Earned Basic", "Earned HRA", "Earned Allow.", "Earned Gross",
          "PF (Emp)", "PF (Er)", "ESI (Emp)", "ESI (Er)", "PT", "Bonus", "Overtime", "Arrears", "Expense Reimb.",
          "Advance", "Other Ded.", "Total Ded.", "Net Salary",
        ],
        kinds: ["text", "text", "text", "text", "number", "number", "number", ...Array<"money">(21).fill("money")],
        rows: slips.map((s) => [
          s.department ?? "", s.empCode, s.name, s.designation ?? "", s.totalDays, n(s.paidDays), n(s.lopDays),
          n(s.basicSalary), n(s.hra), n(s.allowances), n(n(s.basicSalary) + n(s.hra) + n(s.allowances)),
          n(s.earnedBasic), n(s.earnedHra), n(s.earnedAllowances), n(s.earnedGross),
          n(s.pfEmployee), n(s.pfEmployer), n(s.esiEmployee), n(s.esiEmployer), n(s.professionalTax),
          n(s.bonus), n(s.overtime), n(s.arrears), n(s.reimbursement),
          n(s.advanceRecovery), n(s.otherDeductions), n(s.totalDeductions), n(s.netPay),
        ]),
      };
    case "neft":
      return {
        title: "NEFT",
        headers: ["Employee Code", "Employee Name", "Bank Name", "Account Number", "IFSC", "Amount"],
        kinds: ["text", "text", "text", "text", "text", "money"],
        rows: slips
          .filter((s) => s.bankAccountNumber && n(s.netPay) > 0)
          .map((s) => [s.empCode, s.name, s.bankName ?? "", s.bankAccountNumber ?? "", s.bankIfsc ?? "", n(s.netPay)]),
      };
    case "pf":
      return {
        title: "PF Challan",
        headers: ["UAN", "Employee Code", "Employee Name", "Gross Wages", "EPF Wages", "EPF Employee", "EPF Employer", "EPS", "EDLI"],
        kinds: ["text", "text", "text", "money", "money", "money", "money", "money", "money"],
        rows: slips
          .filter((s) => n(s.pfEmployee) > 0)
          .map((s) => {
            // The wages PF was reckoned on — the run caps earned basic at the ceiling.
            const epfWages = pfWageCeiling > 0 ? Math.min(n(s.earnedBasic), pfWageCeiling) : n(s.earnedBasic);
            const eps = Math.min(Math.round(epfWages * 0.0833), 1250);
            return [s.uanNumber ?? "", s.empCode, s.name, n(s.earnedGross), epfWages, n(s.pfEmployee), n(s.pfEmployer), eps, 0];
          }),
      };
    case "esi":
      return {
        title: "ESI Challan",
        headers: ["ESI Number", "Employee Code", "Employee Name", "No of Days", "Total Earnings", "Employee Share", "Employer Share"],
        kinds: ["text", "text", "text", "number", "money", "money", "money"],
        rows: slips
          .filter((s) => n(s.esiEmployee) > 0)
          .map((s) => [s.esiNumber ?? "", s.empCode, s.name, n(s.paidDays), n(s.earnedGross), n(s.esiEmployee), n(s.esiEmployer)]),
      };
    case "dept": {
      const by = new Map<string, { count: number; gross: number; pf: number; esi: number; net: number; ctc: number }>();
      for (const s of slips) {
        const d = s.department ?? "No department";
        const a = by.get(d) ?? { count: 0, gross: 0, pf: 0, esi: 0, net: 0, ctc: 0 };
        a.count++;
        a.gross += n(s.earnedGross);
        a.pf += n(s.pfEmployee) + n(s.pfEmployer);
        a.esi += n(s.esiEmployee) + n(s.esiEmployer);
        a.net += n(s.netPay);
        a.ctc += n(s.earnedGross) + n(s.pfEmployer) + n(s.esiEmployer);
        by.set(d, a);
      }
      return {
        title: "Dept Cost",
        headers: ["Department", "Employees", "Gross Salary", "Total PF", "Total ESI", "Net Salary", "CTC"],
        kinds: ["text", "number", "money", "money", "money", "money", "money"],
        rows: [...by.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([d, a]) => [d, a.count, n(a.gross), n(a.pf), n(a.esi), n(a.net), n(a.ctc)]),
      };
    }
  }
}

const FILE_STEM: Record<PayrollReport, string> = {
  register: "Salary_Register",
  neft: "NEFT",
  pf: "PF_Challan",
  esi: "ESI_Challan",
  dept: "Dept_Cost",
};

export function payrollReportFile(
  report: PayrollReport,
  format: "csv" | "xlsx",
  run: { month: number; year: number },
  slips: Slip[],
  pfWageCeiling: number,
): { filename: string; contentType: string; body: Buffer | string } {
  const t = table(report, slips, pfWageCeiling);
  const stem = `${FILE_STEM[report]}_${MONTHS[run.month - 1]}_${run.year}`;
  if (format === "csv") {
    const esc = (v: string | number) => {
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const body = [t.headers, ...t.rows].map((r) => r.map(esc).join(",")).join("\n");
    return { filename: `${stem}.csv`, contentType: "text/csv", body };
  }
  const rows: Cell[][] = [
    t.headers.map((h) => ({ value: h, style: "header" as const })),
    ...t.rows.map((r) => r.map((v, i) => ({ value: v, style: t.kinds[i] }))),
  ];
  return {
    filename: `${stem}.xlsx`,
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    body: buildXlsx({ name: t.title, columnWidths: t.headers.map((h) => Math.max(12, h.length + 2)), rows }),
  };
}
