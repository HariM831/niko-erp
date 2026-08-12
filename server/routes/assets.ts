import { Router } from "express";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { accounts, contacts, depreciationEntries, fixedAssets } from "@shared/schema";
import { db } from "../db";
import { requirePermission } from "../lib/rbac";
import { validateBody } from "../lib/validate";
import { nextDocumentNumber } from "../lib/numbering";
import { PostingError } from "../services/posting";
import {
  disposeAsset,
  lastRunPeriod,
  monthEnd,
  netBookValue,
  runDepreciation,
} from "../services/depreciation";

export const assetsRouter = Router();

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const money = z.string().regex(/^\d+(\.\d{1,2})?$/);

const assetSchema = z.object({
  seriesId: z.string().uuid().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  assetAccountId: z.string().uuid(),
  acquisitionDate: dateStr,
  cost: money,
  salvageValue: money.optional(),
  method: z.enum(["straight_line", "written_down_value"]).optional(),
  usefulLifeMonths: z.number().int().min(1).max(1200),
  openingAccumulated: money.optional(),
  depreciationStartDate: dateStr.optional(),
  vendorId: z.string().uuid().optional(),
  serialNumber: z.string().optional(),
  location: z.string().optional(),
});

function handlePostingError(err: unknown, res: Parameters<Parameters<Router["post"]>[1]>[1]) {
  if (err instanceof PostingError) {
    res.status(422).json({ error: err.message });
    return true;
  }
  return false;
}

const STATUSES = ["active", "fully_depreciated", "disposed"] as const;

assetsRouter.get("/", requirePermission("accounting", "view"), async (req, res) => {
  const raw = (req.query as Record<string, string | undefined>).status;
  const status = STATUSES.find((s) => s === raw);
  const rows = await db
    .select({
      id: fixedAssets.id,
      number: fixedAssets.number,
      name: fixedAssets.name,
      status: fixedAssets.status,
      acquisitionDate: fixedAssets.acquisitionDate,
      cost: fixedAssets.cost,
      salvageValue: fixedAssets.salvageValue,
      openingAccumulated: fixedAssets.openingAccumulated,
      method: fixedAssets.method,
      usefulLifeMonths: fixedAssets.usefulLifeMonths,
      accountName: accounts.name,
      accountCode: accounts.code,
      // Joined, not a correlated subquery — drizzle emits bare column names
      // inside sql`` subqueries, which silently binds to the wrong table.
      charged: sql<string>`coalesce(sum(${depreciationEntries.amount}), 0)`,
    })
    .from(fixedAssets)
    .leftJoin(accounts, eq(accounts.id, fixedAssets.assetAccountId))
    .leftJoin(depreciationEntries, eq(depreciationEntries.assetId, fixedAssets.id))
    .where(status ? eq(fixedAssets.status, status) : undefined)
    .groupBy(fixedAssets.id, accounts.name, accounts.code)
    .orderBy(desc(fixedAssets.acquisitionDate));

  res.json(
    rows.map((r) => {
      const accumulated = Number(r.openingAccumulated) + Number(r.charged);
      return { ...r, accumulated: accumulated.toFixed(2), netBookValue: (Number(r.cost) - accumulated).toFixed(2) };
    }),
  );
});

/** Totals for the asset register header. */
assetsRouter.get("/summary", requirePermission("accounting", "view"), async (_req, res) => {
  const [row] = await db
    .select({
      count: sql<number>`count(*) filter (where ${fixedAssets.status} <> 'disposed')`,
      cost: sql<string>`coalesce(sum(${fixedAssets.cost}) filter (where ${fixedAssets.status} <> 'disposed'), 0)`,
      opening: sql<string>`coalesce(sum(${fixedAssets.openingAccumulated}) filter (where ${fixedAssets.status} <> 'disposed'), 0)`,
    })
    .from(fixedAssets);
  const [charged] = await db
    .select({
      total: sql<string>`coalesce(sum(${depreciationEntries.amount}), 0)`,
    })
    .from(depreciationEntries)
    .innerJoin(fixedAssets, eq(fixedAssets.id, depreciationEntries.assetId))
    .where(sql`${fixedAssets.status} <> 'disposed'`);

  const accumulated = Number(row?.opening ?? 0) + Number(charged?.total ?? 0);
  res.json({
    count: Number(row?.count ?? 0),
    cost: Number(row?.cost ?? 0).toFixed(2),
    accumulated: accumulated.toFixed(2),
    netBookValue: (Number(row?.cost ?? 0) - accumulated).toFixed(2),
    lastRunPeriod: await lastRunPeriod(db),
  });
});

assetsRouter.get("/:id", requirePermission("accounting", "view"), async (req, res) => {
  const asset = await db.query.fixedAssets.findFirst({
    where: eq(fixedAssets.id, req.params.id!),
  });
  if (!asset) return res.status(404).json({ error: "Asset not found" });

  const [account] = await db
    .select({ code: accounts.code, name: accounts.name })
    .from(accounts)
    .where(eq(accounts.id, asset.assetAccountId));
  const vendor = asset.vendorId
    ? await db.query.contacts.findFirst({ where: eq(contacts.id, asset.vendorId) })
    : null;
  const schedule = await db
    .select()
    .from(depreciationEntries)
    .where(eq(depreciationEntries.assetId, asset.id))
    .orderBy(asc(depreciationEntries.periodEnd));

  const nbvP = await netBookValue(db, asset);
  res.json({
    ...asset,
    account,
    vendorName: vendor?.displayName ?? null,
    schedule,
    accumulated: (Number(asset.cost) - nbvP / 100).toFixed(2),
    netBookValue: (nbvP / 100).toFixed(2),
  });
});

assetsRouter.post(
  "/",
  requirePermission("accounting", "create"),
  validateBody(assetSchema),
  async (req, res) => {
    const body = req.body as z.infer<typeof assetSchema>;
    try {
      const asset = await db.transaction(async (tx) => {
        const [account] = await tx
          .select({ subtype: accounts.subtype, isGroup: accounts.isGroup, name: accounts.name })
          .from(accounts)
          .where(eq(accounts.id, body.assetAccountId));
        if (!account) throw new PostingError("Asset account not found");
        if (account.isGroup) {
          throw new PostingError(`"${account.name}" is a heading — pick one of its sub-accounts`);
        }
        if (account.subtype !== "fixed_asset") {
          throw new PostingError(`"${account.name}" is not a fixed asset account`);
        }
        if (Number(body.salvageValue ?? 0) > Number(body.cost)) {
          throw new PostingError("Salvage value cannot exceed cost");
        }

        const number = await nextDocumentNumber(tx, "fixed_asset", body.seriesId);
        const [row] = await tx
          .insert(fixedAssets)
          .values({
            number,
            name: body.name,
            description: body.description,
            assetAccountId: body.assetAccountId,
            acquisitionDate: body.acquisitionDate,
            cost: body.cost,
            salvageValue: body.salvageValue ?? "0",
            method: body.method ?? "straight_line",
            usefulLifeMonths: body.usefulLifeMonths,
            openingAccumulated: body.openingAccumulated ?? "0",
            depreciationStartDate: body.depreciationStartDate ?? body.acquisitionDate,
            vendorId: body.vendorId,
            serialNumber: body.serialNumber,
            location: body.location,
            createdBy: req.session.user!.id,
          })
          .returning();
        return row!;
      });
      res.status(201).json(asset);
    } catch (err) {
      if (!handlePostingError(err, res)) throw err;
    }
  },
);

/**
 * The asset's cost is assumed to already be on the balance sheet via the bill
 * or journal that bought it, so registering an asset posts nothing to the GL —
 * it only starts the depreciation schedule.
 */
assetsRouter.patch(
  "/:id",
  requirePermission("accounting", "edit"),
  validateBody(assetSchema.partial().omit({ seriesId: true })),
  async (req, res) => {
    const asset = await db.query.fixedAssets.findFirst({
      where: eq(fixedAssets.id, req.params.id!),
    });
    if (!asset) return res.status(404).json({ error: "Asset not found" });
    if (asset.status === "disposed") {
      return res.status(422).json({ error: "A disposed asset cannot be edited" });
    }
    const [charged] = await db
      .select({ n: sql<number>`count(*)` })
      .from(depreciationEntries)
      .where(eq(depreciationEntries.assetId, asset.id));
    const body = req.body as Partial<z.infer<typeof assetSchema>>;
    // Changing the basis after depreciation has been charged would silently
    // rewrite history, since every run recomputes from these numbers.
    if (Number(charged?.n ?? 0) > 0) {
      const locked = ["cost", "salvageValue", "method", "usefulLifeMonths", "depreciationStartDate", "openingAccumulated"] as const;
      const attempted = locked.filter((k) => body[k] !== undefined);
      if (attempted.length) {
        return res.status(422).json({
          error: `Depreciation has already been charged — ${attempted.join(", ")} can no longer be changed`,
        });
      }
    }
    const [updated] = await db
      .update(fixedAssets)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(fixedAssets.id, asset.id))
      .returning();
    res.json(updated);
  },
);

/** Preview what a run would charge, without posting anything. */
assetsRouter.get(
  "/depreciation/preview",
  requirePermission("accounting", "view"),
  async (req, res) => {
    const { periodEnd } = req.query as Record<string, string | undefined>;
    if (!periodEnd || !/^\d{4}-\d{2}-\d{2}$/.test(periodEnd)) {
      return res.status(400).json({ error: "periodEnd (YYYY-MM-DD) is required" });
    }
    try {
      const preview = await db.transaction((tx) =>
        runDepreciation(tx, {
          periodEnd,
          postedBy: req.session.user!.id,
          dryRun: true,
        }),
      );
      res.json(preview);
    } catch (err) {
      if (!handlePostingError(err, res)) throw err;
    }
  },
);

assetsRouter.post(
  "/depreciation/run",
  requirePermission("accounting", "create"),
  validateBody(z.object({ periodEnd: dateStr })),
  async (req, res) => {
    try {
      const run = await db.transaction((tx) =>
        runDepreciation(tx, {
          periodEnd: req.body.periodEnd,
          postedBy: req.session.user!.id,
        }),
      );
      if (!run.journalEntryId) {
        return res.status(422).json({
          error: `Nothing to depreciate for ${monthEnd(req.body.periodEnd)} — every active asset is already up to date`,
        });
      }
      res.status(201).json(run);
    } catch (err) {
      if (!handlePostingError(err, res)) throw err;
    }
  },
);

assetsRouter.post(
  "/:id/dispose",
  requirePermission("accounting", "delete"),
  validateBody(
    z.object({
      disposalDate: dateStr,
      proceeds: money.optional(),
      proceedsAccountId: z.string().uuid().optional(),
    }),
  ),
  async (req, res) => {
    try {
      const result = await db.transaction(async (tx) => {
        const asset = await tx.query.fixedAssets.findFirst({
          where: eq(fixedAssets.id, req.params.id!),
        });
        if (!asset) throw new PostingError("Asset not found");
        const journalEntryId = await disposeAsset(tx, {
          asset,
          disposalDate: req.body.disposalDate,
          proceeds: req.body.proceeds ?? "0",
          proceedsAccountId: req.body.proceedsAccountId,
          postedBy: req.session.user!.id,
        });
        return { journalEntryId };
      });
      res.status(201).json(result);
    } catch (err) {
      if (!handlePostingError(err, res)) throw err;
    }
  },
);
