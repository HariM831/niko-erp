/**
 * Gates and weighbridges — the physical places office happens at.
 *
 * Reference data, not documents: no numbering, no journal, no lifecycle. Both
 * are scoped to a location because a gate belongs to a site, and knowing which
 * site a truck came in at is what makes a receipt traceable.
 *
 * Deactivated rather than deleted, always. A gate that let two hundred trucks in
 * is named on two hundred receipts, and deleting it would blank the answer to
 * "where did this arrive". `isActive` keeps it out of tomorrow's dropdown while
 * leaving yesterday's records readable.
 *
 * Gated on `office.manage_rules` to write — the same authority that sets
 * what a deduction costs. Both are configuration somebody signs off, not
 * something a shift changes.
 */
import { Router } from "express";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { gates, locations, weighbridges } from "@shared/schema";
import { db } from "../db";
import { requirePermission } from "../lib/rbac";
import { validateBody } from "../lib/validate";

export const officeSitesRouter = Router();

/**
 * A coordinate, or nothing at all.
 *
 * Nullable on purpose: a gate is usable the moment it has a name, and demanding
 * a latitude before anyone can receive a truck would stop the flow to collect a
 * number somebody has to walk outside to read. Without coordinates the geofence
 * simply does not apply — which is the current state of every gate, and honest.
 */
const coord = (max: number) =>
  z
    .string()
    .regex(/^-?\d+(\.\d{1,7})?$/, "Enter a decimal coordinate")
    .refine((v) => Math.abs(Number(v)) <= max, `Must be between -${max} and ${max}`)
    .nullish();

const gateSchema = z.object({
  locationId: z.string().uuid(),
  name: z.string().min(1).max(120),
  latitude: coord(90),
  longitude: coord(180),
  /** How far from the gate a capture may be and still count as at the gate. */
  radiusM: z.number().int().min(10).max(5000).default(200),
});

const weighbridgeSchema = z.object({
  locationId: z.string().uuid(),
  name: z.string().min(1).max(120),
  /** The sanity ceiling on an entered weight. Null means no ceiling checked. */
  capacityKg: z.string().regex(/^\d+(\.\d{1,3})?$/, "Enter a weight in kg").nullish(),
});

/**
 * A gate with only one of its two coordinates is not half-located, it is
 * unusable — `resolvePlace` needs both to measure a distance, so a lone
 * latitude reads as configured while doing nothing.
 */
function coordProblem(lat?: string | null, lng?: string | null): string | null {
  const has = (v?: string | null) => v != null && String(v).trim() !== "";
  if (has(lat) !== has(lng)) {
    return "A gate needs both a latitude and a longitude, or neither — one alone cannot place it";
  }
  return null;
}

/** Both lists, with their location names and how much history each carries. */
async function sites() {
  const [gateRows, bridgeRows] = await Promise.all([
    db
      .select({
        id: gates.id,
        name: gates.name,
        locationId: gates.locationId,
        locationName: locations.name,
        latitude: gates.latitude,
        longitude: gates.longitude,
        radiusM: gates.radiusM,
        isActive: gates.isActive,
        // Receipts that came in here. Deactivating one that has admitted
        // trucks is a different decision from deactivating one that never has.
        receipts: sql<number>`(
          SELECT count(*)::int FROM office_receipts r WHERE r.gate_id = ${gates.id}
        )`,
      })
      .from(gates)
      .leftJoin(locations, eq(locations.id, gates.locationId))
      .orderBy(asc(locations.name), asc(gates.name)),
    db
      .select({
        id: weighbridges.id,
        name: weighbridges.name,
        locationId: weighbridges.locationId,
        locationName: locations.name,
        capacityKg: weighbridges.capacityKg,
        isActive: weighbridges.isActive,
        weighings: sql<number>`(
          SELECT count(*)::int FROM office_receipts r
          WHERE r.gross_weighbridge_id = ${weighbridges.id}
             OR r.tare_weighbridge_id = ${weighbridges.id}
        )`,
      })
      .from(weighbridges)
      .leftJoin(locations, eq(locations.id, weighbridges.locationId))
      .orderBy(asc(locations.name), asc(weighbridges.name)),
  ]);
  return { gates: gateRows, weighbridges: bridgeRows };
}

officeSitesRouter.get("/", requirePermission("office", "view"), async (_req, res) => {
  res.json(await sites());
});

// ───────────────────────────────── Gates ─────────────────────────────────

officeSitesRouter.post(
  "/gates",
  requirePermission("office", "manage_rules"),
  validateBody(gateSchema),
  async (req, res) => {
    const body = req.body as z.infer<typeof gateSchema>;
    const problem = coordProblem(body.latitude, body.longitude);
    if (problem) return res.status(422).json({ error: problem });
    const clash = await db.query.gates.findFirst({
      where: and(eq(gates.locationId, body.locationId), eq(gates.name, body.name), eq(gates.isActive, true)),
    });
    if (clash) return res.status(409).json({ error: `${body.name} already exists at that location` });
    const [row] = await db
      .insert(gates)
      .values({ ...body, latitude: body.latitude ?? null, longitude: body.longitude ?? null })
      .returning();
    res.status(201).json(row);
  },
);

officeSitesRouter.patch(
  "/gates/:id",
  requirePermission("office", "manage_rules"),
  validateBody(gateSchema.partial().extend({ isActive: z.boolean().optional() })),
  async (req, res) => {
    const body = req.body as Partial<z.infer<typeof gateSchema>> & { isActive?: boolean };
    const current = await db.query.gates.findFirst({ where: eq(gates.id, req.params.id!) });
    if (!current) return res.status(404).json({ error: "Gate not found" });
    // Checked against the merged result, not the patch: clearing one coordinate
    // while leaving the other is exactly the case to catch.
    const problem = coordProblem(
      body.latitude !== undefined ? body.latitude : current.latitude,
      body.longitude !== undefined ? body.longitude : current.longitude,
    );
    if (problem) return res.status(422).json({ error: problem });
    const [row] = await db
      .update(gates)
      .set(body as Partial<typeof gates.$inferInsert>)
      .where(eq(gates.id, req.params.id!))
      .returning();
    res.json(row);
  },
);

// ───────────────────────────── Weighbridges ──────────────────────────────

officeSitesRouter.post(
  "/weighbridges",
  requirePermission("office", "manage_rules"),
  validateBody(weighbridgeSchema),
  async (req, res) => {
    const body = req.body as z.infer<typeof weighbridgeSchema>;
    const clash = await db.query.weighbridges.findFirst({
      where: and(
        eq(weighbridges.locationId, body.locationId),
        eq(weighbridges.name, body.name),
        eq(weighbridges.isActive, true),
      ),
    });
    if (clash) return res.status(409).json({ error: `${body.name} already exists at that location` });
    const [row] = await db
      .insert(weighbridges)
      .values({ ...body, capacityKg: body.capacityKg ?? null })
      .returning();
    res.status(201).json(row);
  },
);

officeSitesRouter.patch(
  "/weighbridges/:id",
  requirePermission("office", "manage_rules"),
  validateBody(weighbridgeSchema.partial().extend({ isActive: z.boolean().optional() })),
  async (req, res) => {
    const [row] = await db
      .update(weighbridges)
      .set(req.body as Partial<typeof weighbridges.$inferInsert>)
      .where(eq(weighbridges.id, req.params.id!))
      .returning();
    if (!row) return res.status(404).json({ error: "Weighbridge not found" });
    res.json(row);
  },
);
