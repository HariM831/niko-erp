/**
 * Payroll — people, time and pay.
 *
 * Ported from Amino's payroll, minus the duplication it grew. One table of
 * people covers salaried staff and daily-wage labour (`pay_type`), so there
 * is one punch table, one attendance table and one run. Attendance is a row
 * per employee-day rather than a month row with a jsonb calendar, so a month
 * is a SUM and the question "who was in on the 14th" is a WHERE. Bonuses,
 * overtime, reimbursements and one-off deductions are all `pay_inputs`; an
 * advance is the one pay item that carries a balance, and that balance is
 * derived from its repayments, never stored.
 *
 * Statutory rates live in `payroll_settings`. PF and ESI are law, not a
 * per-company component list.
 *
 * Day resolution precedence — punch > holiday > approved leave > weekly off
 * > absent — is implemented once, in server/services/day-resolution.ts, and
 * the results are what `attendance_days` holds.
 */
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { users } from "./auth";
import { journalEntries } from "./accounting";
import { locations } from "./locations";

const money = (name: string) => numeric(name, { precision: 14, scale: 2 });

/* ── Enums ─────────────────────────────────────────────────────────────── */

export const payType = pgEnum("pay_type", ["salaried", "daily_wage"]);
export const punchType = pgEnum("punch_type", ["in", "out"]);
export const punchMethod = pgEnum("punch_method", ["face", "manual", "device"]);
/** P present, H half day, A absent, WO weekly off, HO holiday, L approved leave. */
export const attendanceStatus = pgEnum("attendance_status", ["P", "H", "A", "WO", "HO", "L"]);
/** What decided the day. `manual` is an HR override and survives recomputes. */
export const attendanceSource = pgEnum("attendance_source", [
  "punch",
  "holiday",
  "leave",
  "weekly_off",
  "absent",
  "manual",
  "import",
]);
export const leaveType = pgEnum("leave_type", ["CL", "SL", "CompOff"]);
export const approvalStatus = pgEnum("approval_status", ["pending", "approved", "rejected"]);
export const holidayType = pgEnum("holiday_type", ["national", "regional", "company"]);
export const advanceType = pgEnum("advance_type", ["salary_advance", "loan"]);
export const advanceStatus = pgEnum("advance_status", ["active", "closed", "cancelled"]);
export const payInputKind = pgEnum("pay_input_kind", ["bonus", "overtime", "reimbursement", "deduction"]);
export const payInputStatus = pgEnum("pay_input_status", ["pending", "approved", "rejected", "paid"]);
export const payrollRunStatus = pgEnum("payroll_run_status", ["draft", "confirmed"]);

/* ── Structure ─────────────────────────────────────────────────────────── */

export const departments = pgTable("departments", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const designations = pgTable(
  "designations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    departmentId: uuid("department_id")
      .notNull()
      .references(() => departments.id),
    name: text("name").notNull(),
    /** Rank within the department; the team grid sorts by it. */
    displayOrder: integer("display_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
  },
  (t) => [uniqueIndex("uq_designations_dept_name").on(t.departmentId, t.name)],
);

/** The rate card for daily-wage labour. The device never sees the rate. */
export const wageRoles = pgTable("wage_roles", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  dailyRate: money("daily_rate").notNull(),
  isActive: boolean("is_active").notNull().default(true),
});

export const shifts = pgTable("shifts", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  startTime: varchar("start_time", { length: 5 }).notNull(), // "06:00"
  endTime: varchar("end_time", { length: 5 }).notNull(),
  workingHours: real("working_hours").notNull().default(8),
  /** 0 = Sunday … 6 = Saturday. */
  weeklyOffDays: integer("weekly_off_days").array().notNull().default([0]),
  color: varchar("color", { length: 9 }).notNull().default("#3B82F6"),
  isActive: boolean("is_active").notNull().default(true),
});

/**
 * One row per person, whichever way they are paid. A daily-wage worker has a
 * wage role and no salary; a salaried employee has a salary and no role. The
 * gate, the canteen and attendance never care which.
 */
export const employees = pgTable(
  "employees",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    empCode: varchar("emp_code", { length: 20 }).notNull().unique(),
    name: text("name").notNull(),
    payType: payType("pay_type").notNull().default("salaried"),
    departmentId: uuid("department_id").references(() => departments.id),
    designationId: uuid("designation_id").references(() => designations.id),
    wageRoleId: uuid("wage_role_id").references(() => wageRoles.id),
    /** Where they normally work; the canteen roster and device pulls filter on it. */
    locationId: uuid("location_id").references(() => locations.id),
    reportingTo: uuid("reporting_to").references((): any => employees.id),
    dateOfJoining: date("date_of_joining"),
    dateOfLeaving: date("date_of_leaving"),
    contactNumber: varchar("contact_number", { length: 20 }),
    email: text("email"),
    panNumber: varchar("pan_number", { length: 10 }),
    aadharNumber: varchar("aadhar_number", { length: 12 }),
    uanNumber: varchar("uan_number", { length: 12 }),
    esiNumber: varchar("esi_number", { length: 17 }),
    bankName: text("bank_name"),
    bankAccountNumber: varchar("bank_account_number", { length: 30 }),
    bankIfsc: varchar("bank_ifsc", { length: 11 }),
    basicSalary: money("basic_salary").notNull().default("0"),
    hra: money("hra").notNull().default("0"),
    allowances: money("allowances").notNull().default("0"),
    pfEnabled: boolean("pf_enabled").notNull().default(true),
    esiEnabled: boolean("esi_enabled").notNull().default(true),
    openingCl: real("opening_cl").notNull().default(0),
    openingSl: real("opening_sl").notNull().default(0),
    emergencyContactName: text("emergency_contact_name"),
    emergencyContactNumber: varchar("emergency_contact_number", { length: 20 }),
    emergencyContactRelation: text("emergency_contact_relation"),
    /** Data URL; served to devices as a 96 px JPEG by /api/device/photo. */
    photoUrl: text("photo_url"),
    /** sha256 of photoUrl, so a device can ask "changed?" without the bytes. */
    photoHash: varchar("photo_hash", { length: 64 }),
    panDocUrl: text("pan_doc_url"),
    aadharDocUrl: text("aadhar_doc_url"),
    /** Face embedding (Human FaceRes, 1024 floats). Matching is on-device. */
    faceDescriptor: jsonb("face_descriptor").$type<number[]>(),
    faceEnrolledAt: timestamp("face_enrolled_at", { withTimezone: true }),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Drives the devices' delta pull — every write must bump it. */
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ix_employees_updated").on(t.updatedAt), index("ix_employees_dept").on(t.departmentId)],
);

export const shiftAssignments = pgTable(
  "shift_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id),
    shiftId: uuid("shift_id")
      .notNull()
      .references(() => shifts.id),
    effectiveFrom: date("effective_from").notNull(),
    /** Null while open. */
    effectiveTo: date("effective_to"),
    notes: text("notes"),
  },
  (t) => [index("ix_shift_assignments_emp").on(t.employeeId, t.effectiveFrom)],
);

export const holidays = pgTable("holidays", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  date: date("date").notNull(),
  type: holidayType("type").notNull().default("company"),
  /** Same day every year. */
  isRecurring: boolean("is_recurring").notNull().default(false),
});

/** Singleton. Statutory rates and the handful of policy numbers. */
export const payrollSettings = pgTable("payroll_settings", {
  id: integer("id").primaryKey().default(1),
  pfEmployeePct: real("pf_employee_pct").notNull().default(12),
  pfEmployerPct: real("pf_employer_pct").notNull().default(12),
  /** PF is computed on basic up to this; 0 = no ceiling. */
  pfWageCeiling: money("pf_wage_ceiling").notNull().default("15000"),
  esiEmployeePct: real("esi_employee_pct").notNull().default(0.75),
  esiEmployerPct: real("esi_employer_pct").notNull().default(3.25),
  /** ESI applies only when gross is at or under this. */
  esiGrossCeiling: money("esi_gross_ceiling").notNull().default("21000"),
  /** Professional tax slabs: [{ upTo: number | null, amount: number }]. */
  ptSlabs: jsonb("pt_slabs").$type<{ upTo: number | null; amount: number }[]>().notNull().default([]),
  fullDayHours: real("full_day_hours").notNull().default(8),
  halfDayHours: real("half_day_hours").notNull().default(4),
  clPerMonth: real("cl_per_month").notNull().default(1),
  clMaxConsecutive: integer("cl_max_consecutive").notNull().default(6),
  slPerMonth: real("sl_per_month").notNull().default(0.5),
  compOffValidityDays: integer("comp_off_validity_days").notNull().default(30),
  /** A face match under this score keeps its photo for review. */
  reviewBelowScore: real("review_below_score").notNull().default(0.72),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ── Time ──────────────────────────────────────────────────────────────── */

/**
 * A punch at a gate, from the browser kiosk, a paired device, or HR by hand.
 * `punchDate` is the IST business date, computed server-side. The photo is
 * kept only when the match was doubtful or the punch was manual — the ones
 * anyone will ever look at.
 */
export const punches = pgTable(
  "punches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id),
    type: punchType("type").notNull(),
    punchDate: date("punch_date").notNull(),
    punchedAt: timestamp("punched_at", { withTimezone: true }).notNull().defaultNow(),
    method: punchMethod("method").notNull().default("face"),
    matchScore: real("match_score"),
    latitude: real("latitude"),
    longitude: real("longitude"),
    accuracyM: real("accuracy_m"),
    locationId: uuid("location_id").references(() => locations.id),
    photoUrl: text("photo_url"),
    /** Set by a paired device; its event id is the idempotency key. */
    deviceId: uuid("device_id"),
    clientId: varchar("client_id", { length: 64 }).unique(),
    markedBy: uuid("marked_by").references(() => users.id),
    /** HR closed a forgotten punch-out. */
    resolvedBy: uuid("resolved_by").references(() => users.id),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolutionNote: text("resolution_note"),
  },
  (t) => [
    index("ix_punches_emp_day").on(t.employeeId, t.punchDate),
    index("ix_punches_day").on(t.punchDate),
  ],
);

/** One row per employee-day, written by the resolver; month totals are sums. */
export const attendanceDays = pgTable(
  "attendance_days",
  {
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id),
    day: date("day").notNull(),
    status: attendanceStatus("status").notNull(),
    source: attendanceSource("source").notNull(),
    /**
     * The role actually worked that day — egg picking today, vaccination
     * helper tomorrow. Null means the worker's usual role; salaried employees
     * never carry one. Every place a wage day is priced reads THIS first and
     * falls back to employees.wageRoleId, so the daily sheet, the wages report
     * and the payroll run cannot disagree.
     */
    wageRoleId: uuid("wage_role_id").references(() => wageRoles.id),
    workedHours: real("worked_hours").notNull().default(0),
    note: text("note"),
    setBy: uuid("set_by").references(() => users.id),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("uq_attendance_days").on(t.employeeId, t.day), index("ix_attendance_days_day").on(t.day)],
);

export const leaveApplications = pgTable(
  "leave_applications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id),
    leaveType: leaveType("leave_type").notNull(),
    fromDate: date("from_date").notNull(),
    toDate: date("to_date").notNull(),
    days: real("days").notNull(),
    reason: text("reason").notNull(),
    status: approvalStatus("status").notNull().default("pending"),
    medicalDocUrl: text("medical_doc_url"),
    /** The extra day worked that a comp-off is drawn against. */
    compOffWorkDate: date("comp_off_work_date"),
    decidedBy: uuid("decided_by").references(() => users.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    remarks: text("remarks"),
    appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ix_leave_emp").on(t.employeeId, t.fromDate)],
);

/* ── Pay ───────────────────────────────────────────────────────────────── */

/** Anything that adds to or takes from one month's pay, other than an advance. */
export const payInputs = pgTable(
  "pay_inputs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id),
    kind: payInputKind("kind").notNull(),
    /** Pay it in this month. */
    month: integer("month").notNull(),
    year: integer("year").notNull(),
    amount: money("amount").notNull(),
    /** Overtime only: amount = hours × rate, computed on the server. */
    hours: real("hours"),
    ratePerHour: money("rate_per_hour"),
    /** Free text: festival / travel / canteen recovery … */
    category: text("category"),
    description: text("description"),
    receiptUrl: text("receipt_url"),
    status: payInputStatus("status").notNull().default("pending"),
    approvedAmount: money("approved_amount"),
    decidedBy: uuid("decided_by").references(() => users.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    payrollRunId: uuid("payroll_run_id"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ix_pay_inputs_month").on(t.year, t.month, t.status)],
);

export const advances = pgTable("advances", {
  id: uuid("id").primaryKey().defaultRandom(),
  employeeId: uuid("employee_id")
    .notNull()
    .references(() => employees.id),
  type: advanceType("type").notNull().default("salary_advance"),
  amount: money("amount").notNull(),
  /** Recovered per month from pay. */
  emiAmount: money("emi_amount").notNull().default("0"),
  givenOn: date("given_on").notNull(),
  reason: text("reason"),
  status: advanceStatus("status").notNull().default("active"),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Outstanding = advance.amount − SUM(repayments). */
export const advanceRepayments = pgTable(
  "advance_repayments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    advanceId: uuid("advance_id")
      .notNull()
      .references(() => advances.id),
    amount: money("amount").notNull(),
    month: integer("month").notNull(),
    year: integer("year").notNull(),
    /** Null = recovered by hand, outside a run. */
    payrollRunId: uuid("payroll_run_id"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ix_advance_repayments_adv").on(t.advanceId)],
);

export const payrollRuns = pgTable(
  "payroll_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    month: integer("month").notNull(),
    year: integer("year").notNull(),
    status: payrollRunStatus("status").notNull().default("draft"),
    employeeCount: integer("employee_count").notNull().default(0),
    totalGross: money("total_gross").notNull().default("0"),
    totalDeductions: money("total_deductions").notNull().default("0"),
    totalNet: money("total_net").notNull().default("0"),
    totalEmployerCost: money("total_employer_cost").notNull().default("0"),
    processedBy: uuid("processed_by").references(() => users.id),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    confirmedBy: uuid("confirmed_by").references(() => users.id),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    journalEntryId: uuid("journal_entry_id").references(() => journalEntries.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("uq_payroll_runs_month").on(t.year, t.month)],
);

/**
 * One slip per person per run — a snapshot, since the employee row will
 * change and the slip must not. Daily-wage slips use paidDays × dailyRate as
 * gross with basic = gross and zero HRA/allowances.
 */
export const salarySlips = pgTable(
  "salary_slips",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    payrollRunId: uuid("payroll_run_id")
      .notNull()
      .references(() => payrollRuns.id, { onDelete: "cascade" }),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id),
    payType: payType("pay_type").notNull(),
    totalDays: integer("total_days").notNull(),
    presentDays: real("present_days").notNull().default(0),
    halfDays: real("half_days").notNull().default(0),
    weeklyOffs: real("weekly_offs").notNull().default(0),
    holidays: real("holidays").notNull().default(0),
    leaveDays: real("leave_days").notNull().default(0),
    paidDays: real("paid_days").notNull(),
    lopDays: real("lop_days").notNull().default(0),
    dailyRate: money("daily_rate"),
    basicSalary: money("basic_salary").notNull().default("0"),
    hra: money("hra").notNull().default("0"),
    allowances: money("allowances").notNull().default("0"),
    earnedBasic: money("earned_basic").notNull().default("0"),
    earnedHra: money("earned_hra").notNull().default("0"),
    earnedAllowances: money("earned_allowances").notNull().default("0"),
    earnedGross: money("earned_gross").notNull().default("0"),
    bonus: money("bonus").notNull().default("0"),
    overtime: money("overtime").notNull().default("0"),
    reimbursement: money("reimbursement").notNull().default("0"),
    pfEmployee: money("pf_employee").notNull().default("0"),
    pfEmployer: money("pf_employer").notNull().default("0"),
    esiEmployee: money("esi_employee").notNull().default("0"),
    esiEmployer: money("esi_employer").notNull().default("0"),
    professionalTax: money("professional_tax").notNull().default("0"),
    otherDeductions: money("other_deductions").notNull().default("0"),
    advanceRecovery: money("advance_recovery").notNull().default("0"),
    totalDeductions: money("total_deductions").notNull().default("0"),
    netPay: money("net_pay").notNull().default("0"),
    bankName: text("bank_name"),
    bankAccountNumber: varchar("bank_account_number", { length: 30 }),
    bankIfsc: varchar("bank_ifsc", { length: 11 }),
  },
  (t) => [uniqueIndex("uq_salary_slips_run_emp").on(t.payrollRunId, t.employeeId)],
);
