/**
 * The canteen's rules, where a script can reach them: who counts as present,
 * how a plate served at the browser gate is recorded, and who gets breakfast
 * for having worked the night.
 *
 * The browser Canteen Gate is the only thing that records plates now. It has no
 * device behind it — `device_id` is null and `served_by` names whoever was
 * logged in — and it never says which meal it is: the server reads the clock.
 */
import { randomBytes } from "node:crypto";
import { and, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";
import {
  canteenMealEligibility,
  canteenMealWindows,
  canteenServings,
  canteens,
  employees,
  punches,
  shiftAssignments,
  shifts,
} from "@shared/schema";
import { DEFAULT_MEAL_WINDOWS, MEALS, istTimeHHMM, mealForTime, type Meal, type MealWindow } from "@shared/canteen";
import type { Db, Tx } from "../db";
import { PostingError } from "./posting";
import { acceptCentred } from "./face-model";
import { carryOverIn, isOvernightShift, istDate } from "./day-resolution";

type Conn = Db | Tx;

/** Global defaults, then the canteen's own rows on top. */
export async function mealWindowsFor(conn: Conn, canteenId: string | null): Promise<MealWindow[]> {
  const rows = await conn
    .select()
    .from(canteenMealWindows)
    .where(
      and(
        eq(canteenMealWindows.isActive, true),
        canteenId ? or(isNull(canteenMealWindows.canteenId), eq(canteenMealWindows.canteenId, canteenId)) : isNull(canteenMealWindows.canteenId),
      ),
    );
  const effective = new Map<Meal, { startTime: string; endTime: string }>();
  for (const meal of MEALS) effective.set(meal, DEFAULT_MEAL_WINDOWS[meal]);
  for (const r of rows.filter((r) => r.canteenId === null)) effective.set(r.meal, { startTime: r.startTime, endTime: r.endTime });
  for (const r of rows.filter((r) => r.canteenId !== null)) effective.set(r.meal, { startTime: r.startTime, endTime: r.endTime });
  return MEALS.map((meal) => ({ meal, ...effective.get(meal)! }));
}

/**
 * Is this person at work, as far as the counter can know?
 *
 * Any punch that day — a plate is served at noon, long before the day is
 * resolved. And someone who came in last night and has not left: his punches
 * belong to yesterday, so by the date alone a night worker is "absent" at the
 * very breakfast he has earned.
 */
export async function presentForCanteen(conn: Conn, employeeId: string | null, day: string, at: Date = new Date()): Promise<boolean> {
  if (!employeeId) return false;
  const [row] = await conn
    .select({ id: punches.id })
    .from(punches)
    .where(and(eq(punches.employeeId, employeeId), eq(punches.punchDate, day)))
    .limit(1);
  if (row) return true;
  return day === istDate(at) && (await carryOverIn(conn, employeeId, at)) !== null;
}

/* ── A plate at the browser gate ───────────────────────────────────────── */

export class DuplicatePlate extends Error {
  constructor(readonly servedAt: Date, readonly tokenNumber: string, readonly meal: Meal) {
    super("Already served");
  }
}

export interface BrowserServing {
  clientId: string;
  canteenId: string;
  employeeId: string;
  method: "face" | "manual";
  matchScore?: number | null;
  latitude?: number | null;
  longitude?: number | null;
  accuracyM?: number | null;
  /** What centred matching made of the scan (services/face-model.ts); recorded, never used to decide. */
  centred?: { modelId: string; matchId: string | null; score: number; secondScore: number } | null;
}

/**
 * Record one plate. The meal comes from the clock, the name from the database,
 * and the verdicts — outside its window, not at work, not on the list — are
 * worked out here and stored, so the Exceptions tab can show them.
 *
 * Someone not on the list for breakfast or dinner is still served: the counter
 * is not the place to argue, and a hungry night worker whose shift changed
 * yesterday is a likelier story than a thief. It is marked, which Amino did
 * not do, so it can be asked about afterwards.
 */
export async function recordBrowserServing(conn: Conn, userId: string, input: BrowserServing, at: Date = new Date()) {
  // The same plate sent twice — a retry on a bad connection — is one plate.
  const [replay] = await conn.select().from(canteenServings).where(eq(canteenServings.clientId, input.clientId));
  if (replay) return { serving: replay, replay: true };

  const [canteen] = await conn.select({ id: canteens.id, isActive: canteens.isActive }).from(canteens).where(eq(canteens.id, input.canteenId));
  if (!canteen?.isActive) throw new PostingError("No such canteen");
  const [emp] = await conn
    .select({ id: employees.id, name: employees.name, isActive: employees.isActive })
    .from(employees)
    .where(eq(employees.id, input.employeeId));
  if (!emp) throw new PostingError("No such employee");
  if (!emp.isActive) throw new PostingError("This employee is inactive");

  const mealDate = istDate(at);
  const { meal, outsideWindow } = mealForTime(istTimeHHMM(at), await mealWindowsFor(conn, canteen.id));

  const [already] = await conn
    .select({ servedAt: canteenServings.servedAt, tokenNumber: canteenServings.tokenNumber })
    .from(canteenServings)
    .where(
      and(
        eq(canteenServings.canteenId, canteen.id),
        eq(canteenServings.mealDate, mealDate),
        eq(canteenServings.meal, meal),
        eq(canteenServings.employeeId, emp.id),
        isNull(canteenServings.authorisedBy),
      ),
    );
  if (already) throw new DuplicatePlate(already.servedAt, already.tokenNumber, meal);

  let ineligible = false;
  if (meal !== "lunch") {
    const [e] = await conn.select().from(canteenMealEligibility).where(eq(canteenMealEligibility.employeeId, emp.id));
    ineligible = meal === "breakfast" ? !(e?.breakfast || e?.breakfastAuto) : !e?.dinner;
  }

  const [serving] = await conn
    .insert(canteenServings)
    .values({
      clientId: input.clientId,
      deviceId: null,
      servedBy: userId,
      canteenId: canteen.id,
      mealDate,
      meal,
      employeeId: emp.id,
      personName: emp.name,
      state: input.method === "face" ? "verified" : "name_matched",
      matchScore: input.method === "face" ? (input.matchScore ?? null) : null,
      ...(input.method === "face" ? await acceptCentred(conn, input.centred) : {}),
      servedAt: at,
      tokenNumber: `WEB-${randomBytes(3).toString("hex").toUpperCase()}`,
      outsideWindow,
      ineligible,
      latitude: input.latitude ?? null,
      longitude: input.longitude ?? null,
      accuracyM: input.accuracyM ?? null,
      attendancePresent: await presentForCanteen(conn, emp.id, mealDate, at),
      reconciledAt: at,
    })
    .returning();
  return { serving: serving!, replay: false };
}

/* ── Breakfast for the night shift ─────────────────────────────────────── */

/**
 * Whoever is on an overnight shift today gets breakfast; whoever is not, does
 * not get it on that account. Only `breakfast_auto` is touched — HR's own
 * breakfast, dinner and note are never read and never written here.
 *
 * Amino decided this at the moment an assignment was saved, so a future-dated
 * assignment granted nothing and one that later expired never took the grant
 * back. This is a statement about TODAY, and it is simply re-asked: when an
 * assignment changes, when a shift's hours change, and once a day.
 */
export async function syncNightShiftBreakfast(conn: Conn, employeeIds?: string[], today: string = istDate()): Promise<{ granted: number; withdrawn: number }> {
  const onNights = await conn
    .selectDistinct({ employeeId: shiftAssignments.employeeId, startTime: shifts.startTime, endTime: shifts.endTime })
    .from(shiftAssignments)
    .innerJoin(shifts, eq(shifts.id, shiftAssignments.shiftId))
    .innerJoin(employees, eq(employees.id, shiftAssignments.employeeId))
    .where(
      and(
        eq(employees.isActive, true),
        lte(shiftAssignments.effectiveFrom, today),
        or(isNull(shiftAssignments.effectiveTo), gte(shiftAssignments.effectiveTo, today)),
        employeeIds?.length ? inArray(shiftAssignments.employeeId, employeeIds) : undefined,
      ),
    );
  const should = new Set(onNights.filter(isOvernightShift).map((r) => r.employeeId));

  const has = await conn
    .select({ employeeId: canteenMealEligibility.employeeId })
    .from(canteenMealEligibility)
    .where(and(eq(canteenMealEligibility.breakfastAuto, true), employeeIds?.length ? inArray(canteenMealEligibility.employeeId, employeeIds) : undefined));
  const had = new Set(has.map((r) => r.employeeId));

  const grant = [...should].filter((id) => !had.has(id));
  const withdraw = [...had].filter((id) => !should.has(id));
  const now = new Date();
  for (const employeeId of grant) {
    await conn
      .insert(canteenMealEligibility)
      .values({ employeeId, breakfastAuto: true, updatedAt: now })
      .onConflictDoUpdate({ target: canteenMealEligibility.employeeId, set: { breakfastAuto: true, updatedAt: now } });
  }
  if (withdraw.length) {
    await conn.update(canteenMealEligibility).set({ breakfastAuto: false, updatedAt: now }).where(inArray(canteenMealEligibility.employeeId, withdraw));
  }
  // The gate's roster pulls by employees.updated_at; a changed flag must move it.
  const touched = [...grant, ...withdraw];
  if (touched.length) await conn.update(employees).set({ updatedAt: now }).where(inArray(employees.id, touched));
  return { granted: grant.length, withdrawn: withdraw.length };
}

