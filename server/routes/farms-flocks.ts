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
import { EGG_SIZES, eggPrefs, eggsInBox } from "../services/egg-sales";
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
  /**
   * House this batch beside one already in the shed.
   *
   * Off by default, so the usual refusal stands: a shed still holding birds is
   * far more often a remainder nobody wrote off than a second cohort somebody
   * meant to put there. Ticked, it is a decision on the record.
   */
  alongsideExisting: z.boolean().optional(),
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

/**
 * What the shed's own instruments say about a day, for the entry form to open
 * with. Suggestions only — nothing here is saved until a person saves it.
 *
 * Four numbers, and each one is refused rather than guessed when the
 * controller cannot support it:
 *
 *  - feed and water are the controller's own daily totals. They reset at
 *    midnight and climb, so asking about TODAY gets the running figure so far,
 *    not the day's. `partial` says which, and the form says so on screen.
 *  - silo is the current weight in the bins, which is what "stock" means.
 *  - mortality is NOT the controller's mortality tag: that reads zero on every
 *    house on every day ever polled, because nobody types deaths into the
 *    panel. It is the fall in the panel's own BIRD COUNT since yesterday,
 *    which staff do maintain. That fall also contains any culls and transfers
 *    out, so it is offered as a number to check rather than a fact.
 *
 * A controller repeating one frozen snapshot (P1 and P2 have done since they
 * were wired) offers nothing at all. A stuck number presented confidently is
 * worse than an empty box, because the empty box gets filled in.
 */
farmsFlockRouter.get("/daily/sensor", view, async (req, res) => {
  const day = String(req.query.date ?? "").slice(0, 10);
  const houseId = String(req.query.houseId ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return res.status(422).json({ error: "Use a YYYY-MM-DD date" });
  if (!houseId) return res.status(422).json({ error: "Which house?" });

  const rows = await db.execute(sql`
    WITH today AS (
      SELECT feed_kg, water_l, silo_kg, bird_count, updated_at
        FROM iot_house_day WHERE house_id = ${houseId}::uuid AND day = ${day}
    ),
    yesterday AS (
      SELECT bird_count, silo_kg FROM iot_house_day
       WHERE house_id = ${houseId}::uuid AND day = (${day}::date - 1)
    ),
    /* What the mill says it sent this house today, voided lines excluded. */
    mill AS (
      SELECT coalesce(sum(quantity_kg), 0) AS mill_kg
        FROM feed_transfers
       WHERE to_house_id = ${houseId}::uuid AND transfer_date = ${day}
         AND coalesce(status, '') <> 'void'
    ),
    /*
     * Is the controller reporting, or repeating one snapshot?
     *
     * Movement across a window that spans real TIME.
     *
     * Three wrong answers came before this one. A 24-hour window assumed a
     * five-minute timer and called every house on staging frozen. Twelve
     * readings regardless of age spanned the gap between imported history and
     * today's fetch, and the gap alone looked like life. Two consecutive
     * readings looked tightest — until two manual fetches landed 38 seconds
     * apart and L2 and L5 read as frozen, because nothing changes in 38
     * seconds.
     *
     * So: readings from the last six hours, which excludes an import gap, and
     * the span between oldest and newest must be at least ten minutes, which
     * is long enough that a live house has moved SOMETHING — the water
     * counter ticks about a hundred litres every five minutes. Too short a
     * span is not evidence of a frozen controller, and says so instead.
     */
    recent AS (
      SELECT temp_c, feed_kg, water_l, silo_kg, at
        FROM iot_house_sample
       WHERE house_id = ${houseId}::uuid AND at > now() - interval '6 hours'
       ORDER BY at DESC LIMIT 24
    ),
    liveness AS (
      SELECT count(*) AS seen,
             GREATEST(count(DISTINCT temp_c), count(DISTINCT feed_kg),
                      count(DISTINCT water_l), count(DISTINCT silo_kg)) AS temps,
             EXTRACT(EPOCH FROM (max(at) - min(at))) AS span_s,
             max(at) AS newest
        FROM recent
    )
    SELECT t.feed_kg, t.water_l, t.silo_kg, t.bird_count, t.updated_at,
           y.bird_count AS prev_birds, y.silo_kg AS prev_silo, m.mill_kg,
           l.temps, l.seen, l.span_s, l.newest
      FROM liveness l LEFT JOIN today t ON true LEFT JOIN yesterday y ON true
      LEFT JOIN mill m ON true
  `);

  const r = rows.rows[0] as
    | {
        feed_kg: string | null; water_l: string | null; silo_kg: string | null;
        bird_count: number | null; updated_at: string | null;
        prev_birds: number | null; prev_silo: string | null; mill_kg: string | null;
        temps: string | number; seen: string | number;
        span_s: string | number | null; newest: string | null;
      }
    | undefined;

  const num = (v: string | null | undefined) => (v == null ? null : Number(v));
  // Nothing moving across a window that spans real time is a frozen controller.
  const seen = Number(r?.seen ?? 0);
  const spanS = Number(r?.span_s ?? 0);
  const moved = r != null && Number(r.temps) > 1;
  const longEnough = spanS >= 600;
  if (!moved) {
    return res.json({
      available: false,
      reason:
        seen === 0
          ? "No readings from this house's controller."
          : !longEnough
            ? "The readings so far are minutes apart — too close together to tell a live controller from a frozen one. Fetch again shortly."
            : "This house's controller is repeating one frozen reading — nothing to suggest.",
    });
  }

  const fall =
    r!.bird_count != null && r!.prev_birds != null ? r!.prev_birds - r!.bird_count : null;

  /**
   * A live controller can still have a dead instrument.
   *
   * L4 reported 63 kg of feed for 109,968 birds and L5 reported minus one,
   * on a day both were plainly reporting temperature. That is a broken feed
   * line, not a fasting house, and 63 kg prefilled into a form is a number
   * somebody signs off. Each figure is checked against the birds it claims to
   * have fed and dropped on its own if it cannot be true — a blank box asks to
   * be filled, which is exactly the right outcome.
   *
   * The bands are deliberately wide: a layer eats about 110 g and drinks about
   * 250 ml a day, and these bounds only exclude the impossible.
   */
  const birds = r!.bird_count ?? 0;
  const perBird = (total: number | null, factor: number) =>
    total == null || birds <= 0 ? null : (total * factor) / birds;

  const feedKg = num(r!.feed_kg);
  const feedG = perBird(feedKg, 1000);
  const feedOk = feedG != null && feedG >= 20 && feedG <= 250;

  const waterL = num(r!.water_l);
  const waterMl = perBird(waterL, 1000);
  const waterOk = waterMl != null && waterMl >= 50 && waterMl <= 600;

  const siloKg = num(r!.silo_kg);
  const siloOk = siloKg != null && siloKg >= 0;

  /**
   * Eggs produced, from the grading sheet this house filled for the day.
   *
   * Boxes, converted at the size's own capacity: a jumbo box holds 180 where
   * the rest hold 210. Dirty eggs are counted — they were laid, and this
   * figure is production, not saleable stock.
   */
  const graded = await db.execute(sql`
    SELECT small, medium, large, xl, jumbo, dirty
      FROM egg_grading WHERE house_id = ${houseId}::uuid AND graded_on = ${day}
  `);
  const g = graded.rows[0] as Record<string, number> | undefined;
  const prefs = await eggPrefs(db);
  const eggsProduced = g
    ? EGG_SIZES.reduce((n, size) => n + Number(g[size] ?? 0) * eggsInBox(size, prefs), 0)
    : null;

  /**
   * What the silo says arrived, against what the mill says it sent.
   *
   *   delivered = silo now - silo yesterday + what the birds ate
   *
   * A cross-check, never a claim. The silo is a level read at one moment and
   * the feed counter can under-record, so the identity comes out negative when
   * one of them is wrong — L2 on 30 Aug lost 10,199 kg from the silo while the
   * counter recorded 6,838 eaten, which is not a delivery of minus 3,361 kg.
   * A negative answer is reported as unusable rather than shown as a number.
   *
   * On days with no delivery the arithmetic lands within a few hundred kg of
   * zero (144, 289, 347 across the last week), so that is the noise floor and
   * the tolerance is built from it: differences under half a tonne, or under
   * 5%, are the instruments disagreeing rather than a missing transfer.
   */
  const siloPrev = num(r!.prev_silo);
  const impliedRaw =
    siloOk && siloPrev != null && feedOk ? siloKg! - siloPrev + feedKg! : null;
  const deliveredImpliedKg = impliedRaw == null || impliedRaw < 0 ? null : Math.round(impliedRaw);
  const millRecordedKg = r!.mill_kg == null ? null : Math.round(Number(r!.mill_kg));

  let deliveryCheck: "agrees" | "differs" | "unknown" = "unknown";
  if (deliveredImpliedKg != null) {
    const mill = millRecordedKg ?? 0;
    const gap = Math.abs(deliveredImpliedKg - mill);
    const tolerance = Math.max(500, mill * 0.05);
    deliveryCheck = gap <= tolerance ? "agrees" : "differs";
  }

  const rejected: string[] = [];
  if (!feedOk && feedKg != null) rejected.push(`feed (${Math.round(feedG ?? 0)} g/bird)`);
  if (!waterOk && waterL != null) rejected.push(`water (${Math.round(waterMl ?? 0)} ml/bird)`);
  if (!siloOk && siloKg != null) rejected.push("silo");

  res.json({
    available: true,
    // Today's totals are still climbing; yesterday's are final.
    partial: day >= new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10),
    at: r!.updated_at,
    feedConsumedKg: feedOk ? feedKg : null,
    feedClosingKg: siloOk ? siloKg : null,
    waterKl: waterOk ? Math.round(waterL! / 100) / 10 : null,
    // Negative means the panel count went UP — a transfer in, not a resurrection.
    mortality: fall != null && fall > 0 ? fall : null,
    birdCount: r!.bird_count,
    eggsProduced,
    deliveredImpliedKg,
    millRecordedKg,
    deliveryCheck,
    /** Instruments that answered with something that cannot be true. */
    rejected,
  });
});

const dailySchema = z.object({
  placementId: z.string().uuid(),
  day: isoDate,
  feedConsumedKg: decimal,
  feedClosingKg: decimal,
  waterKl: decimal,
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
