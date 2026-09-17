/**
 * A night target, on a controller whose web pages offer none.
 *
 * The 9200 exposes one target per age row. L3 runs a day-and-night programme
 * from its own panel, 27 by day and 26 from 18:10 to 05:40, but it moves only
 * the target and the alarms, and in tunnel mode the ladder is anchored to the
 * TUNNEL temperature, so that programme changes little the birds feel. For a
 * night target to mean more air, the tunnel temperature has to come down with
 * it. So niko's night setback moves the pair: at dusk the age row's target and
 * tunnel temperature both drop by the setback, at dawn both return.
 *
 * Order matters, because the controller refuses a target above its tunnel
 * temperature: going down, the target first and then the tunnel temperature;
 * going up, the tunnel temperature first and then the target. Both registers
 * are on the curve TABLE page, which every shed accepts; the correction
 * register on the form page is refused by L4.
 *
 * It is a schedule a person set, not a loop that reads the air: it writes on
 * its own whenever the rule is enabled for the shed, writes are on for the
 * farm and the shed is not on hold, and every move is logged as a proposal
 * niko decided. The day values are remembered at dusk so dawn restores
 * exactly what was there. 17 September 2026.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { controllerChanges, controllerProposals, houses, iotReadings } from "@shared/schema";
import { db } from "../../db";
import { fetchDeviceStatus } from "./bhfarm";
import { checkBounds, farmBounds, houseMode } from "./bounds";
import { latestSnapshot } from "./controls";
import { writeAndConfirm } from "./control";
import { ruleParams, saveRule } from "./proposals";

const RULE = "night-setback";
const IST = 5.5 * 3_600_000;
const istHour = (d = new Date()) => { const t = new Date(d.getTime() + IST); return t.getUTCHours() + t.getUTCMinutes() / 60; };
export const isNight = (h: number, from: number, to: number) => (from > to ? h >= from || h < to : h >= from && h < to);
const fmtHour = (h: number) => `${String(Math.floor(h)).padStart(2, "0")}:${String(Math.round((h % 1) * 60)).padStart(2, "0")}`;
const r1 = (x: number) => Math.round(x * 10) / 10;

export interface SetbackResult { code: string; note: string }
interface State { nightOn?: boolean; dayTarget?: number; dayTunnel?: number; lastTryAt?: string }

/** The age row in force: the highest starting age at or below the flock's, on the temperature curve. */
function curveRow(settings: Record<string, string>, age: number | null): string | null {
  if (age == null) return null;
  let best: { nn: string; day: number } | null = null;
  for (const [k, v] of Object.entries(settings)) { const i = k.indexOf("温度曲线.日龄"); if (i < 0) continue; const nn = k.slice(i + "温度曲线.日龄".length); if (!/^\d+$/.test(nn)) continue; const d = Number(v); if (!Number.isFinite(d) || d <= 0 || d > age) continue; if (!best || d >= best.day) best = { nn, day: d }; }
  return best?.nn ?? null;
}

async function flockAge(houseId: string): Promise<number | null> {
  const rows = await db.select({ tagId: iotReadings.tagId, value: iotReadings.value, at: iotReadings.fetchedAt }).from(iotReadings).where(eq(iotReadings.houseId, houseId));
  let best: { v: string; at: Date } | null = null;
  for (const r of rows) { const leaf = r.tagId.split(".").pop(); if ((leaf === "日龄" || leaf === "当前日龄") && r.value != null && (!best || r.at > best.at)) best = { v: r.value, at: r.at }; }
  const n = Number(best?.v); return Number.isFinite(n) ? n : null;
}

/** What the hour asks of one shed: the two registers, where they stand, where they should. Null when nothing is to be done. */
export async function planSetback(houseId: string, hour = istHour()) {
  const { params, enabled, rows } = await ruleParams(houseId);
  const own = rows.find((r) => r.key === RULE && r.houseId === houseId);
  if (!own?.enabled || enabled[RULE as keyof typeof enabled] === false) return null;
  const p = { nightFrom: 18.17, nightTo: 5.67, setback: 1, ...((params as Record<string, Record<string, number>>)[RULE] ?? {}) };
  const state = (own.params as State) ?? {};
  const snap = await latestSnapshot(houseId);
  if (!snap) return null;
  const settings = snap.values as Record<string, string>;
  const nn = curveRow(settings, await flockAge(houseId));
  if (!nn) return null;
  const targetReg = Object.keys(settings).find((k) => k.endsWith(`温度曲线.目标温度${nn}`));
  const tunnelReg = Object.keys(settings).find((k) => k.endsWith(`温度曲线.纵向通风温度${nn}`));
  if (!targetReg || !tunnelReg) return null;
  const target = Number(settings[targetReg]), tunnel = Number(settings[tunnelReg]);
  const night = isNight(hour, p.nightFrom, p.nightTo);
  if (night && !state.nightOn) return { p, state, snap, settings, night, steps: [[targetReg, target, r1(target - p.setback)], [tunnelReg, tunnel, r1(tunnel - p.setback)]] as Array<[string, number, number]>, dayTarget: target, dayTunnel: tunnel };
  if (!night && state.nightOn && state.dayTarget != null && state.dayTunnel != null) return { p, state, snap, settings, night, steps: [[tunnelReg, tunnel, state.dayTunnel], [targetReg, target, state.dayTarget]] as Array<[string, number, number]>, dayTarget: state.dayTarget, dayTunnel: state.dayTunnel };
  return null;
}

export async function nightSetbackTick(): Promise<SetbackResult[]> {
  const out: SetbackResult[] = [];
  const sheds = await db.select({ id: houses.id, code: houses.code, device: houses.bhDeviceId }).from(houses).where(and(sql`${houses.bhDeviceId} IS NOT NULL`, eq(houses.isActive, true)));
  for (const h of sheds) {
    const plan = await planSetback(h.id);
    if (!plan || !h.device) continue;
    const { farm } = await ruleParams(h.id);
    if (!farm.writesEnabled) { out.push({ code: h.code, note: "writing is off for the farm" }); continue; }
    if ((await houseMode(h.id)) === "hold") { out.push({ code: h.code, note: "on hold" }); continue; }
    if (plan.state.lastTryAt && Date.now() - new Date(plan.state.lastTryAt).getTime() < 30 * 60_000) continue; // a failed try waits half an hour
    const changes = plan.steps.filter(([, was, will]) => Math.abs(was - will) >= 0.05).map(([register, was, will]) => ({ register, label: register.includes("目标温度") ? "Target, age row in force" : "Tunnel temperature, age row in force", unit: "°C", before: String(was), after: String(will), critical: true }));
    if (!changes.length) { await saveRule(RULE, h.id, { ...plan.state, nightOn: plan.night, dayTarget: plan.night ? plan.dayTarget : null, dayTunnel: plan.night ? plan.dayTunnel : null, lastTryAt: null }, true, null); continue; }
    const bc = checkBounds(changes, await farmBounds());
    const title = plan.night ? `Night: target and tunnel temperature ${plan.p.setback}° lower until ${fmtHour(plan.p.nightTo)}` : "Day: target and tunnel temperature back to the curve";
    const reason = plan.night
      ? `It is ${fmtHour(istHour())} IST. From ${fmtHour(plan.p.nightFrom)} to ${fmtHour(plan.p.nightTo)} this shed aims ${plan.p.setback}° lower, and because the tunnel ladder is anchored to the tunnel temperature, that moves with the target: the ladder sits about ${Math.round(plan.p.setback / 0.25)} steps higher through the night. The target goes down first, then the tunnel temperature, which the controller requires.`
      : `It is ${fmtHour(istHour())} IST, past ${fmtHour(plan.p.nightTo)}: the tunnel temperature goes back up first, then the target, to the day's ${plan.dayTunnel} and ${plan.dayTarget}.`;
    const [prop] = await db.insert(controllerProposals).values({ houseId: h.id, rule: RULE, title, reason: bc.ok ? reason : `${reason} Outside the farm's bounds (${bc.violations.join("; ")}), so not written.`, evidence: { ...plan.p, night: plan.night, auto: bc.ok, schedule: true }, changes, status: bc.ok ? "approved" : "open", decidedAt: bc.ok ? new Date() : null, snapshotBefore: plan.snap.id }).returning({ id: controllerProposals.id });
    if (!bc.ok) { out.push({ code: h.code, note: `outside bounds: ${bc.violations.join("; ")}` }); continue; }
    const registers: unknown[] = []; let ok = true; let err: string | undefined;
    try {
      const st = await fetchDeviceStatus(h.device);
      if (!st.isLiving) throw new Error("controller not reachable");
      for (const c of changes) { // one at a time, in the order the controller needs
        const rec = await writeAndConfirm(h.device, [{ key: `${h.device}.${c.register}`, value: c.after }]);
        registers.push(...rec.registers);
        if (!rec.confirmed) { ok = false; break; }
        await db.insert(controllerChanges).values({ houseId: h.id, register: c.register, pageCode: null, before: c.before, after: c.after, seenAt: new Date(), source: "niko" });
        plan.settings[c.register] = c.after;
        await db.execute(sql`UPDATE controller_snapshots SET values = ${JSON.stringify(plan.settings)}::jsonb WHERE id = ${plan.snap.id}`);
      }
    } catch (e) { ok = false; err = e instanceof Error ? e.message : String(e); }
    await db.update(controllerProposals).set({ status: ok ? "written" : "failed", writtenAt: new Date(), writeRecord: { confirmed: ok, registers, error: err } }).where(eq(controllerProposals.id, prop!.id));
    await saveRule(RULE, h.id, ok ? { ...plan.state, nightOn: plan.night, dayTarget: plan.night ? plan.dayTarget : null, dayTunnel: plan.night ? plan.dayTunnel : null, lastTryAt: null } : { ...plan.state, dayTarget: plan.dayTarget, dayTunnel: plan.dayTunnel, lastTryAt: new Date().toISOString() }, true, null);
    out.push({ code: h.code, note: `${plan.night ? "night" : "day"}: ${changes.map((c) => `${c.before}→${c.after}`).join(", ")} ${ok ? "written and confirmed" : `FAILED${err ? `: ${err}` : ""}`}` });
  }
  return out;
}

/** The newest setback decisions for a shed, for the page. */
export async function recentSetbacks(houseId: string, limit = 6) {
  return db.select().from(controllerProposals).where(and(eq(controllerProposals.houseId, houseId), eq(controllerProposals.rule, RULE))).orderBy(desc(controllerProposals.createdAt)).limit(limit);
}
