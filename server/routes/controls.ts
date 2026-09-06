/**
 * The Controls page's API: the catalogue, a page with the controller's live
 * values, what changed outside niko, and snapshots on demand.
 *
 * Read-only in stage 1. Viewing is the farms view permission; taking a
 * snapshot or refreshing the catalogue asks the vendor for a few thousand
 * values and is kept to those who manage houses.
 */
import { Router } from "express";
import { eq } from "drizzle-orm";
import { houses } from "@shared/schema";
import { db } from "../db";
import { requirePermission } from "../lib/rbac";
import { fetchDeviceStatus } from "../services/iot/bhfarm";
import {
  getCatalog,
  latestSnapshot,
  pageKept,
  recentChanges,
  refreshPage,
  refreshCatalog,
  snapshotAll,
  snapshotHouse,
} from "../services/iot/controls";
import {
  FARM_KEY,
  approveProposal,
  dismissProposal,
  evaluateAll,
  evaluateHouse,
  listProposals,
  ruleParams,
  saveRule,
  WritesDisabled,
} from "../services/iot/proposals";
import { RULES } from "../services/iot/rules";

export const controlsRouter = Router();
const view = requirePermission("farms", "view");
const manage = requirePermission("farms", "manage");
/** Approving a proposal writes to a live shed; its own permission, granted to named people. */
const control = requirePermission("farms", "control");

/** The pages of the model's catalogue, without their registers — the tree the page draws. */
controlsRouter.get("/catalog", view, async (_req, res) => {
  const cat = await getCatalog();
  if (!cat) return res.json({ model: null, fetchedAt: null, pages: [] });
  res.json({
    model: cat.model,
    fetchedAt: cat.fetchedAt,
    pages: cat.pages.map((p) => ({
      code: p.code,
      type: p.type,
      position: p.position,
      path: p.path,
      pathEn: p.pathEn,
      registers: p.registers.length,
      readOnly: p.readOnlyRegisters.length,
    })),
  });
});

/** Fetch the catalogue afresh from the vendor, through the first house that names a controller. */
controlsRouter.post("/catalog/refresh", manage, async (_req, res) => {
  const [h] = await db
    .select({ device: houses.bhDeviceId })
    .from(houses)
    .where(eq(houses.isActive, true))
    .orderBy(houses.displayOrder);
  const source = h?.device;
  if (!source) return res.status(422).json({ error: "No house names a controller" });
  const cat = await refreshCatalog(source);
  res.json({ model: cat.model, fetchedAt: cat.fetchedAt, pages: cat.pages.length });
});

/** Whether the controller answers, and when its settings were last kept. */
controlsRouter.get("/:houseId/status", view, async (req, res) => {
  const [h] = await db
    .select({ id: houses.id, code: houses.code, device: houses.bhDeviceId })
    .from(houses)
    .where(eq(houses.id, req.params.houseId!));
  if (!h) return res.status(404).json({ error: "No such house" });
  if (!h.device) return res.json({ code: h.code, controller: false, live: false, snapshot: null });
  const [status, snap] = await Promise.all([
    fetchDeviceStatus(h.device).catch(() => ({ isLiving: false, lastStatusTime: null })),
    latestSnapshot(h.id),
  ]);
  res.json({
    code: h.code,
    controller: true,
    live: status.isLiving,
    snapshot: snap ? { takenAt: snap.takenAt, registers: snap.registers } : null,
  });
});

/** One page, as the catalogue defines it, with the values as last kept — instant, no controller in the loop. */
controlsRouter.get("/:houseId/page/:code", view, async (req, res) => {
  try {
    res.json(await pageKept(req.params.houseId!, req.params.code!));
  } catch (e) {
    res.status(422).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/** The same page from the controller itself; folds the answer into the kept copy and records what moved. */
controlsRouter.get("/:houseId/page/:code/live", view, async (req, res) => {
  try {
    res.json(await refreshPage(req.params.houseId!, req.params.code!));
  } catch (e) {
    res.status(422).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/** Registers that differed between snapshots, newest first. */
controlsRouter.get("/:houseId/changes", view, async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days ?? 30), 1), 365);
  res.json({ changes: await recentChanges(req.params.houseId!, days) });
});

/** Read every register of one house now and keep it. */
controlsRouter.post("/:houseId/snapshot", manage, async (req, res) => {
  try {
    res.json(await snapshotHouse(req.params.houseId!));
  } catch (e) {
    res.status(422).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/** Every house, as the nightly job does. */
controlsRouter.post("/snapshot-all", manage, async (_req, res) => {
  res.json({ results: await snapshotAll() });
});

/* ── Stage 2: rules and proposals ──────────────────────────────────────── */

/** The rules, their defaults, and what the farm and this house have set. */
controlsRouter.get("/rules", view, async (req, res) => {
  const houseId = typeof req.query.houseId === "string" && req.query.houseId ? req.query.houseId : null;
  const { params, enabled, farm, rows } = await ruleParams(houseId);
  res.json({
    farm,
    rules: (Object.keys(RULES) as Array<keyof typeof RULES>).map((key) => ({
      key,
      title: RULES[key].title,
      description: RULES[key].description,
      defaults: RULES[key].params,
      params: params[key] ?? {},
      enabled: enabled[key] ?? true,
      houseOverride: rows.some((r) => r.key === key && r.houseId === houseId && houseId !== null),
    })),
  });
});

/** Set a rule's parameters, for the farm or for one house. */
controlsRouter.put("/rules/:key", manage, async (req, res) => {
  const key = req.params.key!;
  if (key !== FARM_KEY && !(key in RULES)) return res.status(404).json({ error: "No such rule" });
  const body = req.body as { houseId?: string | null; params?: Record<string, unknown>; enabled?: boolean };
  await saveRule(key, body.houseId ?? null, body.params ?? {}, body.enabled ?? true, req.session.user?.id ?? null);
  res.json({ ok: true });
});

/** Open proposals for a house, or its history. */
controlsRouter.get("/:houseId/proposals", view, async (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status.split(",") : ["open"];
  res.json({ proposals: await listProposals(req.params.houseId!, status) });
});

/** Ask the rules now, for one house or for all. */
controlsRouter.post("/proposals/evaluate", manage, async (req, res) => {
  const houseId = (req.body as { houseId?: string })?.houseId;
  res.json({ results: houseId ? [await evaluateHouse(houseId)] : await evaluateAll() });
});

/** Say yes: write through the one path, with readback. */
controlsRouter.post("/proposals/:id/approve", control, async (req, res) => {
  try {
    res.json(await approveProposal(Number(req.params.id), req.session.user!.id));
  } catch (e) {
    res.status(e instanceof WritesDisabled ? 423 : 422).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/** Say no. The rule may raise it again when the week changes. */
controlsRouter.post("/proposals/:id/dismiss", control, async (req, res) => {
  await dismissProposal(Number(req.params.id), req.session.user!.id);
  res.json({ ok: true });
});
