import type { NextFunction, Request, Response } from "express";
import type { ZodSchema } from "zod";

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
