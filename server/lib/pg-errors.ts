import pg from "pg";
import { ZodError } from "zod";
import type { Response } from "express";

/**
 * Translate the handful of Postgres error codes a malformed request actually
 * produces into the 4xx they should have been, before the central handler's
 * flat 500 catches them. A route that validates its own input never reaches
 * this — it exists for the id/date/uniqueness/foreign-key failures nothing
 * upstream was checking for.
 *
 * Returns true (and has already written the response) when it recognised the
 * error; false otherwise, so the caller can fall through to its own handling.
 */
export function respondToPgError(err: unknown, res: Response): boolean {
  // A date field is typically checked only for shape (`\d{4}-\d{2}-\d{2}`),
  // never for being a real calendar date. "2026-13-45" passes that regex,
  // then blows up the moment application code does date arithmetic on it —
  // `new Date(...).toISOString()` throws exactly this, a plain RangeError
  // with no `.code`, well before anything reaches Postgres.
  if (err instanceof RangeError && err.message === "Invalid time value") {
    res.status(400).json({ error: "One of the dates isn't a real calendar date" });
    return true;
  }

  // A handful of routes (the legacy farms-compat ones) call a zod schema's
  // own .parse() instead of going through the validateBody middleware, so a
  // bad request reaches here as a raw ZodError rather than the clean 400
  // validateBody would have already sent.
  if (err instanceof ZodError) {
    res.status(400).json({
      error: "Validation failed",
      issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
    return true;
  }

  // Drizzle's own guard on an empty `.set({})` — thrown before the query ever
  // reaches Postgres, so it carries no `.code` and pg.DatabaseError never
  // sees it. A `PATCH` whose body validated to nothing lands here across
  // every route that does `db.update(...).set(req.body)` with no other work.
  if (err instanceof Error && err.message === "No values to set") {
    res.status(400).json({ error: "Nothing to update" });
    return true;
  }

  if (!(err instanceof pg.DatabaseError) || !err.code) return false;

  switch (err.code) {
    case "22P02": // invalid_text_representation — a value that isn't the type a column/cast expects
    case "22007": // invalid_datetime_format
    case "22008": // datetime_field_overflow — e.g. 2026-13-45
      res.status(400).json({ error: "One of the values sent isn't in a format the server accepts" });
      return true;

    case "22003": // numeric_value_out_of_range
      res.status(400).json({ error: "A number in the request is too large to store" });
      return true;

    case "22001": // string_data_right_truncation — longer than the column allows
      res.status(400).json({ error: "One of the values is too long" });
      return true;

    case "23514": // check_violation — e.g. a quantity/amount a CHECK constraint requires positive
      res.status(422).json({
        error: err.constraint
          ? `That value isn't allowed here (${err.constraint})`
          : "That value isn't allowed here",
      });
      return true;

    case "23505": // unique_violation
      res.status(409).json({
        error: err.constraint
          ? `That value is already in use (${err.constraint})`
          : "That value is already in use",
      });
      return true;

    case "23503": // foreign_key_violation
      res.status(400).json({
        error: err.constraint
          ? `Refers to something that doesn't exist (${err.constraint})`
          : "Refers to something that doesn't exist",
      });
      return true;

    default:
      return false;
  }
}
