import { Router } from "express";
import { and, desc } from "drizzle-orm";
import { activityLog } from "@shared/schema";
import { db } from "../db";
import { requireAdmin } from "../lib/rbac";
import { advancedSearch, type DocumentSearch } from "../services/document-search";

export const activityRouter = Router();

/**
 * The log's advanced search. Browsing shows the latest 300 entries, so a
 * question like "what did Ramesh delete in August" has to be asked here — the
 * answer is usually older than what the page holds. The resource box matches
 * anywhere in the path, so "invoices" finds every invoice route.
 */
const activitySearch: DocumentSearch = {
  advanced: {
    userId: { kind: "eq", col: activityLog.userId },
    action: { kind: "eq", col: activityLog.action },
    resource: { kind: "text", col: activityLog.resource },
    date: { kind: "dateRange", col: activityLog.createdAt },
    ip: { kind: "text", col: activityLog.ipAddress },
  },
};

activityRouter.get("/", requireAdmin, async (req, res) => {
  const conditions = advancedSearch(activitySearch, req.query as Record<string, string | undefined>);
  const rows = db
    .select()
    .from(activityLog)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(activityLog.createdAt));
  // A search reaches the whole log; browsing stops at the latest 300.
  res.json(conditions.length ? await rows : await rows.limit(300));
});
