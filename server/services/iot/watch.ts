/**
 * The masters, watched between snapshots.
 *
 * A handful of settings decide the birds' day — the pad start, the target,
 * the floor and ceiling of the ladder, the alarms — and the controller
 * reports each of them as a plain reading alongside the temperatures. So the
 * five-minute poll already carries a twin of every master register, and a
 * change made at the panel shows up in the next poll rather than at the
 * 02:30 snapshot.
 *
 * On 7 September 2026 the operator at L2 lowered the pad start twice in the
 * morning, at 10:00 and 10:45, because the pads had no water and the shed was
 * getting hot; niko learned of it at 11:50, from the snapshot an approval
 * happened to take, and wrote over it. This is the fix: the change is logged
 * as made outside niko within five minutes, folded into the kept settings,
 * and shown on the board.
 *
 * Detection is reading-against-reading, not reading-against-snapshot: the
 * twin's value now versus its value at the previous poll. That sidesteps the
 * one trap in the mapping — a target the controller interpolates between age
 * rows would never match its row's register exactly — at the cost of missing
 * a change made while the server was down, which the nightly snapshot still
 * catches.
 */
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { controllerChanges, controllerProposals, houses, iotReadings } from "@shared/schema";
import { db } from "../../db";
import { latestSnapshot } from "./controls";

/** Reading (last segment) → how to find the register it mirrors in the kept settings. */
const TWINS: Array<{ leaf: string; label: string; register: (settings: Record<string, string>, age: number | null) => string | null }> = [
  { leaf: "制冷温度", label: "Pads start at", register: (s) => keyEnding(s, "制冷调整.制冷温度") },
  { leaf: "目标温度", label: "Target", register: (s, age) => rowRegister(s, "温度曲线.日龄", "温度曲线.目标温度", age) },
  { leaf: "高温报警温度", label: "High alarm", register: (s, age) => rowRegister(s, "温度曲线.日龄", "温度曲线.高温报警温度", age) },
  { leaf: "低温报警温度", label: "Low alarm", register: (s, age) => rowRegister(s, "温度曲线.日龄", "温度曲线.低温报警温度", age) },
  { leaf: "当前最小通风级别", label: "Ladder floor", register: (s, age) => rowRegister(s, "呼吸率曲线.日龄", "呼吸率曲线.最小级别", age) },
  { leaf: "当前最大通风级别", label: "Ladder ceiling", register: (s, age) => rowRegister(s, "呼吸率曲线.日龄", "呼吸率曲线.最大级别", age) },
  { leaf: "高压报警压力", label: "High pressure alarm", register: (s) => keyEnding(s, "负压设定.高压报警压力") },
  { leaf: "低压报警压力", label: "Low pressure alarm", register: (s) => keyEnding(s, "负压设定.低压报警压力") },
];

const keyEnding = (s: Record<string, string>, suffix: string) => Object.keys(s).find((k) => k.endsWith(suffix)) ?? null;

/** The register of an age-banded table's row in force: the highest starting age at or below the flock's. */
function rowRegister(s: Record<string, string>, dayPrefix: string, valuePrefix: string, age: number | null): string | null {
  if (age == null) return null;
  let best: { nn: string; day: number } | null = null;
  for (const [k, v] of Object.entries(s)) {
    const i = k.indexOf(dayPrefix);
    if (i < 0) continue;
    const nn = k.slice(i + dayPrefix.length);
    if (!/^\d+$/.test(nn)) continue;
    const day = Number(v);
    if (!Number.isFinite(day) || day <= 0 || day > age) continue;
    if (!best || day >= best.day) best = { nn, day };
  }
  return best ? keyEnding(s, `${valuePrefix}${best.nn}`) : null;
}

/** What each house's twins read at the previous poll. Seeded at boot; a restart forgets, the nightly snapshot remembers. */
const lastSeen = new Map<string, Map<string, string>>();

const asNumber = (v: string | null) => {
  if (v == null) return null;
  const n = Number(v === "True" ? 1 : v === "False" ? 0 : v);
  return Number.isFinite(n) ? n : null;
};

/** The newest value of each twin reading for a house, keyed on the reading's last segment. */
async function twinReadings(houseId: string): Promise<{ values: Map<string, string>; age: number | null }> {
  const rows = await db
    .select({ tagId: iotReadings.tagId, value: iotReadings.value, at: iotReadings.fetchedAt })
    .from(iotReadings)
    .where(eq(iotReadings.houseId, houseId));
  const newest = new Map<string, { value: string; at: Date }>();
  for (const r of rows) {
    const leaf = r.tagId.split(".").pop() ?? r.tagId;
    const held = newest.get(leaf);
    if (r.value != null && (!held || r.at > held.at)) newest.set(leaf, { value: r.value, at: r.at });
  }
  const values = new Map<string, string>();
  for (const t of TWINS) {
    const v = newest.get(t.leaf)?.value;
    if (v != null) values.set(t.leaf, v);
  }
  const age = asNumber(newest.get("日龄")?.value ?? newest.get("当前日龄")?.value ?? null);
  return { values, age };
}

/** Was this register niko's own doing in the last quarter hour, or is a write to it in flight? */
async function nikosOwn(houseId: string, register: string, leaf: string): Promise<boolean> {
  const since = new Date(Date.now() - 15 * 60_000);
  const [own] = await db
    .select({ id: controllerChanges.id })
    .from(controllerChanges)
    .where(and(eq(controllerChanges.houseId, houseId), eq(controllerChanges.source, "niko"), gte(controllerChanges.seenAt, since), sql`${controllerChanges.register} LIKE ${"%" + leaf.replace(/^当前/, "")}`))
    .limit(1);
  if (own) return true;
  const inflight = await db
    .select({ changes: controllerProposals.changes })
    .from(controllerProposals)
    .where(and(eq(controllerProposals.houseId, houseId), inArray(controllerProposals.status, ["approved", "written"]), gte(controllerProposals.decidedAt, since)));
  return inflight.some((p) => (p.changes as Array<{ register: string }>).some((c) => c.register === register || c.register.endsWith(leaf)));
}

export interface WatchEvent {
  code: string;
  label: string;
  register: string | null;
  before: string;
  after: string;
}

/** Compare every house's master twins with the previous poll; log, fold and report what moved. */
export async function watchMasters(): Promise<WatchEvent[]> {
  const rows = await db
    .select({ id: houses.id, code: houses.code })
    .from(houses)
    .where(and(sql`${houses.bhDeviceId} IS NOT NULL`, eq(houses.isActive, true)));
  const events: WatchEvent[] = [];
  for (const h of rows) {
    const { values, age } = await twinReadings(h.id);
    const prev = lastSeen.get(h.id);
    lastSeen.set(h.id, values);
    if (!prev) continue; // first sight since boot: seed, say nothing
    const snap = await latestSnapshot(h.id);
    const settings = (snap?.values ?? {}) as Record<string, string>;
    let folded = false;
    for (const t of TWINS) {
      const before = prev.get(t.leaf);
      const after = values.get(t.leaf);
      if (before == null || after == null) continue;
      const a = asNumber(before);
      const b = asNumber(after);
      if (a == null || b == null || Math.abs(a - b) < 0.05) continue;
      // L3's controller runs a day-and-night programme of its own: the target and both alarms glide
      // 27 → 26 from 18:11 and back from 05:41, a tenth or two every five minutes. That is the
      // controller, not a hand; a hand moves in halves and wholes. Seen 8–11 September 2026.
      if (Math.abs(a - b) < 0.35 && /温度/.test(t.leaf)) continue;
      const register = t.register(settings, age);
      if (register && (await nikosOwn(h.id, register, t.leaf))) continue;
      // A twin that moved because the flock crossed into the next age row is the curve, not a hand.
      if (register && settings[register] != null && Math.abs((asNumber(settings[register]) ?? NaN) - b) < 0.05) continue;
      await db.insert(controllerChanges).values({
        houseId: h.id,
        register: register ?? t.leaf,
        pageCode: null,
        before,
        after,
        seenAt: new Date(),
        source: "outside",
      });
      if (register) {
        settings[register] = after;
        folded = true;
      }
      events.push({ code: h.code, label: t.label, register, before, after });
      console.warn(`[watch] ${h.code}: ${t.label} changed at the panel, ${before} → ${after}${register ? "" : " (register not placed; kept settings unchanged)"}`);
    }
    if (folded && snap) {
      await db.execute(sql`UPDATE controller_snapshots SET values = ${JSON.stringify(settings)}::jsonb WHERE id = ${snap.id}`);
    }
  }
  return events;
}

/** Changes made outside niko on a house in the last day, for the board. */
export async function outsideChangesSince(houseId: string, since: Date): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(controllerChanges)
    .where(and(eq(controllerChanges.houseId, houseId), eq(controllerChanges.source, "outside"), gte(controllerChanges.seenAt, since)));
  return r?.n ?? 0;
}
