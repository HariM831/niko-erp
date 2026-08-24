/**
 * Field devices — the server half of the unified Android app (Amino's
 * UNIFIED-00-CONTRACT). One phone app serves as a gate (punches) or a
 * canteen counter (plates); its role is fixed at pairing and carried by its
 * bearer token. The wire shapes are Amino's, byte for byte where it matters,
 * so the app in the field needs no update: `siteCode` is answered from
 * `locations.code`, `personKind` from `employees.pay_type`.
 *
 * Two halves live in one router because they share the tables:
 *
 *   - bearer-token endpoints (`requireDeviceToken`) — info, config, pulls,
 *     photo, events, enroll; plus the two UNauthenticated pairing calls a
 *     phone makes before it has a token (`/pair/claim`, `/pair/:pendingId`).
 *   - session endpoints (`/devices`, `/pair/codes`, `/pair/requests`,
 *     `/pins`, `/reason-codes`) — each carries its own
 *     `requirePermission("payroll", ...)`, because this router is mounted
 *     BEFORE the global `requireAuth` gate and nothing else guards them.
 *
 * The logic sits in exported functions that take a connection, so
 * scripts/check-device.ts can drive them inside a rolled-back transaction
 * without HTTP.
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import crypto from "node:crypto";
import sharp from "sharp";
import { and, asc, desc, eq, gt, gte, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  canteenMealEligibility,
  canteenMealWindows,
  canteenServings,
  canteens,
  deviceRequests,
  devices,
  employees,
  locations,
  pairingCodes,
  payrollSettings,
  punches,
  reasonCodes,
  staffPins,
  wageRoles,
} from "@shared/schema";
import {
  DEFAULT_MEAL_WINDOWS,
  MAX_EVENTS_PER_REQUEST,
  MEALS,
  PHOTO_RETENTION_DAYS,
  SERVING_STATES,
  SUPERVISED_STATES,
  type Meal,
} from "@shared/canteen";
import { db, type Db, type Tx } from "../db";
import { istDate, recomputeEmployeeDay } from "../services/day-resolution";
import { requirePermission } from "../lib/rbac";
import { validateBody } from "../lib/validate";
import { checkAttendancePresent } from "./canteen";

type Conn = Db | Tx;
type DeviceRow = typeof devices.$inferSelect;
type DeviceWithSite = DeviceRow & { siteCode: string };

/* ── IST ───────────────────────────────────────────────────────────────── */
const istDateOf = istDate;

/** Rebuild attendance_days for every (employee, day) a punch batch touched. */
async function recomputeDays(conn: Conn, days: Set<string>) {
  for (const key of days) {
    const [employeeId, day] = key.split("|") as [string, string];
    try {
      await recomputeEmployeeDay(conn, employeeId, day);
    } catch (err) {
      console.error(`[device] recompute failed for ${key}:`, err);
    }
  }
}

/* ── Pure helpers ──────────────────────────────────────────────────────── */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I — read aloud over a phone
const PAIRING_CODE_LENGTH = 8;
const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;
const PENDING_REQUEST_TTL_MS = 30 * 60 * 1000;
/** Same person, same final type, from ANOTHER device within this → duplicate. */
export const DUPLICATE_WINDOW_MS = 120_000;
const DEVICE_SCHEMA_VERSION = 1;
const PEOPLE_MAX_LIMIT = 500;

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** sha256(salt || pin) — what the phone recomputes offline. */
export function hashPin(saltHex: string, pin: string): string {
  return crypto
    .createHash("sha256")
    .update(Buffer.concat([Buffer.from(saltHex, "hex"), Buffer.from(pin, "utf8")]))
    .digest("hex");
}

export function newToken(): string {
  return crypto.randomBytes(24).toString("hex");
}

export function generatePairingCode(): string {
  let code = "";
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) code += PAIRING_CODE_ALPHABET[crypto.randomInt(PAIRING_CODE_ALPHABET.length)];
  return code;
}

export function normalizePairingCode(raw: unknown): string {
  return typeof raw === "string" ? raw.replace(/[^A-Za-z0-9]/g, "").toUpperCase() : "";
}

/** Embeddings to 4 dp — a quarter of the bytes, no measurable match loss. */
function roundEmbedding(e: number[]): number[] {
  return e.map((n) => Math.round(n * 10_000) / 10_000);
}

/**
 * Cursor: base64 of {v, t: updatedAt ms, i?: last id}. Opaque to the device.
 * `i` lets a page break land inside a group of rows sharing one millisecond
 * (a bulk import stamps hundreds) without skipping or re-serving them.
 */
export function encodeCursor(maxUpdatedAtMs: number, lastId?: string | null): string {
  return Buffer.from(JSON.stringify({ v: DEVICE_SCHEMA_VERSION, t: maxUpdatedAtMs, ...(lastId ? { i: lastId } : {}) })).toString("base64");
}

export function decodeCursor(since: unknown): { t: number; id: string | null } | "missing" | "version_mismatch" {
  if (typeof since !== "string" || !since) return "missing";
  try {
    const parsed = JSON.parse(Buffer.from(since, "base64").toString("utf8"));
    if (typeof parsed?.t !== "number") return "missing";
    if (parsed?.v !== DEVICE_SCHEMA_VERSION) return "version_mismatch";
    return { t: parsed.t, id: typeof parsed?.i === "string" ? parsed.i : null };
  } catch {
    return "missing";
  }
}

const personKindOf = (payType: "salaried" | "daily_wage") => (payType === "daily_wage" ? "wage" : "payroll");

/* ── Device-token auth ─────────────────────────────────────────────────── */

export type TokenCheck =
  | { ok: true; device: DeviceWithSite }
  | { ok: false; status: 401 | 403; body: { error: string; code?: string } };

/**
 * Revoked is told apart from unknown/wrong-role on purpose: the app keys off
 * `code: "device_revoked"` to unpair itself, and keeps retrying anything else.
 */
export async function checkDeviceToken(conn: Conn, token: string, role?: "gate" | "canteen"): Promise<TokenCheck> {
  if (!token) return { ok: false, status: 401, body: { error: "Missing device token" } };
  const [row] = await conn
    .select({ device: devices, siteCode: locations.code })
    .from(devices)
    .innerJoin(locations, eq(locations.id, devices.locationId))
    .where(eq(devices.tokenHash, hashToken(token)));
  if (!row) return { ok: false, status: 401, body: { error: "Invalid device token" } };
  if (row.device.revokedAt) return { ok: false, status: 401, body: { error: "Device revoked", code: "device_revoked" } };
  if (role && row.device.role !== role) return { ok: false, status: 403, body: { error: "Wrong device role", code: "wrong_role" } };
  return { ok: true, device: { ...row.device, siteCode: row.siteCode } };
}

export function requireDeviceToken(role?: "gate" | "canteen") {
  return async (req: Request, res: Response, next: NextFunction) => {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    const check = await checkDeviceToken(db, token, role);
    if (!check.ok) return res.status(check.status).json(check.body);
    (req as any).device = check.device;
    // Fire-and-forget: a heartbeat must never slow the request it rides on.
    db.update(devices)
      .set({ lastSeenAt: new Date() })
      .where(eq(devices.id, check.device.id))
      .catch((err) => console.error("[device] lastSeenAt update failed:", err));
    next();
  };
}

const deviceOf = (req: Request) => (req as any).device as DeviceWithSite;

/* ── Config ────────────────────────────────────────────────────────────── */

export async function effectiveMealWindows(conn: Conn, canteenId: string | null) {
  const rows = await conn
    .select()
    .from(canteenMealWindows)
    .where(and(eq(canteenMealWindows.isActive, true), canteenId ? or(isNull(canteenMealWindows.canteenId), eq(canteenMealWindows.canteenId, canteenId)) : isNull(canteenMealWindows.canteenId)));
  const effective = new Map<Meal, { startTime: string; endTime: string }>();
  for (const meal of MEALS) effective.set(meal, DEFAULT_MEAL_WINDOWS[meal]);
  // Global default first, then the canteen's own row on top.
  for (const r of rows.filter((r) => r.canteenId === null)) effective.set(r.meal, { startTime: r.startTime, endTime: r.endTime });
  for (const r of rows.filter((r) => r.canteenId !== null)) effective.set(r.meal, { startTime: r.startTime, endTime: r.endTime });
  return MEALS.map((meal) => ({ meal, ...effective.get(meal)! }));
}

export async function deviceConfig(conn: Conn, device: DeviceWithSite) {
  const pinRows = await conn
    .select()
    .from(staffPins)
    .where(
      and(
        eq(staffPins.locationId, device.locationId),
        eq(staffPins.isActive, true),
        isNull(staffPins.revokedAt),
        device.canteenId ? or(isNull(staffPins.canteenId), eq(staffPins.canteenId, device.canteenId)) : isNull(staffPins.canteenId),
      ),
    );
  // A gate gets an empty list rather than an error — nothing meal-shaped to give it.
  const mealWindows = device.role === "canteen" && device.canteenId ? await effectiveMealWindows(conn, device.canteenId) : [];
  const reasonRows = await conn.select().from(reasonCodes).where(eq(reasonCodes.isActive, true)).orderBy(asc(reasonCodes.displayOrder));
  // Names only, never rates: role assignment happens at enrolment, which only a gate does.
  const wageRoleNames =
    device.role === "gate"
      ? (await conn.select({ name: wageRoles.name }).from(wageRoles).where(eq(wageRoles.isActive, true))).map((r) => r.name).sort()
      : [];
  const [settings] = await conn.select({ reviewBelowScore: payrollSettings.reviewBelowScore }).from(payrollSettings).limit(1);

  return {
    pins: pinRows.map((p) => ({ id: p.id, name: p.name, saltHex: p.saltHex, pinHash: p.pinHash, canUnlock: p.canUnlock, canAuthorise: p.canAuthorise })),
    mealWindows,
    reasonCodes: reasonRows.map((r) => ({ code: r.code, label: r.label, requiresText: r.requiresText })),
    wageRoles: wageRoleNames,
    thresholds: { reviewBelowScore: settings?.reviewBelowScore ?? 0.72 },
    // Fixed for v1 — the same numbers Amino shipped; not yet admin-tunable.
    sync: { rushWindows: [[7, 0, 10, 0], [12, 0, 14, 0], [16, 0, 18, 0]], rushIntervalMs: 10_000, idleIntervalMs: 300_000 },
    version: {
      latestVersionCode: Number(process.env.DEVICE_LATEST_VERSION_CODE) || 0,
      minVersionCode: Number(process.env.DEVICE_MIN_VERSION_CODE) || 0,
      apkUrl: process.env.DEVICE_APK_URL || null,
    },
    photoRetentionDays: PHOTO_RETENTION_DAYS,
    duplicateWindowMs: DUPLICATE_WINDOW_MS,
  };
}

/* ── Pulls ─────────────────────────────────────────────────────────────── */

/**
 * Keyset over (updatedAt, id), never offset: rows keep changing between a
 * device's pages and an offset would skip whoever shifted. Inactive people
 * come back in `deleted` so the phone drops them. A client that sends no
 * `limit` gets the whole roster in one response, as the first app did.
 */
export async function pullPeople(conn: Conn, since: unknown, rawLimit: unknown) {
  const decoded = decodeCursor(since);
  const fullResyncRequired = decoded === "version_mismatch";
  const sinceMs = typeof decoded === "object" ? decoded.t : 0;
  const sinceId = typeof decoded === "object" ? decoded.id : null;
  const sinceDate = new Date(sinceMs);
  const n = Number(rawLimit);
  const limit = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), PEOPLE_MAX_LIMIT) : null;

  const where = sinceId
    ? or(gt(employees.updatedAt, sinceDate), and(eq(employees.updatedAt, sinceDate), gt(employees.id, sinceId)))
    : gte(employees.updatedAt, sinceDate);

  // Projected — never select() — photoUrl is a base64 blob per row.
  const q = conn
    .select({
      id: employees.id,
      name: employees.name,
      empCode: employees.empCode,
      payType: employees.payType,
      faceDescriptor: employees.faceDescriptor,
      isActive: employees.isActive,
      updatedAt: employees.updatedAt,
      photoHash: employees.photoHash,
      breakfast: canteenMealEligibility.breakfast,
      dinner: canteenMealEligibility.dinner,
    })
    .from(employees)
    .leftJoin(canteenMealEligibility, eq(canteenMealEligibility.employeeId, employees.id))
    .where(where)
    .orderBy(asc(employees.updatedAt), asc(employees.id));
  const rows = limit === null ? await q : await q.limit(limit + 1); // one extra → hasMore without a count
  const page = limit === null ? rows : rows.slice(0, limit);
  const hasMore = limit !== null && rows.length > page.length;

  let newestMs = sinceMs;
  let lastId: string | null = null;
  const people: unknown[] = [];
  const deleted: string[] = [];
  for (const row of page) {
    newestMs = row.updatedAt.getTime();
    lastId = row.id;
    if (!row.isActive) {
      deleted.push(row.id);
      continue;
    }
    people.push({
      id: row.id,
      kind: personKindOf(row.payType),
      name: row.name,
      empCode: row.empCode,
      descriptor: Array.isArray(row.faceDescriptor) ? roundEmbedding(row.faceDescriptor) : null,
      recentEmbeddings: [] as number[][],
      photoHash: row.photoHash,
      eligibility: { breakfast: row.breakfast ?? false, lunch: true, dinner: row.dinner ?? false },
      isActive: true,
      updatedAt: row.updatedAt.getTime(),
    });
  }

  let totalPending: number | undefined;
  if (limit !== null) {
    const [c] = await conn.select({ n: sql<number>`count(*)::int` }).from(employees).where(where);
    totalPending = c?.n ?? 0;
  }
  // A full resync is only "caught up" once the LAST page is out; jumping the
  // cursor to now() earlier would strand everyone past page one.
  const finished = fullResyncRequired && !hasMore;
  const cursor = encodeCursor(finished ? Date.now() : newestMs, finished ? null : (lastId ?? sinceId));
  return { cursor, next: cursor, fullResyncRequired, people, deleted, ...(limit !== null ? { hasMore, totalPending } : {}) };
}

/** Last punch per person and plates served, for the date asked (IST today by default). */
export async function pullState(conn: Conn, since: unknown, date?: unknown) {
  const decoded = decodeCursor(since);
  const sinceMs = typeof decoded === "object" ? decoded.t : 0;
  const today = typeof date === "string" && DATE_RE.test(date) ? date : istDateOf();

  const [punchRows, servingRows] = await Promise.all([
    conn.select({ employeeId: punches.employeeId, type: punches.type, punchedAt: punches.punchedAt }).from(punches).where(eq(punches.punchDate, today)),
    conn.select({ employeeId: canteenServings.employeeId, meal: canteenServings.meal, servedAt: canteenServings.servedAt }).from(canteenServings).where(eq(canteenServings.mealDate, today)),
  ]);

  const last = new Map<string, { type: string; ts: number }>();
  for (const p of [...punchRows].sort((a, b) => b.punchedAt.getTime() - a.punchedAt.getTime())) {
    if (!last.has(p.employeeId)) last.set(p.employeeId, { type: p.type, ts: p.punchedAt.getTime() });
  }
  const served = new Map<string, Set<string>>();
  for (const s of servingRows) {
    if (!s.employeeId) continue;
    (served.get(s.employeeId) ?? served.set(s.employeeId, new Set()).get(s.employeeId)!).add(s.meal);
  }

  const changedIds = new Set<string>();
  let newestMs = sinceMs;
  for (const p of punchRows) {
    const t = p.punchedAt.getTime();
    if (t >= sinceMs) { changedIds.add(p.employeeId); newestMs = Math.max(newestMs, t); }
  }
  for (const s of servingRows) {
    if (!s.employeeId) continue;
    const t = s.servedAt.getTime();
    if (t >= sinceMs) { changedIds.add(s.employeeId); newestMs = Math.max(newestMs, t); }
  }
  const changed = [...changedIds].map((id) => {
    const lp = last.get(id) ?? null;
    return { id, lastPunch: lp, presentToday: !!lp, servedToday: [...(served.get(id) ?? [])] };
  });
  return { cursor: encodeCursor(newestMs), date: today, changed };
}

/* ── Events ────────────────────────────────────────────────────────────── */

export type EventResult = {
  accepted: string[];
  corrected: { id: string; field: string; from: string; to: string }[];
  duplicates: { id: string; reason: string }[];
  rejected: { id: string; reason: string }[];
};

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Apply a batch from one device. Each event is judged on its own; a bad one
 * lands in `rejected` and the rest still go in — the phone only retries
 * what it was not told about. The device's event id is the idempotency key
 * (`client_id`), so a replayed batch is reported as duplicates, not written.
 *
 * Gate: the type is corrected to alternate with the previous punch of the
 * day (two INs in a row is a phone that missed a sync, not a person who
 * entered twice). Canteen: an `unverified_attendance` plate is checked
 * against the day's punches and promoted to `verified` if the person was
 * in; never to override — only a supervisor does that.
 */
export async function applyEvents(conn: Conn, device: DeviceWithSite, rawEvents: unknown): Promise<EventResult> {
  const events = Array.isArray(rawEvents) ? (rawEvents as any[]) : [];
  const out: EventResult = { accepted: [], corrected: [], duplicates: [], rejected: [] };
  const ordered = [...events].sort((a, b) => (num(a?.ts) ?? 0) - (num(b?.ts) ?? 0));

  const [settings] = await conn.select({ reviewBelowScore: payrollSettings.reviewBelowScore }).from(payrollSettings).limit(1);
  const reviewBelow = settings?.reviewBelowScore ?? 0.72;

  // The day's punches per person, loaded once and extended as the batch lands,
  // so the alternation rule sees the batch's own earlier events.
  const dayCache = new Map<string, { clientId: string | null; type: "in" | "out"; at: number }[]>();
  const dayPunches = async (employeeId: string, day: string) => {
    const key = `${employeeId}|${day}`;
    let list = dayCache.get(key);
    if (!list) {
      const rows = await conn
        .select({ clientId: punches.clientId, type: punches.type, punchedAt: punches.punchedAt })
        .from(punches)
        .where(and(eq(punches.employeeId, employeeId), eq(punches.punchDate, day)));
      list = rows.map((r) => ({ clientId: r.clientId, type: r.type, at: r.punchedAt.getTime() }));
      dayCache.set(key, list);
    }
    return list;
  };
  const touched = new Set<string>();

  for (const evt of ordered) {
    const id = typeof evt?.id === "string" ? evt.id.slice(0, 64) : null;
    if (!id) continue; // nothing to report against
    // Amino's wire says `type: in|out|meal`; the plan's summary says `kind` and
    // `plate`. Take either so neither generation of the app is turned away.
    const type = evt.type ?? evt.kind;
    const lat = num(evt.latitude ?? evt.lat);
    const lng = num(evt.longitude ?? evt.lng);
    const acc = num(evt.accuracy ?? evt.accuracyM);
    try {
      if (type === "in" || type === "out") {
        if (device.role !== "gate") { out.rejected.push({ id, reason: "Only a gate device may write attendance punches" }); continue; }
        if (evt.personKind !== "payroll" && evt.personKind !== "wage") { out.rejected.push({ id, reason: "personKind must be payroll or wage for in/out" }); continue; }
        const ts = num(evt.ts);
        if (typeof evt.personId !== "string" || ts === null) { out.rejected.push({ id, reason: "Missing or malformed required field(s)" }); continue; }
        const punchedAt = new Date(ts);
        const day = typeof evt.date === "string" && DATE_RE.test(evt.date) ? evt.date : istDateOf(punchedAt);

        const [emp] = await conn.select({ id: employees.id, isActive: employees.isActive }).from(employees).where(eq(employees.id, evt.personId));
        if (!emp || !emp.isActive) { out.rejected.push({ id, reason: "Unknown or inactive employee" }); continue; }

        const [seen] = await conn.select({ id: punches.id }).from(punches).where(eq(punches.clientId, id));
        if (seen) { out.duplicates.push({ id, reason: "already synced" }); continue; }

        const day_ = await dayPunches(emp.id, day);
        let prev: { type: "in" | "out"; at: number } | null = null;
        for (const q of day_) if (q.at <= ts && (!prev || q.at > prev.at)) prev = q;
        let finalType: "in" | "out" = type;
        if (prev) {
          const expected = prev.type === "out" ? "in" : "out";
          if (finalType !== expected) {
            out.corrected.push({ id, field: "type", from: finalType, to: expected });
            finalType = expected;
          }
        }

        // Same person, same type, another device, within the window → the
        // other phone got there first.
        const lo = new Date(ts - DUPLICATE_WINDOW_MS);
        const hi = new Date(ts + DUPLICATE_WINDOW_MS);
        const near = await conn
          .select({ deviceId: punches.deviceId })
          .from(punches)
          .where(and(eq(punches.employeeId, emp.id), eq(punches.type, finalType), gte(punches.punchedAt, lo), lte(punches.punchedAt, hi)));
        if (near.some((r) => r.deviceId && r.deviceId !== device.id)) { out.duplicates.push({ id, reason: "duplicate punch from another device" }); continue; }

        const method = evt.method === "manual" ? "manual" : "device";
        const score = num(evt.matchScore);
        const photo = typeof (evt.photo ?? evt.photoUrl) === "string" ? (evt.photo ?? evt.photoUrl) : null;
        // The photo is kept only where someone will ever look at it.
        const keepPhoto = method === "manual" || (score !== null && score < reviewBelow);
        await conn
          .insert(punches)
          .values({
            employeeId: emp.id,
            type: finalType,
            punchDate: day,
            punchedAt,
            method,
            matchScore: score,
            latitude: lat,
            longitude: lng,
            accuracyM: acc,
            locationId: device.locationId,
            photoUrl: keepPhoto ? photo : null,
            deviceId: device.id,
            clientId: id,
          })
          .onConflictDoNothing({ target: punches.clientId });
        day_.push({ clientId: id, type: finalType, at: ts });
        touched.add(`${emp.id}|${day}`);
        out.accepted.push(id);
      } else if (type === "meal" || type === "plate") {
        if (device.role !== "canteen" || !device.canteenId) { out.rejected.push({ id, reason: "Only a canteen device may write meal servings" }); continue; }
        const ts = num(evt.ts);
        const personName = typeof evt.personName === "string" ? evt.personName.trim() : "";
        const day = typeof evt.date === "string" && DATE_RE.test(evt.date) ? evt.date : ts !== null ? istDateOf(new Date(ts)) : "";
        if (!MEALS.includes(evt.meal) || !SERVING_STATES.includes(evt.state) || ts === null || !personName || !day) {
          out.rejected.push({ id, reason: "Missing or malformed required field(s)" });
          continue;
        }
        const isGuest = evt.personKind === "guest";
        if (!isGuest && typeof evt.personId !== "string") { out.rejected.push({ id, reason: "personId is required unless personKind is guest" }); continue; }
        // override and guest need a PIN + reason; only a guest also needs a
        // photo — a known person's face is already enrolled.
        if (SUPERVISED_STATES.has(evt.state) && (!evt.authorisedBy || !evt.reasonCode)) { out.rejected.push({ id, reason: "override/guest requires authorisedBy and reasonCode" }); continue; }
        if (evt.state === "guest" && !(evt.photoUrl ?? evt.photo)) { out.rejected.push({ id, reason: "guest requires photoUrl" }); continue; }
        if (evt.reasonCode === "other" && !evt.reasonText) { out.rejected.push({ id, reason: "reasonCode 'other' requires reasonText" }); continue; }

        const [seen] = await conn.select({ id: canteenServings.id }).from(canteenServings).where(eq(canteenServings.clientId, id));
        if (seen) { out.duplicates.push({ id, reason: "already synced" }); continue; }

        let employeeId: string | null = null;
        if (!isGuest) {
          const [emp] = await conn.select({ id: employees.id }).from(employees).where(eq(employees.id, evt.personId));
          if (!emp) { out.rejected.push({ id, reason: "Unknown employee" }); continue; }
          employeeId = emp.id;
        }
        // authorisedBy is a staff_pins id; an unknown one is a phone with a
        // stale PIN list — refuse rather than insert a dangling reference.
        let authorisedBy: string | null = null;
        if (typeof evt.authorisedBy === "string" && evt.authorisedBy) {
          const [pin] = await conn.select({ id: staffPins.id }).from(staffPins).where(eq(staffPins.id, evt.authorisedBy));
          if (!pin) { out.rejected.push({ id, reason: "authorisedBy is not a known PIN" }); continue; }
          authorisedBy = pin.id;
        }

        // Reconcile every employee plate against the day's punches — the
        // column the exceptions review keys on. Only an unverified plate is
        // promoted on the strength of it.
        let state: (typeof SERVING_STATES)[number] = evt.state;
        let attendancePresent: boolean | null = null;
        if (employeeId) {
          attendancePresent = await checkAttendancePresent(conn, employeeId, day);
          if (state === "unverified_attendance" && attendancePresent) state = "verified";
        }

        // One plate per person per meal unless somebody authorised this one.
        // Checked before the insert rather than caught after: inside a
        // transaction a unique violation would poison everything after it.
        if (employeeId && !authorisedBy) {
          const [already] = await conn
            .select({ id: canteenServings.id })
            .from(canteenServings)
            .where(and(eq(canteenServings.canteenId, device.canteenId), eq(canteenServings.mealDate, day), eq(canteenServings.meal, evt.meal), eq(canteenServings.employeeId, employeeId), isNull(canteenServings.authorisedBy)));
          if (already) { out.duplicates.push({ id, reason: "already served this meal today" }); continue; }
        }

        try {
          await conn.insert(canteenServings).values({
            clientId: id,
            deviceId: device.id,
            canteenId: device.canteenId,
            mealDate: day,
            meal: evt.meal,
            employeeId,
            personName,
            state,
            matchScore: num(evt.matchScore),
            servedAt: new Date(ts),
            tokenNumber: typeof evt.tokenNumber === "string" ? evt.tokenNumber.slice(0, 20) : "",
            outsideWindow: !!evt.outsideWindow,
            extraPlateKind: ["guest", "second_plate", "override"].includes(evt.extraPlateKind) ? evt.extraPlateKind : isGuest ? "guest" : null,
            guestBatchId: typeof evt.guestBatchId === "string" ? evt.guestBatchId.slice(0, 64) : null,
            guestParty: typeof evt.guestParty === "string" ? evt.guestParty : null,
            reasonCode: typeof evt.reasonCode === "string" ? evt.reasonCode.slice(0, 40) : null,
            reasonText: typeof evt.reasonText === "string" ? evt.reasonText : null,
            authorisedBy,
            photoUrl: typeof (evt.photoUrl ?? evt.photo) === "string" ? (evt.photoUrl ?? evt.photo) : null,
            latitude: lat,
            longitude: lng,
            accuracyM: acc,
            attendancePresent,
            reconciledAt: employeeId ? new Date() : null,
          });
          out.accepted.push(id);
        } catch (e: any) {
          // uq_serving_person_meal raced past the check above (two phones).
          if (e?.code === "23505") out.duplicates.push({ id, reason: "already served this meal today" });
          else throw e;
        }
      } else {
        out.rejected.push({ id, reason: `Unknown event type: ${type}` });
      }
    } catch (e) {
      console.error("[device] event apply failed:", e);
      out.rejected.push({ id, reason: "Server error processing this event" });
    }
  }

  await recomputeDays(conn, touched);
  return out;
}

/* ── Enrol ─────────────────────────────────────────────────────────────── */

const enrollOne = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(120),
  empCode: z.string().trim().max(20).optional(),
  kind: z.enum(["payroll", "wage"]).default("wage"),
  photo: z.string().optional(),
  photoDataUrl: z.string().optional(),
  descriptor: z.array(z.number()).optional(),
  faceDescriptor: z.array(z.number()).optional(),
  roleName: z.string().trim().max(80).optional(),
  role: z.string().trim().max(80).optional(),
  contactNumber: z.string().trim().max(20).optional(),
  aadharNumber: z.string().trim().max(12).optional(),
  isActive: z.boolean().optional(),
});
type EnrollInput = z.infer<typeof enrollOne>;

async function nextEmpCode(conn: Conn, prefix: "W" | "E"): Promise<string> {
  const [r] = await conn
    .select({ n: sql<number>`coalesce(max(substring(emp_code from '^${sql.raw(prefix)}-(\\d+)$')::int), 0)` })
    .from(employees)
    .where(sql`emp_code ~ ${`^${prefix}-\\d+$`}`);
  return `${prefix}-${String((r?.n ?? 0) + 1).padStart(4, "0")}`;
}

/**
 * A person enrolled on the phone becomes an employees row: daily-wage by
 * default (that is who gets enrolled at a gate), salaried when the phone
 * says so. Idempotent on the phone's own id so a re-sent batch updates.
 */
export async function enrollPerson(conn: Conn, device: DeviceWithSite, input: EnrollInput) {
  const payType = input.kind === "payroll" ? "salaried" : "daily_wage";
  const photo = input.photo ?? input.photoDataUrl ?? null;
  const descriptor = input.descriptor ?? input.faceDescriptor ?? null;
  const roleName = input.roleName ?? input.role;
  let wageRoleId: string | null = null;
  if (payType === "daily_wage" && roleName) {
    const [role] = await conn.select({ id: wageRoles.id }).from(wageRoles).where(eq(wageRoles.name, roleName));
    wageRoleId = role?.id ?? null;
  }
  const now = new Date();
  const common = {
    name: input.name,
    payType,
    wageRoleId,
    locationId: device.locationId,
    contactNumber: input.contactNumber ?? null,
    aadharNumber: input.aadharNumber ?? null,
    photoUrl: photo,
    photoHash: photo ? hashToken(photo) : null,
    faceDescriptor: descriptor,
    faceEnrolledAt: descriptor ? now : null,
    isActive: input.isActive !== false,
    updatedAt: now,
  } as const;

  if (input.id) {
    const [existing] = await conn.select({ id: employees.id }).from(employees).where(eq(employees.id, input.id));
    if (existing) {
      const [row] = await conn.update(employees).set(common).where(eq(employees.id, input.id)).returning({ id: employees.id, empCode: employees.empCode });
      return row!;
    }
  }
  const empCode = input.empCode || (await nextEmpCode(conn, payType === "daily_wage" ? "W" : "E"));
  const [row] = await conn
    .insert(employees)
    .values({ ...(input.id ? { id: input.id } : {}), empCode, dateOfJoining: istDateOf(), ...common })
    .returning({ id: employees.id, empCode: employees.empCode });
  return row!;
}

/* ── Pairing ───────────────────────────────────────────────────────────── */

type ClaimInput = { code: unknown; installId?: unknown; deviceModel?: unknown; osVersion?: unknown; appVersionCode?: unknown; lat?: unknown; lng?: unknown };

async function issueDevice(conn: Conn, pairing: typeof pairingCodes.$inferSelect, meta: { installId: string | null; deviceModel: string | null; appVersionCode: number | null }) {
  const rawToken = newToken();
  let row: { id: string; name: string } | undefined;
  if (pairing.targetDeviceId) {
    // Re-pairing an existing device: same row, new token, un-revoked.
    [row] = await conn
      .update(devices)
      .set({ tokenHash: hashToken(rawToken), revokedAt: null, ...meta })
      .where(eq(devices.id, pairing.targetDeviceId))
      .returning({ id: devices.id, name: devices.name });
  } else {
    [row] = await conn
      .insert(devices)
      .values({ name: pairing.deviceName, role: pairing.role, locationId: pairing.locationId, canteenId: pairing.canteenId, tokenHash: hashToken(rawToken), ...meta })
      .returning({ id: devices.id, name: devices.name });
  }
  if (!row) return null;
  await conn.update(pairingCodes).set({ status: "claimed", usedAt: new Date() }).where(eq(pairingCodes.id, pairing.id));
  return { rawToken, row };
}

async function siteCodeOf(conn: Conn, locationId: string) {
  const [l] = await conn.select({ code: locations.code }).from(locations).where(eq(locations.id, locationId));
  return l?.code ?? "";
}

/**
 * A code auto-approves when it re-pairs a known device or when no live
 * device already holds that role at the site; otherwise the claim waits for
 * an admin. A phone that was refused in the last hour always waits.
 */
export async function claimPairing(conn: Conn, body: ClaimInput) {
  const code = normalizePairingCode(body.code);
  const installId = typeof body.installId === "string" ? body.installId.slice(0, 200) : null;
  const deviceModel = typeof body.deviceModel === "string" ? body.deviceModel.slice(0, 200) : null;
  const osVersion = typeof body.osVersion === "string" ? body.osVersion.slice(0, 100) : null;
  const appVersionCode = num(body.appVersionCode);
  if (!installId || code.length !== PAIRING_CODE_LENGTH) return { status: "invalid" as const };

  const [pairing] = await conn.select().from(pairingCodes).where(eq(pairingCodes.codeHash, hashToken(code)));
  if (!pairing || pairing.status !== "unused" || pairing.expiresAt.getTime() < Date.now()) return { status: "invalid" as const };

  const [active] = await conn
    .select({ id: devices.id })
    .from(devices)
    .where(and(eq(devices.role, pairing.role), eq(devices.locationId, pairing.locationId), isNull(devices.revokedAt), pairing.canteenId ? eq(devices.canteenId, pairing.canteenId) : isNull(devices.canteenId)));
  const [recent] = await conn
    .select({ id: deviceRequests.id })
    .from(deviceRequests)
    .where(and(eq(deviceRequests.installId, installId), gte(deviceRequests.requestedAt, new Date(Date.now() - 3_600_000)), inArray(deviceRequests.status, ["pending", "rejected"])));

  const siteCode = await siteCodeOf(conn, pairing.locationId);
  if ((!!pairing.targetDeviceId || !active) && !recent) {
    const issued = await issueDevice(conn, pairing, { installId, deviceModel, appVersionCode });
    if (!issued) return { status: "invalid" as const };
    return { status: "approved" as const, token: issued.rawToken, deviceId: issued.row.id, name: issued.row.name, role: pairing.role, siteCode, canteenId: pairing.canteenId };
  }

  const [request] = await conn
    .insert(deviceRequests)
    .values({ codeId: pairing.id, installId, deviceModel, osVersion, appVersionCode, latitude: num(body.lat), longitude: num(body.lng) })
    .returning({ id: deviceRequests.id });
  await conn.update(pairingCodes).set({ status: "pending" }).where(eq(pairingCodes.id, pairing.id));
  return { status: "pending" as const, pendingId: request!.id };
}

export async function approvePairingRequest(conn: Conn, requestId: string, userId: string) {
  const [request] = await conn.select().from(deviceRequests).where(eq(deviceRequests.id, requestId));
  if (!request) return { status: 404 as const, body: { error: "Request not found" } };
  if (request.status !== "pending") return { status: 400 as const, body: { error: `Request is already ${request.status}` } };
  const [pairing] = await conn.select().from(pairingCodes).where(eq(pairingCodes.id, request.codeId));
  if (!pairing) return { status: 400 as const, body: { error: "Pairing code no longer exists" } };
  const issued = await issueDevice(conn, pairing, { installId: request.installId, deviceModel: request.deviceModel, appVersionCode: request.appVersionCode });
  if (!issued) return { status: 400 as const, body: { error: "Target device no longer exists" } };
  // The token is parked on the request for the phone's next poll to collect.
  await conn
    .update(deviceRequests)
    .set({ status: "approved", decidedBy: userId, decidedAt: new Date(), deviceId: issued.row.id, issuedToken: issued.rawToken })
    .where(eq(deviceRequests.id, request.id));
  return { status: 200 as const, body: { requestId: request.id, deviceId: issued.row.id } };
}

export async function rejectPairingRequest(conn: Conn, requestId: string, userId: string) {
  const [request] = await conn.select().from(deviceRequests).where(eq(deviceRequests.id, requestId));
  if (!request) return { status: 404 as const, body: { error: "Request not found" } };
  if (request.status !== "pending") return { status: 400 as const, body: { error: `Request is already ${request.status}` } };
  await conn.update(deviceRequests).set({ status: "rejected", decidedBy: userId, decidedAt: new Date() }).where(eq(deviceRequests.id, request.id));
  await conn.update(pairingCodes).set({ status: "rejected" }).where(eq(pairingCodes.id, request.codeId));
  return { status: 204 as const, body: null };
}

/** The phone's poll. The token is handed over exactly once, then nulled. */
export async function pollPairing(conn: Conn, pendingId: string) {
  const [request] = await conn
    .select({ request: deviceRequests, pairing: pairingCodes })
    .from(deviceRequests)
    .innerJoin(pairingCodes, eq(pairingCodes.id, deviceRequests.codeId))
    .where(eq(deviceRequests.id, pendingId));
  if (!request) return { status: "expired", reason: "Request not found" };
  const { request: r, pairing } = request;
  if (r.status === "pending" && Date.now() - r.requestedAt.getTime() > PENDING_REQUEST_TTL_MS) {
    await conn.update(deviceRequests).set({ status: "expired" }).where(eq(deviceRequests.id, r.id));
    await conn.update(pairingCodes).set({ status: "expired" }).where(eq(pairingCodes.id, r.codeId));
    return { status: "expired", reason: "Request expired" };
  }
  if (r.status === "pending") return { status: "pending" };
  if (r.status === "rejected") return { status: "rejected", reason: "Rejected by office" };
  if (r.status === "approved") {
    if (!r.issuedToken) return { status: "expired", reason: "Request expired" };
    const [dev] = r.deviceId ? await conn.select({ name: devices.name }).from(devices).where(eq(devices.id, r.deviceId)) : [];
    await conn.update(deviceRequests).set({ issuedToken: null }).where(eq(deviceRequests.id, r.id));
    return { status: "approved", token: r.issuedToken, deviceId: r.deviceId, name: dev?.name ?? "", role: pairing.role, siteCode: await siteCodeOf(conn, pairing.locationId), canteenId: pairing.canteenId };
  }
  return { status: "expired", reason: "Request expired" };
}

/* ── PINs ──────────────────────────────────────────────────────────────── */

/**
 * Every phone at a site checks a PIN against every row it holds, so two
 * people at one site cannot share a PIN. Hashes are salted per row, so each
 * candidate is recomputed with its own salt.
 */
export async function pinCollidesAtSite(conn: Conn, locationId: string, pin: string, excludeId?: string) {
  const rows = await conn.select().from(staffPins).where(and(eq(staffPins.locationId, locationId), eq(staffPins.isActive, true), isNull(staffPins.revokedAt)));
  return rows.some((r) => r.id !== excludeId && hashPin(r.saltHex, pin) === r.pinHash);
}

async function wouldZeroOutAuthorisers(conn: Conn, locationId: string, excludeId: string) {
  const rows = await conn
    .select({ id: staffPins.id })
    .from(staffPins)
    .where(and(eq(staffPins.locationId, locationId), eq(staffPins.isActive, true), eq(staffPins.canAuthorise, true), isNull(staffPins.revokedAt), ne(staffPins.id, excludeId)));
  return rows.length === 0;
}

/* ══════════════════════════════════════════════════════════════════════════
   Router
   ══════════════════════════════════════════════════════════════════════════ */

export const deviceRouter = Router();

const devicesAdmin = requirePermission("payroll", "devices");
const view = requirePermission("payroll", "view");

const isAdminPath = (p: string) => p.startsWith("/devices") || p.startsWith("/pins") || p.startsWith("/reason-codes") || p === "/pair/codes" || p.startsWith("/pair/requests");

// CORS for the bearer-token routes only: the app is not served from this
// origin. Session routes stay same-origin like every other admin route.
deviceRouter.use((req, res, next) => {
  if (isAdminPath(req.path)) return next();
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const serverError = (res: Response, what: string, err: unknown) => {
  console.error(`[device] ${what} failed:`, err);
  res.status(500).json({ error: `Failed to ${what}` });
};

/* ── Bearer-token routes ───────────────────────────────────────────────── */

deviceRouter.get("/info", requireDeviceToken(), async (req, res) => {
  try {
    const device = deviceOf(req);
    const [c] = device.canteenId ? await db.select({ name: canteens.name }).from(canteens).where(eq(canteens.id, device.canteenId)) : [];
    res.json({ deviceId: device.id, name: device.name, role: device.role, siteCode: device.siteCode, canteenId: device.canteenId, canteenName: c?.name ?? null });
  } catch (e) {
    serverError(res, "fetch device info", e);
  }
});

deviceRouter.get("/config", requireDeviceToken(), async (req, res) => {
  try {
    res.json(await deviceConfig(db, deviceOf(req)));
  } catch (e) {
    serverError(res, "fetch config", e);
  }
});

deviceRouter.get("/pull/people", requireDeviceToken(), async (req, res) => {
  try {
    res.json(await pullPeople(db, req.query.since, req.query.limit));
  } catch (e) {
    serverError(res, "fetch people", e);
  }
});

deviceRouter.get("/pull/state", requireDeviceToken(), async (req, res) => {
  try {
    res.json(await pullState(db, req.query.since, req.query.date));
  } catch (e) {
    serverError(res, "fetch state", e);
  }
});

deviceRouter.get("/photo/:personId", requireDeviceToken(), async (req, res) => {
  try {
    const [emp] = await db.select({ photoUrl: employees.photoUrl }).from(employees).where(eq(employees.id, req.params.personId!));
    const m = emp?.photoUrl ? /^data:image\/\w+;base64,(.+)$/.exec(emp.photoUrl) : null;
    if (!m) return res.status(404).json({ error: "No photo for this person" });
    const thumb = await sharp(Buffer.from(m[1]!, "base64")).resize(96, 96, { fit: "cover" }).jpeg({ quality: 80 }).toBuffer();
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(thumb);
  } catch (e) {
    serverError(res, "fetch photo", e);
  }
});

deviceRouter.post("/events", requireDeviceToken(), async (req, res) => {
  try {
    const events = Array.isArray(req.body?.events) ? req.body.events : [];
    if (events.length > MAX_EVENTS_PER_REQUEST) return res.status(400).json({ error: `Batch too large — max ${MAX_EVENTS_PER_REQUEST} events per request` });
    const device = deviceOf(req);
    // One transaction per event, not per batch: a rejected plate must not
    // take its accepted neighbours down with it.
    const result: EventResult = { accepted: [], corrected: [], duplicates: [], rejected: [] };
    for (const evt of events) {
      const r = await db.transaction((tx) => applyEvents(tx, device, [evt]));
      result.accepted.push(...r.accepted);
      result.corrected.push(...r.corrected);
      result.duplicates.push(...r.duplicates);
      result.rejected.push(...r.rejected);
    }
    // Amino reports `accepted` as a count; the ids are in the per-event lists.
    res.json({ accepted: result.accepted.length, acceptedIds: result.accepted, corrected: result.corrected, duplicates: result.duplicates, rejected: result.rejected });
  } catch (e) {
    serverError(res, "sync events", e);
  }
});

deviceRouter.post("/enroll", requireDeviceToken("gate"), async (req, res) => {
  try {
    const device = deviceOf(req);
    // Amino's app sends `{ workers: [...] }`; the plan's single-person shape
    // is the same fields at the top level. Both land in employees.
    const batch = Array.isArray(req.body?.workers) ? req.body.workers : null;
    if (batch) {
      if (batch.length > 200) return res.status(400).json({ error: "Batch too large — max 200 workers per request" });
      let synced = 0;
      for (const w of batch) {
        const parsed = enrollOne.safeParse(w);
        if (!parsed.success) continue;
        await db.transaction((tx) => enrollPerson(tx, device, parsed.data));
        synced++;
      }
      return res.json({ synced });
    }
    const parsed = enrollOne.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Validation failed", issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    const row = await db.transaction((tx) => enrollPerson(tx, device, parsed.data));
    res.status(201).json(row);
  } catch (e) {
    serverError(res, "enrol", e);
  }
});

/* ── Pairing: phone side (no auth by design — the code IS the credential) ─ */

deviceRouter.post("/pair/claim", async (req, res) => {
  try {
    res.json(await db.transaction((tx) => claimPairing(tx, req.body ?? {})));
  } catch (e) {
    serverError(res, "pair", e);
  }
});

/* ── Pairing: admin side ───────────────────────────────────────────────── */

const pairCodeBody = z.object({
  deviceName: z.string().trim().max(80).optional(),
  role: z.enum(["gate", "canteen"]),
  locationId: z.string().uuid().optional(),
  siteCode: z.string().trim().max(12).optional(),
  canteenId: z.string().uuid().nullish(),
  targetDeviceId: z.string().uuid().optional(),
});

deviceRouter.post("/pair/codes", devicesAdmin, validateBody(pairCodeBody), async (req, res) => {
  try {
    const b = req.body as z.infer<typeof pairCodeBody>;
    let locationId = b.locationId ?? null;
    if (!locationId && b.siteCode) {
      const [l] = await db.select({ id: locations.id }).from(locations).where(eq(locations.code, b.siteCode));
      locationId = l?.id ?? null;
    }
    if (!locationId) return res.status(400).json({ error: "locationId (or a known siteCode) is required" });
    if (b.role === "canteen" && !b.canteenId) return res.status(400).json({ error: "canteenId is required for role 'canteen'" });
    let deviceName = b.deviceName ?? "";
    if (b.targetDeviceId) {
      const [d] = await db.select({ name: devices.name }).from(devices).where(eq(devices.id, b.targetDeviceId));
      if (!d) return res.status(400).json({ error: "Unknown device" });
      deviceName = d.name;
    } else if (!deviceName) {
      return res.status(400).json({ error: "deviceName is required" });
    }
    const code = generatePairingCode();
    const [row] = await db
      .insert(pairingCodes)
      .values({
        codeHash: hashToken(code),
        codeLast4: code.slice(-4),
        deviceName,
        role: b.role,
        locationId,
        canteenId: b.canteenId ?? null,
        targetDeviceId: b.targetDeviceId ?? null,
        createdBy: req.session.user!.id,
        expiresAt: new Date(Date.now() + PAIRING_CODE_TTL_MS),
      })
      .returning({ id: pairingCodes.id, expiresAt: pairingCodes.expiresAt });
    // The clear code is shown once, here; only its hash and last4 are stored.
    res.status(201).json({ id: row!.id, code, last4: code.slice(-4), codeLast4: code.slice(-4), expiresAt: row!.expiresAt, mode: b.targetDeviceId ? "replace" : "new", deviceName, role: b.role, locationId, canteenId: b.canteenId ?? null });
  } catch (e) {
    serverError(res, "create pairing code", e);
  }
});

deviceRouter.get("/pair/requests", view, async (req, res) => {
  try {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const rows = await db
      .select({
        id: deviceRequests.id,
        codeId: deviceRequests.codeId,
        role: pairingCodes.role,
        locationId: pairingCodes.locationId,
        siteCode: locations.code,
        canteenId: pairingCodes.canteenId,
        deviceName: pairingCodes.deviceName,
        targetDeviceId: pairingCodes.targetDeviceId,
        installId: deviceRequests.installId,
        deviceModel: deviceRequests.deviceModel,
        osVersion: deviceRequests.osVersion,
        appVersionCode: deviceRequests.appVersionCode,
        latitude: deviceRequests.latitude,
        longitude: deviceRequests.longitude,
        requestedAt: deviceRequests.requestedAt,
        status: deviceRequests.status,
        decidedBy: deviceRequests.decidedBy,
        decidedAt: deviceRequests.decidedAt,
      })
      .from(deviceRequests)
      .innerJoin(pairingCodes, eq(pairingCodes.id, deviceRequests.codeId))
      .innerJoin(locations, eq(locations.id, pairingCodes.locationId))
      .where(status && ["pending", "approved", "rejected", "expired"].includes(status) ? eq(deviceRequests.status, status as any) : undefined)
      .orderBy(desc(deviceRequests.requestedAt));
    res.json(rows);
  } catch (e) {
    serverError(res, "list pairing requests", e);
  }
});

deviceRouter.post("/pair/requests/:id/approve", devicesAdmin, async (req, res) => {
  try {
    const r = await db.transaction((tx) => approvePairingRequest(tx, req.params.id!, req.session.user!.id));
    res.status(r.status).json(r.body);
  } catch (e) {
    serverError(res, "approve request", e);
  }
});

deviceRouter.post("/pair/requests/:id/reject", devicesAdmin, async (req, res) => {
  try {
    const r = await db.transaction((tx) => rejectPairingRequest(tx, req.params.id!, req.session.user!.id));
    if (r.status === 204) return res.status(204).send();
    res.status(r.status).json(r.body);
  } catch (e) {
    serverError(res, "reject request", e);
  }
});

// Registered after /pair/codes and /pair/requests so the literal paths win.
deviceRouter.get("/pair/:pendingId", async (req, res) => {
  try {
    res.json(await db.transaction((tx) => pollPairing(tx, req.params.pendingId!)));
  } catch (e) {
    serverError(res, "poll pairing", e);
  }
});

/* ── Admin: devices ────────────────────────────────────────────────────── */

deviceRouter.get("/devices", view, async (_req, res) => {
  try {
    const rows = await db
      .select({
        id: devices.id,
        name: devices.name,
        role: devices.role,
        location: { id: locations.id, code: locations.code, name: locations.name },
        canteenId: devices.canteenId,
        canteen: canteens.name,
        installId: devices.installId,
        deviceModel: devices.deviceModel,
        appVersionCode: devices.appVersionCode,
        lastSeenAt: devices.lastSeenAt,
        revokedAt: devices.revokedAt,
        createdAt: devices.createdAt,
      })
      .from(devices)
      .innerJoin(locations, eq(locations.id, devices.locationId))
      .leftJoin(canteens, eq(canteens.id, devices.canteenId))
      .orderBy(asc(devices.name));
    res.json(rows);
  } catch (e) {
    serverError(res, "fetch devices", e);
  }
});

deviceRouter.post("/devices/:id/rotate-token", devicesAdmin, async (req, res) => {
  try {
    const rawToken = newToken();
    const [row] = await db
      .update(devices)
      .set({ tokenHash: hashToken(rawToken), revokedAt: null })
      .where(eq(devices.id, req.params.id!))
      .returning({ id: devices.id, name: devices.name, createdAt: devices.createdAt });
    if (!row) return res.status(404).json({ error: "Device not found" });
    res.json({ ...row, token: rawToken });
  } catch (e) {
    serverError(res, "rotate device token", e);
  }
});

deviceRouter.delete("/devices/:id", devicesAdmin, async (req, res) => {
  try {
    const [row] = await db.update(devices).set({ revokedAt: new Date() }).where(eq(devices.id, req.params.id!)).returning({ id: devices.id });
    if (!row) return res.status(404).json({ error: "Device not found" });
    res.json({ success: true });
  } catch (e) {
    serverError(res, "revoke device", e);
  }
});

/* ── Admin: PINs ───────────────────────────────────────────────────────── */

const pinColumns = {
  id: staffPins.id,
  name: staffPins.name,
  locationId: staffPins.locationId,
  siteCode: locations.code,
  canteenId: staffPins.canteenId,
  canUnlock: staffPins.canUnlock,
  canAuthorise: staffPins.canAuthorise,
  isActive: staffPins.isActive,
  createdAt: staffPins.createdAt,
  revokedAt: staffPins.revokedAt,
};

deviceRouter.get("/pins", view, async (_req, res) => {
  try {
    const rows = await db.select(pinColumns).from(staffPins).innerJoin(locations, eq(locations.id, staffPins.locationId)).orderBy(asc(staffPins.name));
    res.json(rows);
  } catch (e) {
    serverError(res, "fetch PIN list", e);
  }
});

const pinBody = z.object({
  name: z.string().trim().min(1).max(80),
  locationId: z.string().uuid(),
  canteenId: z.string().uuid().nullish(),
  pin: z.string().regex(/^\d{4,6}$/, "a 4-6 digit pin is required"),
  canUnlock: z.boolean().optional(),
  canAuthorise: z.boolean().optional(),
});

deviceRouter.post("/pins", devicesAdmin, validateBody(pinBody), async (req, res) => {
  try {
    const b = req.body as z.infer<typeof pinBody>;
    if (await pinCollidesAtSite(db, b.locationId, b.pin)) return res.status(400).json({ error: "This PIN is already in use by someone else at this site" });
    const saltHex = crypto.randomBytes(16).toString("hex");
    const [row] = await db
      .insert(staffPins)
      .values({ name: b.name, locationId: b.locationId, canteenId: b.canteenId ?? null, saltHex, pinHash: hashPin(saltHex, b.pin), canUnlock: b.canUnlock !== false, canAuthorise: !!b.canAuthorise })
      .returning({ id: staffPins.id, name: staffPins.name });
    res.status(201).json(row);
  } catch (e) {
    serverError(res, "create PIN", e);
  }
});

const pinPatch = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  pin: z.string().regex(/^\d{4,6}$/).optional(),
  canUnlock: z.boolean().optional(),
  canAuthorise: z.boolean().optional(),
  isActive: z.boolean().optional(),
  revoke: z.boolean().optional(),
});

deviceRouter.patch("/pins/:id", devicesAdmin, validateBody(pinPatch), async (req, res) => {
  try {
    const b = req.body as z.infer<typeof pinPatch>;
    const [existing] = await db.select().from(staffPins).where(eq(staffPins.id, req.params.id!));
    if (!existing) return res.status(404).json({ error: "PIN not found" });
    // A site with no authoriser cannot serve a guest or an override at all.
    const nextAuth = b.canAuthorise ?? existing.canAuthorise;
    const nextActive = b.isActive ?? existing.isActive;
    const loses = existing.canAuthorise && existing.isActive && (!nextAuth || !nextActive || b.revoke === true);
    if (loses && (await wouldZeroOutAuthorisers(db, existing.locationId, existing.id))) {
      return res.status(400).json({ error: "This site would be left with no active authoriser — add another PIN with 'can authorise' first" });
    }
    const patch: Partial<typeof staffPins.$inferInsert> = {};
    if (b.name) patch.name = b.name;
    if (b.canUnlock !== undefined) patch.canUnlock = b.canUnlock;
    if (b.canAuthorise !== undefined) patch.canAuthorise = b.canAuthorise;
    if (b.isActive !== undefined) patch.isActive = b.isActive;
    if (b.revoke === true) patch.revokedAt = new Date();
    if (b.pin) {
      if (await pinCollidesAtSite(db, existing.locationId, b.pin, existing.id)) return res.status(400).json({ error: "This PIN is already in use by someone else at this site" });
      patch.saltHex = crypto.randomBytes(16).toString("hex");
      patch.pinHash = hashPin(patch.saltHex, b.pin);
    }
    const [row] = await db.update(staffPins).set(patch).where(eq(staffPins.id, existing.id)).returning({ id: staffPins.id });
    res.json(row);
  } catch (e) {
    serverError(res, "update PIN", e);
  }
});

/* ── Admin: reason codes ───────────────────────────────────────────────── */

deviceRouter.get("/reason-codes", view, async (_req, res) => {
  try {
    res.json(await db.select().from(reasonCodes).orderBy(asc(reasonCodes.displayOrder), asc(reasonCodes.code)));
  } catch (e) {
    serverError(res, "fetch reason codes", e);
  }
});

const reasonBody = z.object({
  code: z.string().trim().min(1).max(40),
  label: z.string().trim().min(1).max(120),
  requiresText: z.boolean().optional(),
  displayOrder: z.coerce.number().int().optional(),
});

deviceRouter.post("/reason-codes", devicesAdmin, validateBody(reasonBody), async (req, res) => {
  try {
    const b = req.body as z.infer<typeof reasonBody>;
    const [row] = await db.insert(reasonCodes).values({ code: b.code, label: b.label, requiresText: !!b.requiresText, displayOrder: b.displayOrder ?? 0 }).returning();
    res.status(201).json(row);
  } catch (e: any) {
    if (e?.code === "23505") return res.status(400).json({ error: "A reason code with that code already exists" });
    serverError(res, "create reason code", e);
  }
});

const reasonPatch = z.object({
  label: z.string().trim().min(1).max(120).optional(),
  requiresText: z.boolean().optional(),
  isActive: z.boolean().optional(),
  displayOrder: z.coerce.number().int().optional(),
});

deviceRouter.patch("/reason-codes/:id", devicesAdmin, validateBody(reasonPatch), async (req, res) => {
  try {
    const b = req.body as z.infer<typeof reasonPatch>;
    const [row] = await db.update(reasonCodes).set(b).where(eq(reasonCodes.id, req.params.id!)).returning();
    if (!row) return res.status(404).json({ error: "Reason code not found" });
    res.json(row);
  } catch (e) {
    serverError(res, "update reason code", e);
  }
});
