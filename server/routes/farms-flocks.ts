/**
 * Farms — breeds, standards, and the flock spine.
 *
 * Mounted under the same `/api/farms` prefix as the houses routes; kept in its
 * own file because places and cohorts are different subjects and one router
 * file that owns both is the file nobody wants to open.
 */
import { Router } from "express";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  birdValuationRates,
  breeds,
  flockHatches,
  flockMovements,
  flockPlacements,
  flocks,
  hatchProfile,
  houses,
  locations,
  mortalityCauses,
  movementDelta,
  standardPoints,
  standardSets,
} from "@shared/schema";
import { db } from "../db";
import { requirePermission } from "../lib/rbac";
import { nonBlank, validateBody } from "../lib/validate";
import { PostingError } from "../services/posting";
import { dayBoard, saveDay } from "../services/daily";
import { housesBoard } from "../services/houses-board";
import { houseDetail } from "../services/house-detail";
import {
  ageOn,
  boardRows,
  createFlock,
  handoverSummary,
  nextFlockCode,
  placementCounts,
  recordMovement,
  setFlockCulls,
  setFlockHatches,
  setFlockTransfers,
  startLay,
} from "../services/flocks";

export const farmsFlockRouter = Router();

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date");
const decimal = z
  .union([z.string(), z.number()])
  .nullish()
  .transform((v) => (v === null || v === undefined || v === "" ? null : String(v)));

const fail = (err: unknown, res: { status: (n: number) => { json: (b: unknown) => unknown } }) => {
  if (err instanceof PostingError) {
    res.status(422).json({ error: err.message });
    return true;
  }
  const e = err as { code?: string; constraint?: string };
  if (e?.code === "23505") {
    const msg =
      e.constraint === "flocks_code_unique"
        ? "A flock with that code already exists"
        : e.constraint === "uq_standard_sets_default"
          ? "That breed already has a default set"
          : e.constraint === "uq_standard_sets_name"
            ? "That breed already has a set with this name and version"
            : "That already exists";
    res.status(422).json({ error: msg });
    return true;
  }
  if (e?.code === "23514") {
    res.status(422).json({ error: "The database refused that — check the dates and quantities" });
    return true;
  }
  return false;
};

const view = requirePermission("farms", "view");
const manage = requirePermission("farms", "manage");

/* ── Reference data ──────────────────────────────────────────────────────── */

farmsFlockRouter.get("/breeds", view, async (_req, res) => {
  const rows = await db
    .select({
      id: breeds.id,
      code: breeds.code,
      name: breeds.name,
      isActive: breeds.isActive,
      setCount: sql<number>`(SELECT count(*)::int FROM standard_sets s WHERE s.breed_id = ${breeds.id})`,
      defaultSetId: sql<
        string | null
      >`(SELECT s.id FROM standard_sets s WHERE s.breed_id = ${breeds.id} AND s.is_default LIMIT 1)`,
    })
    .from(breeds)
    .orderBy(asc(breeds.name));
  res.json(rows);
});

farmsFlockRouter.post(
  "/breeds",
  manage,
  validateBody(z.object({ code: nonBlank(20), name: nonBlank(120) })),
  async (req, res) => {
    const b = req.body as { code: string; name: string };
    try {
      const [row] = await db
        .insert(breeds)
        .values({ code: b.code.trim().toUpperCase(), name: b.name.trim() })
        .returning();
      res.status(201).json(row);
    } catch (err) {
      if (!fail(err, res)) throw err;
    }
  },
);

farmsFlockRouter.get("/standard-sets", view, async (req, res) => {
  const breedId = req.query.breedId as string | undefined;
  const rows = await db
    .select({
      id: standardSets.id,
      breedId: standardSets.breedId,
      breedName: breeds.name,
      name: standardSets.name,
      source: standardSets.source,
      version: standardSets.version,
      effectiveFrom: standardSets.effectiveFrom,
      isDefault: standardSets.isDefault,
      note: standardSets.note,
      pointCount: sql<number>`(SELECT count(*)::int FROM standard_points p WHERE p.set_id = ${standardSets.id})`,
      /** A set any flock is pinned to is versioned on edit, never overwritten. */
      flockCount: sql<number>`(SELECT count(*)::int FROM flocks f WHERE f.standard_set_id = ${standardSets.id})`,
    })
    .from(standardSets)
    .innerJoin(breeds, eq(breeds.id, standardSets.breedId))
    .where(breedId ? eq(standardSets.breedId, breedId) : undefined)
    .orderBy(asc(breeds.name), asc(standardSets.name), desc(standardSets.version));
  res.json(rows);
});

const setSchema = z.object({
  breedId: z.string().uuid(),
  name: z.string().min(1).max(160),
  source: z.enum(["breeder", "in-house", "blend"]).nullish(),
  effectiveFrom: isoDate.nullish(),
  isDefault: z.boolean().optional(),
  note: z.string().max(2000).nullish(),
});

farmsFlockRouter.post("/standard-sets", manage, validateBody(setSchema), async (req, res) => {
  const b = req.body as z.infer<typeof setSchema>;
  try {
    const row = await db.transaction(async (tx) => {
      // The unique partial index allows exactly one default per breed, so an
      // incoming default has to displace the sitting one inside the same
      // transaction rather than racing it.
      if (b.isDefault) {
        await tx
          .update(standardSets)
          .set({ isDefault: false })
          .where(and(eq(standardSets.breedId, b.breedId), eq(standardSets.isDefault, true)));
      }
      const [made] = await tx
        .insert(standardSets)
        .values({
          breedId: b.breedId,
          name: b.name.trim(),
          source: b.source ?? null,
          effectiveFrom: b.effectiveFrom ?? null,
          isDefault: b.isDefault ?? false,
          note: b.note ?? null,
        })
        .returning();
      return made!;
    });
    res.status(201).json(row);
  } catch (err) {
    if (!fail(err, res)) throw err;
  }
});

farmsFlockRouter.get("/standard-sets/:id/points", view, async (req, res) => {
  const rows = await db
    .select()
    .from(standardPoints)
    .where(eq(standardPoints.setId, req.params.id!))
    .orderBy(asc(standardPoints.ageWeek));
  res.json(rows);
});

const pointSchema = z.object({
  ageWeek: z.number().int().min(1).max(120),
  bodyWeightG: decimal,
  uniformityCvPct: decimal,
  feedGPerBirdDay: decimal,
  waterMlPerBirdDay: decimal,
  layPct: decimal,
  eggWeightG: decimal,
  cumMortalityPct: decimal,
});

/**
 * Replace a set's curve wholesale.
 *
 * Whole-set replace rather than per-row edit because a curve is one thing: a
 * half-applied CSV import that leaves weeks 40–90 from the previous upload is
 * worse than a failed one. Versioning protects the flocks already pinned to it,
 * so overwriting here is safe.
 */
farmsFlockRouter.put(
  "/standard-sets/:id/points",
  manage,
  validateBody(z.object({ points: z.array(pointSchema).max(120) })),
  async (req, res) => {
    const { points } = req.body as { points: Array<z.infer<typeof pointSchema>> };
    const weeks = new Set(points.map((p) => p.ageWeek));
    if (weeks.size !== points.length) {
      return res.status(422).json({ error: "The same age week appears twice" });
    }
    try {
      const n = await db.transaction(async (tx) => {
        const [set] = await tx.select().from(standardSets).where(eq(standardSets.id, req.params.id!));
        if (!set) throw new PostingError("No such standard set");
        await tx.delete(standardPoints).where(eq(standardPoints.setId, set.id));
        if (points.length) {
          await tx.insert(standardPoints).values(points.map((p) => ({ ...p, setId: set.id })));
        }
        return points.length;
      });
      res.json({ points: n });
    } catch (err) {
      if (!fail(err, res)) throw err;
    }
  },
);

farmsFlockRouter.get("/mortality-causes", view, async (_req, res) => {
  const rows = await db
    .select()
    .from(mortalityCauses)
    .where(eq(mortalityCauses.isActive, true))
    .orderBy(asc(mortalityCauses.sortOrder));
  res.json(rows);
});

/** Bird valuation rates for a breed — the rate in force per age week. */
farmsFlockRouter.get("/breeds/:id/valuation", view, async (req, res) => {
  const rows = await db
    .select()
    .from(birdValuationRates)
    .where(eq(birdValuationRates.breedId, req.params.id!))
    .orderBy(asc(birdValuationRates.ageWeek), desc(birdValuationRates.effectiveFrom));
  res.json(rows);
});

/* ── Flocks ──────────────────────────────────────────────────────────────── */

/** Everything the New flock dialog needs to offer, in one request. */
farmsFlockRouter.get("/flock-context", view, async (_req, res) => {
  const [sites, houseRows, breedRows, sets, causes] = await Promise.all([
    db
      .select({ id: locations.id, name: locations.name })
      .from(locations)
      .where(and(eq(locations.type, "farm"), eq(locations.isActive, true)))
      .orderBy(asc(locations.name)),
    db
      .select({
        id: houses.id,
        code: houses.code,
        purpose: houses.purpose,
        locationId: houses.locationId,
      })
      .from(houses)
      .where(eq(houses.isActive, true))
      .orderBy(asc(houses.code)),
    db
      .select({ id: breeds.id, name: breeds.name })
      .from(breeds)
      .where(eq(breeds.isActive, true))
      .orderBy(asc(breeds.name)),
    db
      .select({
        id: standardSets.id,
        breedId: standardSets.breedId,
        name: standardSets.name,
        version: standardSets.version,
        isDefault: standardSets.isDefault,
      })
      .from(standardSets)
      .orderBy(asc(standardSets.name)),
    db
      .select()
      .from(mortalityCauses)
      .where(eq(mortalityCauses.isActive, true))
      .orderBy(asc(mortalityCauses.sortOrder)),
  ]);
  res.json({ sites, houses: houseRows, breeds: breedRows, standardSets: sets, causes });
});

farmsFlockRouter.get("/flocks", view, async (req, res) => {
  const status = req.query.status as string | undefined;
  const rows = await db
    .select({
      id: flocks.id,
      code: flocks.code,
      status: flocks.status,
      hatchDate: flocks.hatchDate,
      placedCount: flocks.placedCount,
      layStartDate: flocks.layStartDate,
      depletedOn: flocks.depletedOn,
      breedName: breeds.name,
      locationName: locations.name,
      /** Derived, never stored — see services/flocks.ts. */
      birds: sql<number>`coalesce((
        SELECT sum(CASE
          WHEN m.kind IN ('place','transfer_in') THEN m.qty
          WHEN m.kind = 'adjustment' THEN m.qty * m.adjustment_sign
          ELSE -m.qty END)
        FROM flock_movements m
        JOIN flock_placements p ON p.id = m.placement_id
        WHERE p.flock_id = ${flocks.id}), 0)::int`,
      houseCodes: sql<string>`coalesce((
        SELECT string_agg(h.code, ', ' ORDER BY h.code)
        FROM flock_placements p JOIN houses h ON h.id = p.house_id
        WHERE p.flock_id = ${flocks.id} AND p.to_date IS NULL), '—')`,
    })
    .from(flocks)
    .innerJoin(breeds, eq(breeds.id, flocks.breedId))
    .innerJoin(locations, eq(locations.id, flocks.locationId))
    .where(status && status !== "all" ? eq(flocks.status, status) : undefined)
    .orderBy(desc(flocks.hatchDate));
  res.json(rows);
});

/** The code the next flock at this site would get, so the dialog can show it. */
farmsFlockRouter.get("/next-flock-code", view, async (req, res) => {
  const locationId = req.query.locationId as string | undefined;
  const year = Number(req.query.year) || new Date().getFullYear();
  if (!locationId) return res.status(422).json({ error: "Which site?" });
  try {
    const code = await db.transaction((tx) => nextFlockCode(tx, locationId, year));
    res.json({ code });
  } catch (err) {
    if (!fail(err, res)) throw err;
  }
});

const newFlockSchema = z.object({
  locationId: z.string().uuid(),
  breedId: z.string().uuid(),
  houseId: z.string().uuid(),
  /** One line per hatch. The flock's age is their bird-weighted average. */
  hatches: z
    .array(z.object({ hatchDate: isoDate, qty: z.number().int().positive() }))
    .min(1)
    .max(50),
  note: z.string().max(2000).nullish(),
});

farmsFlockRouter.post("/flocks", manage, validateBody(newFlockSchema), async (req, res) => {
  const b = req.body as z.infer<typeof newFlockSchema>;
  try {
    const out = await db.transaction((tx) =>
      createFlock(tx, { ...b, userId: req.session.user!.id }),
    );
    res.status(201).json(out.flock);
  } catch (err) {
    if (!fail(err, res)) throw err;
  }
});

/** One flock, with its placements and its movement ledger. */
farmsFlockRouter.get("/flocks/:id", view, async (req, res) => {
  const out = await db.transaction(async (tx) => {
    const [flock] = await tx
      .select({
        id: flocks.id,
        code: flocks.code,
        status: flocks.status,
        hatchDate: flocks.hatchDate,
        placedCount: flocks.placedCount,
        housedOn: flocks.housedOn,
        layStartDate: flocks.layStartDate,
        depletedOn: flocks.depletedOn,
        note: flocks.note,
        breedId: flocks.breedId,
        breedName: breeds.name,
        locationId: flocks.locationId,
        locationName: locations.name,
        standardSetId: flocks.standardSetId,
        standardSetName: standardSets.name,
        standardSetVersion: standardSets.version,
      })
      .from(flocks)
      .innerJoin(breeds, eq(breeds.id, flocks.breedId))
      .innerJoin(locations, eq(locations.id, flocks.locationId))
      // Left: a flock placed before its breed had a curve has no set pinned.
      .leftJoin(standardSets, eq(standardSets.id, flocks.standardSetId))
      .where(eq(flocks.id, req.params.id!));
    if (!flock) return null;

    const hatches = await tx
      .select({
        id: flockHatches.id,
        hatchDate: flockHatches.hatchDate,
        qty: flockHatches.qty,
      })
      .from(flockHatches)
      .where(eq(flockHatches.flockId, flock.id))
      .orderBy(asc(flockHatches.hatchDate));

    const placements = await tx
      .select({
        id: flockPlacements.id,
        houseId: flockPlacements.houseId,
        houseCode: houses.code,
        fromDate: flockPlacements.fromDate,
        toDate: flockPlacements.toDate,
        note: flockPlacements.note,
      })
      .from(flockPlacements)
      .innerJoin(houses, eq(houses.id, flockPlacements.houseId))
      .where(eq(flockPlacements.flockId, flock.id))
      .orderBy(asc(flockPlacements.fromDate));

    const counts = await placementCounts(
      tx,
      placements.map((p) => p.id),
    );

    const movements = await tx
      .select({
        id: flockMovements.id,
        placementId: flockMovements.placementId,
        houseCode: houses.code,
        eventDate: flockMovements.eventDate,
        kind: flockMovements.kind,
        qty: flockMovements.qty,
        adjustmentSign: flockMovements.adjustmentSign,
        causeCode: flockMovements.causeCode,
        causeLabel: mortalityCauses.label,
        counterpartPlacementId: flockMovements.counterpartPlacementId,
        note: flockMovements.note,
        createdAt: flockMovements.createdAt,
      })
      .from(flockMovements)
      .innerJoin(flockPlacements, eq(flockPlacements.id, flockMovements.placementId))
      .innerJoin(houses, eq(houses.id, flockPlacements.houseId))
      .leftJoin(mortalityCauses, eq(mortalityCauses.code, flockMovements.causeCode))
      .where(eq(flockPlacements.flockId, flock.id))
      .orderBy(desc(flockMovements.eventDate), desc(flockMovements.createdAt));

    const birds = movements.reduce(
      (n, m) => n + movementDelta(m.kind, m.qty, m.adjustmentSign),
      0,
    );
    const lost = movements
      .filter((m) => m.kind === "mortality" || m.kind === "cull")
      .reduce((n, m) => n + m.qty, 0);

    return {
      ...flock,
      birds,
      /** Against what was placed, so a split flock still reads correctly. */
      cumMortalityPct: flock.placedCount ? (lost / flock.placedCount) * 100 : 0,
      hatches,
      /** Null only for a flock with no hatch rows, which cannot be created. */
      hatchSpread: hatchProfile(hatches),
      // Age runs off the weighted average, so a batch spread over a week is the
      // age most of its birds actually are.
      age: ageOn(flock.hatchDate, new Date().toISOString().slice(0, 10)),
      placements: placements.map((p) => ({ ...p, birds: counts.get(p.id) ?? 0 })),
      movements,
    };
  });
  if (!out) return res.status(404).json({ error: "Flock not found" });
  res.json(out);
});

/**
 * Correct a flock's hatches.
 *
 * A batch is opened when the first chicks land and keeps filling for another
 * week, so this is an ordinary operation rather than an error path. Changing it
 * moves the flock's age, because age is the weighted average of these lines.
 */
farmsFlockRouter.put(
  "/flocks/:id/hatches",
  manage,
  validateBody(
    z.object({
      hatches: z
        .array(z.object({ hatchDate: isoDate, qty: z.number().int().positive() }))
        .min(1)
        .max(50),
    }),
  ),
  async (req, res) => {
    try {
      const profile = await db.transaction((tx) =>
        setFlockHatches(tx, req.params.id!, req.body.hatches, req.session.user!.id),
      );
      res.json(profile);
    } catch (err) {
      if (!fail(err, res)) throw err;
    }
  },
);


farmsFlockRouter.post(
  "/flocks/:id/movements",
  manage,
  validateBody(
    z.object({
      placementId: z.string().uuid(),
      kind: z.enum(["mortality", "cull", "male_removal", "adjustment"]),
      qty: z.number().int().positive(),
      eventDate: isoDate,
      causeCode: z.string().max(40).nullish(),
      adjustmentSign: z.union([z.literal(1), z.literal(-1)]).nullish(),
      note: z.string().max(500).nullish(),
    }),
  ),
  async (req, res) => {
    try {
      const row = await db.transaction((tx) =>
        recordMovement(tx, {
          ...req.body,
          flockId: req.params.id!,
          userId: req.session.user!.id,
        }),
      );
      res.status(201).json(row);
    } catch (err) {
      if (!fail(err, res)) throw err;
    }
  },
);

/**
 * The handover sheet, as at a date. Read before housing to see what is being
 * handed over, and after it as the record of what was.
 */
farmsFlockRouter.get("/flocks/:id/handover", view, async (req, res) => {
  const on = (req.query.on as string) || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(on)) {
    return res.status(422).json({ error: "Use a YYYY-MM-DD date" });
  }
  try {
    const out = await db.transaction((tx) => handoverSummary(tx, req.params.id!, on));
    res.json(out);
  } catch (err) {
    if (!fail(err, res)) throw err;
  }
});

/**
 * Replace a flock's transfers.
 *
 * One set of dated lines, not one act. Moving a batch out of rearing takes the
 * best part of a week, a lorry at a time, so it is edited the same way hatches
 * are — see services/flocks.ts.
 */
farmsFlockRouter.put(
  "/flocks/:id/transfers",
  manage,
  validateBody(
    z.object({
      lines: z
        .array(
          z.object({
            eventDate: isoDate,
            fromHouseId: z.string().uuid(),
            toHouseId: z.string().uuid(),
            qty: z.number().int().positive(),
          }),
        )
        .max(50),
    }),
  ),
  async (req, res) => {
    try {
      const out = await db.transaction((tx) =>
        setFlockTransfers(tx, req.params.id!, req.body.lines, req.session.user!.id),
      );
      res.json(out);
    } catch (err) {
      if (!fail(err, res)) throw err;
    }
  },
);

/** Replace a flock's culling-out. Same shape, same reason. */
farmsFlockRouter.put(
  "/flocks/:id/culls",
  manage,
  validateBody(
    z.object({
      lines: z
        .array(
          z.object({
            eventDate: isoDate,
            houseId: z.string().uuid(),
            qty: z.number().int().positive(),
          }),
        )
        .max(50),
    }),
  ),
  async (req, res) => {
    try {
      const out = await db.transaction((tx) =>
        setFlockCulls(tx, req.params.id!, req.body.lines, req.session.user!.id),
      );
      res.json(out);
    } catch (err) {
      if (!fail(err, res)) throw err;
    }
  },
);

farmsFlockRouter.post(
  "/flocks/:id/start-lay",
  manage,
  validateBody(z.object({ on: isoDate })),
  async (req, res) => {
    try {
      const row = await db.transaction((tx) => startLay(tx, req.params.id!, req.body.on));
      res.json(row);
    } catch (err) {
      if (!fail(err, res)) throw err;
    }
  },
);


/* ── The board ───────────────────────────────────────────────────────────── */

/**
 * What is standing in every house on a day. One request — the screen it feeds
 * is the landing page, and a card grid that fires a query per card is how the
 * old dashboard ended up making 28.
 */
farmsFlockRouter.get("/board", view, async (req, res) => {
  const on = (req.query.date as string) || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(on)) {
    return res.status(422).json({ error: "Use a YYYY-MM-DD date" });
  }
  const out = await db.transaction(async (tx) => {
    const occupied = await boardRows(tx, on);
    // Empty houses matter as much as full ones: a shed nobody has placed into
    // is a shed earning nothing, and a board that only lists occupancy hides it.
    const all = await tx
      .select({
        id: houses.id,
        code: houses.code,
        purpose: houses.purpose,
        locationName: locations.name,
        ownerName: sql<string | null>`(SELECT display_name FROM contacts WHERE id = ${houses.ownerId})`,
      })
      .from(houses)
      .innerJoin(locations, eq(locations.id, houses.locationId))
      .where(eq(houses.isActive, true))
      .orderBy(asc(locations.name), asc(houses.code));
    const busy = new Set(occupied.map((r) => r.houseId));
    return {
      date: on,
      placements: occupied,
      emptyHouses: all.filter((h) => !busy.has(h.id)),
      totals: {
        birds: occupied.reduce((n, r) => n + r.birds, 0),
        houses: all.length,
        occupied: busy.size,
      },
    };
  });
  res.json(out);
});

/* ── Daily records ───────────────────────────────────────────────────────── */

/**
 * Every open house on a day, with what has been recorded for it.
 *
 * Houses with no entry come back as well. A screen that lists only what has
 * been filled in cannot show what has not, and the missing house is the whole
 * reason for looking.
 */
farmsFlockRouter.get("/daily", view, async (req, res) => {
  const day = (req.query.date as string) || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return res.status(422).json({ error: "Use a YYYY-MM-DD date" });
  }
  const out = await db.transaction((tx) => dayBoard(tx, day));
  res.json(out);
});

const dailySchema = z.object({
  placementId: z.string().uuid(),
  day: isoDate,
  feedConsumedKg: decimal,
  feedClosingKg: decimal,
  waterUpperKl: decimal,
  waterLowerKl: decimal,
  eggsTotal: z.number().int().min(0).nullish(),
  eggsCracked: z.number().int().min(0).nullish(),
  eggsDirty: z.number().int().min(0).nullish(),
  note: z.string().max(1000).nullish(),
  losses: z
    .array(
      z.object({
        kind: z.enum(["mortality", "cull", "male_removal"]),
        qty: z.number().int().positive(),
        causeCode: z.string().max(40).nullish(),
        note: z.string().max(300).nullish(),
      }),
    )
    .max(20),
});

farmsFlockRouter.post("/daily", manage, validateBody(dailySchema), async (req, res) => {
  try {
    const out = await db.transaction((tx) =>
      saveDay(tx, req.body as never, req.session.user!.id),
    );
    res.json(out);
  } catch (err) {
    if (!fail(err, res)) throw err;
  }
});

/**
 * Everything the Houses screen holds in state, in one request.
 *
 * The screen is a port from the farm's own app and its calculations are carried
 * over untouched, so the shapes it expects are produced in the adapter rather
 * than by editing the page — see services/houses-board.ts.
 */
farmsFlockRouter.get("/houses-board", view, async (_req, res) => {
  const out = await db.transaction((tx) => housesBoard(tx));
  res.json(out);
});

/** One house's page — the shed screen's eight collections, in one request. */
farmsFlockRouter.get("/houses/:id/detail", view, async (req, res) => {
  const out = await db.transaction((tx) => houseDetail(tx, req.params.id!));
  if (!out) return res.status(404).json({ error: "House not found" });
  res.json(out);
});
