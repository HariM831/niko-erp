import type { NextFunction, Request, Response } from "express";

export interface SessionUser {
  id: string;
  name: string;
  username: string;
  roleName: string;
  permissions: Record<string, string[]>;
}

declare module "express-session" {
  interface SessionData {
    user?: SessionUser;
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session.user) return res.status(401).json({ error: "Not authenticated" });
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const user = req.session.user;
  if (!user) return res.status(401).json({ error: "Not authenticated" });
  if (!user.permissions["*"]?.includes("*")) {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
}

/**
 * Permission gate — used on EVERY module route, not just defined.
 * "*" as a module or action grants everything (admin role).
 */
export function requirePermission(module: string, action: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = req.session.user;
    if (!user) return res.status(401).json({ error: "Not authenticated" });
    const perms = user.permissions;
    const granted =
      perms["*"]?.includes("*") ||
      perms[module]?.includes("*") ||
      perms[module]?.includes(action);
    if (!granted) {
      return res
        .status(403)
        .json({ error: `Missing permission: ${module}.${action}` });
    }
    next();
  };
}
