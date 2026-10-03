/**
 * The NIR bench — scans uploaded from the PC beside the weighbridge, and the
 * link between each calibration model and the material it is for.
 *
 * The bench PC runs IAS, which writes every scan to its own SQLite file. The
 * Weighment page reads that file in the browser and posts what it finds here;
 * see client/src/lib/nir-feed.ts. Nothing is judged on arrival — QC does that.
 */
import { Router } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { nirModelItems } from "@shared/schema";
import { db } from "../db";
import { requireAnyPermission, requirePermission } from "../lib/rbac";
import { validateBody } from "../lib/validate";
import { benchStatus, ingest } from "../services/nir";

export const nirRouter = Router();

/**
 * The weighbridge operator and the QC technician share the desk, and whichever
 * of them has the Weighment page open is the one whose browser uploads.
 */
const atTheBench = requireAnyPermission([
  ["office", "quality_control"],
  ["office", "weighbridge"],
]);

const row = z.object({
  iasId: z.number().int(),
  resultSn: z.string().min(1).max(60),
  deviceSn: z.string().min(1).max(40),
  model: z.string().min(1).max(60),
  modelVersion: z.string().max(20).nullable(),
  sampleName: z.string().max(200).nullable(),
  scannedAt: z.string().datetime({ offset: true }),
  iasStatus: z.number().int().nullable(),
  readings: z.record(z.string(), z.number()),
  flags: z.record(z.string(), z.number()),
  raw: z.unknown(),
});

nirRouter.post(
  "/results",
  atTheBench,
  validateBody(
    z.object({
      deviceSn: z.string().max(40).nullable(),
      models: z
        .array(
          z.object({
            shortName: z.string().min(1).max(60),
            modelName: z.string().nullable(),
            version: z.string().max(20).nullable(),
            matterNames: z.record(z.string(), z.string()),
          }),
        )
        .max(200),
      rows: z.array(row).max(500),
    }),
  ),
  async (req, res) => {
    const body = req.body as {
      deviceSn: string | null;
      models: Parameters<typeof ingest>[2];
      rows: Parameters<typeof ingest>[1];
    };
    const out = await db.transaction((tx) =>
      ingest(tx, body.rows, body.models, body.deviceSn, req.session.user!.id),
    );
    res.json(out);
  },
);

nirRouter.get("/status", atTheBench, async (_req, res) => {
  res.json(await benchStatus(db));
});

/**
 * Link a model to a material, or unlink it.
 *
 * Writing this decides which figures land on which truck's QC, so it is the
 * rule-writer's permission, not the bench's — the same split as deduction rules.
 */
nirRouter.put(
  "/models/:shortName/items",
  requirePermission("office", "manage_rules"),
  validateBody(z.object({ itemIds: z.array(z.string().uuid()).max(50) })),
  async (req, res) => {
    const shortName = req.params.shortName!;
    const { itemIds } = req.body as { itemIds: string[] };
    try {
      await db.transaction(async (tx) => {
        await tx.delete(nirModelItems).where(eq(nirModelItems.shortName, shortName));
        if (itemIds.length) {
          await tx.insert(nirModelItems).values(
            itemIds.map((itemId) => ({ shortName, itemId, createdBy: req.session.user!.id })),
          );
        }
      });
    } catch (err) {
      if (err instanceof LinkError) return res.status(422).json({ error: err.message });
      if ((err as { code?: string }).code === "23505") {
        return res.status(409).json({ error: "That material is already linked to another NIR model" });
      }
      throw err;
    }
    res.json({ ok: true });
  },
);

class LinkError extends Error {}
