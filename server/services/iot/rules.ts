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
import type { Catalog, CatalogPage, CatalogRow } from "./controls";
import { FAN_KW, fansInGroup } from "./feels-like";
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
  /** When the ladder page last changed; pressure readings from before it were taken under another ladder. */
  ladderChangedAt?: Date | null;
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
    title: "Pads start",
    description:
      "The house temperature at which the cooling pads start, one number for wet weeks and one for dry. The theory that a pad in saturated air only raises the wet-bulb was tried on L2 on 6 September 2026 with a wet start of 31.5: the shed ran a degree hotter than L3 all night at the same humidity reading, so the pads do cool here even at 90%. Both starts are 29 until the data says otherwise.",
    params: { rhWet: 80, padStartWet: 29.0, padStartDry: 29.0 },
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
    description: "Negative pressure control on and the same pressure whatever the outside temperature, so the openings are managed for jet speed; spray humidity setpoint at 100 while the spray is not in use.",
    params: { pressureControl: 1, pressurePa: 25, sprayHumiditySetpoint: 100 },
  },
  "ladder-monotonic": {
    title: "The ladder must not run backwards",
    description: "Every step up should add air. A step with fewer fans than the one below is a place the controller climbs into and gets less; this names them for a sitting at the ladder page.",
    params: {},
  },
  "ladder-reach": {
    title: "The whole ladder within reach",
    description:
      "In tunnel the steps are measured from the tunnel temperature, and today's ladders put the top step five degrees above it, where the birds at the exhaust end are already in the critical band, with fans still idle. This spaces the tunnel steps evenly over the spread, so the top step arrives that many degrees above the tunnel temperature and runs as many fans as the cap allows; each step up adds fan groups in the order the ladder already brings them in, so no step has fewer fans than the one below. The tunnel curtains open in proportion: curtain 1 on the gable wall opens first and fully before curtain 2 on the side walls starts, each step's opening sized from the week's pressure readings to hold the set pressure. Decided 6 September 2026: a spread of 4° because the house reaches 31 at times, 40 fans at the top, 25 Pa. Two slopes when lowSpacing and lowSteps are set: the first lowSteps steps are lowSpacing apart, so a mild day sits lower on the ladder, and the rest share what remains of the spread; 12 September, L2 ran 24 fans at 29° where L3 ran 20 for the same comfort.",
    params: { spread: 4.0, maxFans: 40, pressurePa: 25, curtain1Area: 108, curtain2Area: 216, lowSpacing: 0, lowSteps: 0 },
  },
  "night-setback": {
    title: "Night target",
    description:
      "This controller holds one target per age row and no night target; what L3 shows as 27 and 26 are two age rows. So the night target is niko's: between nightFrom and nightTo (hours IST) it writes the curve's target correction to minus the setback, and clears it at dawn, through the confirmed write path, logged as its own decision. Off unless enabled for a shed with writing on. Note that in a month when the shed cannot get down to its day target at night, a setback only holds the ladder up for nothing.",
    params: { nightFrom: 20, nightTo: 5, setback: 1.0 },
  },
  "target-reachable": {
    title: "A target the air can deliver",
    description:
      "A target below the coolest the shed reached all week is a number the outside air cannot deliver; it only holds the ladder up through every night. The target for the age row rises to the week's low less a little slack, to the nearest half degree and never above the ceiling. It is never lowered here: when the weather turns that is the vet's call.",
    params: { slack: 0.4, ceiling: 28 },
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
  for (const leaf of ["低温压力", "高温压力"]) {
    const f = fieldByLeaf(ctx.catalog, "FYSD_S", leaf);
    if (!f) continue;
    const c = change(ctx, f.register, f.labelEn, f.unit || "Pa", p.pressurePa!, f.range || "0~100");
    if (c) changes.push(c);
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

/**
 * The tunnel part of the ladder, rebuilt: offsets spaced evenly from the
 * tunnel temperature to `topAt`, fan groups added step by step in the order
 * the ladder already uses, every group running at the top.
 */
const ladderReach: Rule = (ctx, p) => {
  const pg = page(ctx.catalog, "TFJB_TFJB_S");
  const offCol = pg?.columns?.find((c) => c.key === "tempOffset");
  if (!pg?.rows || !offCol) return null;
  const setting = (leaf: string) => num(Object.entries(ctx.settings).find(([k]) => k.endsWith(leaf))?.[1]);
  const maxStep = setting("当前最大通风级别") ?? 25;
  const start = setting("纵向通风开启级别");
  const row = rowInForce(ctx.catalog, "QXTZ_WDQX_S", ctx.settings, ctx.ageDays, "day", "target");
  const tunnelTemp = row ? num(ctx.settings[row.cells.zxtf ?? ""]) : null;
  if (start == null || tunnelTemp == null || start >= maxStep) return null;
  const topOffset = Math.round(p.spread! * 10) / 10;
  if (topOffset < 1) return null;

  const rows = pg.rows.filter((r) => r.id >= start && r.id <= maxStep).sort((a, b) => a.id - b.id);
  if (rows.length < 3) return null;
  const groupKeys = Object.keys(rows[0]!.cells)
    .filter((k) => /^f\d+$/.test(k))
    .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  const groupNo = (g: string) => Number(g.slice(1));
  const mode = (r: CatalogRow, g: string) => num(ctx.settings[r.cells[g] ?? ""]) ?? 0;
  const fansOf = (m: number, g: string) => (m === 2 ? fansInGroup(groupNo(g)) : m > 0 ? fansInGroup(groupNo(g)) / 2 : 0);

  // The vendor's page has columns for more groups than the wall holds; a
  // group no step anywhere uses does not exist and is never switched on.
  const used = groupKeys.filter((g) => pg.rows!.some((r) => mode(r, g) > 0));
  // The order the ladder already brings groups in — the commissioning
  // engineer's spread across the fan wall — then any it uses only higher up.
  const order: string[] = [];
  for (const r of rows) for (const g of used) if (mode(r, g) > 0 && !order.includes(g)) order.push(g);
  for (const g of used) if (!order.includes(g)) order.push(g);
  const fansIn = (count: number) => order.slice(0, count).reduce((n, g) => n + fansInGroup(groupNo(g)), 0);
  // As many groups as the fan cap allows, in that order.
  let total = order.length;
  while (total > 1 && fansIn(total) > p.maxFans!) total--;
  const countToday = (r: CatalogRow) => used.filter((g) => mode(r, g) > 0).length;
  const firstCount = Math.max(2, countToday(rows[0]!));
  const span = rows.length - 1;

  /*
   * The curtains. Static pressure is what the fans pull against the pads and
   * the curtain opening in series: P ≈ fans² · (a + b / area²), with a the
   * pads' share and b the curtains'. Both are fitted from this week's samples
   * — the mean pressure at each step, against today's fans and opening at
   * that step — so the sizing is this house's, not a textbook's. Curtain 1 on
   * the gable wall opens first and fully; curtain 2 on the side walls only
   * after it.
   */
  const A1 = p.curtain1Area!;
  const A2 = p.curtain2Area!;
  const pct = (r: CatalogRow, key: string) => num(ctx.settings[r.cells[key] ?? ""]);
  const areaToday = (r: CatalogRow) => ((pct(r, "mlRate") ?? 0) / 100) * A1 + ((pct(r, "mL2Rate") ?? 0) / 100) * A2;
  // Only readings taken under the ladder as it is now say anything about it.
  const sinceMs = ctx.ladderChangedAt?.getTime() ?? 0;
  const paByStep = new Map<number, number[]>();
  for (const [at, step, pa] of ctx.stats.pressureSamples) if (at >= sinceMs) paByStep.set(step, [...(paByStep.get(step) ?? []), pa]);
  const points: Array<{ step: number; n: number; pa: number; fans: number; area: number }> = [];
  for (const r of rows) {
    const xs = paByStep.get(r.id);
    const fans = ctx.fansAtStep?.[r.id] ?? null;
    const area = areaToday(r);
    if (xs && xs.length >= 5 && fans && fans > 0 && area > 0) points.push({ step: r.id, n: xs.length, pa: Math.round((xs.reduce((u, v) => u + v, 0) / xs.length) * 10) / 10, fans, area });
  }
  let fit: { a: number; b: number } | null = null;
  if (points.length >= 3) {
    const xs = points.map((q) => 1 / (q.area * q.area));
    const ys = points.map((q) => q.pa / (q.fans * q.fans));
    const mx = xs.reduce((u, v) => u + v, 0) / xs.length;
    const my = ys.reduce((u, v) => u + v, 0) / ys.length;
    const sxx = xs.reduce((u, x) => u + (x - mx) * (x - mx), 0);
    const b = sxx > 0 ? xs.reduce((u, x, i) => u + (x - mx) * (ys[i]! - my), 0) / sxx : 0;
    const a = my - b * mx;
    if (b > 0 && a >= 0) fit = { a, b };
  }
  const round5 = (x: number) => Math.max(0, Math.min(100, Math.round(x / 5) * 5));
  const hasCurtains = rows.every((r) => r.cells.mlRate && r.cells.mL2Rate);

  const changes: ProposedChange[] = [];
  const ladder: Array<{ step: number; offsetWas: number | null; offset: number; fansWas: number; fans: number; c1Was?: number | null; c1?: number; c2Was?: number | null; c2?: number }> = [];
  let prevC1 = 0;
  let prevC2 = 0;
  // Fans climb evenly from the first tunnel step to the cap at the top, each
  // step at least as strong as the one below. Only the steps at or below the
  // night floor keep what they run today, so the floor keeps its air; above
  // it today's shape is what is being replaced. (6 September 2026: a first
  // version kept every step at today's strength, and today's step 18, an
  // outlier with 38 fans, made steps 19 to 25 add nothing.)
  const fansToday = (r: CatalogRow) => used.reduce((n, g) => n + fansOf(mode(r, g), g), 0);
  const floorRow = rowInForce(ctx.catalog, "JXJB_ZXZDJBQX_S", ctx.settings, ctx.ageDays, "day");
  const floorStep = (floorRow && num(ctx.settings[floorRow.cells.minLevel ?? ""])) || start;
  let prevCount = 0;
  let prevFans = 0;
  // above the floor the ramp runs from the floor's own strength to the cap
  let rampFrom: { step: number; count: number } = { step: start, count: firstCount };
  // Two slopes: coarse for the first `lowSteps` intervals, then the rest of the spread evenly.
  const lowSpacing = Math.max(0, p.lowSpacing ?? 0);
  const lowSteps = Math.min(span - 1, Math.max(0, Math.round(p.lowSteps ?? 0)));
  const lowTop = lowSpacing * lowSteps;
  const upperSpacing = lowSteps > 0 ? (topOffset - lowTop) / (span - lowSteps) : topOffset / span;
  const offsetAt = (i: number) => (lowSteps > 0 && i <= lowSteps ? lowSpacing * i : lowSteps > 0 ? lowTop + upperSpacing * (i - lowSteps) : (topOffset * i) / span);
  rows.forEach((r, i) => {
    const offset = Math.round(offsetAt(i) * 10) / 10;
    const ramp = Math.round(rampFrom.count + ((total - rampFrom.count) * (r.id - rampFrom.step)) / Math.max(1, maxStep - rampFrom.step));
    const keep = r.id <= floorStep ? countToday(r) : 0;
    let count = Math.min(total, Math.max(prevCount, keep, ramp));
    // groups 21 and 22 hold four fans, so a step's fans, not only its groups, must not fall
    while (count < total && fansIn(count) < Math.max(prevFans, r.id <= floorStep ? fansToday(r) : 0)) count++;
    if (r.id === floorStep) rampFrom = { step: r.id, count };
    prevCount = count;
    prevFans = fansIn(count);
    const on = new Set(order.slice(0, count));
    const oc = change(ctx, r.cells.tempOffset!, `Step ${r.id} starts, above the tunnel temperature`, offCol.unit || "°C", offset, offCol.range || "0~999");
    if (oc) changes.push(oc);
    let fansWas = 0;
    let fans = 0;
    for (const g of used) {
      const was = mode(r, g);
      const want = on.has(g) ? (was > 0 ? was : 2) : 0;
      fansWas += fansOf(was, g);
      fans += fansOf(want, g);
      if (want !== was) {
        changes.push({
          register: r.cells[g]!,
          label: `Step ${r.id}, fan group ${groupNo(g)}`,
          unit: "",
          before: ctx.settings[r.cells[g]!] ?? null,
          after: String(want),
          critical: false,
        });
      }
    }
    const entry: (typeof ladder)[number] = { step: r.id, offsetWas: num(ctx.settings[r.cells.tempOffset!]), offset, fansWas, fans };
    if (fit && hasCurtains) {
      const need = p.pressurePa! / (fans * fans) - fit.a;
      const area = need > 0 ? Math.sqrt(fit.b / need) : Infinity;
      let c1 = Math.max(prevC1, round5((Math.min(area, A1) / A1) * 100));
      let c2 = Math.max(prevC2, area <= A1 ? 0 : round5((Math.min(area - A1, A2) / A2) * 100));
      // a curtain moves for a real difference, not for the fit's rounding; otherwise it stays, and the grid says so
      if (Math.abs((pct(r, "mlRate") ?? 0) - c1) < 10) c1 = pct(r, "mlRate") ?? c1;
      if (Math.abs((pct(r, "mL2Rate") ?? 0) - c2) < 10) c2 = pct(r, "mL2Rate") ?? c2;
      prevC1 = c1;
      prevC2 = c2;
      Object.assign(entry, { c1Was: pct(r, "mlRate"), c1, c2Was: pct(r, "mL2Rate"), c2 });
      for (const [key, want, name] of [
        ["mlRate", c1, "curtain 1 open"],
        ["mL2Rate", c2, "curtain 2 open"],
      ] as const) {
        const cc = change(ctx, r.cells[key]!, `Step ${r.id}, ${name}`, "%", want, "0~100");
        if (cc) changes.push(cc);
      }
    }
    ladder.push(entry);
  });
  if (!changes.length) return null;

  const top = ladder[ladder.length - 1]!;
  const topFans = top.fans;
  const st = ctx.stats;
  // What the week's mean temperature would have cost on each ladder.
  const stepAt = (excess: number, key: "offsetWas" | "offset") => ladder.reduce((best, l) => ((l[key] ?? 0) <= excess ? l : best), ladder[0]!);
  const mean = st.tempMean == null ? null : { was: stepAt(st.tempMean - tunnelTemp, "offsetWas"), will: stepAt(st.tempMean - tunnelTemp, "offset") };
  const cost = mean
    ? ` At the week's mean the ladder sits at step ${mean.was.step} with ${mean.was.fansWas} fans today (${Math.round(mean.was.fansWas * FAN_KW)} kW) and would sit at step ${mean.will.step} with ${mean.will.fans} fans (${Math.round(mean.will.fans * FAN_KW)} kW): that is the price of the air.`
    : "";
  const allOpen = fit ? Math.round(topFans * topFans * (fit.a + fit.b / ((A1 + A2) * (A1 + A2)))) : null;
  const curtains = fit
    ? ` Curtain 1 on the gable wall (${A1} m²) opens first and fully before curtain 2 on the side walls (${A2} m²) starts; each step's opening is sized to hold ${fmt(p.pressurePa!)} Pa, from this week's pressure at ${points.length} steps (${points.map((q) => `step ${q.step}: ${q.pa} Pa at ${q.fans} fans`).join(", ")}). With every curtain open, ${topFans} fans would read about ${allOpen} Pa: the pads set that floor.`
    : ` The curtains are left as they are: too few readings yet on this ladder to size them (${points.length} usable step(s)${ctx.ladderChangedAt ? `, counted since the ladder changed on ${ctx.ladderChangedAt.toISOString().slice(0, 10)}` : ""}).`;
  const comfort =
    st.feelsLikeHoursSevere != null
      ? ` On the feels-like scale the house spent ${st.feelsLikeHoursSevere} h in the severe band and ${st.feelsLikeHoursCritical ?? 0} h critical this week, at a mean step of ${st.stepMean ?? "?"}.`
      : "";
  return {
    rule: "ladder-reach",
    title: RULES["ladder-reach"].title,
    reason:
      `In tunnel the steps are measured from the tunnel temperature, ${fmt(tunnelTemp)}°C. Today step ${top.step} starts ${fmt(top.offsetWas ?? 0)}° above it, at ${fmt(tunnelTemp + (top.offsetWas ?? 0))}°C house average, and runs ${top.fansWas} of ${topFans} fans; the week's mean was ${st.tempMean ?? "?"}°C.${comfort} ` +
      `Spread over ${fmt(topOffset)}°${lowSteps > 0 ? `: ${fmt(lowSpacing)}° a step for the first ${lowSteps} steps, to +${fmt(lowTop)} at step ${rows[0]!.id + lowSteps}, then ${fmt(upperSpacing)}° a step` : `, ${fmt(topOffset / span)}° a step`}, the top step arrives at ${fmt(tunnelTemp + topOffset)}°C average, about ${fmt(tunnelTemp + topOffset + 1.3)}°C at the exhaust end, and runs ${topFans} of the ${fansIn(order.length)} fans, the cap; each step adds fan groups in the order the ladder already brings them in, so no step has fewer fans than the one below. ` +
      `${changes.length} registers on the ladder page, steps ${rows[0]!.id} to ${top.step}. At the top ${Math.round(topFans * FAN_KW)} kW runs.${cost}${curtains}`,
    evidence: { tunnelTemp, start, floorStep, maxStep, spread: p.spread, maxFans: p.maxFans, pressurePa: p.pressurePa, topOffset, fit, points, allOpenPa: allOpen, order: order.map(groupNo), ladder, tempMean: st.tempMean, atMean: mean ? { stepWas: mean.was.step, fansWas: mean.was.fansWas, step: mean.will.step, fans: mean.will.fans } : null, feelsLikeHoursSevere: st.feelsLikeHoursSevere, feelsLikeHoursCritical: st.feelsLikeHoursCritical },
    changes,
  };
};

const targetReachable: Rule = (ctx, p) => {
  const row = rowInForce(ctx.catalog, "QXTZ_WDQX_S", ctx.settings, ctx.ageDays, "day", "target");
  const low = ctx.stats.tempMin;
  if (!row || low == null) return null;
  const target = num(ctx.settings[row.cells.target ?? ""]);
  if (target == null) return null;
  const want = Math.min(p.ceiling!, Math.round((low - p.slack!) * 2) / 2);
  if (want <= target + 0.05) return null;
  const col = page(ctx.catalog, "QXTZ_WDQX_S")!.columns!.find((c) => c.key === "target")!;
  const c = change(ctx, row.cells.target!, `Target, age row from day ${num(ctx.settings[row.cells.day!])}`, col.unit || "°C", want, col.range || "0~50", true);
  if (!c) return null;
  return {
    rule: "target-reachable",
    title: RULES["target-reachable"].title,
    reason:
      `The shed's coolest reading all week was ${fmt(low)}°C and the target for this age row is ${fmt(target)}°C: a number the outside air did not deliver once in ${Math.round(ctx.stats.hours)} hours, so the ladder held its ceiling through every night for nothing. ` +
      `A target of ${fmt(want)}°C, the week's low less ${fmt(p.slack!)}° to the nearest half degree and never above ${fmt(p.ceiling!)}, asks for what the air can give. Once written, the companions rule brings the tunnel temperature and the high alarm up with it.`,
    evidence: { tempMin: low, tempMean: ctx.stats.tempMean, target, want, hours: ctx.stats.hours, ageDays: ctx.ageDays },
    changes: [c],
  };
};

export const RULE_FNS: Record<RuleKey, Rule> = {
  companions,
  "pads-humidity": padsHumidity,
  stability,
  floor,
  consistency,
  "ladder-monotonic": ladderMonotonic,
  "ladder-reach": ladderReach,
  "target-reachable": targetReachable,
  // Not an evaluation rule: the scheduler acts on it directly (see setback.ts).
  "night-setback": () => null,
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
  // A rebuilt ladder is monotonic by construction; the sitting is not needed while it is on the table.
  if (out.some((d) => d.rule === "ladder-reach" && d.changes.length)) return out.filter((d) => d.rule !== "ladder-monotonic");
  return out;
}
