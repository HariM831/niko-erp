import type { NextFunction, Request, Response } from "express";

/**
 * The floor every document form stands on.
 *
 * A purchase order picks an item, a tax, an account and a number series. Not
 * one of those belongs to Purchases, so gating each list on its owning module
 * meant raising a single PO needed four modules ticked — and ticking them
 * handed over the Items pages, Stock on Hand, the Chart of Accounts screen and
 * Settings, which is a great deal more authority than "raise a PO".
 *
 * These lists are reference data: names, codes and rates a form offers and a
 * document then refers to. Reading one is not the same as holding the module,
 * so they sit on this floor instead. Writing them — and every page the owning
 * modules put them on — stays exactly where it was.
 *
 * `office.view` already carried this idea for the six goods-receipt stations:
 * "every station reads reference data and the receipt it is working on". This
 * is that floor, for the document forms.
 *
 * Banking is deliberately NOT reference data. `/api/banking/accounts` carries
 * live balances, so it stays behind `banking.view`: a role that needs the
 * paid-through field on an expense, or the Payments Made page, is granted
 * Banking on purpose rather than by implication.
 */
const REFERENCE_READERS = [
  "sales",
  "purchases",
  "items",
  "accounting",
  "banking",
  "reports",
  "office",
  "feed_mill",
  "farms",
];

/**
 * Any right at all in a module that authors or reads documents.
 *
 * Any right, not `view`: the modules with verbs of their own have no `view` to
 * check — a mill hand holds `feed_mill.produce` and needs the material list
 * exactly as much as someone who can read the formulas.
 */
export function requireReferenceRead(req: Request, res: Response, next: NextFunction) {
  const perms = req.session.user?.permissions;
  if (!perms) return res.status(401).json({ error: "Not authenticated" });
  if (perms["*"]?.includes("*")) return next();
  if (REFERENCE_READERS.some((m) => (perms[m]?.length ?? 0) > 0)) return next();
  return res.status(403).json({ error: "Missing permission: no module that uses this list" });
}
