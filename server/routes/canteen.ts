/**
 * Canteen — canteens, meal windows, who gets breakfast and dinner, the plates
 * served, the reports, and the browser Canteen Gate that records them.
 * Mounted at /api/canteen behind the global requireAuth. The rules themselves
 * live in services/canteen.ts, where a script can reach them; the old phone
 * routes (routes/device.ts) import `checkAttendancePresent` from here so the
 * presence rule is still written once.
 */
import { Router } from "express";
import { and, asc, desc, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import { advancedSearch, matches, type DocumentSearch } from "../services/document-search";
import { z } from "zod";
import {
  accounts,
  canteenMealEligibility,
  canteenMealWindows,
  canteenServings,
  canteens,
  devices,
  employees,
  expenses,
  locations,
  punches,
} from "@shared/schema";
import { MEALS, SERVING_STATES } from "@shared/canteen";
import { db, type Db, type Tx } from "../db";
import { requireAnyPermission, requirePermission } from "../lib/rbac";
import { DuplicatePlate, mealWindowsFor, presentForCanteen, recordBrowserServing } from "../services/canteen";
import { PostingError } from "../services/posting";
import { taughtCapturesByEmployee, roundEmbedding } from "../services/face-gallery";
import { istTimeHHMM, mealForTime, MEAL_LABEL } from "@shared/canteen";
import { timeOfDay, validateBody } from "../lib/validate";

type Conn = Db | Tx;

const IST = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" });
const istToday = () => IST.format(new Date());
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dateStr = z.string().regex(DATE_RE);

/**
 * The canteen's whole presence rule: any punch that day. Not the resolved
 * attendance status — a plate is served at noon, long before the day is
 * closed, and an IN punch is all the proof the counter can have.
 */
export async function checkAttendancePresent(conn: Conn, employeeId: string | null, day: string): Promise<boolean> {
  // …and someone still inside from last night; see services/canteen.ts.
  return presentForCanteen(conn, employeeId, day);
}

export const canteenRouter = Router();

const view = requirePermission("payroll", "view");
const manage = requirePermission("payroll", "canteen");
/**
 * The counter. Narrower than `canteen`: whoever serves plates needs neither the
 * eligibility list nor the reports — and not `payroll.view` either, which would
 * hand a canteen hand every employee's record to get at a camera.
 */
const serve = requireAnyPermission([["payroll", "canteen_punch"], ["payroll", "canteen"]]);

/* ── Canteens ──────────────────────────────────────────────────────────── */

const canteenCols = {
  id: canteens.id,
  code: canteens.code,
  name: canteens.name,
  locationId: canteens.locationId,
  location: { id: locations.id, code: locations.code, name: locations.name },
  isActive: canteens.isActive,
};

canteenRouter.get("/canteens", view, async (_req, res) => {
  const rows = await db.select(canteenCols).from(canteens).innerJoin(locations, eq(locations.id, canteens.locationId)).orderBy(asc(canteens.name));
  res.json(rows);
});

const canteenBody = z.object({
  code: z.string().trim().min(1).max(12).toUpperCase(),
  name: z.string().trim().min(1).max(80),
  locationId: z.string().uuid(),
});

canteenRouter.post("/canteens", manage, validateBody(canteenBody), async (req, res) => {
  const b = req.body as z.infer<typeof canteenBody>;
  try {
    const [row] = await db.insert(canteens).values(b).returning();
    res.status(201).json(row);
  } catch (e: any) {
    if (e?.code === "23505") return res.status(409).json({ error: "A canteen with that code already exists" });
    throw e;
  }
});

const canteenPatch = canteenBody.partial().extend({ isActive: z.boolean().optional() });

canteenRouter.patch("/canteens/:id", manage, validateBody(canteenPatch), async (req, res) => {
  const [row] = await db.update(canteens).set(req.body).where(eq(canteens.id, req.params.id!)).returning();
  if (!row) return res.status(404).json({ error: "Canteen not found" });
  res.json(row);
});

/* ── Meal windows ──────────────────────────────────────────────────────── */

canteenRouter.get("/windows", view, async (req, res) => {
  const canteenId = typeof req.query.canteenId === "string" ? req.query.canteenId : null;
  // Always include the global defaults: a canteen's own rows only override them.
  const rows = await db
    .select()
    .from(canteenMealWindows)
    .where(canteenId ? sql`${canteenMealWindows.canteenId} IS NULL OR ${canteenMealWindows.canteenId} = ${canteenId}` : undefined)
    .orderBy(asc(canteenMealWindows.canteenId), asc(canteenMealWindows.meal));
  res.json(rows);
});

const windowsBody = z
  .array(
    z
      .object({
        canteenId: z.string().uuid().nullable(),
        meal: z.enum(MEALS),
        startTime: timeOfDay,
        endTime: timeOfDay,
      })
      .refine((w) => w.endTime > w.startTime, {
        message: "End time must be after start time",
        path: ["endTime"],
      }),
  )
  .min(1);

/** Upsert by (canteenId, meal) — the unique index cannot do it for NULL canteenId, so by hand. */
canteenRouter.put("/windows", manage, validateBody(windowsBody), async (req, res) => {
  const items = req.body as z.infer<typeof windowsBody>;
  const out = await db.transaction(async (tx) => {
    const rows = [];
    for (const w of items) {
      const scope = w.canteenId ? eq(canteenMealWindows.canteenId, w.canteenId) : isNull(canteenMealWindows.canteenId);
      const [existing] = await tx.select({ id: canteenMealWindows.id }).from(canteenMealWindows).where(and(eq(canteenMealWindows.meal, w.meal), scope));
      const [row] = existing
        ? await tx.update(canteenMealWindows).set({ startTime: w.startTime, endTime: w.endTime, isActive: true }).where(eq(canteenMealWindows.id, existing.id)).returning()
        : await tx.insert(canteenMealWindows).values(w).returning();
      rows.push(row!);
    }
    return rows;
  });
  res.json(out);
});

/* ── Eligibility ───────────────────────────────────────────────────────── */

canteenRouter.get("/eligibility", view, async (_req, res) => {
  // Every active employee, flags defaulting to false — lunch is universal.
  const rows = await db
    .select({
      employeeId: employees.id,
      empCode: employees.empCode,
      name: employees.name,
      payType: employees.payType,
      locationId: employees.locationId,
      breakfast: sql<boolean>`coalesce(${canteenMealEligibility.breakfast}, false)`,
      // Breakfast the system grants for a night shift; shown, never edited.
      breakfastAuto: sql<boolean>`coalesce(${canteenMealEligibility.breakfastAuto}, false)`,
      dinner: sql<boolean>`coalesce(${canteenMealEligibility.dinner}, false)`,
      note: canteenMealEligibility.note,
    })
    .from(employees)
    .leftJoin(canteenMealEligibility, eq(canteenMealEligibility.employeeId, employees.id))
    .where(eq(employees.isActive, true))
    .orderBy(asc(employees.name));
  res.json(rows);
});

const eligibilityBody = z.object({
  breakfast: z.boolean(),
  dinner: z.boolean(),
  note: z.string().trim().max(200).nullish(),
});

canteenRouter.put("/eligibility/:employeeId", manage, validateBody(eligibilityBody), async (req, res) => {
  const b = req.body as z.infer<typeof eligibilityBody>;
  const userId = req.session.user!.id;
  const [emp] = await db.select({ id: employees.id }).from(employees).where(eq(employees.id, req.params.employeeId!));
  if (!emp) return res.status(404).json({ error: "Employee not found" });
  const now = new Date();
  const [row] = await db.transaction(async (tx) => {
    const r = await tx
      .insert(canteenMealEligibility)
      .values({ employeeId: emp.id, breakfast: b.breakfast, dinner: b.dinner, note: b.note ?? null, updatedBy: userId, updatedAt: now })
      .onConflictDoUpdate({ target: canteenMealEligibility.employeeId, set: { breakfast: b.breakfast, dinner: b.dinner, note: b.note ?? null, updatedBy: userId, updatedAt: now } })
      .returning();
    // The phones pull by employees.updated_at; a changed flag must move it.
    await tx.update(employees).set({ updatedAt: now }).where(eq(employees.id, emp.id));
    return r;
  });
  res.json(row);
});

/* ── Servings ──────────────────────────────────────────────────────────── */

const servingCols = {
  id: canteenServings.id,
  clientId: canteenServings.clientId,
  canteenId: canteenServings.canteenId,
  canteen: canteens.name,
  deviceId: canteenServings.deviceId,
  device: sql<string>`coalesce(${devices.name}, 'Web gate')`,
  ineligible: canteenServings.ineligible,
  mealDate: canteenServings.mealDate,
  meal: canteenServings.meal,
  employeeId: canteenServings.employeeId,
  empCode: employees.empCode,
  personName: canteenServings.personName,
  state: canteenServings.state,
  matchScore: canteenServings.matchScore,
  servedAt: canteenServings.servedAt,
  tokenNumber: canteenServings.tokenNumber,
  outsideWindow: canteenServings.outsideWindow,
  extraPlateKind: canteenServings.extraPlateKind,
  guestBatchId: canteenServings.guestBatchId,
  guestParty: canteenServings.guestParty,
  reasonCode: canteenServings.reasonCode,
  reasonText: canteenServings.reasonText,
  authorisedBy: canteenServings.authorisedBy,
  hasPhoto: sql<boolean>`${canteenServings.photoUrl} IS NOT NULL`,
  attendancePresent: canteenServings.attendancePresent,
  reconciledAt: canteenServings.reconciledAt,
  syncedAt: canteenServings.syncedAt,
};

const servingsFrom = (conn: Conn) =>
  conn
    .select(servingCols)
    .from(canteenServings)
    .innerJoin(canteens, eq(canteens.id, canteenServings.canteenId))
    // LEFT: a plate served at the browser gate has no device, and an inner join
    // here made it exist in the table and appear on no screen at all.
    .leftJoin(devices, eq(devices.id, canteenServings.deviceId))
    .leftJoin(employees, eq(employees.id, canteenServings.employeeId));

/**
 * The Today tab's advanced search. Canteen and meal are the tab's own
 * pickers; this is the rest — whose plates, how they were let through, and
 * the flags a supervisor looks for. A date range, when given, replaces the
 * tab's single day, so "every second plate this month" is one search.
 */
const servingSearch: DocumentSearch = {
  advanced: {
    mealDate: { kind: "dateRange", col: canteenServings.mealDate },
    employee: { kind: "eq", col: canteenServings.employeeId },
    state: { kind: "eq", col: canteenServings.state },
    token: { kind: "text", col: canteenServings.tokenNumber },
    guestParty: { kind: "text", col: canteenServings.guestParty },
    flag: {
      kind: "custom",
      build: (get) => {
        switch (get("flag")) {
          case "outside_window":
            return eq(canteenServings.outsideWindow, true);
          case "second_plate":
            return eq(canteenServings.extraPlateKind, "second_plate");
          case "extra_plate":
            return sql`${canteenServings.extraPlateKind} IS NOT NULL`;
          case "no_punch":
            return eq(canteenServings.attendancePresent, false);
          case "not_on_list":
            return eq(canteenServings.ineligible, true);
        }
      },
    },
  },
};

canteenRouter.get("/servings", view, async (req, res) => {
  const q = req.query;
  const date = typeof q.date === "string" && DATE_RE.test(q.date) ? q.date : istToday();
  const advanced = advancedSearch(servingSearch, q as Record<string, string | undefined>);
  const ranged = [q.mealDateFrom, q.mealDateTo].some((v) => typeof v === "string" && DATE_RE.test(v));
  const conds = [...(ranged ? [] : [eq(canteenServings.mealDate, date)]), ...advanced];
  if (typeof q.canteenId === "string" && q.canteenId) conds.push(eq(canteenServings.canteenId, q.canteenId));
  if (typeof q.meal === "string" && (MEALS as readonly string[]).includes(q.meal)) conds.push(eq(canteenServings.meal, q.meal as (typeof MEALS)[number]));
  if (typeof q.state === "string" && (SERVING_STATES as readonly string[]).includes(q.state)) conds.push(eq(canteenServings.state, q.state as (typeof SERVING_STATES)[number]));
  // The top-bar search. Here, not in the page: the list is paged, and a page
  // can only filter the twenty-five plates it was given.
  if (typeof q.search === "string" && q.search.trim()) {
    const cond = or(
      matches(canteenServings.personName, q.search),
      matches(canteenServings.tokenNumber, q.search),
      matches(canteenServings.guestParty, q.search),
    );
    if (cond) conds.push(cond);
  }
  const limit = Math.min(Math.max(Number(q.limit) || 25, 1), 200);
  const offset = Math.max(Number(q.offset) || 0, 0);
  const where = and(...conds);
  const [rows, [count]] = await Promise.all([
    servingsFrom(db).where(where).orderBy(desc(canteenServings.servedAt)).limit(limit).offset(offset),
    db.select({ n: sql<number>`count(*)::int` }).from(canteenServings).where(where),
  ]);
  res.json({ rows, total: count?.n ?? 0, date });
});

/** Plates someone should look at: authorised ones, guests, outside the window, or served to a person the gate never saw. */
canteenRouter.get("/exceptions", view, async (req, res) => {
  const date = typeof req.query.date === "string" && DATE_RE.test(req.query.date) ? req.query.date : istToday();
  const rows = await servingsFrom(db)
    .where(
      and(
        eq(canteenServings.mealDate, date),
        sql`(${canteenServings.state} IN ('override', 'guest', 'unverified_attendance')
          OR ${canteenServings.extraPlateKind} IS NOT NULL
          OR ${canteenServings.authorisedBy} IS NOT NULL
          OR ${canteenServings.outsideWindow}
          OR ${canteenServings.ineligible}
          OR ${canteenServings.attendancePresent} = false)`,
      ),
    )
    .orderBy(desc(canteenServings.servedAt));
  const exceptions = rows.map((r) => ({
    ...r,
    flags: [
      r.state === "override" ? "override" : null,
      r.state === "guest" || r.extraPlateKind === "guest" ? "guest" : null,
      r.extraPlateKind === "second_plate" ? "second_plate" : null,
      r.outsideWindow ? "outside_window" : null,
      r.ineligible ? "not_on_list" : null,
      r.attendancePresent === false ? "no_punch" : null,
      r.state === "unverified_attendance" ? "unverified" : null,
    ].filter(Boolean),
  }));
  res.json({ date, exceptions });
});

/* ── Report ────────────────────────────────────────────────────────────── */

canteenRouter.get("/report", view, async (req, res) => {
  const to = typeof req.query.to === "string" && DATE_RE.test(req.query.to) ? req.query.to : istToday();
  const from = typeof req.query.from === "string" && DATE_RE.test(req.query.from) ? req.query.from : to.slice(0, 8) + "01";
  if (from > to) return res.status(400).json({ error: "from must not be after to" });
  const canteenId = typeof req.query.canteenId === "string" && req.query.canteenId ? req.query.canteenId : null;
  const range = and(gte(canteenServings.mealDate, from), lte(canteenServings.mealDate, to));

  const cells = await db
    .select({
      canteenId: canteenServings.canteenId,
      canteen: canteens.name,
      meal: canteenServings.meal,
      state: canteenServings.state,
      plates: sql<number>`count(*)::int`,
    })
    .from(canteenServings)
    .innerJoin(canteens, eq(canteens.id, canteenServings.canteenId))
    .where(range)
    .groupBy(canteenServings.canteenId, canteens.name, canteenServings.meal, canteenServings.state)
    .orderBy(asc(canteens.name), asc(canteenServings.meal));

  const byDate = await db
    .select({ date: canteenServings.mealDate, plates: sql<number>`count(*)::int` })
    .from(canteenServings)
    .where(range)
    .groupBy(canteenServings.mealDate)
    .orderBy(asc(canteenServings.mealDate));

  // The same days, meal by meal — what the kitchen plans from. Days with no
  // plates are simply absent.
  const perMeal = await db
    .select({ date: canteenServings.mealDate, meal: canteenServings.meal, plates: sql<number>`count(*)::int` })
    .from(canteenServings)
    .where(canteenId ? and(range, eq(canteenServings.canteenId, canteenId)) : range)
    .groupBy(canteenServings.mealDate, canteenServings.meal)
    .orderBy(asc(canteenServings.mealDate));
  const dayMap = new Map<string, { date: string; breakfast: number; lunch: number; dinner: number; total: number }>();
  for (const r of perMeal) {
    const d = dayMap.get(r.date) ?? { date: r.date, breakfast: 0, lunch: 0, dinner: 0, total: 0 };
    d[r.meal] += r.plates;
    d.total += r.plates;
    dayMap.set(r.date, d);
  }
  const days = [...dayMap.values()];
  const totals = days.reduce((t, d) => ({ breakfast: t.breakfast + d.breakfast, lunch: t.lunch + d.lunch, dinner: t.dinner + d.dinner, total: t.total + d.total }), { breakfast: 0, lunch: 0, dinner: 0, total: 0 });

  if (req.query.format === "csv") {
    const lines = [
      "Date,Breakfast,Lunch,Dinner,Total",
      ...days.map((d) => `${d.date},${d.breakfast},${d.lunch},${d.dinner},${d.total}`),
      `Total,${totals.breakfast},${totals.lunch},${totals.dinner},${totals.total}`,
    ];
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="Canteen_Report_${from}_to_${to}.csv"`);
    return res.send(lines.join("\r\n") + "\r\n");
  }

  const plates = cells.reduce((s, c) => s + c.plates, 0);
  const guests = cells.filter((c) => c.state === "guest").reduce((s, c) => s + c.plates, 0);

  // Cost per plate = what was booked to the canteen expense account over the
  // same range ÷ plates. No per-plate accounting exists, on purpose.
  const [account] = await db.select({ id: accounts.id, name: accounts.name }).from(accounts).where(eq(accounts.systemKey, "canteen_expense"));
  let totalExpense: number | null = null;
  if (account) {
    const [sum] = await db
      .select({ total: sql<string>`coalesce(sum(${expenses.amount}), 0)` })
      .from(expenses)
      .where(and(eq(expenses.expenseAccountId, account.id), gte(expenses.expenseDate, from), lte(expenses.expenseDate, to)));
    totalExpense = Number(sum?.total ?? 0);
  }

  res.json({
    from,
    to,
    plates,
    guests,
    cells,
    byDate,
    days,
    totals,
    totalExpense,
    costPerPlate: totalExpense !== null && plates > 0 ? Math.round((totalExpense / plates) * 100) / 100 : null,
    note: account ? undefined : "No account carries the system key 'canteen_expense' yet — cost per plate is not available.",
  });
});

/** Plates month by month, newest first — the run of the year at a glance. */
canteenRouter.get("/report/monthly", view, async (req, res) => {
  const months = Math.min(Math.max(Number(req.query.months) || 12, 1), 36);
  const to = istToday();
  const start = new Date(Date.UTC(Number(to.slice(0, 4)), Number(to.slice(5, 7)) - months, 1)).toISOString().slice(0, 10);
  const rows = await db
    .select({ month: sql<string>`to_char(${canteenServings.mealDate}, 'YYYY-MM')`, meal: canteenServings.meal, plates: sql<number>`count(*)::int` })
    .from(canteenServings)
    .where(and(gte(canteenServings.mealDate, start), lte(canteenServings.mealDate, to)))
    .groupBy(sql`1`, canteenServings.meal);
  const byMonth = new Map<string, { month: string; breakfast: number; lunch: number; dinner: number; total: number }>();
  for (const r of rows) {
    const m = byMonth.get(r.month) ?? { month: r.month, breakfast: 0, lunch: 0, dinner: 0, total: 0 };
    m[r.meal] += r.plates;
    m.total += r.plates;
    byMonth.set(r.month, m);
  }
  res.json({ from: start, to, months: [...byMonth.values()].sort((a, b) => (a.month < b.month ? 1 : -1)) });
});

/* ── The browser Canteen Gate ──────────────────────────────────────────── */

/**
 * Everybody active, with what the gate needs to recognise them and nothing
 * else: descriptors (enrolment plus what the attendance gate has taught
 * itself), and whether they are on the list for breakfast and dinner. People
 * with no face are included — they can still be served by name.
 */
canteenRouter.get("/gate/roster", serve, async (_req, res) => {
  const people = await db
    .select({
      id: employees.id,
      empCode: employees.empCode,
      name: employees.name,
      payType: employees.payType,
      faceDescriptor: employees.faceDescriptor,
      breakfast: sql<boolean>`coalesce(${canteenMealEligibility.breakfast}, false) OR coalesce(${canteenMealEligibility.breakfastAuto}, false)`,
      dinner: sql<boolean>`coalesce(${canteenMealEligibility.dinner}, false)`,
    })
    .from(employees)
    .leftJoin(canteenMealEligibility, eq(canteenMealEligibility.employeeId, employees.id))
    .where(eq(employees.isActive, true))
    .orderBy(asc(employees.empCode));
  const taught = await taughtCapturesByEmployee(db, people.filter((p) => p.faceDescriptor).map((p) => p.id));
  res.json(
    people.map(({ faceDescriptor, ...p }) => ({
      ...p,
      descriptors: faceDescriptor ? [roundEmbedding(faceDescriptor as number[]), ...(taught.get(p.id) ?? [])] : [],
    })),
  );
});

/** Which meal the server says it is, and who has already had it. */
canteenRouter.get("/gate/state", serve, async (req, res) => {
  const canteenId = typeof req.query.canteenId === "string" ? req.query.canteenId : "";
  if (!canteenId) return res.status(400).json({ error: "canteenId is required" });
  const windows = await mealWindowsFor(db, canteenId);
  const now = mealForTime(istTimeHHMM(), windows);
  const served = await db
    .select({ employeeId: canteenServings.employeeId, servedAt: canteenServings.servedAt, personName: canteenServings.personName, state: canteenServings.state, tokenNumber: canteenServings.tokenNumber })
    .from(canteenServings)
    .where(and(eq(canteenServings.canteenId, canteenId), eq(canteenServings.mealDate, istToday()), eq(canteenServings.meal, now.meal)))
    .orderBy(desc(canteenServings.servedAt));
  res.json({ meal: now.meal, mealLabel: MEAL_LABEL[now.meal], outsideWindow: now.outsideWindow, windows, served });
});

/** The canteens a counter can be set to — the gate's own list, so it needs no `payroll.view`. */
canteenRouter.get("/gate/canteens", serve, async (_req, res) => {
  res.json(await db.select({ id: canteens.id, code: canteens.code, name: canteens.name }).from(canteens).where(eq(canteens.isActive, true)).orderBy(asc(canteens.name)));
});

const gateServing = z.object({
  clientId: z.string().uuid(),
  canteenId: z.string().uuid(),
  employeeId: z.string().uuid(),
  method: z.enum(["face", "manual"]),
  matchScore: z.number().min(0).max(1).nullish(),
  latitude: z.number().nullish(),
  longitude: z.number().nullish(),
  accuracyM: z.number().nullish(),
});

canteenRouter.post("/gate/servings", serve, validateBody(gateServing), async (req, res) => {
  try {
    const { serving, replay } = await db.transaction((tx) => recordBrowserServing(tx, req.session.user!.id, req.body as z.infer<typeof gateServing>));
    res.status(replay ? 200 : 201).json({ ...serving, mealLabel: MEAL_LABEL[serving.meal] });
  } catch (err) {
    if (err instanceof DuplicatePlate) {
      return res.status(409).json({ error: `Already served ${MEAL_LABEL[err.meal].toLowerCase()} today`, duplicate: true, servedAt: err.servedAt, tokenNumber: err.tokenNumber });
    }
    if (err instanceof PostingError) return res.status(422).json({ error: err.message });
    throw err;
  }
});
