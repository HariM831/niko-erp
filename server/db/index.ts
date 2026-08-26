import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";

// Load .env when present (local dev); no-op in environments without one.
try {
  process.loadEnvFile();
} catch {
  /* no .env file */
}

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set");
}

/**
 * The driver defaults to 10 connections per process. That is fine against a
 * local Postgres and much too generous against a managed one: DigitalOcean's
 * smallest tier allows 22 backend connections in total, and production and
 * staging share them — two instances at 10 each leaves nothing for a
 * migration or a psql session. PGPOOL_MAX caps it per instance.
 */
const poolMax = Number(process.env.PGPOOL_MAX);

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ...(Number.isFinite(poolMax) && poolMax > 0 ? { max: poolMax } : {}),
});
export const db = drizzle(pool, { schema });

export type Db = typeof db;
/** The transaction handle type accepted by all services. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
