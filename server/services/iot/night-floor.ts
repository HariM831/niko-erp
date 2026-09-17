/**
 * The night floor: loop 2 of the plan, the first live loop.
 *
 * Between dusk and dawn the sheds sit on the floor of their ladder, and the
 * floor is a number chosen once a week. This loop chooses it every night
 * from the air: the lowest step that keeps CO₂ and humidity under their
 * lines. Every poll it reads the shed's latest CO₂, humidity and step, and:
 *
 *   – if CO₂ or humidity is over the high line, the floor goes up one step;
 *   – if both are under the low line and the ladder is sitting on the floor,
 *     the floor comes down one step;
 *   – otherwise nothing.
 *
 * One step at a time, at most one move an hour, never outside the vet's
 * bounds, never in the quarter hour after a restart, and at dawn the floor
 * goes back to what the week's rule set. In advise mode every move is a
 * proposal for a person; in auto mode niko writes it, logs it as its own,
 * and the person reads about it in the morning; in hold mode nothing.
 *
 * Why one step and one an hour: the generators. A ladder that jumps after a
 * cut trips them; a ladder that climbs one group per step-up delay does not.
 * Niko never asks a controller to jump. 17 September 2026.
 */
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { controllerChanges, controllerProposals, houses, iotHouseSample, iotReadings } from "@shared/schema";
import { db } from "../../db";
import { fetchDeviceStatus } from "./bhfarm";
import { checkBounds, farmBounds, houseMode } from "./bounds";
import { latestSnapshot } from "./controls";
import { writeAndConfirm } from "./control";
import { ruleParams, saveRule } from "./proposals";

export const RULE = "night-floor";
const IST = 5.5 * 3_600_000;
const istHour = (d = new Date()) => { const t = new Date(d.getTime() + IST); return t.getUTCHours() + t.getUTCMinutes() / 60; };
const isNight = (h: number, from: number, to: number) => (from > to ? h >= from || h < to : h >= from && h < to);
const fmtHour = (h: number) => `${String(Math.floor(h)).padStart(2, "0")}:${String(Math.round((h % 1) * 60)).padStart(2, "0")}`;

export interface NightResult { code: string; note: string }

async function latest(houseId: string, leaves: string[]): Promise<Map<string, string>> {
  const rows = await db.select({ tagId: iotReadings.tagId, value: iotReadings.value, at: iotReadings.fetchedAt }).from(iotReadings).where(eq(iotReadings.houseId, houseId));
  const newest = new Map<string, { v: string; at: Date }>();
  for (const r of rows) { const leaf = r.tagId.split(".").pop() ?? r.tagId; if (!leaves.includes(leaf) || r.value == null) continue; const h = newest.get(leaf); if (!h || r.at > h.at) newest.set(leaf, { v: r.value, at: r.at }); }
  return new Map([...newest].map(([k, x]) => [k, x.v]));
}

/** Did the step fall by six or more inside the last quarter hour? A restart, and the air is not to be read yet. */
async function justRestarted(houseId: string): Promise<boolean> {
  const rows = await db.select({ st: iotHouseSample.ventLevel }).from(iotHouseSample).where(and(eq(iotHouseSample.houseId, houseId), gte(iotHouseSample.at, new Date(Date.now() - 15 * 60_000)))).orderBy(iotHouseSample.at);
  const steps = rows.map((r) => r.st).filter((x): x is number => x != null);
  return steps.length >= 2 && Math.max(...steps) - Math.min(...steps.slice(-2)) >= 6;
}

/** The floor register for the flock's age row, from the kept settings. */
function floorRegister(settings: Record<string, string>, age: number | null): string | null {
  if (age == null) return null;
  let best: { nn: string; day: number } | null = null;
  for (const [k, v] of Object.entries(settings)) { const i = k.indexOf("呼吸率曲线.日龄"); if (i < 0) continue; const nn = k.slice(i + "呼吸率曲线.日龄".length); if (!/^\d+$/.test(nn)) continue; const d = Number(v); if (!Number.isFinite(d) || d <= 0 || d > age) continue; if (!best || d >= best.day) best = { nn, day: d }; }
  return best ? Object.keys(settings).find((k) => k.endsWith(`呼吸率曲线.最小级别${best!.nn}`)) ?? null : null;
}

export async function nightFloorTick(): Promise<NightResult[]> {
  const out: NightResult[] = [];
  const bounds = await farmBounds();
  const sheds = await db.select({ id: houses.id, code: houses.code, device: houses.bhDeviceId }).from(houses).where(and(sql`${houses.bhDeviceId} IS NOT NULL`, eq(houses.isActive, true)));
  for (const h of sheds) {
    const { params, enabled, farm, rows } = await ruleParams(h.id);
    const own = rows.find((r) => r.key === RULE && r.houseId === h.id);
    if (!own?.enabled || enabled[RULE] === false) continue;
    const mode = await houseMode(h.id);
    if (mode === "hold") { out.push({ code: h.code, note: "hold" }); continue; }
    const p = { nightFrom: 20, nightTo: 5.5, co2High: 2500, co2Low: 1800, rhHigh: 85, rhLow: 80, ...(params[RULE] ?? {}) } as Record<string, number>;
    const snap = await latestSnapshot(h.id);
    if (!snap || !h.device) continue;
    const settings = snap.values as Record<string, string>;
    const live = await latest(h.id, ["CO2", "当前湿度", "通风级别", "当前最小通风级别", "日龄", "当前日龄"]);
    const age = Number(live.get("日龄") ?? live.get("当前日龄"));
    const reg = floorRegister(settings, Number.isFinite(age) ? age : null);
    if (!reg) { out.push({ code: h.code, note: "no floor register for the age row" }); continue; }
    const floor = Number(settings[reg]);
    const co2 = Number(live.get("CO2")), rh = Number(live.get("当前湿度")), step = Number(live.get("通风级别"));
    const night = isNight(istHour(), p.nightFrom!, p.nightTo!);
    const state = (own.params as { dayFloor?: number; lastMoveAt?: string }) ?? {};

    let want: number | null = null; let why = "";
    if (night) {
      if (state.dayFloor == null) { await saveRule(RULE, h.id, { ...(own.params as object), dayFloor: floor }, true, null); }
      if (await justRestarted(h.id)) { out.push({ code: h.code, note: "restart within the quarter hour; not reading the air yet" }); continue; }
      if (state.lastMoveAt && Date.now() - new Date(state.lastMoveAt).getTime() < 3_600_000) continue;
      if ((Number.isFinite(co2) && co2 > p.co2High!) || (Number.isFinite(rh) && rh > p.rhHigh!)) { want = floor + 1; why = `CO₂ ${co2} ppm and humidity ${rh}%: over the line of ${p.co2High} ppm / ${p.rhHigh}%`; }
      else if (Number.isFinite(co2) && co2 < p.co2Low! && Number.isFinite(rh) && rh < p.rhLow! && step <= floor) { want = floor - 1; why = `CO₂ ${co2} ppm and humidity ${rh}% under ${p.co2Low} ppm / ${p.rhLow}%, and the ladder is sitting on the floor of step ${floor}`; }
    } else if (state.dayFloor != null) {
      if (floor !== state.dayFloor) { want = state.dayFloor; why = `dawn, ${fmtHour(istHour())} IST: the floor goes back to the week's ${state.dayFloor}`; }
      else { await saveRule(RULE, h.id, { ...(own.params as object), dayFloor: null, lastMoveAt: null }, true, null); continue; }
    }
    if (want == null) continue;
    want = Math.max(bounds.floorMin ?? 1, Math.min(bounds.floorMax ?? 25, want));
    if (want === floor) { out.push({ code: h.code, note: `floor ${floor} is at the bound` }); continue; }

    const change = { register: reg, label: `Minimum step, age row in force`, unit: "", before: String(floor), after: String(want), critical: true };
    const bc = checkBounds([change], bounds);
    const title = want > floor ? `Night floor up to step ${want}` : want < floor && night ? `Night floor down to step ${want}` : `Floor back to step ${want} at dawn`;
    const reason = `${why}. ${night ? "One step, and no more than one an hour, so the ladder never jumps and the generator is never asked to." : ""}`;
    // withdraw an open proposal of this rule that says something else
    await db.update(controllerProposals).set({ status: "superseded", decidedAt: new Date() }).where(and(eq(controllerProposals.houseId, h.id), eq(controllerProposals.rule, RULE), eq(controllerProposals.status, "open")));
    const willWrite = mode === "auto" && farm.writesEnabled && bc.ok;
    const [prop] = await db.insert(controllerProposals).values({ houseId: h.id, rule: RULE, title, reason: willWrite ? `${reason} Written by niko: this shed is in auto mode.` : bc.ok ? reason : `${reason} Outside the farm's bounds (${bc.violations.join("; ")}), so shown and not written.`, evidence: { co2, rh, step, floor, want, night, mode, auto: willWrite, bounds: bc }, changes: [change], status: willWrite ? "approved" : "open", decidedAt: willWrite ? new Date() : null, snapshotBefore: snap.id }).returning({ id: controllerProposals.id });
    if (!willWrite) { out.push({ code: h.code, note: `proposed floor ${floor} → ${want} (${mode})` }); continue; }
    try {
      const st = await fetchDeviceStatus(h.device);
      if (!st.isLiving) throw new Error("controller not reachable");
      const rec = await writeAndConfirm(h.device, [{ key: `${h.device}.${reg}`, value: String(want) }]);
      await db.update(controllerProposals).set({ status: rec.confirmed ? "written" : "failed", writtenAt: new Date(), writeRecord: rec }).where(eq(controllerProposals.id, prop!.id));
      if (rec.confirmed) {
        await db.insert(controllerChanges).values({ houseId: h.id, register: reg, pageCode: null, before: String(floor), after: String(want), seenAt: new Date(), source: "niko" });
        settings[reg] = String(want);
        await db.execute(sql`UPDATE controller_snapshots SET values = ${JSON.stringify(settings)}::jsonb WHERE id = ${snap.id}`);
        await saveRule(RULE, h.id, { ...(own.params as object), dayFloor: night ? (state.dayFloor ?? floor) : null, lastMoveAt: new Date().toISOString() }, true, null);
      }
      out.push({ code: h.code, note: `auto: floor ${floor} → ${want} ${rec.confirmed ? "written" : "NOT confirmed"}` });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await db.update(controllerProposals).set({ status: "failed", writeRecord: { error: msg } }).where(eq(controllerProposals.id, prop!.id));
      out.push({ code: h.code, note: `auto failed: ${msg}` });
    }
  }
  return out;
}

/** The newest night-floor decision per shed, for the page. */
export async function recentNightDecisions(houseId: string, limit = 12) {
  return db.select().from(controllerProposals).where(and(eq(controllerProposals.houseId, houseId), eq(controllerProposals.rule, RULE))).orderBy(desc(controllerProposals.createdAt)).limit(limit);
}
