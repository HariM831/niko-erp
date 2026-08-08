import type { NextFunction, Request, Response } from "express";
import { activityLog } from "@shared/schema";
import { db } from "../db";

/**
 * Audit-trail middleware: records every successful mutating API call
 * (who, what verb, which resource, from which IP). Reads are not logged.
 */
export function activityLogger(req: Request, res: Response, next: NextFunction) {
  if (!["POST", "PATCH", "PUT", "DELETE"].includes(req.method)) return next();

  res.on("finish", () => {
    const user = req.session?.user;
    if (!user || res.statusCode >= 400) return;
    // Strip ids from the path for a readable resource label.
    const resource = req.originalUrl.split("?")[0] ?? req.originalUrl;
    void db
      .insert(activityLog)
      .values({
        userId: user.id,
        userName: user.name,
        action: req.method,
        resource,
        ipAddress: req.ip,
      })
      .catch((err) => console.error("activity log write failed", err));
  });
  next();
}
