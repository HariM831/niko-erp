import type { NextFunction, Request, Response } from "express";
import { z, type ZodSchema } from "zod";

/**
 * A number that may arrive as a JSON number or a numeric string, never as
 * anything else. `z.coerce.number()` looks like the same thing but isn't: it
 * runs `Number()` on whatever it's given, so `true` silently becomes 1,
 * `null`/`false` become 0, and an empty string becomes 0 — all of which pass
 * as a valid value instead of failing validation. This only converts a string
 * or a number; everything else reaches the underlying `z.number()` unchanged
 * and is rejected by it.
 */
export function looseNumber(inner: z.ZodNumber = z.number()) {
  return z.preprocess(
    (v) => (typeof v === "string" || typeof v === "number" ? Number(v) : v),
    inner,
  );
}

/**
 * "HH:MM" as a real clock time, 00:00–23:59 — the shape-only regex this
 * replaced (`^\d{2}:\d{2}$`) let "25:99" through since it never checked the
 * two halves were in range.
 */
export const timeOfDay = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Not a valid time (HH:MM, 24-hour)");

/**
 * A name/code that has to mean something — `min(1)` alone accepts
 * whitespace-only strings, since a string of spaces has a length greater
 * than zero. Trims first, so "   " and "" are refused the same way.
 */
export function nonBlank(max?: number) {
  const base = max === undefined ? z.string() : z.string().max(max);
  return base.trim().min(1, "Cannot be blank");
}

/**
 * Validate req.body against a Zod schema. Replaces the body with the parsed
 * (stripped) value so unknown keys can never reach the ORM — this is the
 * mass-assignment guard every write route must use.
 */
export function validateBody(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        error: "Validation failed",
        issues: result.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
    }
    req.body = result.data;
    next();
  };
}
