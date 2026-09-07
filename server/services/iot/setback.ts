/**
 * A night target, on a controller that has none.
 *
 * The Big Herdsman 9200 holds one target per age row and no day-and-night
 * pair; what L3 shows as 27 and 26 are two age rows of its curve. The one
 * handle it does offer is the curve page's target correction, added to the
 * row's target whatever the hour. So a night setback is niko writing that
 * correction at dusk and clearing it at dawn, through the same confirmed
 * write path as every approval, and logged as a proposal that niko decided
 * itself.
 *
 * Off everywhere until a manager enables the rule for a shed and writes are
 * on for the farm. First of the live loops; the pattern the rest will use.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { controllerChanges, controllerProposals, houses } from "@shared/schema";
import { db } from "../../db";
import { fetchDeviceStatus } from "./bhfarm";
import { latestSnapshot } from "./controls";
import { writeAndConfirm } from "./control";
import { ruleParams } from "./proposals";

const REGISTER_SUFFIX = "曲线调整.目标温度修正";

/** Hour of day in IST, fractional. */
const istHour = (d = new Date()) => {
  const t = new Date(d.getTime() + 5.5 * 3_600_000);
  return t.getUTCHours() + t.getUTCMinutes() / 60;
};

/** Is `h` inside the night that starts at `from` and ends at `to`, either side of midnight? */
export const isNight = (h: number, from: number, to: number) => (from > to ? h >= from || h < to : h >= from && h < to);

export interface SetbackResult {
  code: string;
  wanted: number;
  had: number | null;
  written: boolean;
  note?: string;
}

/** For every shed with the rule on: make the correction what the hour says it should be. */
export async function nightSetbackTick(): Promise<SetbackResult[]> {
  const rows = await db
    .select({ id: houses.id, code: houses.code, device: houses.bhDeviceId })
    .from(houses)
    .where(and(sql`${houses.bhDeviceId} IS NOT NULL`, eq(houses.isActive, true)));
  const out: SetbackResult[] = [];
  for (const h of rows) {
    const { params, enabled, farm, rows: ruleRows } = await ruleParams(h.id);
    // Only a shed's OWN enablement counts: the farm-level row stays a default that says off.
    const own = ruleRows.find((r) => r.key === "night-setback" && r.houseId === h.id);
    if (!own?.enabled || !farm.writesEnabled || enabled["night-setback"] === false) continue;
    const p = { nightFrom: 20, nightTo: 5, setback: 1, ...(params["night-setback"] ?? {}) };
    const wanted = isNight(istHour(), p.nightFrom, p.nightTo) ? -Math.abs(p.setback) : 0;
    const snap = await latestSnapshot(h.id);
    const settings = (snap?.values ?? {}) as Record<string, string>;
    const register = Object.keys(settings).find((k) => k.endsWith(REGISTER_SUFFIX));
    if (!register || !h.device) {
      out.push({ code: h.code, wanted, had: null, written: false, note: "no kept settings or no correction register" });
      continue;
    }
    const had = Number(settings[register]);
    if (Number.isFinite(had) && Math.abs(had - wanted) < 0.05) {
      out.push({ code: h.code, wanted, had, written: false });
      continue;
    }
    // One attempt per transition: if the last try within the hour failed, wait for the next hour rather than hammer.
    const [recent] = await db
      .select({ status: controllerProposals.status, at: controllerProposals.createdAt })
      .from(controllerProposals)
      .where(and(eq(controllerProposals.houseId, h.id), eq(controllerProposals.rule, "night-setback")))
      .orderBy(desc(controllerProposals.createdAt))
      .limit(1);
    if (recent?.status === "failed" && Date.now() - recent.at.getTime() < 3_600_000) {
      out.push({ code: h.code, wanted, had, written: false, note: "last attempt failed; waiting an hour" });
      continue;
    }
    const status = await fetchDeviceStatus(h.device).catch(() => ({ isLiving: false }));
    if (!status.isLiving) {
      out.push({ code: h.code, wanted, had, written: false, note: "controller not reachable" });
      continue;
    }
    const title = wanted < 0 ? `Night setback on: target ${Math.abs(wanted)}° lower until ${fmtHour(p.nightTo)}` : `Night setback off: target back to the curve`;
    const reason =
      wanted < 0
        ? `It is ${fmtHour(istHour())} IST. Between ${fmtHour(p.nightFrom)} and ${fmtHour(p.nightTo)} the shed aims ${Math.abs(wanted)}° below its age row, so the ladder holds more air through the night.`
        : `It is ${fmtHour(istHour())} IST, past ${fmtHour(p.nightTo)}: the night correction comes off and the target is the age row's again.`;
    const [prop] = await db
      .insert(controllerProposals)
      .values({
        houseId: h.id,
        rule: "night-setback",
        title,
        reason,
        evidence: { nightFrom: p.nightFrom, nightTo: p.nightTo, setback: p.setback, hourIst: Math.round(istHour() * 100) / 100 },
        changes: [{ register: register.replace(`${h.device}.`, ""), label: "Target correction", unit: "°C", before: settings[register] ?? null, after: String(wanted), critical: true }],
        status: "approved",
        decidedAt: new Date(),
        snapshotBefore: snap?.id ?? null,
      })
      .returning({ id: controllerProposals.id });
    try {
      const record = await writeAndConfirm(h.device, [{ key: register.startsWith(h.device) ? register : `${h.device}.${register}`, value: String(wanted) }]);
      await db
        .update(controllerProposals)
        .set({ status: record.confirmed ? "written" : "failed", writtenAt: new Date(), writeRecord: record })
        .where(eq(controllerProposals.id, prop!.id));
      if (record.confirmed) {
        await db.insert(controllerChanges).values({
          houseId: h.id,
          register: register.replace(`${h.device}.`, ""),
          pageCode: null,
          before: settings[register] ?? null,
          after: String(wanted),
          seenAt: new Date(),
          source: "niko",
        });
        if (snap) {
          settings[register] = String(wanted);
          await db.execute(sql`UPDATE controller_snapshots SET values = ${JSON.stringify(settings)}::jsonb WHERE id = ${snap.id}`);
        }
      }
      out.push({ code: h.code, wanted, had, written: record.confirmed, note: record.confirmed ? undefined : "controller did not take it" });
      console.log(`[setback] ${h.code}: correction ${settings[register]} (wanted ${wanted}) — ${record.confirmed ? "written and confirmed" : "NOT confirmed"}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await db.update(controllerProposals).set({ status: "failed", writeRecord: { error: msg } }).where(eq(controllerProposals.id, prop!.id));
      out.push({ code: h.code, wanted, had, written: false, note: msg });
      console.warn(`[setback] ${h.code}: ${msg}`);
    }
  }
  return out;
}

const fmtHour = (h: number) => `${String(Math.floor(h)).padStart(2, "0")}:${String(Math.round((h % 1) * 60)).padStart(2, "0")}`;
