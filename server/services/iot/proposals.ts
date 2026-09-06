/**
 * Proposals: what the rules want changed, and what happened when someone
 * said yes.
 *
 * Evaluation runs every morning and on demand. For each house it takes the
 * kept settings, the week's statistics and the flock's age, asks every enabled
 * rule, and keeps each answer as an open proposal — unless an identical one
 * is already open, in which case nothing new is written; or an open one for
 * the same rule now says something different, in which case the old one is
 * superseded. A person approves or dismisses; approval writes through
 * `writeAndConfirm`, records the controller's readback, logs the change as
 * niko's own, and the nightly snapshot then has nothing to report.
 *
 * Writing is off for the whole farm until a manager turns it on in the rule
 * settings (`farm.writesEnabled`). Until then proposals can be read and
 * dismissed but not approved.
 */
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { controllerChanges, controllerProposals, controllerRules, houses } from "@shared/schema";
import { db } from "../../db";
import { fetchDeviceStatus } from "./bhfarm";
import { getCatalog, ladderFans, latestSnapshot, snapshotHouse } from "./controls";
import { writeAndConfirm } from "./control";
import { weekStats } from "./house-stats";
import { evaluate, RULES, type Draft, type RuleKey } from "./rules";

/* ── Rule parameters: farm defaults, per-house overrides ───────────────── */

export const FARM_KEY = "farm";
export interface FarmSettings {
  /** Nothing is written to any controller while this is false. */
  writesEnabled: boolean;
}

export async function ruleParams(houseId: string | null): Promise<{
  params: Partial<Record<RuleKey, Record<string, number>>>;
  enabled: Partial<Record<RuleKey, boolean>>;
  farm: FarmSettings;
  rows: Array<{ key: string; houseId: string | null; params: unknown; enabled: boolean }>;
}> {
  const rows = await db
    .select({ key: controllerRules.key, houseId: controllerRules.houseId, params: controllerRules.params, enabled: controllerRules.enabled })
    .from(controllerRules)
    .where(houseId ? sql`${controllerRules.houseId} IS NULL OR ${controllerRules.houseId} = ${houseId}::uuid` : isNull(controllerRules.houseId));
  const params: Partial<Record<RuleKey, Record<string, number>>> = {};
  const enabled: Partial<Record<RuleKey, boolean>> = {};
  const farm: FarmSettings = { writesEnabled: false };
  // farm level first, then the house's own over it
  for (const r of [...rows].sort((a, b) => (a.houseId ? 1 : 0) - (b.houseId ? 1 : 0))) {
    if (r.key === FARM_KEY) {
      Object.assign(farm, r.params as Partial<FarmSettings>);
      continue;
    }
    if (!(r.key in RULES)) continue;
    const k = r.key as RuleKey;
    params[k] = { ...(params[k] ?? {}), ...(r.params as Record<string, number>) };
    enabled[k] = r.enabled;
  }
  return { params, enabled, farm, rows };
}

export async function saveRule(key: string, houseId: string | null, params: Record<string, unknown>, enabled: boolean, userId: string | null) {
  const [existing] = await db
    .select({ id: controllerRules.id })
    .from(controllerRules)
    .where(and(eq(controllerRules.key, key), houseId ? eq(controllerRules.houseId, houseId) : isNull(controllerRules.houseId)));
  if (existing) {
    await db.update(controllerRules).set({ params, enabled, updatedBy: userId, updatedAt: new Date() }).where(eq(controllerRules.id, existing.id));
  } else {
    await db.insert(controllerRules).values({ key, houseId, params, enabled, updatedBy: userId });
  }
}

/* ── Evaluation ────────────────────────────────────────────────────────── */

export interface EvaluationResult {
  houseId: string;
  code: string;
  drafts: number;
  created: number;
  superseded: number;
  skipped?: string;
}

async function houseContext(houseId: string, code: string) {
  const cat = await getCatalog();
  const snap = await latestSnapshot(houseId);
  if (!cat || !snap) return null;
  const settings = snap.values as Record<string, string>;
  const fansAtStep = await ladderFans(houseId);
  const tunnelStep = Number(Object.entries(settings).find(([k]) => k.endsWith("通风级别调整.纵向通风开启级别"))?.[1]) || null;
  const ageDays = Number(Object.entries(settings).find(([k]) => k.endsWith("日龄.当前日龄"))?.[1]) || null;
  const stats = await weekStats(houseId, fansAtStep, tunnelStep);
  return { code, ageDays, settings, catalog: cat, stats, fansAtStep };
}

const sameChanges = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Ask every rule about one house and keep what they say. */
export async function evaluateHouse(houseId: string): Promise<EvaluationResult> {
  const [h] = await db.select({ code: houses.code }).from(houses).where(eq(houses.id, houseId));
  const code = h?.code ?? "?";
  const ctx = await houseContext(houseId, code);
  if (!ctx) return { houseId, code, drafts: 0, created: 0, superseded: 0, skipped: "no catalogue or no kept settings yet" };
  const { params, enabled } = await ruleParams(houseId);
  const drafts = evaluate(ctx, params, enabled);

  const open = await db
    .select()
    .from(controllerProposals)
    .where(and(eq(controllerProposals.houseId, houseId), eq(controllerProposals.status, "open")));
  let created = 0;
  let superseded = 0;
  const seen = new Set<string>();
  for (const d of drafts) {
    seen.add(d.rule);
    const existing = open.find((o) => o.rule === d.rule);
    if (existing && sameChanges(existing.changes, d.changes) && existing.reason === d.reason) continue;
    if (existing) {
      await db.update(controllerProposals).set({ status: "superseded", decidedAt: new Date() }).where(eq(controllerProposals.id, existing.id));
      superseded++;
    }
    await db.insert(controllerProposals).values({
      houseId,
      rule: d.rule,
      title: d.title,
      reason: d.reason,
      evidence: { ...d.evidence, week: summarise(ctx.stats) },
      changes: d.changes,
    });
    created++;
  }
  // a rule that no longer has anything to say withdraws its open proposal
  for (const o of open) {
    if (!seen.has(o.rule) && o.status === "open") {
      await db.update(controllerProposals).set({ status: "superseded", decidedAt: new Date() }).where(eq(controllerProposals.id, o.id));
      superseded++;
    }
  }
  return { houseId, code, drafts: drafts.length, created, superseded };
}

function summarise(s: Awaited<ReturnType<typeof weekStats>>) {
  const { hoursAtOrBelowStep: _drop, ...rest } = s;
  return rest;
}

export async function evaluateAll(): Promise<EvaluationResult[]> {
  const rows = await db
    .select({ id: houses.id, code: houses.code })
    .from(houses)
    .where(and(sql`${houses.bhDeviceId} IS NOT NULL`, eq(houses.isActive, true)));
  const out: EvaluationResult[] = [];
  for (const r of rows) {
    try {
      out.push(await evaluateHouse(r.id));
    } catch (e) {
      out.push({ houseId: r.id, code: r.code, drafts: 0, created: 0, superseded: 0, skipped: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

/* ── Deciding ──────────────────────────────────────────────────────────── */

export async function listProposals(houseId: string, status: string[] = ["open"], limit = 100) {
  return db
    .select()
    .from(controllerProposals)
    .where(and(eq(controllerProposals.houseId, houseId), inArray(controllerProposals.status, status)))
    .orderBy(desc(controllerProposals.createdAt))
    .limit(limit);
}

export async function dismissProposal(id: number, userId: string) {
  await db
    .update(controllerProposals)
    .set({ status: "dismissed", decidedBy: userId, decidedAt: new Date() })
    .where(and(eq(controllerProposals.id, id), eq(controllerProposals.status, "open")));
}

export class WritesDisabled extends Error {
  constructor() {
    super("Writing to controllers is switched off for the farm. A manager turns it on under the rules.");
  }
}

/**
 * Approve: keep a snapshot first, write through the one path, record the
 * readback, and log each register as changed by niko so the night's diff
 * does not report it as done outside.
 */
export async function approveProposal(id: number, userId: string) {
  const [p] = await db.select().from(controllerProposals).where(eq(controllerProposals.id, id));
  if (!p) throw new Error("No such proposal");
  if (p.status !== "open") throw new Error(`Proposal is ${p.status}`);
  const changes = p.changes as Array<{ register: string; label: string; unit: string; before: string | null; after: string }>;
  if (!changes.length) throw new Error("This proposal has nothing to write; it asks for a sitting at the panel.");
  const { farm } = await ruleParams(p.houseId);
  if (!farm.writesEnabled) throw new WritesDisabled();

  const [h] = await db.select({ code: houses.code, device: houses.bhDeviceId }).from(houses).where(eq(houses.id, p.houseId));
  if (!h?.device) throw new Error("This house names no controller");
  const status = await fetchDeviceStatus(h.device);
  if (!status.isLiving) throw new Error(`${h.code}'s controller is not reachable; nothing was written`);

  const before = await snapshotHouse(p.houseId);
  const snapBefore = await latestSnapshot(p.houseId);
  await db
    .update(controllerProposals)
    .set({ status: "approved", decidedBy: userId, decidedAt: new Date(), snapshotBefore: snapBefore?.id ?? null })
    .where(eq(controllerProposals.id, id));

  let record;
  try {
    record = await writeAndConfirm(
      h.device,
      changes.map((c) => ({ key: `${h.device}.${c.register}`, value: c.after })),
    );
  } catch (e) {
    await db.update(controllerProposals).set({ status: "failed", writeRecord: { error: e instanceof Error ? e.message : String(e) } }).where(eq(controllerProposals.id, id));
    throw e;
  }
  const ok = record.confirmed;
  await db
    .update(controllerProposals)
    .set({ status: ok ? "written" : "failed", writtenAt: new Date(), writeRecord: record })
    .where(eq(controllerProposals.id, id));
  if (record.registers.some((r) => r.took)) {
    await db.insert(controllerChanges).values(
      record.registers
        .filter((r) => r.took)
        .map((r) => ({
          houseId: p.houseId,
          register: r.fullName.replace(`${h.device}.`, ""),
          pageCode: null,
          before: r.before,
          after: r.after,
          seenAt: new Date(),
          source: "niko",
        })),
    );
    // fold the new values into the kept copy so the page and the next evaluation see them
    const snap = await latestSnapshot(p.houseId);
    if (snap) {
      const values = { ...(snap.values as Record<string, string>) };
      for (const r of record.registers) if (r.took && r.after != null) values[r.fullName.replace(`${h.device}.`, "")] = r.after;
      await db.execute(sql`UPDATE controller_snapshots SET values = ${JSON.stringify(values)}::jsonb WHERE id = ${snap.id}`);
    }
  }
  return { proposal: id, house: h.code, before: before.takenAt, record };
}
