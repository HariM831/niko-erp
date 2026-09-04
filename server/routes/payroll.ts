/**
 * Payroll, over HTTP. The thinking lives in services/day-resolution.ts,
 * services/leave.ts and services/payroll.ts; this file validates, authorises,
 * and answers. Mounted at /api/payroll after requireAuth (session side only —
 * the field devices speak to routes/device.ts with a bearer token).
 */
import { createHash } from "node:crypto";
import { Router } from "express";
import { and, asc, desc, eq, gte, ilike, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  advanceRepayments,
  advances,
  attendanceDays,
  departments,
  designations,
  employees,
  holidays,
  leaveApplications,
  locations,
  payInputs,
  payrollRuns,
  payrollSettings,
  punches,
  salarySlips,
  shiftAssignments,
  shifts,
  wageRoles,
} from "@shared/schema";
import { db } from "../db";
import { requirePermission } from "../lib/rbac";
import { REPEAT_PUNCH_WINDOW_MS } from "./device";
import { photoThumbnail, photoThumbnails } from "../services/photo";
import { isUsableEmbedding, roundEmbedding, taughtCapturesByEmployee } from "../services/face-gallery";
import { looseNumber, nonBlank, timeOfDay, validateBody } from "../lib/validate";
import { PostingError } from "../services/posting";
import {
  addDays,
  daysInMonth,
  emptyTotals,
  istDate,
  loadContext,
  monthRange,
  monthTotals,
  wageDayTotals,
  recomputeEmployeeDay,
  recomputeRange,
  resolveDay,
  shiftForDate,
  addToTotals,
} from "../services/day-resolution";
import { applyLeave, approveLeave, deleteLeave, leaveBalance, leavesInRange, rejectLeave } from "../services/leave";
import {
  advanceOutstanding,
  confirmRun,
  deleteDraftRun,
  listRuns,
  processRun,
  runExceptions,
  runSlips,
} from "../services/payroll";

export const payrollRouter = Router();

const view = requirePermission("payroll", "view");
const settingsPerm = requirePermission("payroll", "settings");
const employeesPerm = requirePermission("payroll", "employees");
const attendancePerm = requirePermission("payroll", "attendance");
const payInputsPerm = requirePermission("payroll", "pay_inputs");
const runPerm = requirePermission("payroll", "run");
const gatePerm = requirePermission("payroll", "gate");

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const moneyNum = looseNumber(z.number().min(0).max(99_99_99_999));
const monthNum = looseNumber(z.number().int().min(1).max(12));
const yearNum = looseNumber(z.number().int().min(2000).max(2100));

const fail = (err: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) => {
  if (err instanceof PostingError) {
    res.status(422).json({ error: err.message });
    return true;
  }
  return false;
};

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** limit/offset for the tables that grow: default 25, never more than 200. */
function pageOf(q: Record<string, unknown>): { limit: number; offset: number } {
  const limit = Math.min(200, Math.max(1, Number(q.limit) || 25));
  const offset = Math.max(0, Number(q.offset) || 0);
  return { limit, offset };
}

/* ══ Masters ═════════════════════════════════════════════════════════════ */

payrollRouter.get("/departments", view, async (_req, res) => {
  const depts = await db.select().from(departments).orderBy(asc(departments.name));
  const desigs = await db.select().from(designations).orderBy(asc(designations.displayOrder), asc(designations.name));
  res.json(
    depts.map((d) => ({
      ...d,
      designations: desigs.filter((g) => g.departmentId === d.id),
    })),
  );
});

payrollRouter.post("/departments", settingsPerm, validateBody(z.object({ name: nonBlank(80) })), async (req, res) => {
  const [row] = await db.insert(departments).values({ name: req.body.name.trim() }).returning();
  res.status(201).json(row);
});

payrollRouter.patch(
  "/departments/:id",
  settingsPerm,
  validateBody(z.object({ name: nonBlank(80).optional(), isActive: z.boolean().optional() })),
  async (req, res) => {
    const [row] = await db.update(departments).set(req.body).where(eq(departments.id, req.params.id!)).returning();
    if (!row) return res.status(404).json({ error: "No such department" });
    res.json(row);
  },
);

payrollRouter.post(
  "/departments/:id/designations",
  settingsPerm,
  validateBody(z.object({ name: nonBlank(80), displayOrder: looseNumber(z.number().int()).optional() })),
  async (req, res) => {
    const [row] = await db
      .insert(designations)
      .values({ departmentId: req.params.id!, name: req.body.name.trim(), displayOrder: req.body.displayOrder ?? 0 })
      .returning();
    res.status(201).json(row);
  },
);

payrollRouter.patch(
  "/designations/:id",
  settingsPerm,
  validateBody(
    z.object({
      name: nonBlank(80).optional(),
      displayOrder: looseNumber(z.number().int()).optional(),
      isActive: z.boolean().optional(),
    }),
  ),
  async (req, res) => {
    const [row] = await db.update(designations).set(req.body).where(eq(designations.id, req.params.id!)).returning();
    if (!row) return res.status(404).json({ error: "No such designation" });
    res.json(row);
  },
);

payrollRouter.get("/wage-roles", view, async (_req, res) => {
  const rows = await db
    .select({
      id: wageRoles.id,
      name: wageRoles.name,
      dailyRate: wageRoles.dailyRate,
      isActive: wageRoles.isActive,
      headcount: sql<number>`(SELECT count(*)::int FROM employees e WHERE e.wage_role_id = ${wageRoles.id} AND e.is_active)`,
    })
    .from(wageRoles)
    .orderBy(asc(wageRoles.name));
  res.json(rows.map((r) => ({ ...r, dailyRate: Number(r.dailyRate) })));
});

payrollRouter.post(
  "/wage-roles",
  settingsPerm,
  validateBody(z.object({ name: nonBlank(80), dailyRate: moneyNum })),
  async (req, res) => {
    const [row] = await db
      .insert(wageRoles)
      .values({ name: req.body.name.trim(), dailyRate: req.body.dailyRate.toFixed(2) })
      .returning();
    res.status(201).json(row);
  },
);

payrollRouter.patch(
  "/wage-roles/:id",
  settingsPerm,
  validateBody(z.object({ name: nonBlank(80).optional(), dailyRate: moneyNum.optional(), isActive: z.boolean().optional() })),
  async (req, res) => {
    const b = req.body as { name?: string; dailyRate?: number; isActive?: boolean };
    const [row] = await db
      .update(wageRoles)
      .set({
        ...(b.name !== undefined && { name: b.name.trim() }),
        ...(b.dailyRate !== undefined && { dailyRate: b.dailyRate.toFixed(2) }),
        ...(b.isActive !== undefined && { isActive: b.isActive }),
      })
      .where(eq(wageRoles.id, req.params.id!))
      .returning();
    if (!row) return res.status(404).json({ error: "No such wage role" });
    res.json(row);
  },
);

const shiftBody = z.object({
  name: nonBlank(80),
  startTime: timeOfDay,
  endTime: timeOfDay,
  workingHours: looseNumber(z.number().positive().max(24)),
  weeklyOffDays: z.array(z.number().int().min(0).max(6)).max(7),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
});

payrollRouter.get("/shifts", view, async (_req, res) => {
  res.json(await db.select().from(shifts).orderBy(asc(shifts.name)));
});

payrollRouter.post("/shifts", settingsPerm, validateBody(shiftBody), async (req, res) => {
  const [row] = await db.insert(shifts).values(req.body).returning();
  res.status(201).json(row);
});

payrollRouter.patch("/shifts/:id", settingsPerm, validateBody(shiftBody.partial().extend({ isActive: z.boolean().optional() })), async (req, res) => {
  const [row] = await db.update(shifts).set(req.body).where(eq(shifts.id, req.params.id!)).returning();
  if (!row) return res.status(404).json({ error: "No such shift" });
  res.json(row);
});

payrollRouter.get("/shift-assignments", view, async (req, res) => {
  const conds = [];
  if (req.query.employeeId) conds.push(eq(shiftAssignments.employeeId, String(req.query.employeeId)));
  if (req.query.active === "1") conds.push(isNull(shiftAssignments.effectiveTo));
  const rows = await db
    .select({
      id: shiftAssignments.id,
      employeeId: shiftAssignments.employeeId,
      employeeName: employees.name,
      empCode: employees.empCode,
      shiftId: shiftAssignments.shiftId,
      shiftName: shifts.name,
      effectiveFrom: shiftAssignments.effectiveFrom,
      effectiveTo: shiftAssignments.effectiveTo,
      notes: shiftAssignments.notes,
    })
    .from(shiftAssignments)
    .innerJoin(employees, eq(employees.id, shiftAssignments.employeeId))
    .innerJoin(shifts, eq(shifts.id, shiftAssignments.shiftId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(shiftAssignments.effectiveFrom));
  res.json(rows);
});

payrollRouter.post(
  "/shift-assignments",
  settingsPerm,
  validateBody(z.object({ employeeId: z.string().uuid(), shiftId: z.string().uuid(), effectiveFrom: dateStr, notes: z.string().max(300).optional() })),
  async (req, res) => {
    const b = req.body as { employeeId: string; shiftId: string; effectiveFrom: string; notes?: string };
    const row = await db.transaction(async (tx) => {
      // One open assignment at a time: the new one closes the old at from−1.
      await tx
        .update(shiftAssignments)
        .set({ effectiveTo: addDays(b.effectiveFrom, -1) })
        .where(and(eq(shiftAssignments.employeeId, b.employeeId), isNull(shiftAssignments.effectiveTo)));
      const [created] = await tx
        .insert(shiftAssignments)
        .values({ employeeId: b.employeeId, shiftId: b.shiftId, effectiveFrom: b.effectiveFrom, notes: b.notes || null })
        .returning();
      return created!;
    });
    res.status(201).json(row);
  },
);

payrollRouter.delete("/shift-assignments/:id", settingsPerm, async (req, res) => {
  await db.delete(shiftAssignments).where(eq(shiftAssignments.id, req.params.id!));
  res.json({ ok: true });
});

payrollRouter.get("/holidays", view, async (req, res) => {
  const rows = await db.select().from(holidays).orderBy(asc(holidays.date));
  const year = Number(req.query.year);
  if (!year) return res.json(rows);
  // Recurring holidays answer for every year; dated ones only for their own.
  res.json(rows.filter((h) => h.isRecurring || h.date.startsWith(String(year))).map((h) => (h.isRecurring ? { ...h, date: `${year}-${h.date.slice(5)}` } : h)));
});

const holidayBody = z.object({
  name: nonBlank(120),
  date: dateStr,
  type: z.enum(["national", "regional", "company"]).optional(),
  isRecurring: z.boolean().optional(),
});

payrollRouter.post("/holidays", settingsPerm, validateBody(holidayBody), async (req, res) => {
  const [row] = await db.insert(holidays).values(req.body).returning();
  res.status(201).json(row);
});

payrollRouter.patch("/holidays/:id", settingsPerm, validateBody(holidayBody.partial()), async (req, res) => {
  const [row] = await db.update(holidays).set(req.body).where(eq(holidays.id, req.params.id!)).returning();
  if (!row) return res.status(404).json({ error: "No such holiday" });
  res.json(row);
});

payrollRouter.delete("/holidays/:id", settingsPerm, async (req, res) => {
  await db.delete(holidays).where(eq(holidays.id, req.params.id!));
  res.json({ ok: true });
});

payrollRouter.get("/settings", view, async (_req, res) => {
  const [row] = await db.select().from(payrollSettings);
  res.json(row ?? null);
});

const settingsPatch = z.object({
  pfEmployeePct: looseNumber(z.number().min(0).max(100)).optional(),
  pfEmployerPct: looseNumber(z.number().min(0).max(100)).optional(),
  pfWageCeiling: moneyNum.optional(),
  esiEmployeePct: looseNumber(z.number().min(0).max(100)).optional(),
  esiEmployerPct: looseNumber(z.number().min(0).max(100)).optional(),
  esiGrossCeiling: moneyNum.optional(),
  ptSlabs: z.array(z.object({ upTo: z.number().nullable(), amount: z.number().min(0) })).optional(),
  fullDayHours: looseNumber(z.number().positive().max(24)).optional(),
  halfDayHours: looseNumber(z.number().positive().max(24)).optional(),
  clPerMonth: looseNumber(z.number().min(0).max(10)).optional(),
  clMaxConsecutive: looseNumber(z.number().int().min(1).max(31)).optional(),
  slPerMonth: looseNumber(z.number().min(0).max(10)).optional(),
  compOffValidityDays: looseNumber(z.number().int().min(1).max(365)).optional(),
  reviewBelowScore: looseNumber(z.number().min(0).max(1)).optional(),
});

payrollRouter.patch("/settings", settingsPerm, validateBody(settingsPatch), async (req, res) => {
  const { pfWageCeiling, esiGrossCeiling, ...rest } = req.body as z.infer<typeof settingsPatch>;
  const [row] = await db
    .update(payrollSettings)
    .set({
      ...rest,
      ...(pfWageCeiling !== undefined && { pfWageCeiling: pfWageCeiling.toFixed(2) }),
      ...(esiGrossCeiling !== undefined && { esiGrossCeiling: esiGrossCeiling.toFixed(2) }),
      updatedAt: new Date(),
    })
    .where(eq(payrollSettings.id, 1))
    .returning();
  res.json(row);
});

/* ══ Employees ═══════════════════════════════════════════════════════════ */

payrollRouter.get("/employees", view, async (req, res) => {
  const q = req.query;
  const conds = [];
  if (q.q) {
    const like = `%${String(q.q)}%`;
    conds.push(or(ilike(employees.name, like), ilike(employees.empCode, like)));
  }
  if (q.department) conds.push(eq(employees.departmentId, String(q.department)));
  if (q.payType) conds.push(eq(employees.payType, String(q.payType) as "salaried" | "daily_wage"));
  if (q.active === "1") conds.push(eq(employees.isActive, true));
  if (q.active === "0") conds.push(eq(employees.isActive, false));

  const rows = await db
    .select({
      id: employees.id,
      empCode: employees.empCode,
      name: employees.name,
      payType: employees.payType,
      department: departments.name,
      designation: designations.name,
      wageRole: wageRoles.name,
      dailyRate: wageRoles.dailyRate,
      location: locations.name,
      dateOfJoining: employees.dateOfJoining,
      contactNumber: employees.contactNumber,
      basicSalary: employees.basicSalary,
      hra: employees.hra,
      allowances: employees.allowances,
      pfEnabled: employees.pfEnabled,
      esiEnabled: employees.esiEnabled,
      isActive: employees.isActive,
      hasPhoto: sql<boolean>`${employees.photoUrl} IS NOT NULL`,
      hasFace: sql<boolean>`${employees.faceDescriptor} IS NOT NULL`,
      shift: sql<string | null>`(
        SELECT s.name FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id
        WHERE a.employee_id = ${employees.id} AND a.effective_from <= (NOW() AT TIME ZONE 'Asia/Kolkata')::date
          AND (a.effective_to IS NULL OR a.effective_to >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date)
        ORDER BY a.effective_from DESC LIMIT 1
      )`,
    })
    .from(employees)
    .leftJoin(departments, eq(departments.id, employees.departmentId))
    .leftJoin(designations, eq(designations.id, employees.designationId))
    .leftJoin(wageRoles, eq(wageRoles.id, employees.wageRoleId))
    .leftJoin(locations, eq(locations.id, employees.locationId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(asc(employees.empCode));
  res.json(
    rows.map((r) => ({
      ...r,
      dailyRate: r.dailyRate == null ? null : Number(r.dailyRate),
      basicSalary: Number(r.basicSalary),
      hra: Number(r.hra),
      allowances: Number(r.allowances),
      gross: Number(r.basicSalary) + Number(r.hra) + Number(r.allowances),
    })),
  );
});

/**
 * The active roster for the browser kiosk: descriptor + photo, nothing else.
 * The ONLY route that ever ships faceDescriptor.
 *
 * The photo is a 96 px thumbnail, not the enrolment original. The kiosk shows
 * it at 80 px at the very largest, and shipping the originals would put a
 * couple of hundred kilobytes per worker on a response every open gate
 * re-reads — the descriptors are the payload that has to be here, and they
 * are large enough on their own.
 */
payrollRouter.get("/employees/gallery", gatePerm, async (req, res) => {
  const since = Number(req.query.since) || 0;

  /*
   * "Changed" for a roster means either the person changed or their gallery
   * did, and a new capture does not touch the employee row. Taking the later
   * of the two keeps a freshly taught face flowing to the kiosk without
   * writing to `employees` on every punch — which would churn the device
   * delta for every worker, twice a day, to say nothing had really changed
   * about them.
   */
  const changedAt = sql<Date>`GREATEST(
    ${employees.updatedAt},
    COALESCE((SELECT max(p.punched_at) FROM punches p
               WHERE p.employee_id = ${employees.id} AND p.face_embedding IS NOT NULL), 'epoch'::timestamptz)
  )`;

  const rows = await db
    .select({
      id: employees.id,
      empCode: employees.empCode,
      name: employees.name,
      payType: employees.payType,
      isActive: employees.isActive,
      faceDescriptor: employees.faceDescriptor,
      photoUrl: employees.photoUrl,
      photoHash: employees.photoHash,
      changedAt,
    })
    .from(employees)
    // `>=`, not `>`: two rows can share a millisecond, and re-sending the
    // newest one costs a row while missing it costs a face at the gate. The
    // kiosk merges by id, so a repeat is a no-op.
    .where(since ? sql`${changedAt} >= ${new Date(since)}` : undefined);

  const live = rows.filter((r) => r.isActive && r.faceDescriptor);
  const taught = await taughtCapturesByEmployee(db, live.map((r) => r.id));
  const thumbs = await photoThumbnails(live);

  res.json({
    // Everything the caller has, so an unchanged fetch does not rewind it.
    cursor: rows.reduce((max, r) => Math.max(max, r.changedAt.getTime()), since),
    people: live.map((r, i) => ({
      id: r.id,
      empCode: r.empCode,
      name: r.name,
      payType: r.payType,
      photoUrl: thumbs[i],
      // Enrolment first, then what the gate has taught itself. A face is
      // scored on its BEST descriptor, so the order is for readers, not
      // for the matcher.
      descriptors: [roundEmbedding(r.faceDescriptor!), ...(taught.get(r.id) ?? [])],
    })),
    // Left, deactivated, or had their enrolment cleared. Named rather than
    // simply absent, because the kiosk is holding a copy it has to drop.
    deleted: rows.filter((r) => !r.isActive || !r.faceDescriptor).map((r) => r.id),
  });
});

const employeeFields = z.object({
  empCode: nonBlank(20),
  name: nonBlank(120),
  payType: z.enum(["salaried", "daily_wage"]),
  departmentId: z.string().uuid().nullish(),
  designationId: z.string().uuid().nullish(),
  wageRoleId: z.string().uuid().nullish(),
  locationId: z.string().uuid().nullish(),
  reportingTo: z.string().uuid().nullish(),
  dateOfJoining: dateStr.nullish(),
  dateOfLeaving: dateStr.nullish(),
  contactNumber: z.string().max(20).nullish(),
  email: z.string().max(200).nullish(),
  panNumber: z.string().max(10).nullish(),
  aadharNumber: z.string().max(12).nullish(),
  uanNumber: z.string().max(12).nullish(),
  esiNumber: z.string().max(17).nullish(),
  bankName: z.string().max(200).nullish(),
  bankAccountNumber: z.string().max(30).nullish(),
  bankIfsc: z.string().max(11).nullish(),
  basicSalary: moneyNum.optional(),
  hra: moneyNum.optional(),
  allowances: moneyNum.optional(),
  pfEnabled: z.boolean().optional(),
  esiEnabled: z.boolean().optional(),
  openingCl: looseNumber(z.number().min(0).max(60)).optional(),
  openingSl: looseNumber(z.number().min(0).max(60)).optional(),
  emergencyContactName: z.string().max(120).nullish(),
  emergencyContactNumber: z.string().max(20).nullish(),
  emergencyContactRelation: z.string().max(60).nullish(),
  photoUrl: z.string().nullish(),
  panDocUrl: z.string().nullish(),
  aadharDocUrl: z.string().nullish(),
  isActive: z.boolean().optional(),
});

/** Money fields to numeric strings, photoHash kept in step with photoUrl. */
function employeeWrite(b: Partial<z.infer<typeof employeeFields>>) {
  const { basicSalary, hra, allowances, photoUrl, ...rest } = b;
  return {
    ...rest,
    ...(basicSalary !== undefined && { basicSalary: basicSalary.toFixed(2) }),
    ...(hra !== undefined && { hra: hra.toFixed(2) }),
    ...(allowances !== undefined && { allowances: allowances.toFixed(2) }),
    ...(photoUrl !== undefined && { photoUrl, photoHash: photoUrl ? sha256(photoUrl) : null }),
    updatedAt: new Date(),
  };
}

payrollRouter.post("/employees", employeesPerm, validateBody(employeeFields), async (req, res) => {
  const b = req.body as z.infer<typeof employeeFields>;
  if (b.dateOfJoining && b.dateOfLeaving && b.dateOfLeaving < b.dateOfJoining) {
    return res.status(422).json({ error: "Date of leaving is before date of joining" });
  }
  const [dup] = await db.select({ id: employees.id }).from(employees).where(eq(employees.empCode, b.empCode));
  if (dup) return res.status(422).json({ error: `Employee code ${b.empCode} is already taken` });
  const [row] = await db
    .insert(employees)
    .values(employeeWrite(b) as typeof employees.$inferInsert)
    .returning({ id: employees.id });
  res.status(201).json({ id: row!.id });
});

payrollRouter.patch("/employees/:id", employeesPerm, validateBody(employeeFields.partial()), async (req, res) => {
  const body = req.body as Partial<z.infer<typeof employeeFields>>;
  if (body.dateOfJoining !== undefined || body.dateOfLeaving !== undefined) {
    const [existing] = await db
      .select({ dateOfJoining: employees.dateOfJoining, dateOfLeaving: employees.dateOfLeaving })
      .from(employees)
      .where(eq(employees.id, req.params.id!));
    if (!existing) return res.status(404).json({ error: "No such employee" });
    const joining = body.dateOfJoining !== undefined ? body.dateOfJoining : existing.dateOfJoining;
    const leaving = body.dateOfLeaving !== undefined ? body.dateOfLeaving : existing.dateOfLeaving;
    if (joining && leaving && leaving < joining) {
      return res.status(422).json({ error: "Date of leaving is before date of joining" });
    }
  }
  const [row] = await db
    .update(employees)
    .set(employeeWrite(req.body))
    .where(eq(employees.id, req.params.id!))
    .returning({ id: employees.id });
  if (!row) return res.status(404).json({ error: "No such employee" });
  res.json({ id: row.id });
});

/**
 * The list ships no photos; a table avatar fetches its own, at the size an
 * avatar is drawn. The full enrolment photo is only ever served inline on the
 * one employee's own page, where it is the subject rather than a decoration.
 */
payrollRouter.get("/employees/:id/photo", view, async (req, res) => {
  const [row] = await db
    .select({ photoUrl: employees.photoUrl, photoHash: employees.photoHash })
    .from(employees)
    .where(eq(employees.id, req.params.id!));
  const thumb = await photoThumbnail(row?.photoUrl ?? null, row?.photoHash);
  if (!thumb) return res.status(404).json({ error: "No photo" });
  res.setHeader("Content-Type", "image/jpeg");
  res.setHeader("Cache-Control", "private, max-age=300");
  res.send(thumb);
});

payrollRouter.get("/employees/:id", view, async (req, res) => {
  // Everything except the face embedding, which only /employees/gallery ships.
  const [row] = await db
    .select({
      id: employees.id,
      empCode: employees.empCode,
      name: employees.name,
      payType: employees.payType,
      departmentId: employees.departmentId,
      designationId: employees.designationId,
      wageRoleId: employees.wageRoleId,
      locationId: employees.locationId,
      reportingTo: employees.reportingTo,
      dateOfJoining: employees.dateOfJoining,
      dateOfLeaving: employees.dateOfLeaving,
      contactNumber: employees.contactNumber,
      email: employees.email,
      panNumber: employees.panNumber,
      aadharNumber: employees.aadharNumber,
      uanNumber: employees.uanNumber,
      esiNumber: employees.esiNumber,
      bankName: employees.bankName,
      bankAccountNumber: employees.bankAccountNumber,
      bankIfsc: employees.bankIfsc,
      basicSalary: employees.basicSalary,
      hra: employees.hra,
      allowances: employees.allowances,
      pfEnabled: employees.pfEnabled,
      esiEnabled: employees.esiEnabled,
      openingCl: employees.openingCl,
      openingSl: employees.openingSl,
      emergencyContactName: employees.emergencyContactName,
      emergencyContactNumber: employees.emergencyContactNumber,
      emergencyContactRelation: employees.emergencyContactRelation,
      photoUrl: employees.photoUrl,
      panDocUrl: employees.panDocUrl,
      aadharDocUrl: employees.aadharDocUrl,
      faceEnrolledAt: employees.faceEnrolledAt,
      isActive: employees.isActive,
      createdAt: employees.createdAt,
      updatedAt: employees.updatedAt,
    })
    .from(employees)
    .where(eq(employees.id, req.params.id!));
  if (!row) return res.status(404).json({ error: "No such employee" });
  res.json({
    ...row,
    basicSalary: Number(row.basicSalary),
    hra: Number(row.hra),
    allowances: Number(row.allowances),
  });
});

payrollRouter.post(
  "/employees/:id/face",
  gatePerm,
  validateBody(z.object({ descriptor: z.array(z.number()).min(64).max(4096) })),
  async (req, res) => {
    const [row] = await db
      .update(employees)
      .set({ faceDescriptor: req.body.descriptor, faceEnrolledAt: new Date(), updatedAt: new Date() })
      .where(eq(employees.id, req.params.id!))
      .returning({ id: employees.id });
    if (!row) return res.status(404).json({ error: "No such employee" });
    res.json({ ok: true });
  },
);

payrollRouter.delete("/employees/:id/face", gatePerm, async (req, res) => {
  await db
    .update(employees)
    .set({ faceDescriptor: null, faceEnrolledAt: null, updatedAt: new Date() })
    .where(eq(employees.id, req.params.id!));
  res.json({ ok: true });
});

const importRow = employeeFields
  .omit({ departmentId: true, designationId: true, wageRoleId: true })
  .extend({
    department: z.string().max(80).nullish(),
    designation: z.string().max(80).nullish(),
    wageRole: z.string().max(80).nullish(),
  });

/** Upsert by empCode; department/designation/wage-role named, created if new. */
payrollRouter.post(
  "/employees/import",
  employeesPerm,
  validateBody(z.object({ rows: z.array(importRow).min(1).max(2000) })),
  async (req, res) => {
    const rows = req.body.rows as z.infer<typeof importRow>[];
    const out = await db.transaction(async (tx) => {
      let created = 0;
      let updated = 0;
      for (const r of rows) {
        const { department, designation, wageRole, ...fields } = r;
        let departmentId: string | null | undefined;
        let designationId: string | null | undefined;
        let wageRoleId: string | null | undefined;
        if (department) {
          const [d] =
            (await tx.select().from(departments).where(eq(departments.name, department))) ??
            [];
          departmentId = d ? d.id : (await tx.insert(departments).values({ name: department }).returning())[0]!.id;
          if (designation) {
            const [g] = await tx
              .select()
              .from(designations)
              .where(and(eq(designations.departmentId, departmentId), eq(designations.name, designation)));
            designationId = g ? g.id : (await tx.insert(designations).values({ departmentId, name: designation }).returning())[0]!.id;
          }
        }
        if (wageRole) {
          const [w] = await tx.select().from(wageRoles).where(eq(wageRoles.name, wageRole));
          wageRoleId = w ? w.id : (await tx.insert(wageRoles).values({ name: wageRole, dailyRate: "0.00" }).returning())[0]!.id;
        }
        const values = { ...employeeWrite(fields), departmentId, designationId, wageRoleId };
        const [existing] = await tx.select({ id: employees.id }).from(employees).where(eq(employees.empCode, r.empCode));
        if (existing) {
          await tx.update(employees).set(values).where(eq(employees.id, existing.id));
          updated++;
        } else {
          await tx.insert(employees).values(values as typeof employees.$inferInsert);
          created++;
        }
      }
      return { created, updated };
    });
    res.status(201).json(out);
  },
);

/* ══ Punches & attendance ════════════════════════════════════════════════ */

/**
 * A scan inside the cooldown window. Not a refusal the operator has to fix
 * — the punch it repeats is already recorded — so it gets its own status and
 * flag, and the gate says "already punched" instead of "punch failed".
 */
class RepeatPunch extends Error {}

const punchBody = z.object({
  employeeId: z.string().uuid(),
  type: z.enum(["in", "out"]).optional(),
  method: z.enum(["face", "manual"]),
  matchScore: z.number().min(0).max(1).optional(),
  // nullish, not optional: the gate sends null when the browser has no
  // location fix, and optional() rejects null — every desktop punch failed
  // validation the moment the location prompt was declined.
  latitude: z.number().nullish(),
  longitude: z.number().nullish(),
  accuracyM: z.number().nullish(),
  photoUrl: z.string().nullish(),
  /**
   * The embedding of the face just scanned. Kept so this worker's gallery
   * grows; see server/services/face-gallery.ts. Absent when the guard picked
   * a name without scanning at all, which teaches nothing because there is
   * nothing to teach from.
   */
  faceEmbedding: z.array(z.number()).nullish(),
});

payrollRouter.post("/punches", gatePerm, validateBody(punchBody), async (req, res) => {
  const b = req.body as z.infer<typeof punchBody>;
  try {
    const out = await db.transaction(async (tx) => {
      const [emp] = await tx
        .select({ id: employees.id, isActive: employees.isActive, payType: employees.payType })
        .from(employees)
        .where(eq(employees.id, b.employeeId));
      if (!emp) throw new PostingError("No such employee");
      if (!emp.isActive) throw new PostingError("This employee is inactive");
      const today = istDate();
      const [last] = await tx
        .select({ type: punches.type, punchedAt: punches.punchedAt })
        .from(punches)
        .where(and(eq(punches.employeeId, b.employeeId), eq(punches.punchDate, today)))
        .orderBy(desc(punches.punchedAt))
        .limit(1);
      // Before the type is decided, because the line below decides it by
      // toggling off `last` — so a guard re-scanning a worker still standing
      // at the camera is offered an OUT, and booking it writes an exit that
      // never happened. Same windows as the device sync.
      if (last && Date.now() - last.punchedAt.getTime() < REPEAT_PUNCH_WINDOW_MS[emp.payType]) {
        throw new RepeatPunch(`Already punched ${last.type} a moment ago — this scan was not recorded.`);
      }
      const type = b.type ?? (last?.type === "in" ? "out" : "in");
      // The photo is kept only when someone might need to look at it: a manual
      // punch, or a face match below the review threshold.
      const [settings] = await tx.select({ reviewBelowScore: payrollSettings.reviewBelowScore }).from(payrollSettings);
      const review = settings?.reviewBelowScore ?? 0.72;
      const keepPhoto = b.method === "manual" || (b.matchScore != null && b.matchScore < review);
      const [punch] = await tx
        .insert(punches)
        .values({
          employeeId: b.employeeId,
          type,
          punchDate: today,
          method: b.method,
          matchScore: b.matchScore ?? null,
          latitude: b.latitude ?? null,
          longitude: b.longitude ?? null,
          accuracyM: b.accuracyM ?? null,
          photoUrl: keepPhoto ? (b.photoUrl ?? null) : null,
          faceEmbedding: isUsableEmbedding(b.faceEmbedding) ? roundEmbedding(b.faceEmbedding) : null,
          markedBy: req.session.user!.id,
        })
        .returning();
      const day = await recomputeEmployeeDay(tx, b.employeeId, today);
      return { ...punch!, status: day?.status ?? null, workedHours: day?.workedHours ?? 0 };
    });
    res.status(201).json(out);
  } catch (err) {
    if (err instanceof RepeatPunch) return res.status(409).json({ error: err.message, repeatPunch: true });
    if (!fail(err, res)) throw err;
  }
});

payrollRouter.get("/punches", view, async (req, res) => {
  const { limit, offset } = pageOf(req.query);
  const conds = [];
  if (req.query.date) conds.push(eq(punches.punchDate, String(req.query.date)));
  if (req.query.employeeId) conds.push(eq(punches.employeeId, String(req.query.employeeId)));
  const where = conds.length ? and(...conds) : undefined;
  const rows = await db
    .select({
      id: punches.id,
      employeeId: punches.employeeId,
      name: employees.name,
      empCode: employees.empCode,
      type: punches.type,
      punchDate: punches.punchDate,
      punchedAt: punches.punchedAt,
      method: punches.method,
      matchScore: punches.matchScore,
      latitude: punches.latitude,
      longitude: punches.longitude,
      photoUrl: punches.photoUrl,
      resolvedAt: punches.resolvedAt,
      resolutionNote: punches.resolutionNote,
    })
    .from(punches)
    .innerJoin(employees, eq(employees.id, punches.employeeId))
    .where(where)
    .orderBy(desc(punches.punchedAt))
    .limit(limit)
    .offset(offset);
  const [{ total }] = (await db
    .select({ total: sql<number>`count(*)::int` })
    .from(punches)
    .where(where)) as [{ total: number }];
  res.json({ rows, total });
});

/** Dangling `in` punches on past days — the exceptions list HR works through. */
payrollRouter.get("/punches/open", view, async (req, res) => {
  const before = typeof req.query.before === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.before) ? req.query.before : istDate();
  const last = await db
    .selectDistinctOn([punches.employeeId, punches.punchDate], {
      id: punches.id,
      employeeId: punches.employeeId,
      name: employees.name,
      empCode: employees.empCode,
      type: punches.type,
      punchDate: punches.punchDate,
      punchedAt: punches.punchedAt,
      resolvedAt: punches.resolvedAt,
    })
    .from(punches)
    .innerJoin(employees, eq(employees.id, punches.employeeId))
    .where(sql`${punches.punchDate} < ${before}`)
    .orderBy(punches.employeeId, punches.punchDate, desc(punches.punchedAt));
  res.json(last.filter((p) => p.type === "in" && !p.resolvedAt).sort((a, b) => (a.punchDate < b.punchDate ? 1 : -1)));
});

const resolveBody = z.object({
  outAt: z.string().datetime({ offset: true }).optional(),
  status: z.enum(["P", "H", "A"]).optional(),
  note: z.string().max(300),
});

/** Close a forgotten punch-out: give the day its `out`, or rule it by hand. */
payrollRouter.post("/punches/:id/resolve", attendancePerm, validateBody(resolveBody), async (req, res) => {
  const b = req.body as z.infer<typeof resolveBody>;
  if (!b.outAt && !b.status) return res.status(422).json({ error: "Give an out time or a status" });
  try {
    const out = await db.transaction(async (tx) => {
      const [p] = await tx.select().from(punches).where(eq(punches.id, req.params.id!));
      if (!p) throw new PostingError("No such punch");
      if (p.type !== "in") throw new PostingError("Only an `in` punch can be resolved");
      const userId = req.session.user!.id;
      if (b.outAt) {
        const outAt = new Date(b.outAt);
        if (outAt.getTime() <= p.punchedAt.getTime()) throw new PostingError("The out time must be after the in time");
        await tx.insert(punches).values({
          employeeId: p.employeeId,
          type: "out",
          punchDate: p.punchDate,
          punchedAt: outAt,
          method: "manual",
          markedBy: userId,
          resolutionNote: b.note,
        });
      } else {
        // HR ruled the day directly; the manual row survives every recompute.
        await tx
          .insert(attendanceDays)
          .values({ employeeId: p.employeeId, day: p.punchDate, status: b.status!, source: "manual", note: b.note, setBy: userId })
          .onConflictDoUpdate({
            target: [attendanceDays.employeeId, attendanceDays.day],
            set: { status: b.status!, source: "manual", note: b.note, setBy: userId, updatedAt: new Date() },
          });
      }
      await tx
        .update(punches)
        .set({ resolvedBy: userId, resolvedAt: new Date(), resolutionNote: b.note })
        .where(eq(punches.id, p.id));
      const day = await recomputeEmployeeDay(tx, p.employeeId, p.punchDate);
      return { ok: true, status: day?.status ?? b.status ?? null };
    });
    res.json(out);
  } catch (err) {
    if (!fail(err, res)) throw err;
  }
});

/** The team grid: every employee × every day of the month. */
payrollRouter.get("/attendance/month", view, async (req, res) => {
  const year = yearNum.safeParse(req.query.year);
  const month = monthNum.safeParse(req.query.month);
  if (!year.success || !month.success) return res.status(400).json({ error: "year and month are required" });
  const { from, to } = monthRange(year.data, month.data);
  const n = daysInMonth(year.data, month.data);

  const conds = [eq(employees.isActive, true)];
  if (req.query.department) conds.push(eq(employees.departmentId, String(req.query.department)));
  const staff = await db
    .select({ id: employees.id, empCode: employees.empCode, name: employees.name, department: departments.name })
    .from(employees)
    .leftJoin(departments, eq(departments.id, employees.departmentId))
    .where(and(...conds))
    .orderBy(asc(employees.empCode));

  const rows = await db
    .select()
    .from(attendanceDays)
    .where(and(gte(attendanceDays.day, from), lte(attendanceDays.day, to)));
  const byEmp = new Map<string, typeof rows>();
  for (const r of rows) byEmp.set(r.employeeId, [...(byEmp.get(r.employeeId) ?? []), r]);

  res.json({
    days: Array.from({ length: n }, (_, i) => i + 1),
    employees: staff.map((e) => {
      const mine = byEmp.get(e.id) ?? [];
      const totals = emptyTotals();
      const days: Record<number, { status: string; source: string; hours: number }> = {};
      for (const r of mine) {
        days[Number(r.day.slice(8))] = { status: r.status, source: r.source, hours: r.workedHours };
        addToTotals(totals, r.status);
      }
      return { ...e, days, totals };
    }),
  });
});

/** One employee's month, with the punches behind each day — the calendar. */
payrollRouter.get("/attendance/employee/:id", view, async (req, res) => {
  const year = yearNum.safeParse(req.query.year);
  const month = monthNum.safeParse(req.query.month);
  if (!year.success || !month.success) return res.status(400).json({ error: "year and month are required" });
  const { from, to } = monthRange(year.data, month.data);
  const employeeId = req.params.id!;

  const dayRows = await db
    .select()
    .from(attendanceDays)
    .where(and(eq(attendanceDays.employeeId, employeeId), gte(attendanceDays.day, from), lte(attendanceDays.day, to)));
  const punchRows = await db
    .select()
    .from(punches)
    .where(and(eq(punches.employeeId, employeeId), gte(punches.punchDate, from), lte(punches.punchDate, to)))
    .orderBy(asc(punches.punchedAt));
  const punchesByDay = new Map<string, typeof punchRows>();
  for (const p of punchRows) punchesByDay.set(p.punchDate, [...(punchesByDay.get(p.punchDate) ?? []), p]);

  const totals = emptyTotals();
  const days: Record<number, unknown> = {};
  for (const r of dayRows) {
    addToTotals(totals, r.status);
    days[Number(r.day.slice(8))] = {
      status: r.status,
      source: r.source,
      hours: r.workedHours,
      note: r.note,
      punches: (punchesByDay.get(r.day) ?? []).map((p) => ({
        id: p.id,
        type: p.type,
        punchedAt: p.punchedAt,
        method: p.method,
        matchScore: p.matchScore,
        photoUrl: p.photoUrl,
        location: p.latitude != null ? { latitude: p.latitude, longitude: p.longitude, accuracyM: p.accuracyM } : null,
      })),
    };
  }

  const ctx = await loadContext(db, from, to, [employeeId]);
  const shift = shiftForDate(to, ctx.assignmentsByEmp.get(employeeId) ?? [], ctx.shiftById) ?? null;
  const leaves = await leavesInRange(db, employeeId, from, to);
  res.json({ days, totals, shift, leaves });
});

const overrideBody = z.object({
  employeeId: z.string().uuid(),
  day: dateStr,
  status: z.enum(["P", "H", "A", "WO", "HO", "L"]),
  note: z.string().max(300),
});

payrollRouter.post("/attendance/override", attendancePerm, validateBody(overrideBody), async (req, res) => {
  const b = req.body as z.infer<typeof overrideBody>;
  const userId = req.session.user!.id;
  await db
    .insert(attendanceDays)
    .values({ employeeId: b.employeeId, day: b.day, status: b.status, source: "manual", note: b.note, setBy: userId })
    .onConflictDoUpdate({
      target: [attendanceDays.employeeId, attendanceDays.day],
      set: { status: b.status, source: "manual", note: b.note, setBy: userId, updatedAt: new Date() },
    });
  res.status(201).json({ ok: true });
});

payrollRouter.delete(
  "/attendance/override",
  attendancePerm,
  validateBody(z.object({ employeeId: z.string().uuid(), day: dateStr })),
  async (req, res) => {
    const b = req.body as { employeeId: string; day: string };
    await db.transaction(async (tx) => {
      await tx
        .delete(attendanceDays)
        .where(and(eq(attendanceDays.employeeId, b.employeeId), eq(attendanceDays.day, b.day), inArray(attendanceDays.source, ["manual", "import"])));
      await recomputeEmployeeDay(tx, b.employeeId, b.day);
    });
    res.json({ ok: true });
  },
);

payrollRouter.post(
  "/attendance/bulk-override",
  attendancePerm,
  validateBody(
    z.object({
      day: dateStr,
      status: z.enum(["P", "H", "A", "WO", "HO", "L"]),
      employeeIds: z.array(z.string().uuid()).min(1).max(1000),
      note: z.string().max(300),
    }),
  ),
  async (req, res) => {
    const b = req.body as { day: string; status: "P" | "H" | "A" | "WO" | "HO" | "L"; employeeIds: string[]; note: string };
    const userId = req.session.user!.id;
    await db.transaction(async (tx) => {
      for (const employeeId of b.employeeIds) {
        await tx
          .insert(attendanceDays)
          .values({ employeeId, day: b.day, status: b.status, source: "manual", note: b.note, setBy: userId })
          .onConflictDoUpdate({
            target: [attendanceDays.employeeId, attendanceDays.day],
            set: { status: b.status, source: "manual", note: b.note, setBy: userId, updatedAt: new Date() },
          });
      }
    });
    res.status(201).json({ count: b.employeeIds.length });
  },
);

payrollRouter.post(
  "/attendance/recompute",
  attendancePerm,
  validateBody(z.object({ year: yearNum, month: monthNum, employeeId: z.string().uuid().optional() })),
  async (req, res) => {
    const b = req.body as { year: number; month: number; employeeId?: string };
    const { from, to } = monthRange(b.year, b.month);
    const out = await db.transaction((tx) => recomputeRange(tx, from, to, b.employeeId ? [b.employeeId] : undefined));
    res.json(out);
  },
);

payrollRouter.post(
  "/attendance/import",
  attendancePerm,
  validateBody(
    z.object({
      rows: z.array(z.object({ empCode: z.string().min(1), day: dateStr, status: z.enum(["P", "H", "A", "WO", "HO", "L"]) })).min(1).max(20000),
    }),
  ),
  async (req, res) => {
    const rows = req.body.rows as { empCode: string; day: string; status: "P" | "H" | "A" | "WO" | "HO" | "L" }[];
    const userId = req.session.user!.id;
    const out = await db.transaction(async (tx) => {
      const codes = [...new Set(rows.map((r) => r.empCode))];
      const emps = await tx.select({ id: employees.id, empCode: employees.empCode }).from(employees).where(inArray(employees.empCode, codes));
      const idOf = new Map(emps.map((e) => [e.empCode, e.id]));
      let written = 0;
      const unknown = new Set<string>();
      for (const r of rows) {
        const employeeId = idOf.get(r.empCode);
        if (!employeeId) {
          unknown.add(r.empCode);
          continue;
        }
        await tx
          .insert(attendanceDays)
          .values({ employeeId, day: r.day, status: r.status, source: "import", setBy: userId })
          .onConflictDoUpdate({
            target: [attendanceDays.employeeId, attendanceDays.day],
            set: { status: r.status, source: "import", setBy: userId, updatedAt: new Date() },
          });
        written++;
      }
      return { written, unknownCodes: [...unknown] };
    });
    res.status(201).json(out);
  },
);

/** Who is here right now — the dashboard's people card. */
payrollRouter.get("/attendance/today", view, async (_req, res) => {
  const today = istDate();
  const staff = await db
    .select({ id: employees.id, empCode: employees.empCode, name: employees.name, department: departments.name })
    .from(employees)
    .leftJoin(departments, eq(departments.id, employees.departmentId))
    .where(eq(employees.isActive, true));
  const dayRows = await db
    .select({ employeeId: attendanceDays.employeeId, status: attendanceDays.status })
    .from(attendanceDays)
    .where(eq(attendanceDays.day, today));
  const statusOf = new Map(dayRows.map((r) => [r.employeeId, r.status]));
  const lastPunches = await db
    .selectDistinctOn([punches.employeeId], { employeeId: punches.employeeId, type: punches.type, punchedAt: punches.punchedAt })
    .from(punches)
    .where(eq(punches.punchDate, today))
    .orderBy(punches.employeeId, desc(punches.punchedAt));
  const lastOf = new Map(lastPunches.map((p) => [p.employeeId, p]));

  const present = staff.filter((e) => ["P", "H"].includes(statusOf.get(e.id) ?? "") || lastOf.has(e.id));
  const insideNow = staff.filter((e) => lastOf.get(e.id)?.type === "in");
  const presentIds = new Set(present.map((e) => e.id));
  const absent = staff.filter((e) => !presentIds.has(e.id));
  res.json({
    present,
    insideNow: insideNow.map((e) => ({ ...e, since: lastOf.get(e.id)!.punchedAt })),
    absent,
    counts: { total: staff.length, present: present.length, insideNow: insideNow.length, absent: absent.length },
  });
});

/* ══ Leave ═══════════════════════════════════════════════════════════════ */

payrollRouter.get("/leave", view, async (req, res) => {
  const conds = [];
  if (req.query.status) conds.push(eq(leaveApplications.status, String(req.query.status) as "pending" | "approved" | "rejected"));
  if (req.query.employeeId) conds.push(eq(leaveApplications.employeeId, String(req.query.employeeId)));
  if (req.query.year) {
    const y = Number(req.query.year);
    conds.push(gte(leaveApplications.fromDate, `${y}-01-01`), lte(leaveApplications.fromDate, `${y}-12-31`));
  }
  const rows = await db
    .select({
      id: leaveApplications.id,
      employeeId: leaveApplications.employeeId,
      name: employees.name,
      empCode: employees.empCode,
      leaveType: leaveApplications.leaveType,
      fromDate: leaveApplications.fromDate,
      toDate: leaveApplications.toDate,
      days: leaveApplications.days,
      reason: leaveApplications.reason,
      status: leaveApplications.status,
      medicalDocUrl: leaveApplications.medicalDocUrl,
      compOffWorkDate: leaveApplications.compOffWorkDate,
      remarks: leaveApplications.remarks,
      appliedAt: leaveApplications.appliedAt,
      decidedAt: leaveApplications.decidedAt,
    })
    .from(leaveApplications)
    .innerJoin(employees, eq(employees.id, leaveApplications.employeeId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(leaveApplications.appliedAt));
  res.json(rows);
});

payrollRouter.post(
  "/leave",
  attendancePerm,
  validateBody(
    z.object({
      employeeId: z.string().uuid(),
      leaveType: z.enum(["CL", "SL", "CompOff"]),
      fromDate: dateStr,
      toDate: dateStr,
      reason: z.string().min(1).max(500),
      medicalDocUrl: z.string().nullish(),
      compOffWorkDate: dateStr.nullish(),
    }),
  ),
  async (req, res) => {
    try {
      const row = await db.transaction((tx) => applyLeave(tx, req.body));
      res.status(201).json(row);
    } catch (err) {
      if (!fail(err, res)) throw err;
    }
  },
);

payrollRouter.post(
  "/leave/:id/approve",
  attendancePerm,
  validateBody(z.object({ remarks: z.string().max(300).optional() })),
  async (req, res) => {
    try {
      const row = await db.transaction((tx) => approveLeave(tx, req.params.id!, req.session.user!.id, req.body.remarks));
      res.json(row);
    } catch (err) {
      if (!fail(err, res)) throw err;
    }
  },
);

payrollRouter.post(
  "/leave/:id/reject",
  attendancePerm,
  validateBody(z.object({ remarks: z.string().max(300).optional() })),
  async (req, res) => {
    try {
      const row = await db.transaction((tx) => rejectLeave(tx, req.params.id!, req.session.user!.id, req.body.remarks));
      res.json(row);
    } catch (err) {
      if (!fail(err, res)) throw err;
    }
  },
);

payrollRouter.delete("/leave/:id", attendancePerm, async (req, res) => {
  try {
    const row = await db.transaction((tx) => deleteLeave(tx, req.params.id!));
    res.json(row);
  } catch (err) {
    if (!fail(err, res)) throw err;
  }
});

payrollRouter.get("/leave/balance/:employeeId", view, async (req, res) => {
  const year = Number(req.query.year) || Number(istDate().slice(0, 4));
  try {
    res.json(await leaveBalance(db, req.params.employeeId!, year));
  } catch (err) {
    if (!fail(err, res)) throw err;
  }
});

/* ══ Pay inputs & advances ═══════════════════════════════════════════════ */

payrollRouter.get("/pay-inputs", view, async (req, res) => {
  const conds = [];
  if (req.query.year) conds.push(eq(payInputs.year, Number(req.query.year)));
  if (req.query.month) conds.push(eq(payInputs.month, Number(req.query.month)));
  if (req.query.kind) conds.push(eq(payInputs.kind, String(req.query.kind) as "bonus" | "overtime" | "reimbursement" | "deduction"));
  if (req.query.status) conds.push(eq(payInputs.status, String(req.query.status) as "pending" | "approved" | "rejected" | "paid"));
  const rows = await db
    .select({
      id: payInputs.id,
      employeeId: payInputs.employeeId,
      name: employees.name,
      empCode: employees.empCode,
      kind: payInputs.kind,
      month: payInputs.month,
      year: payInputs.year,
      amount: payInputs.amount,
      hours: payInputs.hours,
      ratePerHour: payInputs.ratePerHour,
      category: payInputs.category,
      description: payInputs.description,
      receiptUrl: payInputs.receiptUrl,
      status: payInputs.status,
      approvedAmount: payInputs.approvedAmount,
      createdAt: payInputs.createdAt,
    })
    .from(payInputs)
    .innerJoin(employees, eq(employees.id, payInputs.employeeId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(payInputs.createdAt));
  res.json(rows.map((r) => ({ ...r, amount: Number(r.amount), approvedAmount: r.approvedAmount == null ? null : Number(r.approvedAmount) })));
});

const payInputBody = z.object({
  employeeId: z.string().uuid(),
  kind: z.enum(["bonus", "overtime", "reimbursement", "deduction"]),
  month: monthNum,
  year: yearNum,
  amount: moneyNum.optional(),
  hours: looseNumber(z.number().positive().max(400)).optional(),
  ratePerHour: moneyNum.optional(),
  category: z.string().max(120).nullish(),
  description: z.string().max(500).nullish(),
  receiptUrl: z.string().nullish(),
});

/** Overtime is hours × rate, computed here — never a typed-in amount. */
function payInputAmount(b: z.infer<typeof payInputBody>): number {
  if (b.kind === "overtime") {
    if (!b.hours || b.ratePerHour == null) throw new PostingError("Overtime needs hours and a rate per hour");
    return Math.round(b.hours * b.ratePerHour * 100) / 100;
  }
  if (!b.amount || b.amount <= 0) throw new PostingError("Amount must be above zero");
  return b.amount;
}

payrollRouter.post("/pay-inputs", payInputsPerm, validateBody(payInputBody), async (req, res) => {
  const b = req.body as z.infer<typeof payInputBody>;
  try {
    const amount = payInputAmount(b);
    const [row] = await db
      .insert(payInputs)
      .values({
        employeeId: b.employeeId,
        kind: b.kind,
        month: b.month,
        year: b.year,
        amount: amount.toFixed(2),
        hours: b.kind === "overtime" ? b.hours : null,
        ratePerHour: b.kind === "overtime" ? b.ratePerHour!.toFixed(2) : null,
        category: b.category ?? null,
        description: b.description ?? null,
        receiptUrl: b.receiptUrl ?? null,
        createdBy: req.session.user!.id,
      })
      .returning();
    res.status(201).json(row);
  } catch (err) {
    if (!fail(err, res)) throw err;
  }
});

payrollRouter.patch("/pay-inputs/:id", payInputsPerm, validateBody(payInputBody.partial().omit({ employeeId: true })), async (req, res) => {
  const [existing] = await db.select().from(payInputs).where(eq(payInputs.id, req.params.id!));
  if (!existing) return res.status(404).json({ error: "No such pay input" });
  if (existing.status !== "pending") return res.status(422).json({ error: "Only a pending input can be edited" });
  const b = req.body as Partial<z.infer<typeof payInputBody>>;
  try {
    const merged = {
      kind: existing.kind,
      month: existing.month,
      year: existing.year,
      amount: Number(existing.amount),
      hours: existing.hours ?? undefined,
      ratePerHour: existing.ratePerHour == null ? undefined : Number(existing.ratePerHour),
      ...b,
    } as z.infer<typeof payInputBody>;
    const amount = payInputAmount(merged);
    const [row] = await db
      .update(payInputs)
      .set({
        month: merged.month,
        year: merged.year,
        amount: amount.toFixed(2),
        hours: merged.kind === "overtime" ? merged.hours : null,
        ratePerHour: merged.kind === "overtime" ? merged.ratePerHour!.toFixed(2) : null,
        ...(b.category !== undefined && { category: b.category }),
        ...(b.description !== undefined && { description: b.description }),
        ...(b.receiptUrl !== undefined && { receiptUrl: b.receiptUrl }),
      })
      .where(eq(payInputs.id, req.params.id!))
      .returning();
    res.json(row);
  } catch (err) {
    if (!fail(err, res)) throw err;
  }
});

payrollRouter.post(
  "/pay-inputs/:id/approve",
  payInputsPerm,
  validateBody(z.object({ approvedAmount: moneyNum.optional() })),
  async (req, res) => {
    const [existing] = await db.select().from(payInputs).where(eq(payInputs.id, req.params.id!));
    if (!existing) return res.status(404).json({ error: "No such pay input" });
    if (existing.status !== "pending") return res.status(422).json({ error: `Already ${existing.status}` });
    const [row] = await db
      .update(payInputs)
      .set({
        status: "approved",
        approvedAmount: req.body.approvedAmount != null ? Number(req.body.approvedAmount).toFixed(2) : null,
        decidedBy: req.session.user!.id,
        decidedAt: new Date(),
      })
      .where(eq(payInputs.id, req.params.id!))
      .returning();
    res.json(row);
  },
);

payrollRouter.post("/pay-inputs/:id/reject", payInputsPerm, async (req, res) => {
  const [existing] = await db.select().from(payInputs).where(eq(payInputs.id, req.params.id!));
  if (!existing) return res.status(404).json({ error: "No such pay input" });
  if (existing.status === "paid") return res.status(422).json({ error: "Already paid through a run" });
  const [row] = await db
    .update(payInputs)
    .set({ status: "rejected", decidedBy: req.session.user!.id, decidedAt: new Date() })
    .where(eq(payInputs.id, req.params.id!))
    .returning();
  res.json(row);
});

payrollRouter.delete("/pay-inputs/:id", payInputsPerm, async (req, res) => {
  const [existing] = await db.select().from(payInputs).where(eq(payInputs.id, req.params.id!));
  if (!existing) return res.status(404).json({ error: "No such pay input" });
  if (existing.status === "paid") return res.status(422).json({ error: "Paid through a run — it cannot be deleted" });
  await db.delete(payInputs).where(eq(payInputs.id, req.params.id!));
  res.json({ ok: true });
});

payrollRouter.get("/advances", view, async (req, res) => {
  const conds = [];
  if (req.query.employeeId) conds.push(eq(advances.employeeId, String(req.query.employeeId)));
  if (req.query.status) conds.push(eq(advances.status, String(req.query.status) as "active" | "closed" | "cancelled"));
  const rows = await db
    .select({
      id: advances.id,
      employeeId: advances.employeeId,
      name: employees.name,
      empCode: employees.empCode,
      type: advances.type,
      amount: advances.amount,
      emiAmount: advances.emiAmount,
      givenOn: advances.givenOn,
      reason: advances.reason,
      status: advances.status,
      createdAt: advances.createdAt,
    })
    .from(advances)
    .innerJoin(employees, eq(employees.id, advances.employeeId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(advances.givenOn));
  const reps = rows.length
    ? await db
        .select()
        .from(advanceRepayments)
        .where(inArray(advanceRepayments.advanceId, rows.map((r) => r.id)))
        .orderBy(desc(advanceRepayments.createdAt))
    : [];
  const byAdvance = new Map<string, typeof reps>();
  for (const r of reps) byAdvance.set(r.advanceId, [...(byAdvance.get(r.advanceId) ?? []), r]);
  res.json(
    rows.map((r) => {
      const mine = byAdvance.get(r.id) ?? [];
      const repaid = mine.reduce((n, x) => n + Number(x.amount), 0);
      return {
        ...r,
        amount: Number(r.amount),
        emiAmount: Number(r.emiAmount),
        outstanding: Math.round((Number(r.amount) - repaid) * 100) / 100,
        repayments: mine.map((x) => ({ ...x, amount: Number(x.amount) })),
      };
    }),
  );
});

payrollRouter.post(
  "/advances",
  payInputsPerm,
  validateBody(
    z.object({
      employeeId: z.string().uuid(),
      type: z.enum(["salary_advance", "loan"]).optional(),
      amount: moneyNum.refine((n) => n > 0, "Amount must be above zero"),
      emiAmount: moneyNum,
      givenOn: dateStr,
      reason: z.string().max(300).nullish(),
    }),
  ),
  async (req, res) => {
    const b = req.body as { employeeId: string; type?: "salary_advance" | "loan"; amount: number; emiAmount: number; givenOn: string; reason?: string | null };
    const [row] = await db
      .insert(advances)
      .values({
        employeeId: b.employeeId,
        type: b.type ?? "salary_advance",
        amount: b.amount.toFixed(2),
        emiAmount: b.emiAmount.toFixed(2),
        givenOn: b.givenOn,
        reason: b.reason ?? null,
        createdBy: req.session.user!.id,
      })
      .returning();
    res.status(201).json(row);
  },
);

/** A repayment taken by hand, outside a run — cash at the counter. */
payrollRouter.post(
  "/advances/:id/repay",
  payInputsPerm,
  validateBody(z.object({ amount: moneyNum.refine((n) => n > 0), month: monthNum, year: yearNum, notes: z.string().max(300).nullish() })),
  async (req, res) => {
    const b = req.body as { amount: number; month: number; year: number; notes?: string | null };
    try {
      const out = await db.transaction(async (tx) => {
        const [adv] = await tx.select().from(advances).where(eq(advances.id, req.params.id!));
        if (!adv) throw new PostingError("No such advance");
        if (adv.status !== "active") throw new PostingError(`This advance is ${adv.status}`);
        const outstanding = await advanceOutstanding(tx, adv.id);
        if (b.amount > outstanding + 0.005) throw new PostingError(`Only ₹${outstanding.toFixed(2)} is outstanding`);
        const [row] = await tx
          .insert(advanceRepayments)
          .values({ advanceId: adv.id, amount: b.amount.toFixed(2), month: b.month, year: b.year, notes: b.notes ?? null })
          .returning();
        if (outstanding - b.amount <= 0.005) await tx.update(advances).set({ status: "closed" }).where(eq(advances.id, adv.id));
        return { ...row!, outstanding: Math.round((outstanding - b.amount) * 100) / 100 };
      });
      res.status(201).json(out);
    } catch (err) {
      if (!fail(err, res)) throw err;
    }
  },
);

payrollRouter.post("/advances/:id/cancel", payInputsPerm, async (req, res) => {
  try {
    const out = await db.transaction(async (tx) => {
      const [adv] = await tx.select().from(advances).where(eq(advances.id, req.params.id!));
      if (!adv) throw new PostingError("No such advance");
      if (adv.status !== "active") throw new PostingError(`This advance is ${adv.status}`);
      const [rep] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(advanceRepayments)
        .where(eq(advanceRepayments.advanceId, adv.id));
      if (rep!.n > 0) throw new PostingError("Repayments exist — this advance can only run down to closed");
      const [row] = await tx.update(advances).set({ status: "cancelled" }).where(eq(advances.id, adv.id)).returning();
      return row!;
    });
    res.json(out);
  } catch (err) {
    if (!fail(err, res)) throw err;
  }
});

/* ══ Runs ════════════════════════════════════════════════════════════════ */

payrollRouter.get("/runs", view, async (_req, res) => {
  res.json(await listRuns(db));
});

payrollRouter.post("/runs/process", runPerm, validateBody(z.object({ month: monthNum, year: yearNum })), async (req, res) => {
  try {
    const out = await db.transaction(async (tx) => {
      const run = await processRun(tx, { month: req.body.month, year: req.body.year, userId: req.session.user!.id });
      return { run, slips: await runSlips(tx, run.id) };
    });
    res.status(201).json(out);
  } catch (err) {
    if (!fail(err, res)) throw err;
  }
});

payrollRouter.get("/runs/:id", view, async (req, res) => {
  const [run] = await db.select().from(payrollRuns).where(eq(payrollRuns.id, req.params.id!));
  if (!run) return res.status(404).json({ error: "No such run" });
  const slips = await runSlips(db, run.id);
  const exceptions = await runExceptions(db, run.id);
  res.json({ run, slips, exceptions });
});

payrollRouter.post("/runs/:id/confirm", runPerm, async (req, res) => {
  try {
    const out = await db.transaction((tx) => confirmRun(tx, req.params.id!, req.session.user!.id));
    res.json(out);
  } catch (err) {
    if (!fail(err, res)) throw err;
  }
});

payrollRouter.delete("/runs/:id", runPerm, async (req, res) => {
  try {
    await db.transaction((tx) => deleteDraftRun(tx, req.params.id!));
    res.json({ ok: true });
  } catch (err) {
    if (!fail(err, res)) throw err;
  }
});

/** The bank's upload: name, account, IFSC, net — nothing more. */
payrollRouter.get("/runs/:id/bank-file", view, async (req, res) => {
  const [run] = await db.select().from(payrollRuns).where(eq(payrollRuns.id, req.params.id!));
  if (!run) return res.status(404).json({ error: "No such run" });
  const slips = await runSlips(db, run.id);
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = [
    "Name,Account Number,IFSC,Net Pay",
    ...slips
      .filter((s) => Number(s.netPay) > 0)
      .map((s) => [esc(s.name), esc(s.bankAccountNumber ?? ""), esc(s.bankIfsc ?? ""), Number(s.netPay).toFixed(2)].join(",")),
  ];
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename=payroll-${run.year}-${String(run.month).padStart(2, "0")}.csv`);
  res.send(lines.join("\n"));
});

payrollRouter.get("/slips/:id", view, async (req, res) => {
  const [row] = await db
    .select({
      slip: salarySlips,
      run: payrollRuns,
      name: employees.name,
      empCode: employees.empCode,
      department: departments.name,
      designation: designations.name,
    })
    .from(salarySlips)
    .innerJoin(payrollRuns, eq(payrollRuns.id, salarySlips.payrollRunId))
    .innerJoin(employees, eq(employees.id, salarySlips.employeeId))
    .leftJoin(departments, eq(departments.id, employees.departmentId))
    .leftJoin(designations, eq(designations.id, employees.designationId))
    .where(eq(salarySlips.id, req.params.id!));
  if (!row) return res.status(404).json({ error: "No such slip" });
  res.json(row);
});

/* ══ Reports ═════════════════════════════════════════════════════════════ */

/** Daily-wage cost over a range: rate × (P + 0.5·H) per person, totalled by role. */
payrollRouter.get("/reports/wages", view, async (req, res) => {
  const from = dateStr.safeParse(req.query.from);
  const to = dateStr.safeParse(req.query.to);
  if (!from.success || !to.success) return res.status(400).json({ error: "from and to are required" });
  const conds = [eq(employees.payType, "daily_wage" as const)];
  const staff = await db
    .select({ id: employees.id, empCode: employees.empCode, name: employees.name, defaultRoleId: employees.wageRoleId })
    .from(employees)
    .where(and(...conds))
    .orderBy(asc(employees.empCode));
  const roles = await db.select().from(wageRoles);
  const roleById = new Map(roles.map((r) => [r.id, r]));

  // Each day is paid at the rate of the role it was WORKED in. The empty
  // bucket is days with no per-day role, priced at the worker's usual role.
  const totals = await wageDayTotals(db, from.data, to.data, staff.map((s) => s.id));
  const roleFilter = req.query.role ? String(req.query.role) : null;
  const byRole = new Map<string, { role: string; heads: number; presentDays: number; halfDays: number; amount: number }>();
  const rows: Array<{
    id: string; empCode: string; name: string; role: string | null;
    dailyRate: number; presentDays: number; halfDays: number; amount: number;
  }> = [];
  for (const s of staff) {
    const buckets = totals.get(s.id) ?? new Map<string, { P: number; H: number }>();
    let amount = 0;
    let presentDays = 0;
    let halfDays = 0;
    let touchesFilter = false;
    // Roles worked this range, most days first — the Role column reads
    // "Egg picking +2" when a month mixes three.
    const worked: Array<{ name: string; days: number; rate: number }> = [];
    for (const [bucketRole, b] of buckets) {
      const roleId = bucketRole || s.defaultRoleId || "";
      const role = roleId ? roleById.get(roleId) : undefined;
      const rate = Number(role?.dailyRate ?? 0);
      const days = b.P + 0.5 * b.H;
      amount = Math.round((amount + rate * days) * 100) / 100;
      presentDays += b.P;
      halfDays += b.H;
      if (roleId === roleFilter) touchesFilter = true;
      const label = role?.name ?? "(no role)";
      const w = worked.find((x) => x.name === label);
      if (w) w.days += days;
      else worked.push({ name: label, days, rate });
      const agg = byRole.get(label) ?? { role: label, heads: 0, presentDays: 0, halfDays: 0, amount: 0 };
      agg.presentDays += b.P;
      agg.halfDays += b.H;
      agg.amount = Math.round((agg.amount + rate * days) * 100) / 100;
      byRole.set(label, agg);
    }
    // heads: one per worker per role touched
    for (const w of worked) {
      const agg = byRole.get(w.name);
      if (agg) agg.heads++;
    }
    if (roleFilter && !touchesFilter && s.defaultRoleId !== roleFilter) continue;
    if (presentDays + halfDays === 0 && !roleFilter) continue;
    worked.sort((a, b) => b.days - a.days);
    const primary = worked[0];
    const defaultRole = s.defaultRoleId ? roleById.get(s.defaultRoleId) : undefined;
    rows.push({
      id: s.id,
      empCode: s.empCode,
      name: s.name,
      role: primary ? primary.name + (worked.length > 1 ? ` +${worked.length - 1}` : "") : (defaultRole?.name ?? null),
      dailyRate: primary ? primary.rate : Number(defaultRole?.dailyRate ?? 0),
      presentDays,
      halfDays,
      amount,
    });
  }
  res.json({ rows, byRole: [...byRole.values()], total: rows.reduce((n, r) => n + r.amount, 0) });
});

/**
 * One day of the wage yard: who was in, and as what.
 *
 * People change jobs day to day — egg picking today, vaccination helper
 * tomorrow — so the day's role is set HERE, against the attendance row the
 * gate already made. No row means the gate never saw them: presence comes
 * from punches, this screen only says what the day was spent on.
 */
payrollRouter.get("/wages/day", view, async (req, res) => {
  const day = dateStr.safeParse(req.query.date);
  if (!day.success) return res.status(400).json({ error: "date is required" });
  const staff = await db
    .select({
      id: employees.id,
      empCode: employees.empCode,
      name: employees.name,
      defaultRoleId: employees.wageRoleId,
      defaultRoleName: wageRoles.name,
    })
    .from(employees)
    .leftJoin(wageRoles, eq(wageRoles.id, employees.wageRoleId))
    .where(and(eq(employees.payType, "daily_wage" as const), eq(employees.isActive, true)))
    .orderBy(asc(employees.empCode));
  const att = await db
    .select({ employeeId: attendanceDays.employeeId, status: attendanceDays.status, wageRoleId: attendanceDays.wageRoleId })
    .from(attendanceDays)
    .where(eq(attendanceDays.day, day.data));
  const byEmp = new Map(att.map((a) => [a.employeeId, a]));
  res.json(
    staff.map((st) => {
      const a = byEmp.get(st.id);
      return {
        id: st.id,
        empCode: st.empCode,
        name: st.name,
        defaultRoleId: st.defaultRoleId,
        defaultRoleName: st.defaultRoleName,
        status: a?.status ?? null,
        dayRoleId: a?.wageRoleId ?? null,
      };
    }),
  );
});

payrollRouter.patch(
  "/wages/day",
  attendancePerm,
  validateBody(
    z.object({
      employeeId: z.string().uuid(),
      day: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/),
      wageRoleId: z.string().uuid().nullable(),
    }),
  ),
  async (req, res) => {
    const { employeeId, day, wageRoleId } = req.body as {
      employeeId: string;
      day: string;
      wageRoleId: string | null;
    };
    const [emp] = await db
      .select({ payType: employees.payType })
      .from(employees)
      .where(eq(employees.id, employeeId));
    if (!emp) return res.status(404).json({ error: "No such employee" });
    if (emp.payType !== "daily_wage")
      return res.status(400).json({ error: "Day roles are for daily-wage workers" });
    if (wageRoleId) {
      const [role] = await db.select({ id: wageRoles.id }).from(wageRoles).where(eq(wageRoles.id, wageRoleId));
      if (!role) return res.status(404).json({ error: "No such wage role" });
    }
    const [row] = await db
      .update(attendanceDays)
      .set({ wageRoleId, updatedAt: new Date() })
      .where(and(eq(attendanceDays.employeeId, employeeId), eq(attendanceDays.day, day)))
      .returning({ employeeId: attendanceDays.employeeId });
    if (!row)
      return res.status(409).json({ error: "No attendance that day — presence comes from the gate, not from here" });
    res.json({ ok: true });
  },
);

/** Month by month, from confirmed runs only — the year at a glance. */
payrollRouter.get("/reports/summary", view, async (req, res) => {
  const year = Number(req.query.year) || Number(istDate().slice(0, 4));
  const runs = await db
    .select()
    .from(payrollRuns)
    .where(and(eq(payrollRuns.year, year), eq(payrollRuns.status, "confirmed")))
    .orderBy(asc(payrollRuns.month));
  res.json(
    runs.map((r) => ({
      month: r.month,
      gross: Number(r.totalGross),
      deductions: Number(r.totalDeductions),
      net: Number(r.totalNet),
      employerCost: Number(r.totalEmployerCost),
      headcount: r.employeeCount,
    })),
  );
});

/** The Home "People" card. "Today" is IST today; the range drives cost and %. */
payrollRouter.get("/reports/people", view, async (req, res) => {
  const today = istDate();
  const from = typeof req.query.from === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from) ? req.query.from : today.slice(0, 8) + "01";
  const to = typeof req.query.to === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to) ? req.query.to : today;

  const staff = await db
    .select({ id: employees.id, empCode: employees.empCode, name: employees.name, payType: employees.payType, department: departments.name, wageRoleId: employees.wageRoleId })
    .from(employees)
    .leftJoin(departments, eq(departments.id, employees.departmentId))
    .leftJoin(wageRoles, eq(wageRoles.id, employees.wageRoleId))
    .where(eq(employees.isActive, true));
  const todayRows = await db
    .select({ employeeId: attendanceDays.employeeId, status: attendanceDays.status })
    .from(attendanceDays)
    .where(eq(attendanceDays.day, today));
  const statusOf = new Map(todayRows.map((r) => [r.employeeId, r.status]));
  const lastPunches = await db
    .selectDistinctOn([punches.employeeId], { employeeId: punches.employeeId, type: punches.type, punchedAt: punches.punchedAt })
    .from(punches)
    .where(eq(punches.punchDate, today))
    .orderBy(punches.employeeId, desc(punches.punchedAt));
  const lastOf = new Map(lastPunches.map((p) => [p.employeeId, p]));

  const isPresent = (id: string) => ["P", "H"].includes(statusOf.get(id) ?? "") || lastOf.has(id);
  const byDepartment = new Map<string, { department: string; present: number; total: number }>();
  for (const e of staff) {
    const key = e.department ?? "(none)";
    const agg = byDepartment.get(key) ?? { department: key, present: 0, total: 0 };
    agg.total++;
    if (isPresent(e.id)) agg.present++;
    byDepartment.set(key, agg);
  }

  const totals = await monthTotals(db, from, to);
  const peopleBuckets = await wageDayTotals(db, from, to);
  const peopleRoles = new Map(
    (await db.select({ id: wageRoles.id, dailyRate: wageRoles.dailyRate }).from(wageRoles)).map((r) => [r.id, Number(r.dailyRate)]),
  );
  let workDays = 0;
  let presentEq = 0;
  let wagesCost = 0;
  for (const e of staff) {
    const t = totals.get(e.id);
    if (!t) continue;
    workDays += t.P + t.H + t.A + t.L;
    presentEq += t.P + 0.5 * t.H;
    if (e.payType === "daily_wage") {
      // Per-day roles: each bucket at its own rate, blank at the usual role.
      for (const [bucketRole, b] of peopleBuckets.get(e.id) ?? []) {
        const rid = bucketRole || e.wageRoleId || "";
        wagesCost += Number(rid ? (peopleRoles.get(rid) ?? 0) : 0) * (b.P + 0.5 * b.H);
      }
    }
  }

  res.json({
    totalStaff: staff.length,
    presentToday: staff.filter((e) => isPresent(e.id)).length,
    insideNow: staff.filter((e) => lastOf.get(e.id)?.type === "in").map((e) => ({ id: e.id, empCode: e.empCode, name: e.name, since: lastOf.get(e.id)!.punchedAt })),
    absentToday: staff.filter((e) => !isPresent(e.id)).map((e) => ({ id: e.id, empCode: e.empCode, name: e.name, department: e.department })),
    byDepartment: [...byDepartment.values()].sort((a, b) => a.department.localeCompare(b.department)),
    attendancePct: workDays ? Math.round((presentEq / workDays) * 1000) / 10 : null,
    wagesCost: Math.round(wagesCost * 100) / 100,
  });
});
