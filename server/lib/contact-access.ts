import type { NextFunction, Request, Response } from "express";
import { holds } from "./rbac";

/**
 * Which module answers for a contact.
 *
 * Customers and vendors share one table, but not one permission. A customer
 * is a Sales record and a vendor is a Purchases one, and a party that trades
 * both ways — a shed owner who buys feed and sells eggs back — answers to
 * either, because whichever side you came from is a real reason to be looking.
 *
 * Gating every contact route on Sales, as the read routes all once were, told
 * a purchase manager holding exactly the right they had been granted that they
 * were missing `sales.view` — on a page the menu had just offered them.
 */
export function modulesForContact(type: string | null | undefined): string[] {
  if (type === "vendor") return ["purchases"];
  if (type === "both") return ["sales", "purchases"];
  return ["sales"];
}

/** Does this session hold `action` on the side this contact sits on? */
export function mayAccessContact(
  req: Request,
  type: string | null | undefined,
  action: string,
): boolean {
  const perms = req.session.user?.permissions;
  return modulesForContact(type).some((m) => holds(perms, m, action));
}

/**
 * The 403 for a contact, naming the rights that would have answered.
 *
 * Returns false so a handler can `if (!allowContact(...)) return;`.
 */
export function allowContact(
  req: Request,
  res: Response,
  type: string | null | undefined,
  action: string,
): boolean {
  if (mayAccessContact(req, type, action)) return true;
  res.status(403).json({
    error: `Missing permission: ${modulesForContact(type)
      .map((m) => `${m}.${action}`)
      .join(" or ")}`,
  });
  return false;
}

/** The same rule as middleware, for routes that gate before they read a body. */
export function requireContactPermission(type: string | null | undefined, action: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (allowContact(req, res, type, action)) next();
  };
}
