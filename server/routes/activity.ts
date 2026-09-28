import { Router } from "express";
import { and, desc } from "drizzle-orm";
import { activityLog } from "@shared/schema";
import { db } from "../db";
import { requireAdmin } from "../lib/rbac";
import { advancedSearch, type DocumentSearch } from "../services/document-search";

export const activityRouter = Router();

/**
 * The log's advanced search, for a question like "what did Ramesh delete in
 * August". The resource box matches anywhere in the path, so "invoices" finds
 * every invoice route.
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
  // The whole log, newest first. Browsing used to stop at the latest 300 —
  // paging by hand before the page had a pager — and everything older could
  // only be reached through a search. The page pages it now.
  res.json(await rows);
});
