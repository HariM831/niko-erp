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

export const controlsRouter = Router();
const view = requirePermission("farms", "view");
const manage = requirePermission("farms", "manage");

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
