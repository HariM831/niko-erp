/**
 * Weigh slips — a vehicle weighed, and nothing more claimed than that.
 *
 * The stations next door exist to receive a purchase: gate in against a vendor
 * bill, match lines to a purchase order, judge them at QC, settle into a Bill.
 * Selling gunny bags or scrap has none of that shape. There is a vehicle, a
 * material, two weighments and a slip the driver takes away, so it gets its own
 * small table rather than a purchase order invented to carry it.
 *
 * One row per visit, holding both weighments in whichever order they happen.
 * Neither is "first" in the schema, only in time — the mill's own book records
 * a tare before a gross as often as after, because a tanker weighs empty on the
 * way out and full on the way back.
 *
 * Gated on `office.weighbridge`: this is the platform operator's screen, and it
 * is the same authority that records a gross weight at Weigh In.
 */
import { Router } from "express";
import { and, asc, desc, eq, isNotNull, isNull, notInArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { contacts, items, locations, orgProfile, users, weighTickets } from "@shared/schema";
import { db } from "../db";
import { nextDocumentNumber } from "../lib/numbering";
import { requirePermission } from "../lib/rbac";
import { validateBody } from "../lib/validate";

export const weighTicketsRouter = Router();

/** Kilograms as a string, so nothing is lost to a float on the way in. */
const weightKg = z
  .string()
  .regex(/^\d+(\.\d{1,3})?$/, "Enter a weight in kilograms")
  .refine((v) => Number(v) >= 0, "A weight cannot be negative")
  .refine((v) => Number(v) <= 200000, "That is heavier than any weighbridge");

const kindSchema = z.enum(["gross", "tare"]);

const createSchema = z.object({
  vehicleNumber: z.string().trim().min(4).max(20),
  partyId: z.string().uuid().nullish(),
  itemId: z.string().uuid().nullish(),
  locationId: z.string().uuid().nullish(),
  kind: kindSchema,
  weightKg,
  notes: z.string().max(500).nullish(),
});

const secondSchema = z.object({
  kind: kindSchema,
  weightKg,
  partyId: z.string().uuid().nullish(),
  itemId: z.string().uuid().nullish(),
  notes: z.string().max(500).nullish(),
});

/** The columns every read of a ticket wants, names resolved. */
const ticketColumns = {
  id: weighTickets.id,
  number: weighTickets.number,
  vehicleNumber: weighTickets.vehicleNumber,
  partyId: weighTickets.partyId,
  partyName: contacts.displayName,
  itemId: weighTickets.itemId,
  itemName: items.name,
  grossWeightKg: weighTickets.grossWeightKg,
  grossAt: weighTickets.grossAt,
  tareWeightKg: weighTickets.tareWeightKg,
  tareAt: weighTickets.tareAt,
  netWeightKg: weighTickets.netWeightKg,
  notes: weighTickets.notes,
  printCount: weighTickets.printCount,
  createdAt: weighTickets.createdAt,
};

const withNames = () =>
  db
    .select(ticketColumns)
    .from(weighTickets)
    .leftJoin(contacts, eq(contacts.id, weighTickets.partyId))
    .leftJoin(items, eq(items.id, weighTickets.itemId));

/**
 * A ticket is open until both weighments are on it.
 *
 * Derived rather than stored: a status column and two weight columns can
 * disagree, and then the queue shows a vehicle that has already left.
 */
const isOpen = or(isNull(weighTickets.grossWeightKg), isNull(weighTickets.tareWeightKg));

weighTicketsRouter.get(
  "/",
  requirePermission("office", "weighbridge"),
  async (req, res) => {
    const status = (req.query.status as string | undefined) ?? "open";
    const where =
      status === "open"
        ? isOpen
        : status === "closed"
          ? and(isNotNull(weighTickets.grossWeightKg), isNotNull(weighTickets.tareWeightKg))
          : undefined;
    const rows = await (where ? withNames().where(where) : withNames())
      .orderBy(desc(weighTickets.createdAt))
      .limit(status === "open" ? 100 : 50);
    res.json(rows);
  },
);

/**
 * Categories that never cross a platform.
 *
 * An exclusion rather than a list of what does, because nothing in the item
 * master says "weighbridge" and inventing that judgement at a keyboard gets it
 * wrong: construction looks like the obvious thing to drop until you notice
 * Crusher Sand and 20mm Aggregate in it, which is exactly what a tipper is
 * weighed for.
 *
 * These three are safe. A vial of vaccine and a strip of medicine arrive in a
 * box, and eggs leave by tray through the Loading Bay and are counted, never
 * weighed.
 *
 * `category` is nullable — five items have never been classified — and a bare
 * NOT IN would drop every one of them, because in SQL a NULL is not "not in"
 * anything. Unclassified means nobody has said yet, not "hide it".
 */
const NOT_WEIGHED = or(
  isNull(items.category),
  notInArray(items.category, ["vaccines", "medicines", "eggs"]),
);

/**
 * Everything the form picks from.
 *
 * Not `/api/office/context`, which narrows contacts to vendors and items to
 * the purchased ones — right for receiving a delivery, wrong here. A slip is
 * as often a sale as a purchase: gunny bags and scrap go OUT to a customer,
 * and feed is produced rather than bought, so either filter would hide exactly
 * what this screen is for.
 *
 * Declared before `/:id` so "context" is never read as an id.
 */
weighTicketsRouter.get(
  "/context",
  requirePermission("office", "weighbridge"),
  async (_req, res) => {
    const [locs, parties, materials] = await Promise.all([
      db
        .select({ id: locations.id, name: locations.name })
        .from(locations)
        .where(eq(locations.isActive, true))
        .orderBy(asc(locations.name)),
      db
        .select({ id: contacts.id, name: contacts.displayName, company: contacts.companyName })
        .from(contacts)
        .where(eq(contacts.isActive, true))
        .orderBy(asc(contacts.displayName)),
      db
        .select({ id: items.id, name: items.name, unit: items.unit })
        .from(items)
        .where(and(eq(items.isActive, true), NOT_WEIGHED))
        .orderBy(asc(items.name)),
    ]);
    res.json({ locations: locs, parties, items: materials });
  },
);

/**
 * One ticket, plus the letterhead the slip prints under.
 *
 * The organisation profile is served from here rather than fetched separately
 * because `/api/settings/org` needs `settings.view`, which a platform operator
 * has no reason to hold — and a slip with no company name on it is not a slip.
 */
weighTicketsRouter.get(
  "/:id",
  requirePermission("office", "weighbridge"),
  async (req, res) => {
    const [row] = await withNames().where(eq(weighTickets.id, req.params.id!)).limit(1);
    if (!row) return res.status(404).json({ error: "No such weigh slip" });
    const [org] = await db.select().from(orgProfile).limit(1);
    const [operator] = await db
      .select({ name: users.name })
      .from(weighTickets)
      .leftJoin(users, eq(users.id, weighTickets.createdBy))
      .where(eq(weighTickets.id, row.id))
      .limit(1);
    res.json({ ...row, operatorName: operator?.name ?? null, org: org ?? null });
  },
);

/** The first weighment. Whichever one it is, it opens the ticket. */
weighTicketsRouter.post(
  "/",
  requirePermission("office", "weighbridge"),
  validateBody(createSchema),
  async (req, res) => {
    const body = req.body as z.infer<typeof createSchema>;
    const userId = req.session.user!.id;
    const created = await db.transaction(async (tx) => {
      const number = await nextDocumentNumber(tx, "weigh_ticket");
      const now = new Date();
      const [row] = await tx
        .insert(weighTickets)
        .values({
          number,
          vehicleNumber: body.vehicleNumber.toUpperCase().replace(/\s+/g, ""),
          partyId: body.partyId ?? null,
          itemId: body.itemId ?? null,
          locationId: body.locationId ?? null,
          notes: body.notes ?? null,
          createdBy: userId,
          ...(body.kind === "gross"
            ? { grossWeightKg: body.weightKg, grossAt: now, grossBy: userId }
            : { tareWeightKg: body.weightKg, tareAt: now, tareBy: userId }),
        })
        .returning({ id: weighTickets.id, number: weighTickets.number });
      return row!;
    });
    res.status(201).json(created);
  },
);

/**
 * The second weighment, which closes the ticket.
 *
 * Refuses to overwrite the one already taken. A slip is a record of two
 * readings; letting the second silently replace the first is how a weight
 * changes after the driver has been paid against it.
 */
weighTicketsRouter.patch(
  "/:id",
  requirePermission("office", "weighbridge"),
  validateBody(secondSchema),
  async (req, res) => {
    const body = req.body as z.infer<typeof secondSchema>;
    const userId = req.session.user!.id;
    const [existing] = await db
      .select({
        gross: weighTickets.grossWeightKg,
        tare: weighTickets.tareWeightKg,
      })
      .from(weighTickets)
      .where(eq(weighTickets.id, req.params.id!))
      .limit(1);
    if (!existing) return res.status(404).json({ error: "No such weigh slip" });

    const already = body.kind === "gross" ? existing.gross : existing.tare;
    if (already != null) {
      return res.status(422).json({
        error: `This slip already has a ${body.kind} weight of ${Number(already)} kg`,
      });
    }

    const other = body.kind === "gross" ? existing.tare : existing.gross;
    if (other != null) {
      const gross = body.kind === "gross" ? Number(body.weightKg) : Number(other);
      const tare = body.kind === "gross" ? Number(other) : Number(body.weightKg);
      if (gross < tare) {
        return res.status(422).json({
          error: `The gross (${gross} kg) is lighter than the tare (${tare} kg) — check which reading went where`,
        });
      }
    }

    const now = new Date();
    const [row] = await db
      .update(weighTickets)
      .set({
        ...(body.partyId !== undefined ? { partyId: body.partyId ?? null } : {}),
        ...(body.itemId !== undefined ? { itemId: body.itemId ?? null } : {}),
        ...(body.notes !== undefined ? { notes: body.notes ?? null } : {}),
        ...(body.kind === "gross"
          ? { grossWeightKg: body.weightKg, grossAt: now, grossBy: userId }
          : { tareWeightKg: body.weightKg, tareAt: now, tareBy: userId }),
      })
      .where(eq(weighTickets.id, req.params.id!))
      .returning({ id: weighTickets.id, netWeightKg: weighTickets.netWeightKg });
    res.json(row);
  },
);

/**
 * Count a print.
 *
 * The first print of a finished slip is the Original and every one after it a
 * Duplicate — the only thing standing between a reprint and a second slip for
 * the same load being passed off as the first. WBSoftCAM has done this for
 * years and the reason for it does not appear until somebody tries it.
 */
weighTicketsRouter.post(
  "/:id/printed",
  requirePermission("office", "weighbridge"),
  async (req, res) => {
    const [row] = await db
      .update(weighTickets)
      .set({ printCount: sql`${weighTickets.printCount} + 1` })
      .where(eq(weighTickets.id, req.params.id!))
      .returning({ printCount: weighTickets.printCount });
    if (!row) return res.status(404).json({ error: "No such weigh slip" });
    res.json(row);
  },
);
