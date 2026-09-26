import { Router } from "express";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { forgetSites } from "../services/punch-sites";
import { locations, stockLocations } from "@shared/schema";
import { db } from "../db";
import { requirePermission } from "../lib/rbac";
import { gstStateCode, validateBody } from "../lib/validate";

export const locationsRouter = Router();

/**
 * A point is stored as an exact decimal, not a float: a coordinate typed by a
 * person is a decimal, and drizzle hands numeric columns strings. Null clears
 * it, which is how a site stops claiming punches.
 */
const point = (v: number | null | undefined) => (v == null ? v : String(v));

/**
 * A location's one store, named after it.
 *
 * Every stock movement lands in a store, so a location without one cannot hold
 * anything: a mill added from Settings could not produce. It is not a second
 * place — Dhekiajuli IS the mill and the mill is its store — just the row the
 * stock ledger needs. Named from the location so a rename carries it along;
 * the old migration's names stayed behind when Nalbari became Nabil.
 */
const mainStoreName = (name: string) => `${name} — main store`;

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
  stateCode: gstStateCode.optional(),
  pincode: z.string().max(10).optional(),
  phone: z.string().max(20).optional(),
  inCharge: z.string().optional(),
  /**
   * Where this place actually is, and how far around it still counts as being
   * here. A punch carries raw GPS and nothing else; these are what turn that
   * into "at the mill" rather than "somewhere in Assam". Left blank, the site
   * simply never claims a punch — better a missing letter than a wrong one.
   */
  latitude: z.coerce.number().min(-90).max(90).nullable().optional(),
  longitude: z.coerce.number().min(-180).max(180).nullable().optional(),
  radiusM: z.coerce.number().int().min(50).max(50_000).optional(),
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
    const { latitude, longitude, ...rest } = req.body as z.infer<typeof locationSchema>;
    const body = { ...rest, latitude: point(latitude), longitude: point(longitude) };
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
        await tx
          .insert(stockLocations)
          .values({ locationId: created!.id, code: "MAIN", name: mainStoreName(created!.name), kind: "main" });
        return created!;
      });
      forgetSites();
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
    const { latitude, longitude, ...rest } = req.body as Partial<z.infer<typeof locationSchema>>;
    const body = {
      ...rest,
      ...(latitude !== undefined && { latitude: point(latitude) }),
      ...(longitude !== undefined && { longitude: point(longitude) }),
    };
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
        if (updated!.name !== existing.name) {
          await tx
            .update(stockLocations)
            .set({ name: mainStoreName(updated!.name) })
            .where(and(eq(stockLocations.locationId, existing.id), eq(stockLocations.kind, "main")));
        }
        return updated!;
      });
      forgetSites();
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
  forgetSites();
  res.json({ ok: true });
});
