/**
 * Farms — houses, for now.
 *
 * A house owns a stock location, and the two are created together: a house that
 * cannot hold feed is not a house, so the foreign key is NOT NULL and there is
 * no window in which one exists without the other.
 */
import { Router } from "express";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { contacts, houses, locations, orgProfile, stockLocations } from "@shared/schema";
import { db } from "../db";
import { requirePermission } from "../lib/rbac";
import { validateBody } from "../lib/validate";
import { PostingError } from "../services/posting";

export const farmsRouter = Router();

/**
 * What a person may set about a house: where it stands, what it is for, and the
 * controller fitted to it. Deliberately not here — `capacity`, `silo1Kg`,
 * `silo2Kg`. Those are readings, not decisions: they change on their own, they
 * are written by a flock placement or by the controller poll, and offering them
 * on a settings form invites somebody to type over a measurement.
 */
const houseSchema = z.object({
  locationId: z.string().uuid(),
  /** The company that owns the shed; null means ours. */
  ownerId: z.string().uuid().nullish(),
  code: z.string().min(1).max(20),
  name: z.string().max(120).nullish(),
  purpose: z.enum(["layer", "pullet"]),
  displayOrder: z.number().int().min(0).max(999).optional(),
  bhDeviceId: z.string().max(60).nullish(),
});

const fail = (err: unknown, res: { status: (n: number) => { json: (b: unknown) => unknown } }) => {
  if (err instanceof PostingError) {
    res.status(422).json({ error: err.message });
    return true;
  }
  const e = err as { code?: string; constraint?: string };
  if (e?.code === "23505") {
    const msg =
      e.constraint === "uq_houses_code"
        ? "That farm already has a house with this code"
        : e.constraint === "uq_houses_bh_device"
          ? "That controller is already fitted to another house"
          : "That house already exists";
    res.status(422).json({ error: msg });
    return true;
  }
  return false;
};

/** Every house, with the site it stands on and the company that owns it. */
farmsRouter.get("/houses", requirePermission("farms", "view"), async (_req, res) => {
  const rows = await db
    .select({
      id: houses.id,
      code: houses.code,
      name: houses.name,
      purpose: houses.purpose,
      displayOrder: houses.displayOrder,
      bhDeviceId: houses.bhDeviceId,
      isActive: houses.isActive,
      locationId: houses.locationId,
      locationName: locations.name,
      ownerId: houses.ownerId,
      /** Null when the shed is ours — the caller shows the org's own name. */
      ownerName: contacts.displayName,
      stockLocationId: houses.stockLocationId,
    })
    .from(houses)
    .innerJoin(locations, eq(locations.id, houses.locationId))
    .leftJoin(contacts, eq(contacts.id, houses.ownerId))
    // By code, not by displayOrder: the migration filled displayOrder with the
    // export's row index, which runs across all sites and means nothing inside
    // one. Nothing sets it by hand yet, so it would only put L3 above L2.
    .orderBy(asc(locations.name), asc(houses.code));
  res.json(rows);
});

/**
 * What the Houses screen needs to offer: the sites a shed can stand on, and the
 * companies that can own one.
 *
 * Owners are contacts of type "both" — a company we bill feed to AND buy eggs
 * from. One that can only be invoiced, or only billed, is a Zoho split rather
 * than a real owner, so it is not offered here.
 */
farmsRouter.get("/context", requirePermission("farms", "view"), async (_req, res) => {
  const [sites, owners, org] = await Promise.all([
    db
      .select({ id: locations.id, code: locations.code, name: locations.name })
      .from(locations)
      // Never the feed mill: a shed does not stand inside the mill.
      .where(and(eq(locations.type, "farm"), eq(locations.isActive, true)))
      .orderBy(asc(locations.name)),
    db
      .select({ id: contacts.id, name: contacts.displayName })
      .from(contacts)
      .where(and(eq(contacts.type, "both"), eq(contacts.isActive, true)))
      .orderBy(asc(contacts.displayName)),
    db.select({ name: orgProfile.name }).from(orgProfile).limit(1),
  ]);
  res.json({ sites, owners, ourName: org[0]?.name ?? "Us" });
});

farmsRouter.post(
  "/houses",
  requirePermission("farms", "manage"),
  validateBody(houseSchema),
  async (req, res) => {
    const body = req.body as z.infer<typeof houseSchema>;
    try {
      const out = await db.transaction(async (tx) => {
        const [farm] = await tx
          .select({ id: locations.id, name: locations.name, type: locations.type })
          .from(locations)
          .where(eq(locations.id, body.locationId));
        if (!farm) throw new PostingError("No such farm");
        if (farm.type !== "farm") {
          throw new PostingError(`${farm.name} is not a farm — a house cannot sit on it`);
        }
        // The store first: the house's FK to it is NOT NULL.
        const [store] = await tx
          .insert(stockLocations)
          .values({
            locationId: farm.id,
            code: body.code.toUpperCase().slice(0, 20),
            name: `${body.code} — feed`,
            kind: "house",
          })
          .returning();
        const [made] = await tx
          .insert(houses)
          .values({
            locationId: farm.id,
            stockLocationId: store!.id,
            ownerId: body.ownerId ?? null,
            code: body.code,
            name: body.name ?? null,
            purpose: body.purpose,
            displayOrder: body.displayOrder ?? 0,
            bhDeviceId: body.bhDeviceId || null,
          })
          .returning();
        return made!;
      });
      res.status(201).json(out);
    } catch (err) {
      if (!fail(err, res)) throw err;
    }
  },
);

farmsRouter.patch(
  "/houses/:id",
  requirePermission("farms", "manage"),
  validateBody(houseSchema.partial().extend({ isActive: z.boolean().optional() })),
  async (req, res) => {
    const body = req.body as Record<string, unknown>;
    // The store belongs to the house for good: moving a house between farms
    // would strand every movement its store already carries.
    delete body.locationId;
    try {
      const [row] = await db
        .update(houses)
        .set({ ...body })
        .where(eq(houses.id, req.params.id!))
        .returning();
      if (!row) return res.status(404).json({ error: "House not found" });
      res.json(row);
    } catch (err) {
      if (!fail(err, res)) throw err;
    }
  },
);
