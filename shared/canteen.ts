/**
 * Canteen naming shared by the server routes and the admin UI — meals,
 * serving states, the default meal windows, retention — so a rename or a
 * new state cannot drift between the two. Ported from Amino's
 * canteen-constants.ts minus the parts its unified device registry made
 * redundant (device kinds, operator roles, the separate permission resource).
 */

export const MEALS = ["breakfast", "lunch", "dinner"] as const;
export type Meal = (typeof MEALS)[number];

export const MEAL_LABEL: Record<Meal, string> = {
  breakfast: "Breakfast",
  lunch: "Lunch",
  dinner: "Dinner",
};

/**
 * The windows a canteen gets when nobody has set its own. Served to devices
 * in /api/device/config so the phone can flag a plate as outside-window
 * without asking; a canteen_meal_windows row (canteen_id NULL = global
 * default, or per canteen) overrides these in that order.
 */
export const DEFAULT_MEAL_WINDOWS: Record<Meal, { startTime: string; endTime: string }> = {
  breakfast: { startTime: "07:00", endTime: "09:00" },
  lunch: { startTime: "12:00", endTime: "15:00" },
  dinner: { startTime: "19:00", endTime: "22:00" },
};

export const SERVING_STATES = ["verified", "name_matched", "unverified_attendance", "override", "guest"] as const;
export type ServingState = (typeof SERVING_STATES)[number];

export const SERVING_STATE_LABEL: Record<ServingState, string> = {
  verified: "Verified",
  name_matched: "Manual",
  unverified_attendance: "Unverified attendance",
  override: "Override",
  guest: "Guest",
};

/**
 * States a supervisor must authorise (PIN + reason) at serve time. The server
 * validates a synced plate against this rather than re-deriving the rule, and
 * the admin UI highlights the same rows the device did.
 */
export const SUPERVISED_STATES: ReadonlySet<ServingState> = new Set(["override", "guest"]);

/** `personKind` on the device wire. payroll = salaried, wage = daily_wage. */
export const PERSON_KINDS = ["payroll", "wage", "guest"] as const;
export type PersonKind = (typeof PERSON_KINDS)[number];

export const EXTRA_PLATE_KINDS = ["guest", "second_plate", "override"] as const;

/**
 * How long override/guest audit photos are kept — one salary cycle, so a
 * disputed plate can still be looked at. Sent to devices in config; pruning
 * is a server job.
 */
export const PHOTO_RETENTION_DAYS = 45;

/** Max events accepted per POST /api/device/events. */
export const MAX_EVENTS_PER_REQUEST = 200;

/* ── Which meal is it? ─────────────────────────────────────────────────── */

export interface MealWindow {
  meal: Meal;
  startTime: string;
  endTime: string;
}

/** IST wall-clock "HH:MM" for an instant. */
export function istTimeHHMM(d: Date = new Date()): string {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d);
  const at = (t: string) => p.find((x) => x.type === t)!.value;
  return `${at("hour") === "24" ? "00" : at("hour")}:${at("minute")}`;
}

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/**
 * The meal being served at a time of day, decided from the clock and nothing
 * else: the window the time falls in, or — outside them all — the meal whose
 * window edge is nearest, flagged as outside its window.
 *
 * The SERVER calls this when a plate is recorded; the browser only calls it to
 * draw a label. Amino's canteen gate let the browser say which meal it was, and
 * while its page was still loading the windows it said "lunch": a 07:37 plate
 * went down as lunch, outside its window. A client that cannot send a meal
 * cannot send the wrong one.
 */
export function mealForTime(hhmm: string, windows: MealWindow[]): { meal: Meal; outsideWindow: boolean } {
  const t = minutes(hhmm);
  const inside = windows.find((w) => t >= minutes(w.startTime) && t <= minutes(w.endTime));
  if (inside) return { meal: inside.meal, outsideWindow: false };
  // Distance round the clock, so 23:30 is nearer a 19:00–22:00 dinner than a 07:00 breakfast.
  const gap = (a: number, b: number) => Math.min(Math.abs(a - b), 1440 - Math.abs(a - b));
  let best: MealWindow = windows[0] ?? { meal: "lunch", ...DEFAULT_MEAL_WINDOWS.lunch };
  let bestGap = Infinity;
  for (const w of windows) {
    const g = Math.min(gap(t, minutes(w.startTime)), gap(t, minutes(w.endTime)));
    if (g < bestGap) { bestGap = g; best = w; }
  }
  return { meal: best.meal, outsideWindow: true };
}
