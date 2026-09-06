/**
 * The farm's climate rules: what the settings should be, given the week.
 *
 * Each rule is a pure function of one house — its kept settings, its catalogue,
 * the flock's age, the week's statistics, and the rule's parameters — and
 * answers with the changes it would make and the evidence for them. It never
 * writes. A rule with nothing to say answers nothing; a rule that finds
 * something a person must fix at the panel, like a ladder that runs
 * backwards, says so with no changes attached.
 *
 * The parameters below are the farm's starting policy, decided on
 * 6 September 2026: today's offsets made relative, and the audit's four
 * monsoon changes. Every one is a number a manager may edit, at farm level
 * or for one house, and the rule reads the edited value.
 */
import type { Catalog, CatalogPage } from "./controls";
import type { WeekStats } from "./house-stats";

export interface ProposedChange {
  register: string;
  label: string;
  unit: string;
  before: string | null;
  after: string;
  /** Hold to confirm on the page: the master registers. */
  critical: boolean;
}
export interface Draft {
  rule: string;
  title: string;
  reason: string;
  evidence: Record<string, unknown>;
  changes: ProposedChange[];
}
export interface HouseContext {
  code: string;
  ageDays: number | null;
  settings: Record<string, string>;
  catalog: Catalog;
  stats: WeekStats;
  /** Fans running at each step from the kept ladder, index = step. */
  fansAtStep: number[] | null;
}

/* ── The rules and their parameters ────────────────────────────────────── */

export const RULES = {
  companions: {
    title: "Companions follow the target",
    description:
      "The tunnel temperature and the high alarm are measured from the target for the current age row. Move the target and they follow; drift apart and this brings them back.",
    params: { tunnelAbove: 0.7, highAlarmAbove: 6.0, tolerance: 0.25 },
  },
  "pads-humidity": {
    title: "Pads only when they work",
    description:
      "An evaporative pad in saturated air cools a degree and raises the wet-bulb, which the birds feel as hotter. When the week's humidity is over the threshold the pads start later; when it is dry again they start at the dry setting.",
    params: { rhWet: 80, padStartWet: 31.5, padStartDry: 29.0 },
  },
  stability: {
    title: "Stop the hunting, keep the air",
    description:
      "A shed that changes step more than once an hour pays a fan start every time and draughts the birds. A wider dead band and a slower step down halve it; the step up stays quick so heat is answered and a restart climbs back fast.",
    params: { whenChangesPerHour: 1.0, band: 0.8, stepUpDelay: 40, stepDownDelay: 90 },
  },
  floor: {
    title: "A ladder floor for the wet months",
    description:
      "In humid heat the air moving over the birds is the only comfort lever, and a restart after a power cut climbs from the floor. When the week is wet and warm the floor for the current age row rises, so air speed never falls away and a restart has fewer steps to climb; it comes down again when the weather turns.",
    params: { rhWet: 80, tempWarm: 28, wetFloorStep: 9, dryFloorStep: 1 },
  },
  consistency: {
    title: "One policy for every shed",
    description: "Negative pressure control on, so the inlets are managed for jet speed in tunnel mode; spray humidity setpoint at 100 while the spray is not in use.",
    params: { pressureControl: 1, sprayHumiditySetpoint: 100 },
  },
  "ladder-monotonic": {
    title: "The ladder must not run backwards",
    description: "Every step up should add air. A step with fewer fans than the one below is a place the controller climbs into and gets less; this names them for a sitting at the ladder page.",
    params: {},
  },
} as const;
export type RuleKey = keyof typeof RULES;
export type RuleParams = { [K in RuleKey]: { [P in keyof (typeof RULES)[K]["params"]]: number } };

/* ── Finding registers by what they are, not by spelling ───────────────── */

const page = (cat: Catalog, code: string): CatalogPage | undefined => cat.pages.find((p) => p.code === code);
const fieldByLeaf = (cat: Catalog, code: string, leaf: string) => page(cat, code)?.fields?.find((f) => f.register.endsWith(`.${leaf}`) || f.register === leaf);
const num = (v: string | undefined | null) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const fmt = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10));

/** The row of an age-banded table in force for the flock: the highest starting age at or below the flock's. */
function rowInForce(cat: Catalog, code: string, settings: Record<string, string>, ageDays: number | null, ageKey: string, mustBePositive?: string) {
  const p = page(cat, code);
  if (!p?.rows || ageDays == null) return null;
  let best: { row: (typeof p.rows)[number]; age: number } | null = null;
  for (const row of p.rows) {
    const age = num(settings[row.cells[ageKey] ?? ""]);
    if (age == null || age > ageDays) continue;
    if (mustBePositive && !(num(settings[row.cells[mustBePositive] ?? ""]) ?? 0)) continue;
    if (!best || age >= best.age) best = { row, age };
  }
  return best?.row ?? null;
}

/** Within the vendor's range for the register, as printed. */
function withinRange(range: string, value: number): boolean {
  const m = /^\s*(-?[\d.]+)\s*[~-]\s*(-?[\d.]+)/.exec(range);
  if (!m) return true;
  return value >= Number(m[1]) && value <= Number(m[2]);
}

function change(ctx: HouseContext, register: string, label: string, unit: string, after: number, range: string, critical = false): ProposedChange | null {
  const before = ctx.settings[register] ?? null;
  if (before != null && Math.abs((num(before) ?? NaN) - after) < 0.05) return null;
  if (!withinRange(range, after)) return null;
  return { register, label, unit, before, after: fmt(after), critical };
}

/* ── The rules ─────────────────────────────────────────────────────────── */

type Rule = (ctx: HouseContext, params: Record<string, number>) => Draft | null;

const companions: Rule = (ctx, p) => {
  const row = rowInForce(ctx.catalog, "QXTZ_WDQX_S", ctx.settings, ctx.ageDays, "day", "target");
  if (!row) return null;
  const target = num(ctx.settings[row.cells.target ?? ""]);
  if (target == null) return null;
  const cols = page(ctx.catalog, "QXTZ_WDQX_S")!.columns!;
  const col = (k: string) => cols.find((c) => c.key === k)!;
  const changes: ProposedChange[] = [];
  const wantTunnel = target + p.tunnelAbove!;
  const wantAlarm = target + p.highAlarmAbove!;
  const tunnel = num(ctx.settings[row.cells.zxtf ?? ""]);
  const alarm = num(ctx.settings[row.cells.warnTemp ?? ""]);
  if (tunnel == null || Math.abs(tunnel - wantTunnel) > p.tolerance!) {
    const c = change(ctx, row.cells.zxtf!, `Tunnel temperature, age row from day ${num(ctx.settings[row.cells.day!])}`, col("zxtf").unit, wantTunnel, col("zxtf").range, true);
    if (c) changes.push(c);
  }
  if (alarm == null || Math.abs(alarm - wantAlarm) > p.tolerance!) {
    const c = change(ctx, row.cells.warnTemp!, `High alarm, age row from day ${num(ctx.settings[row.cells.day!])}`, col("warnTemp").unit, wantAlarm, col("warnTemp").range, true);
    if (c) changes.push(c);
  }
  if (!changes.length) return null;
  return {
    rule: "companions",
    title: RULES.companions.title,
    reason: `The target for this age row is ${fmt(target)}°C. The tunnel temperature should sit ${fmt(p.tunnelAbove!)}° above it and the high alarm ${fmt(p.highAlarmAbove!)}° above it; today they are ${tunnel ?? "unset"} and ${alarm ?? "unset"}.`,
    evidence: { target, tunnel, alarm, wantTunnel, wantAlarm, ageDays: ctx.ageDays },
    changes,
  };
};

const padsHumidity: Rule = (ctx, p) => {
  const f = fieldByLeaf(ctx.catalog, "ZLSZ_S", "制冷温度");
  if (!f || ctx.stats.rhMean == null) return null;
  const wet = ctx.stats.rhMean >= p.rhWet!;
  const want = wet ? p.padStartWet! : p.padStartDry!;
  const c = change(ctx, f.register, f.labelEn, f.unit || "°C", want, f.range || "0~50", true);
  if (!c) return null;
  const hoursAtOrAbove = ctx.stats.tempMean == null ? null : undefined;
  return {
    rule: "pads-humidity",
    title: RULES["pads-humidity"].title,
    reason: wet
      ? `The week's humidity averaged ${ctx.stats.rhMean}% (wet-bulb ${ctx.stats.wetBulbMean}°C, peak ${ctx.stats.wetBulbMax}). Above ${p.rhWet}% a pad cools little and raises the wet-bulb the birds feel. Pads should start at ${fmt(want)}°C until the air dries.`
      : `The week's humidity averaged ${ctx.stats.rhMean}%, under ${p.rhWet}%: the pads work again and should start at the dry setting of ${fmt(want)}°C.`,
    evidence: { rhMean: ctx.stats.rhMean, rhMax: ctx.stats.rhMax, wetBulbMean: ctx.stats.wetBulbMean, wetBulbMax: ctx.stats.wetBulbMax, wetBulbHoursOver29: ctx.stats.wetBulbHoursOver29, hoursAtOrAbove },
    changes: [c],
  };
};

const stability: Rule = (ctx, p) => {
  const cph = ctx.stats.stepChangesPerHour;
  if (cph == null || cph < p.whenChangesPerHour!) return null;
  const band = fieldByLeaf(ctx.catalog, "QXTZ_QXTZ_S", "目标温度带");
  const up = fieldByLeaf(ctx.catalog, "TFJB_TFJBTZ_S", "提高级别延时时间");
  const down = fieldByLeaf(ctx.catalog, "TFJB_TFJBTZ_S", "降低级别延时时间");
  const changes: ProposedChange[] = [];
  for (const [f, want] of [
    [band, p.band],
    [up, p.stepUpDelay],
    [down, p.stepDownDelay],
  ] as const) {
    if (!f) continue;
    const c = change(ctx, f.register, f.labelEn, f.unit, want!, f.range);
    if (c) changes.push(c);
  }
  if (!changes.length) return null;
  const perWeek = Math.round(cph * ctx.stats.hours);
  return {
    rule: "stability",
    title: RULES.stability.title,
    reason: `The controller changed step ${cph} times an hour this week, about ${perWeek} times, each a fan start and a draught. A dead band of ${fmt(p.band!)}°C and a step-down delay of ${p.stepDownDelay} s halve that; the step-up delay stays at ${p.stepUpDelay} s so heat is answered quickly and a restart after a power cut climbs back fast.`,
    evidence: { stepChangesPerHour: cph, stepMean: ctx.stats.stepMean, restarts: ctx.stats.restarts, hours: ctx.stats.hours },
    changes,
  };
};

const floor: Rule = (ctx, p) => {
  const row = rowInForce(ctx.catalog, "JXJB_ZXZDJBQX_S", ctx.settings, ctx.ageDays, "day");
  if (!row || ctx.stats.rhMean == null || ctx.stats.tempMean == null) return null;
  const col = page(ctx.catalog, "JXJB_ZXZDJBQX_S")!.columns!.find((c) => c.key === "minLevel")!;
  const wet = ctx.stats.rhMean >= p.rhWet! && ctx.stats.tempMean >= p.tempWarm!;
  const want = wet ? p.wetFloorStep! : p.dryFloorStep!;
  const current = num(ctx.settings[row.cells.minLevel ?? ""]);
  if (current == null) return null;
  const c = change(ctx, row.cells.minLevel!, `Minimum step, age row from day ${num(ctx.settings[row.cells.day!])}`, "", want, col.range || "1~36", true);
  if (!c) return null;
  const restartNote = ctx.stats.restarts
    ? ` Power came back ${ctx.stats.restarts} time(s) this week and the controller climbed from the floor each time, ${ctx.stats.restartMinutesUnderVentilated} minutes under-ventilated in all; from step ${want} the climb is shorter.`
    : "";
  return {
    rule: "floor",
    title: RULES.floor.title,
    reason: wet
      ? `The week averaged ${ctx.stats.tempMean}°C at ${ctx.stats.rhMean}% humidity: the birds' comfort is the ${ctx.stats.velocityMean ?? "?"} m/s of air over them, and the floor is step ${current}, where there is almost none. A floor of step ${want} for this age row keeps the air moving on the coolest night.${restartNote}`
      : `The week averaged ${ctx.stats.tempMean}°C at ${ctx.stats.rhMean}%: the weather has turned and the floor of step ${current} would over-ventilate cool nights. Back to step ${want}.`,
    evidence: { rhMean: ctx.stats.rhMean, tempMean: ctx.stats.tempMean, velocityMean: ctx.stats.velocityMean, floor: current, restarts: ctx.stats.restarts, restartMinutes: ctx.stats.restartMinutesUnderVentilated, hoursAtOrBelow: ctx.stats.hoursAtOrBelowStep(want - 1) },
    changes: [c],
  };
};

const consistency: Rule = (ctx, p) => {
  const changes: ProposedChange[] = [];
  const pc = fieldByLeaf(ctx.catalog, "FYSD_S", "负压控制选择");
  if (pc) {
    const c = change(ctx, pc.register, pc.labelEn, "", p.pressureControl!, "0~1");
    if (c) changes.push({ ...c, after: fmt(p.pressureControl!) });
  }
  const sp = page(ctx.catalog, "PW_S")?.fields?.find((f) => f.register.endsWith("湿度设定") && !f.register.endsWith("喷雾湿度设定"));
  if (sp) {
    const c = change(ctx, sp.register, sp.labelEn, sp.unit, p.sprayHumiditySetpoint!, sp.range || "0~100");
    if (c) changes.push(c);
  }
  if (!changes.length) return null;
  return {
    rule: "consistency",
    title: RULES.consistency.title,
    reason: `Every shed on the farm should hold the same policy where the birds and the house are the same. ${changes.map((c) => `${c.label}: ${c.before ?? "unset"} → ${c.after}`).join("; ")}.`,
    evidence: {},
    changes,
  };
};

const ladderMonotonic: Rule = (ctx) => {
  const fans = ctx.fansAtStep;
  if (!fans) return null;
  const maxStep = num(Object.entries(ctx.settings).find(([k]) => k.endsWith("当前最大通风级别"))?.[1]) ?? 25;
  const dips: string[] = [];
  for (let s = 2; s <= maxStep; s++) {
    if (fans[s] != null && fans[s - 1] != null && fans[s]! < fans[s - 1]!) dips.push(`${s - 1} → ${s} (${fans[s - 1]} to ${fans[s]} fans)`);
  }
  if (!dips.length) return null;
  return {
    rule: "ladder-monotonic",
    title: RULES["ladder-monotonic"].title,
    reason: `At ${dips.length} step(s) the ladder runs fewer fans than the step below: ${dips.join(", ")}. Each is a place the controller climbs into and gets less air, then climbs again. A sitting at the ladder page puts each step at or above the one below; nothing here is changed by niko.`,
    evidence: { dips, maxStep },
    changes: [],
  };
};

export const RULE_FNS: Record<RuleKey, Rule> = {
  companions,
  "pads-humidity": padsHumidity,
  stability,
  floor,
  consistency,
  "ladder-monotonic": ladderMonotonic,
};

/** Every enabled rule's answer for one house. */
export function evaluate(ctx: HouseContext, params: Partial<Record<RuleKey, Record<string, number>>>, enabled: Partial<Record<RuleKey, boolean>> = {}): Draft[] {
  const out: Draft[] = [];
  for (const key of Object.keys(RULES) as RuleKey[]) {
    if (enabled[key] === false) continue;
    const p = { ...(RULES[key].params as Record<string, number>), ...(params[key] ?? {}) };
    const d = RULE_FNS[key](ctx, p);
    if (d) out.push(d);
  }
  return out;
}
