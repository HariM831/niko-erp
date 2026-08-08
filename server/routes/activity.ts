import { Router } from "express";
import { desc, eq, sql } from "drizzle-orm";
import { activityLog } from "@shared/schema";
import { db } from "../db";
import { requireAdmin } from "../lib/rbac";

export const activityRouter = Router();

activityRouter.get("/", requireAdmin, async (req, res) => {
  const { userId, action } = req.query as Record<string, string | undefined>;
  const conditions = [];
  if (userId) conditions.push(eq(activityLog.userId, userId));
  if (action) conditions.push(eq(activityLog.action, action));
  const rows = await db
    .select()
    .from(activityLog)
    .where(conditions.length ? sql.join(conditions, sql` AND `) : undefined)
    .orderBy(desc(activityLog.createdAt))
    .limit(300);
  res.json(rows);
});
