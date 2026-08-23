-- Payroll: people, time, pay, field devices and the canteen.
--
-- Ported from Amino's payroll with the duplication taken out: one table of
-- people for salaried and daily-wage alike, one punch table, attendance as a
-- row per employee-day, one pay_inputs table for bonus/overtime/claims/
-- deductions, advance balances derived from repayments, statutory rates in a
-- settings row, and a single device registry. See shared/schema/payroll.ts
-- and shared/schema/devices.ts for the reasoning at each table.

-- ── Enums ───────────────────────────────────────────────────────────────
CREATE TYPE "pay_type" AS ENUM ('salaried', 'daily_wage');
--> statement-breakpoint
CREATE TYPE "punch_type" AS ENUM ('in', 'out');
--> statement-breakpoint
CREATE TYPE "punch_method" AS ENUM ('face', 'manual', 'device');
--> statement-breakpoint
CREATE TYPE "attendance_status" AS ENUM ('P', 'H', 'A', 'WO', 'HO', 'L');
--> statement-breakpoint
CREATE TYPE "attendance_source" AS ENUM ('punch', 'holiday', 'leave', 'weekly_off', 'absent', 'manual', 'import');
--> statement-breakpoint
CREATE TYPE "leave_type" AS ENUM ('CL', 'SL', 'CompOff');
--> statement-breakpoint
CREATE TYPE "approval_status" AS ENUM ('pending', 'approved', 'rejected');
--> statement-breakpoint
CREATE TYPE "holiday_type" AS ENUM ('national', 'regional', 'company');
--> statement-breakpoint
CREATE TYPE "advance_type" AS ENUM ('salary_advance', 'loan');
--> statement-breakpoint
CREATE TYPE "advance_status" AS ENUM ('active', 'closed', 'cancelled');
--> statement-breakpoint
CREATE TYPE "pay_input_kind" AS ENUM ('bonus', 'overtime', 'reimbursement', 'deduction');
--> statement-breakpoint
CREATE TYPE "pay_input_status" AS ENUM ('pending', 'approved', 'rejected', 'paid');
--> statement-breakpoint
CREATE TYPE "payroll_run_status" AS ENUM ('draft', 'confirmed');
--> statement-breakpoint
CREATE TYPE "device_role" AS ENUM ('gate', 'canteen');
--> statement-breakpoint
CREATE TYPE "pairing_status" AS ENUM ('unused', 'claimed', 'pending', 'expired', 'rejected');
--> statement-breakpoint
CREATE TYPE "device_request_status" AS ENUM ('pending', 'approved', 'rejected', 'expired');
--> statement-breakpoint
CREATE TYPE "meal" AS ENUM ('breakfast', 'lunch', 'dinner');
--> statement-breakpoint
CREATE TYPE "serving_state" AS ENUM ('verified', 'name_matched', 'unverified_attendance', 'override', 'guest');
--> statement-breakpoint
CREATE TYPE "extra_plate_kind" AS ENUM ('guest', 'second_plate', 'override');
--> statement-breakpoint
ALTER TYPE "journal_source_type" ADD VALUE IF NOT EXISTS 'payroll_run';
--> statement-breakpoint

-- ── Structure ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "departments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" text NOT NULL UNIQUE,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "designations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "department_id" uuid NOT NULL REFERENCES "departments"("id"),
  "name" text NOT NULL,
  "display_order" integer NOT NULL DEFAULT 0,
  "is_active" boolean NOT NULL DEFAULT true
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_designations_dept_name" ON "designations" ("department_id", "name");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wage_roles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" text NOT NULL UNIQUE,
  "daily_rate" numeric(14,2) NOT NULL,
  "is_active" boolean NOT NULL DEFAULT true
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shifts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" text NOT NULL UNIQUE,
  "start_time" varchar(5) NOT NULL,
  "end_time" varchar(5) NOT NULL,
  "working_hours" real NOT NULL DEFAULT 8,
  "weekly_off_days" integer[] NOT NULL DEFAULT '{0}',
  "color" varchar(9) NOT NULL DEFAULT '#3B82F6',
  "is_active" boolean NOT NULL DEFAULT true
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "employees" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "emp_code" varchar(20) NOT NULL UNIQUE,
  "name" text NOT NULL,
  "pay_type" "pay_type" NOT NULL DEFAULT 'salaried',
  "department_id" uuid REFERENCES "departments"("id"),
  "designation_id" uuid REFERENCES "designations"("id"),
  "wage_role_id" uuid REFERENCES "wage_roles"("id"),
  "location_id" uuid REFERENCES "locations"("id"),
  "reporting_to" uuid REFERENCES "employees"("id"),
  "date_of_joining" date,
  "date_of_leaving" date,
  "contact_number" varchar(20),
  "email" text,
  "pan_number" varchar(10),
  "aadhar_number" varchar(12),
  "uan_number" varchar(12),
  "esi_number" varchar(17),
  "bank_name" text,
  "bank_account_number" varchar(30),
  "bank_ifsc" varchar(11),
  "basic_salary" numeric(14,2) NOT NULL DEFAULT 0,
  "hra" numeric(14,2) NOT NULL DEFAULT 0,
  "allowances" numeric(14,2) NOT NULL DEFAULT 0,
  "pf_enabled" boolean NOT NULL DEFAULT true,
  "esi_enabled" boolean NOT NULL DEFAULT true,
  "opening_cl" real NOT NULL DEFAULT 0,
  "opening_sl" real NOT NULL DEFAULT 0,
  "emergency_contact_name" text,
  "emergency_contact_number" varchar(20),
  "emergency_contact_relation" text,
  "photo_url" text,
  "photo_hash" varchar(64),
  "pan_doc_url" text,
  "aadhar_doc_url" text,
  "face_descriptor" jsonb,
  "face_enrolled_at" timestamptz,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_employees_updated" ON "employees" ("updated_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_employees_dept" ON "employees" ("department_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shift_assignments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "employee_id" uuid NOT NULL REFERENCES "employees"("id"),
  "shift_id" uuid NOT NULL REFERENCES "shifts"("id"),
  "effective_from" date NOT NULL,
  "effective_to" date,
  "notes" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_shift_assignments_emp" ON "shift_assignments" ("employee_id", "effective_from");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "holidays" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" text NOT NULL,
  "date" date NOT NULL,
  "type" "holiday_type" NOT NULL DEFAULT 'company',
  "is_recurring" boolean NOT NULL DEFAULT false
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payroll_settings" (
  "id" integer PRIMARY KEY DEFAULT 1,
  "pf_employee_pct" real NOT NULL DEFAULT 12,
  "pf_employer_pct" real NOT NULL DEFAULT 12,
  "pf_wage_ceiling" numeric(14,2) NOT NULL DEFAULT 15000,
  "esi_employee_pct" real NOT NULL DEFAULT 0.75,
  "esi_employer_pct" real NOT NULL DEFAULT 3.25,
  "esi_gross_ceiling" numeric(14,2) NOT NULL DEFAULT 21000,
  "pt_slabs" jsonb NOT NULL DEFAULT '[]',
  "full_day_hours" real NOT NULL DEFAULT 8,
  "half_day_hours" real NOT NULL DEFAULT 4,
  "cl_per_month" real NOT NULL DEFAULT 1,
  "cl_max_consecutive" integer NOT NULL DEFAULT 6,
  "sl_per_month" real NOT NULL DEFAULT 0.5,
  "comp_off_validity_days" integer NOT NULL DEFAULT 30,
  "review_below_score" real NOT NULL DEFAULT 0.72,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
INSERT INTO "payroll_settings" ("id") VALUES (1) ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- ── Time ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "punches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "employee_id" uuid NOT NULL REFERENCES "employees"("id"),
  "type" "punch_type" NOT NULL,
  "punch_date" date NOT NULL,
  "punched_at" timestamptz NOT NULL DEFAULT now(),
  "method" "punch_method" NOT NULL DEFAULT 'face',
  "match_score" real,
  "latitude" real,
  "longitude" real,
  "accuracy_m" real,
  "location_id" uuid REFERENCES "locations"("id"),
  "photo_url" text,
  "device_id" uuid,
  "client_id" varchar(64) UNIQUE,
  "marked_by" uuid REFERENCES "users"("id"),
  "resolved_by" uuid REFERENCES "users"("id"),
  "resolved_at" timestamptz,
  "resolution_note" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_punches_emp_day" ON "punches" ("employee_id", "punch_date");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_punches_day" ON "punches" ("punch_date");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "attendance_days" (
  "employee_id" uuid NOT NULL REFERENCES "employees"("id"),
  "day" date NOT NULL,
  "status" "attendance_status" NOT NULL,
  "source" "attendance_source" NOT NULL,
  "worked_hours" real NOT NULL DEFAULT 0,
  "note" text,
  "set_by" uuid REFERENCES "users"("id"),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_attendance_days" ON "attendance_days" ("employee_id", "day");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_attendance_days_day" ON "attendance_days" ("day");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "leave_applications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "employee_id" uuid NOT NULL REFERENCES "employees"("id"),
  "leave_type" "leave_type" NOT NULL,
  "from_date" date NOT NULL,
  "to_date" date NOT NULL,
  "days" real NOT NULL,
  "reason" text NOT NULL,
  "status" "approval_status" NOT NULL DEFAULT 'pending',
  "medical_doc_url" text,
  "comp_off_work_date" date,
  "decided_by" uuid REFERENCES "users"("id"),
  "decided_at" timestamptz,
  "remarks" text,
  "applied_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_leave_emp" ON "leave_applications" ("employee_id", "from_date");
--> statement-breakpoint

-- ── Pay ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "pay_inputs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "employee_id" uuid NOT NULL REFERENCES "employees"("id"),
  "kind" "pay_input_kind" NOT NULL,
  "month" integer NOT NULL,
  "year" integer NOT NULL,
  "amount" numeric(14,2) NOT NULL,
  "hours" real,
  "rate_per_hour" numeric(14,2),
  "category" text,
  "description" text,
  "receipt_url" text,
  "status" "pay_input_status" NOT NULL DEFAULT 'pending',
  "approved_amount" numeric(14,2),
  "decided_by" uuid REFERENCES "users"("id"),
  "decided_at" timestamptz,
  "payroll_run_id" uuid,
  "created_by" uuid REFERENCES "users"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_pay_inputs_month" ON "pay_inputs" ("year", "month", "status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "advances" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "employee_id" uuid NOT NULL REFERENCES "employees"("id"),
  "type" "advance_type" NOT NULL DEFAULT 'salary_advance',
  "amount" numeric(14,2) NOT NULL,
  "emi_amount" numeric(14,2) NOT NULL DEFAULT 0,
  "given_on" date NOT NULL,
  "reason" text,
  "status" "advance_status" NOT NULL DEFAULT 'active',
  "created_by" uuid REFERENCES "users"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "advance_repayments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "advance_id" uuid NOT NULL REFERENCES "advances"("id"),
  "amount" numeric(14,2) NOT NULL,
  "month" integer NOT NULL,
  "year" integer NOT NULL,
  "payroll_run_id" uuid,
  "notes" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_advance_repayments_adv" ON "advance_repayments" ("advance_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payroll_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "month" integer NOT NULL,
  "year" integer NOT NULL,
  "status" "payroll_run_status" NOT NULL DEFAULT 'draft',
  "employee_count" integer NOT NULL DEFAULT 0,
  "total_gross" numeric(14,2) NOT NULL DEFAULT 0,
  "total_deductions" numeric(14,2) NOT NULL DEFAULT 0,
  "total_net" numeric(14,2) NOT NULL DEFAULT 0,
  "total_employer_cost" numeric(14,2) NOT NULL DEFAULT 0,
  "processed_by" uuid REFERENCES "users"("id"),
  "processed_at" timestamptz,
  "confirmed_by" uuid REFERENCES "users"("id"),
  "confirmed_at" timestamptz,
  "journal_entry_id" uuid REFERENCES "journal_entries"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_payroll_runs_month" ON "payroll_runs" ("year", "month");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "salary_slips" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "payroll_run_id" uuid NOT NULL REFERENCES "payroll_runs"("id") ON DELETE CASCADE,
  "employee_id" uuid NOT NULL REFERENCES "employees"("id"),
  "pay_type" "pay_type" NOT NULL,
  "total_days" integer NOT NULL,
  "present_days" real NOT NULL DEFAULT 0,
  "half_days" real NOT NULL DEFAULT 0,
  "weekly_offs" real NOT NULL DEFAULT 0,
  "holidays" real NOT NULL DEFAULT 0,
  "leave_days" real NOT NULL DEFAULT 0,
  "paid_days" real NOT NULL,
  "lop_days" real NOT NULL DEFAULT 0,
  "daily_rate" numeric(14,2),
  "basic_salary" numeric(14,2) NOT NULL DEFAULT 0,
  "hra" numeric(14,2) NOT NULL DEFAULT 0,
  "allowances" numeric(14,2) NOT NULL DEFAULT 0,
  "earned_basic" numeric(14,2) NOT NULL DEFAULT 0,
  "earned_hra" numeric(14,2) NOT NULL DEFAULT 0,
  "earned_allowances" numeric(14,2) NOT NULL DEFAULT 0,
  "earned_gross" numeric(14,2) NOT NULL DEFAULT 0,
  "bonus" numeric(14,2) NOT NULL DEFAULT 0,
  "overtime" numeric(14,2) NOT NULL DEFAULT 0,
  "reimbursement" numeric(14,2) NOT NULL DEFAULT 0,
  "pf_employee" numeric(14,2) NOT NULL DEFAULT 0,
  "pf_employer" numeric(14,2) NOT NULL DEFAULT 0,
  "esi_employee" numeric(14,2) NOT NULL DEFAULT 0,
  "esi_employer" numeric(14,2) NOT NULL DEFAULT 0,
  "professional_tax" numeric(14,2) NOT NULL DEFAULT 0,
  "other_deductions" numeric(14,2) NOT NULL DEFAULT 0,
  "advance_recovery" numeric(14,2) NOT NULL DEFAULT 0,
  "total_deductions" numeric(14,2) NOT NULL DEFAULT 0,
  "net_pay" numeric(14,2) NOT NULL DEFAULT 0,
  "bank_name" text,
  "bank_account_number" varchar(30),
  "bank_ifsc" varchar(11)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_salary_slips_run_emp" ON "salary_slips" ("payroll_run_id", "employee_id");
--> statement-breakpoint

-- ── Devices ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "canteens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" varchar(12) NOT NULL UNIQUE,
  "name" text NOT NULL,
  "location_id" uuid NOT NULL REFERENCES "locations"("id"),
  "is_active" boolean NOT NULL DEFAULT true
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "devices" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" text NOT NULL,
  "role" "device_role" NOT NULL,
  "location_id" uuid NOT NULL REFERENCES "locations"("id"),
  "canteen_id" uuid REFERENCES "canteens"("id"),
  "token_hash" varchar(64) NOT NULL,
  "install_id" text,
  "device_model" text,
  "app_version_code" integer,
  "last_seen_at" timestamptz,
  "revoked_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pairing_codes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code_hash" varchar(64) NOT NULL UNIQUE,
  "code_last4" varchar(4) NOT NULL,
  "device_name" text NOT NULL,
  "role" "device_role" NOT NULL,
  "location_id" uuid NOT NULL REFERENCES "locations"("id"),
  "canteen_id" uuid REFERENCES "canteens"("id"),
  "target_device_id" uuid REFERENCES "devices"("id"),
  "status" "pairing_status" NOT NULL DEFAULT 'unused',
  "expires_at" timestamptz NOT NULL,
  "used_at" timestamptz,
  "created_by" uuid NOT NULL REFERENCES "users"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "device_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code_id" uuid NOT NULL REFERENCES "pairing_codes"("id"),
  "install_id" text,
  "device_model" text,
  "os_version" text,
  "app_version_code" integer,
  "latitude" real,
  "longitude" real,
  "status" "device_request_status" NOT NULL DEFAULT 'pending',
  "device_id" uuid REFERENCES "devices"("id"),
  "issued_token" text,
  "decided_by" uuid REFERENCES "users"("id"),
  "decided_at" timestamptz,
  "requested_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "staff_pins" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" text NOT NULL,
  "location_id" uuid NOT NULL REFERENCES "locations"("id"),
  "canteen_id" uuid REFERENCES "canteens"("id"),
  "salt_hex" varchar(32) NOT NULL,
  "pin_hash" varchar(64) NOT NULL,
  "can_unlock" boolean NOT NULL DEFAULT true,
  "can_authorise" boolean NOT NULL DEFAULT false,
  "is_active" boolean NOT NULL DEFAULT true,
  "revoked_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reason_codes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" varchar(40) NOT NULL UNIQUE,
  "label" text NOT NULL,
  "requires_text" boolean NOT NULL DEFAULT false,
  "is_active" boolean NOT NULL DEFAULT true,
  "display_order" integer NOT NULL DEFAULT 0
);
--> statement-breakpoint
INSERT INTO "reason_codes" ("code", "label", "requires_text", "display_order") VALUES
  ('forgot_punch', 'Forgot to punch at the gate', false, 1),
  ('came_from_other_site', 'Came from another site', false, 2),
  ('not_in_system', 'Not in the system yet — enrol at the gate', false, 3),
  ('guest', 'Guest / visitor', false, 4),
  ('other', 'Other', true, 9)
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- ── Canteen ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "canteen_meal_windows" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "canteen_id" uuid REFERENCES "canteens"("id"),
  "meal" "meal" NOT NULL,
  "start_time" varchar(5) NOT NULL,
  "end_time" varchar(5) NOT NULL,
  "is_active" boolean NOT NULL DEFAULT true
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_meal_windows" ON "canteen_meal_windows" ("canteen_id", "meal");
--> statement-breakpoint
INSERT INTO "canteen_meal_windows" ("canteen_id", "meal", "start_time", "end_time") VALUES
  (NULL, 'breakfast', '07:00', '09:30'),
  (NULL, 'lunch', '12:00', '14:30'),
  (NULL, 'dinner', '19:00', '21:30')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "canteen_meal_eligibility" (
  "employee_id" uuid PRIMARY KEY REFERENCES "employees"("id"),
  "breakfast" boolean NOT NULL DEFAULT false,
  "dinner" boolean NOT NULL DEFAULT false,
  "note" text,
  "updated_by" uuid REFERENCES "users"("id"),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "canteen_servings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "client_id" varchar(64) NOT NULL UNIQUE,
  "device_id" uuid NOT NULL REFERENCES "devices"("id"),
  "canteen_id" uuid NOT NULL REFERENCES "canteens"("id"),
  "meal_date" date NOT NULL,
  "meal" "meal" NOT NULL,
  "employee_id" uuid REFERENCES "employees"("id"),
  "person_name" text NOT NULL,
  "state" "serving_state" NOT NULL,
  "match_score" real,
  "served_at" timestamptz NOT NULL,
  "token_number" varchar(20) NOT NULL,
  "outside_window" boolean NOT NULL DEFAULT false,
  "extra_plate_kind" "extra_plate_kind",
  "guest_batch_id" varchar(64),
  "guest_party" text,
  "reason_code" varchar(40),
  "reason_text" text,
  "authorised_by" uuid REFERENCES "staff_pins"("id"),
  "photo_url" text,
  "latitude" real,
  "longitude" real,
  "accuracy_m" real,
  "attendance_present" boolean,
  "reconciled_at" timestamptz,
  "synced_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_serving_person_meal" ON "canteen_servings" ("canteen_id", "meal_date", "meal", "employee_id")
  WHERE employee_id IS NOT NULL AND authorised_by IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_servings_date_meal" ON "canteen_servings" ("meal_date", "meal");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_servings_canteen_date" ON "canteen_servings" ("canteen_id", "meal_date");
--> statement-breakpoint

-- ── Ledger hooks ────────────────────────────────────────────────────────
-- The accounts already exist in the chart; they now have system keys so the
-- run can post without anyone picking accounts.
UPDATE "accounts" SET "system_key" = 'salary_expense' WHERE "code" = '6501' AND "system_key" IS NULL;
--> statement-breakpoint
UPDATE "accounts" SET "system_key" = 'wages_expense' WHERE "code" = '6502' AND "system_key" IS NULL;
--> statement-breakpoint
UPDATE "accounts" SET "system_key" = 'pf_employer_expense' WHERE "code" = '6504' AND "system_key" IS NULL;
--> statement-breakpoint
UPDATE "accounts" SET "system_key" = 'esi_employer_expense' WHERE "code" = '6505' AND "system_key" IS NULL;
--> statement-breakpoint
UPDATE "accounts" SET "system_key" = 'esi_payable' WHERE "code" = '2122' AND "system_key" IS NULL;
--> statement-breakpoint
UPDATE "accounts" SET "system_key" = 'pf_payable' WHERE "code" = '2123' AND "system_key" IS NULL;
--> statement-breakpoint
UPDATE "accounts" SET "system_key" = 'salary_payable' WHERE "code" = '2125' AND "system_key" IS NULL;
--> statement-breakpoint
INSERT INTO "accounts" ("code", "name", "type", "subtype", "system_key", "parent_id", "is_group")
SELECT '2129', 'Professional Tax Payable', 'liability', 'other_current_liability', 'pt_payable', p."id", false
FROM "accounts" p WHERE p."code" = '2120'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "document_series" ("series_id", "entity", "prefix", "next_number", "padding")
SELECT s."id", 'payroll_run', 'PAY-', 1, 5 FROM "number_series" s WHERE s."is_default" = true
ON CONFLICT DO NOTHING;
