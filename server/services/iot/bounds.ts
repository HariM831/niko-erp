/**
 * Bounds and modes: what niko may write, and whether it may write on its own.
 *
 * A bound is a floor and a ceiling on one master register, set by the vet
 * for the farm and never wider than the vendor's own range. A proposal that
 * asks for a value outside its bound is shown, not written, whoever asks;
 * widening the bound is a separate, deliberate act under Rules.
 *
 * A mode is per shed:
 *   advise  — every change is a proposal a person approves. The default.
 *   auto    — a live loop's proposal within bounds is written by niko itself,
 *             logged as niko's decision, and the person is told afterwards.
 *             A proposal outside bounds falls back to advise.
 *   hold    — niko reads and records but proposes and writes nothing; for a
 *             shed under service, or when a person wants the panel alone.
 *
 * Both are rows of controller_rules: key "bounds" at farm level with numeric
 * params, key "mode" per house with {mode}. Stage 3, 17 September 2026.
 */
import { and, eq, isNull } from "drizzle-orm";
import { controllerRules } from "@shared/schema";
import { db } from "../../db";

export const BOUNDS_KEY = "bounds";
export const MODE_KEY = "mode";
export type Mode = "advise" | "auto" | "hold";

/**
 * The registers a bound covers, by the suffix of their name, and the params
 * that hold the bound. Age-row tables match any row number.
 */
export const BOUNDED: Array<{ label: string; test: RegExp; min: string; max: string }> = [
  { label: "Target", test: /温度曲线\.目标温度\d+$/, min: "targetMin", max: "targetMax" },
  { label: "Tunnel temperature", test: /温度曲线\.纵向通风温度\d+$/, min: "tunnelMin", max: "tunnelMax" },
  { label: "Ladder floor", test: /呼吸率曲线\.最小级别\d+$/, min: "floorMin", max: "floorMax" },
  { label: "Pads start", test: /制冷调整\.制冷温度$/, min: "padsMin", max: "padsMax" },
  { label: "Target band", test: /目标温度带$/, min: "bandMin", max: "bandMax" },
  { label: "Step-down delay", test: /降低级别延时时间$/, min: "stepDownMin", max: "stepDownMax" },
  { label: "Pressure setpoint", test: /负压设定\.(高温|低温)压力$/, min: "pressureMin", max: "pressureMax" },
];

/** The farm's starting bounds, decided 17 September 2026: the range the sheds have actually run in this month, a little either side. */
export const BOUNDS_DEFAULTS: Record<string, number> = {
  targetMin: 24, targetMax: 28,
  tunnelMin: 25, tunnelMax: 29,
  floorMin: 1, floorMax: 14,
  padsMin: 26, padsMax: 32,
  bandMin: 0.5, bandMax: 1.5,
  stepDownMin: 40, stepDownMax: 180,
  pressureMin: 15, pressureMax: 35,
  /** A live loop moves the floor at most this many steps in one hour. */
  floorStepsPerHour: 1,
  /** A live loop moves the target at most this much in one day. */
  targetPerDay: 0.5,
};

export async function farmBounds(): Promise<Record<string, number>> {
  const [row] = await db.select({ params: controllerRules.params }).from(controllerRules).where(and(eq(controllerRules.key, BOUNDS_KEY), isNull(controllerRules.houseId)));
  return { ...BOUNDS_DEFAULTS, ...((row?.params as Record<string, number> | undefined) ?? {}) };
}

export async function houseMode(houseId: string): Promise<Mode> {
  const [row] = await db.select({ params: controllerRules.params, enabled: controllerRules.enabled }).from(controllerRules).where(and(eq(controllerRules.key, MODE_KEY), eq(controllerRules.houseId, houseId)));
  const m = (row?.params as { mode?: string } | undefined)?.mode;
  return m === "auto" || m === "hold" ? m : "advise";
}

export interface BoundCheck {
  ok: boolean;
  /** Each change that falls outside its bound, in words. */
  violations: string[];
}

/** Every change in a proposal against the farm's bounds. Registers with no bound pass. */
export function checkBounds(changes: Array<{ register: string; label: string; after: string }>, bounds: Record<string, number>): BoundCheck {
  const violations: string[] = [];
  for (const c of changes) {
    const b = BOUNDED.find((x) => x.test.test(c.register));
    if (!b) continue;
    const v = Number(c.after);
    if (!Number.isFinite(v)) continue;
    const lo = bounds[b.min], hi = bounds[b.max];
    if (lo != null && v < lo) violations.push(`${c.label}: ${c.after} is below the bound of ${lo}`);
    if (hi != null && v > hi) violations.push(`${c.label}: ${c.after} is above the bound of ${hi}`);
  }
  return { ok: violations.length === 0, violations };
}
