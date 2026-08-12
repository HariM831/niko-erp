import { Router } from "express";
import { asc, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { locations } from "@shared/schema";
import { db } from "../db";
import { requirePermission } from "../lib/rbac";
import { validateBody } from "../lib/validate";

export const locationsRouter = Router();

const locationSchema = z.object({
  code: z
    .string()
    .min(1)
    .max(12)
    .regex(/^[A-Za-z0-9-]+$/, { message: "Letters, numbers and dashes only" }),
  name: z.string().min(1),
  type: z.enum(["farm", "feed_mill", "warehouse", "office"]),
  isPrimary: z.boolean().optional(),
  addressLine1: z.string().optional(),
  addressLine2: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  stateCode: z.string().max(4).optional(),
  pincode: z.string().max(10).optional(),
  phone: z.string().max(20).optional(),
  inCharge: z.string().optional(),
  notes: z.string().optional(),
  isActive: z.boolean().optional(),
});

locationsRouter.get("/", requirePermission("settings", "view"), async (_req, res) => {
  const rows = await db
    .select()
    .from(locations)
    .orderBy(asc(locations.type), asc(locations.name));
  res.json(rows);
});

locationsRouter.post(
  "/",
  requirePermission("settings", "create"),
  validateBody(locationSchema),
  async (req, res) => {
    const body = req.body as z.infer<typeof locationSchema>;
    const code = body.code.toUpperCase();
    try {
      const row = await db.transaction(async (tx) => {
        const [existing] = await tx.select({ n: sql<number>`count(*)::int` }).from(locations);
        // The first location is automatically the primary one — an org always
        // has somewhere transactions belong by default.
        const primary = body.isPrimary || Number(existing?.n ?? 0) === 0;
        if (primary) await tx.update(locations).set({ isPrimary: false });
        const [created] = await tx
          .insert(locations)
          .values({ ...body, code, isPrimary: primary })
          .returning();
        return created!;
      });
      res.status(201).json(row);
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      if (message.includes("locations_code_unique")) {
        return res.status(422).json({ error: `Code "${code}" is already used` });
      }
      if (message.includes("locations_name_unique")) {
        return res.status(422).json({ error: `A location named "${body.name}" already exists` });
      }
      throw err;
    }
  },
);

locationsRouter.patch(
  "/:id",
  requirePermission("settings", "edit"),
  validateBody(locationSchema.partial()),
  async (req, res) => {
    const body = req.body as Partial<z.infer<typeof locationSchema>>;
    const existing = await db.query.locations.findFirst({
      where: eq(locations.id, req.params.id!),
    });
    if (!existing) return res.status(404).json({ error: "Location not found" });

    // The primary location is where transactions land by default, so it has to
    // exist and has to be usable.
    if (existing.isPrimary && body.isPrimary === false) {
      return res
        .status(422)
        .json({ error: "Make another location primary instead of clearing this one" });
    }
    if (existing.isPrimary && body.isActive === false) {
      return res
        .status(422)
        .json({ error: "The primary location cannot be deactivated — promote another one first" });
    }

    try {
      const row = await db.transaction(async (tx) => {
        if (body.isPrimary) {
          await tx.update(locations).set({ isPrimary: false }).where(ne(locations.id, existing.id));
        }
        const [updated] = await tx
          .update(locations)
          .set({
            ...body,
            ...(body.code && { code: body.code.toUpperCase() }),
            updatedAt: new Date(),
          })
          .where(eq(locations.id, existing.id))
          .returning();
        return updated!;
      });
      res.json(row);
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      if (message.includes("locations_code_unique")) {
        return res.status(422).json({ error: "That code is already used" });
      }
      if (message.includes("locations_name_unique")) {
        return res.status(422).json({ error: "That name is already used" });
      }
      throw err;
    }
  },
);

locationsRouter.delete("/:id", requirePermission("settings", "delete"), async (req, res) => {
  const existing = await db.query.locations.findFirst({
    where: eq(locations.id, req.params.id!),
  });
  if (!existing) return res.status(404).json({ error: "Location not found" });
  if (existing.isPrimary) {
    return res.status(422).json({ error: "The primary location cannot be deleted" });
  }
  // Nothing references locations yet. Once the operational modules do, this
  // becomes a usage check rather than a straight delete.
  await db.delete(locations).where(eq(locations.id, existing.id));
  res.json({ ok: true });
});
